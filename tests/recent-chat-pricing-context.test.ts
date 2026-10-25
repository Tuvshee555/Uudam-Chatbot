import assert from "node:assert/strict";
import test from "node:test";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { buildTripRequest, mergeTripSelection } from "../src/lib/tripRequest";
import { buildAmbiguousPassengerTotalReply, buildStructuredTripReply } from "../src/lib/travelFastPaths";
import { buildAmbiguousTripReply } from "../src/lib/travelFastPathsPricing";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { FastPathRoute } from "../src/lib/fastPathRouting";

const now = new Date("2098-02-01T04:00:00Z");
const trip = (fields: Partial<TravelTrip> = {}): TravelTrip => ({
  id: "velmor", route_name: "Вэлмор нуурын аялал", category: "Аялал", operator_name: "Agency",
  duration_text: "5 өдөр 4 шөнө", adult_price: 731_000, child_price: 333_000, infant_price: null,
  currency: "MNT", departure_dates: ["2098-03-08", "2098-03-15", "2098-04-05"],
  seats_total: null, seats_left: null, has_food: null, status: "active", hotel: "", notes: "",
  source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
});
const route = (selection?: FastPathRoute["selection"]): FastPathRoute => ({ chosenTripId: "velmor", matchText: "", scopedClarify: null, ...(selection ? { selection } : {}) });

test("a passenger follow-up retains the month and prints the departure menu once", () => {
  const t = trip();
  const first = buildTripAnswerPlan({ text: "3 сард хэзээ гарах вэ", trips: [t], route: route(), now })!;
  const next = buildTripAnswerPlan({ text: "5 tom hun 1 huuhed", trips: [t], route: route(first.selection), now })!;
  assert.equal(next.status, "clarify");
  assert.match(next.reply, /3 сарын 8|3 сарын 15/);
  assert.doesNotMatch(next.reply, /4 сарын 5/);
  assert.equal((next.reply.match(/3 сарын 8/g) || []).length, 1);
  assert.equal((first.reply.match(/3 сарын 8/g) || []).length, 1);
});

test("date windows survive passenger and hotel turns and explicit dates replace them", () => {
  const t = trip();
  const first = buildTripAnswerPlan({ text: "3 сарын эхний 2 долоо хоногт үнэ хэд вэ", trips: [t], route: route(), now })!;
  assert.equal(first.selection.date, "2098-03-08");
  const next = buildTripAnswerPlan({ text: "2 том хүн", trips: [t], route: route(first.selection), now })!;
  assert.equal(next.selection.date, "2098-03-08");
  assert.match(next.reply, /Нийт: 1,462,000₮/);
  const changed = mergeTripSelection(t.id, buildTripRequest("4 сарын 5", [t], undefined, now), first.selection);
  assert.equal(changed.date, "2098-04-05");
  assert.equal(changed.dateScope, undefined);
});

test("a shared-month OR list uses a supported later day instead of its first day", () => {
  const t = trip({ departure_dates: ["2098-03-30"] });
  const plan = buildTripAnswerPlan({ text: "3.28,30-nd үнэ хэд вэ", trips: [t], route: route(), now })!;
  assert.equal(plan.status, "answered");
  assert.equal(plan.selection.date, "2098-03-30");
  assert.match(plan.reply, /731,000₮/);
});

test("a free-program package request quotes only that documented package", () => {
  const t = trip({ departure_dates: ["2098-03-08"], extra: { price_groups: [
    { dates: ["2098-03-08"], hotel: "Lumen Lodge", package_id: "Хөтөлбөргүй", adult_price: 801_000 },
    { dates: ["2098-03-08"], hotel: "Sable Lodge", package_id: "Хөтөлбөргүй", adult_price: 901_000 },
    { dates: ["2098-03-08"], hotel: "Lumen Lodge", package_id: "Хөтөлбөртэй", adult_price: 1_101_000 },
    { dates: ["2098-03-08"], hotel: "Sable Lodge", package_id: "Хөтөлбөртэй", adult_price: 1_201_000 },
  ] } });
  const plan = buildTripAnswerPlan({ text: "3 сарын 8-нд чөлөөт аялал хэд вэ", trips: [t], route: route(), now })!;
  assert.equal(plan.status, "answered");
  assert.equal(plan.selection.package, "Хөтөлбөргүй");
  assert.match(plan.reply, /801,000₮/);
  assert.match(plan.reply, /901,000₮/);
  assert.doesNotMatch(plan.reply, /1,101,000|1,201,000|Хөтөлбөртэй/);
});

test("a missing requested package hands off instead of listing unrelated package fares", () => {
  const plan = buildTripAnswerPlan({ text: "3 сарын 8-нд чөлөөт аялал хэд вэ", trips: [trip()], route: route(), now })!;
  assert.equal(plan.status, "handoff");
  assert.equal(plan.reply, "REFER");
  assert.deepEqual(plan.missingFacts, ["price.package"]);
  assert.equal(buildTripRequest("чөлөөт өдөр бий юу", [trip()], undefined, now).packagePreference, undefined);
});

test("a selected package never offers a hotel that sells only another package", () => {
  const t = trip({ departure_dates: ["2098-03-08"], extra: { price_groups: [
    { dates: ["2098-03-08"], hotel: "Lumen Lodge", package_id: "Хөтөлбөргүй", adult_price: 801_000 },
    { dates: ["2098-03-08"], hotel: "Sable Lodge", package_id: "Хөтөлбөртэй", adult_price: 1_201_000 },
  ] } });
  const plan = buildTripAnswerPlan({ text: "3 сарын 8-нд чөлөөт аялал хэд вэ", trips: [t], route: route(), now })!;
  assert.equal(plan.status, "answered");
  assert.match(plan.reply, /801,000₮/);
  assert.doesNotMatch(plan.reply, /Sable|1,201,000/);
});

test("a named trip with an unsupported date never borrows a sibling's date or fare", () => {
  const a = trip({ route_name: "ВЭЛМОР ХОЙД АЯЛАЛ", departure_dates: ["2098-03-08"] });
  const b = trip({ id: "south", route_name: "ВЭЛМОР ӨМНӨД АЯЛАЛ", departure_dates: ["2098-03-15"], adult_price: 901_000 });
  const reply = buildStructuredTripReply("ВЭЛМОР ХОЙД АЯЛАЛ 3 сарын 15 үнэ хэд вэ", [a, b], now) || "";
  assert.doesNotMatch(reply, /ВЭЛМОР ӨМНӨД|901,000/);
});

test("ambiguous totals use canonical dated passenger fares rather than stale scalar summaries", () => {
  const catalog = ["velmor", "nerith"].map((id, i) => trip({ id, route_name: i ? "Нерит ойн аялал" : "Вэлмор нуурын аялал", departure_dates: ["2098-03-08"], extra: {
    price_groups: [{ dates: ["2098-03-08"], adult_price: 901_000 + i * 100_000, child_price: 401_000 }],
  } }));
  const reply = buildAmbiguousPassengerTotalReply("2 том хүн 1 хүүхэд", catalog, now)!;
  assert.match(reply, /2,203,000₮/);
  assert.match(reply, /2,403,000₮/);
  assert.doesNotMatch(reply, /1,795,000/);
});

test("ambiguous totals do not assume a date, hotel or child age", () => {
  const simple = trip({ id: "simple", departure_dates: ["2098-03-08"] });
  const changing = trip({ extra: { price_groups: [{ dates: ["2098-04-05"], adult_price: 901_000 }] } });
  assert.equal(buildAmbiguousPassengerTotalReply("2 том хүн 1 хүүхэд", [simple, changing], now), null);
  const hotels = trip({ departure_dates: ["2098-03-08"], extra: { price_groups: [
    { dates: ["2098-03-08"], hotel: "Lumen Lodge", adult_price: 901_000 },
    { dates: ["2098-03-08"], hotel: "Sable Lodge", adult_price: 1_001_000 },
  ] } });
  assert.equal(buildAmbiguousPassengerTotalReply("2 том хүн 1 хүүхэд", [simple, hotels], now), null);
  const ages = trip({ departure_dates: ["2098-03-08"], extra: { price_groups: [
    { dates: ["2098-03-08"], passenger_prices: [
      { label: "Хүүхэд", age_range: "2-5 нас", price: 201_000 },
      { label: "Хүүхэд", age_range: "6-11 нас", price: 401_000 },
    ] },
  ] } });
  assert.equal(buildAmbiguousPassengerTotalReply("2 том хүн 1 хүүхэд", [simple, ages], now), null);
});

test("a month-scoped destination list filters before limiting dates and uses that month's fare", () => {
  const t = trip({ departure_dates: [...Array.from({ length: 10 }, (_, i) => `2098-03-${String(i + 1).padStart(2, "0")}`), "2098-04-05"], extra: {
    price_groups: [{ dates: ["2098-04-05"], adult_price: 901_000 }],
  } });
  const reply = buildAmbiguousTripReply([t], undefined, { customerText: "4сарынх" }, now);
  assert.match(reply, /4 сарын 5/);
  assert.match(reply, /901,000₮/);
  assert.doesNotMatch(reply, /3 сарын|731,000/);
  assert.equal(buildAmbiguousTripReply([t], undefined, { customerText: "5 сарынх" }, now), "REFER");
  assert.equal(buildAmbiguousTripReply([t], undefined, { customerText: "оны сүүлээр" }, now), "REFER");
  const earlier = Array.from({ length: 9 }, (_, i) => trip({ id: `earlier-${i}`, departure_dates: ["2098-03-08"] }));
  assert.match(buildAmbiguousTripReply([...earlier, t], undefined, { customerText: "4сарынх" }, now), /4 сарын 5/);
});
