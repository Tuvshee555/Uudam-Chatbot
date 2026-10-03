import assert from "node:assert/strict";
import test from "node:test";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { buildTripAnswerRuntime } from "../src/lib/tripAnswerRuntime";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { FastPathRoute } from "../src/lib/fastPathRouting";

const now = new Date("2026-10-02T04:00:00Z");
function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "lumi", category: "Аялал", operator_name: "Uudam", route_name: "Лумиа аялал", duration_text: "6 өдөр 5 шөнө",
    adult_price: 2_000_000, child_price: 1_500_000, infant_price: 400_000, currency: "MNT", departure_dates: ["2026-10-08"],
    seats_total: 20, seats_left: 10, has_food: true, status: "active", notes: "", hotel: "Hotel Lumi", source_description: "",
    photo_urls: [], extra: { age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" }, transport_type: "direct_flight" },
    created_at: "", updated_at: "", ...fields,
  };
}
const route = (id = "lumi"): FastPathRoute => ({ matchText: "", scopedClarify: null, chosenTripId: id });

test("one answer covers the selected departure's price, hotel and duration together", () => {
  const plan = buildTripAnswerPlan({ text: "10 сарын 8-нд буудал, үнэ, хэдэн хоног вэ?", trips: [trip()], route: route(), now });
  assert.equal(plan?.status, "answered");
  assert.match(plan!.reply, /2,000,000₮/);
  assert.match(plan!.reply, /Hotel Lumi/);
  assert.match(plan!.reply, /6 өдөр/);
  assert.ok(plan!.answeredTopics.includes("price"));
  assert.ok(plan!.answeredTopics.includes("hotel"));
  assert.ok(plan!.answeredTopics.includes("duration"));
});

test("passenger totals are computed from the correct hotel and each child's age", () => {
  const t = trip({ extra: { age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" }, price_groups: [
    { dates: ["2026-10-08"], hotel: "Hotel Lumi", adult_price: 2_000_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-5 нас", price: 1_000_000 }, { label: "Хүүхэд", age_range: "6-11 нас", price: 1_500_000 }] },
  ] } });
  const plan = buildTripAnswerPlan({ text: "10 сарын 8-нд 2 том хүн 5, 8 настай, нийт үнэ хэд вэ?", trips: [t], route: route(), now });
  assert.equal(plan?.status, "answered");
  assert.match(plan!.reply, /Нийт: 6,500,000₮/);
  assert.equal(plan?.offer?.status, "ready");
});

test("a sold-out date is closed while another departure of that trip remains open", () => {
  const t = trip({ departure_dates: ["2026-10-08", "2026-10-15"], extra: { website_departure_availability: [
    { date: "2026-10-08", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2026-10-15", status: "OPEN", seatsLeft: 5 },
  ] } });
  const closed = buildTripAnswerPlan({ text: "10 сарын 8-нд үнэ, суудал байна уу?", trips: [t], route: route(), now });
  assert.match(closed!.reply, /суудал дүүрсэн/);
  assert.doesNotMatch(closed!.reply, /захиалга нээлттэй|2,000,000₮/);
  const open = buildTripAnswerPlan({ text: "10 сарын 15-нд суудал байна уу?", trips: [t], route: route(), now });
  assert.match(open!.reply, /5 суудал/);
});

test("two different hotels on one date ask for a hotel before quoting a total", () => {
  const t = trip({ hotel: "", extra: { price_groups: [
    { dates: ["2026-10-08"], hotel: "Hotel Lumi", adult_price: 2_000_000 },
    { dates: ["2026-10-08"], hotel: "Hotel Peln", adult_price: 3_000_000 },
  ] } });
  const plan = buildTripAnswerPlan({ text: "10 сарын 8-нд 2 том хүн нийт хэд вэ?", trips: [t], route: route(), now });
  assert.equal(plan?.status, "clarify");
  assert.match(plan!.reply, /Аль буудлын/);
  assert.doesNotMatch(plan!.reply, /Нийт:/);
});

test("selected IDs keep two trips with identical names separate", () => {
  const a = trip();
  const b = trip({ id: "other", adult_price: 3_000_000 });
  const plan = buildTripAnswerPlan({ text: "үнэ хэд вэ", trips: [a, b], route: route("other"), now });
  assert.match(plan!.reply, /3,000,000₮/);
  assert.doesNotMatch(plan!.reply, /2,000,000₮/);
});

test("the shared verifier rejects swapped passenger fares and invented durations", () => {
  const t = trip();
  assert.equal(verifyTripReply({ reply: "2026-10-08\nТом хүн: 1,500,000₮", trips: [t], now }), "REFER");
  assert.equal(verifyTripReply({ reply: "2026-10-08\nХүүхэд: 2,000,000₮", trips: [t], now }), "REFER");
  assert.equal(verifyTripReply({ reply: "Хугацаа: 5 өдөр.", trips: [t], now }), "REFER");
  const correct = "2026-10-08\nТом хүн: 2,000,000₮\nХүүхэд: 1,500,000₮";
  assert.equal(verifyTripReply({ reply: correct, trips: [t], now }), correct);
});

test("a code-generated availability claim is checked against the selected date too", () => {
  const t = trip({ extra: { website_departure_availability: [{ date: "2026-10-08", status: "SOLD_OUT", seatsLeft: 0 }] } });
  assert.equal(verifyTripReply({ reply: "2026-10-08: захиалга нээлттэй.", trips: [t], now }), "REFER");
});

test("missing factual data produces a handoff instead of an invented transport answer", () => {
  const t = trip({ extra: {} });
  const plan = buildTripAnswerPlan({ text: "нислэгтэй юу", trips: [t], route: route(), now });
  assert.equal(plan?.status, "handoff");
  assert.equal(plan?.reply, "REFER");
});

test("identical fares across multiple dates do not force an unnecessary date selection", () => {
  const t = trip({ departure_dates: ["2026-10-08", "2026-10-15"] });
  const plan = buildTripAnswerPlan({ text: "үнэ хэд вэ", trips: [t], route: route(), now });
  assert.equal(plan?.status, "answered");
  assert.match(plan!.reply, /2,000,000₮/);
  assert.doesNotMatch(plan!.reply, /Аль гарах|захиалга нээлттэй|2026-10-08/);
});

test("changing date fares still ask for the date rather than assuming the first price", () => {
  const t = trip({ departure_dates: ["2026-10-08", "2026-10-15"], extra: { price_groups: [
    { dates: ["2026-10-15"], adult_price: 3_000_000 },
  ] } });
  const plan = buildTripAnswerPlan({ text: "үнэ хэд вэ", trips: [t], route: route(), now });
  assert.equal(plan?.status, "clarify");
  assert.match(plan!.reply, /Аль гарах/);
});

test("a compound weather and fare question uses one selected trip and date", async () => {
  const seen: unknown[] = [];
  const plan = await buildTripAnswerRuntime({ text: "10 сарын 8-нд үнэ, цаг агаар?", trips: [trip(), trip({ id: "other", adult_price: 3_000_000 })], route: route(), now }, async (id, date) => {
    seen.push({ id, date });
    return { text: "Website weather report", tripSlug: "lumi" };
  });
  assert.deepEqual(seen, [{ id: "lumi", date: "2026-10-08" }]);
  assert.match(plan!.reply, /Website weather report/);
  assert.match(plan!.reply, /2,000,000₮/);
  assert.doesNotMatch(plan!.reply, /3,000,000₮/);
  assert.deepEqual(plan?.missingTopics, []);
});

test("a known food flag alone does not answer whether a ticket is included", () => {
  const plan = buildTripAnswerPlan({ text: "тийз үнэд багтсан уу", trips: [trip()], route: route(), now });
  assert.equal(plan?.status, "handoff");
});

test("the verifier checks each category on a single line and child age fares", () => {
  const t = trip();
  const correct = "2026-10-08: Том хүн 2,000,000₮, Хүүхдийн үнэ 1,500,000₮, нярай 400,000₮";
  assert.equal(verifyTripReply({ reply: correct, trips: [t], now }), correct);
  assert.equal(verifyTripReply({ reply: "2026-10-08: Хүүхдийн үнэ 2,000,000₮", trips: [t], now }), "REFER");
  const tiered = trip({ extra: { age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" }, price_groups: [
    { dates: ["2026-10-08"], passenger_prices: [{ label: "Хүүхэд", age_range: "2-5 нас", price: 1_000_000 }, { label: "Хүүхэд", age_range: "6-11 нас", price: 1_500_000 }] },
  ] } });
  assert.equal(verifyTripReply({ reply: "2026-10-08: Хүүхэд (2-5 нас): 1,500,000₮", trips: [tiered], now }), "REFER");
});

test("known departure availability is answered even before a base fare is entered", () => {
  const plan = buildTripAnswerPlan({ text: "10 сарын 8-нд суудал байгаа юу", trips: [trip({ adult_price: null, child_price: null, infant_price: null })], route: route(), now });
  assert.equal(plan?.status, "answered");
  assert.match(plan!.reply, /10 суудал/);
  assert.doesNotMatch(plan!.reply, /₮/);
});

test("published trip pages remain preferred over frozen photo or PDF attachments", () => {
  const t = trip({ photo_urls: ["https://example.com/trip.jpg"], extra: { website_slug: "lumi", website_published: true, brochure_pdf_url: "https://example.com/trip.pdf" } });
  const plan = buildTripAnswerPlan({ text: "хөтөлбөр зураг явуулна уу", trips: [t], route: route(), now });
  assert.match(plan!.reply, /https:\/\/uudamtravel.mn\/trips\/lumi/);
  assert.deepEqual(plan?.mediaUrls, []);
  assert.equal(plan?.brochureUrl, null);
});
