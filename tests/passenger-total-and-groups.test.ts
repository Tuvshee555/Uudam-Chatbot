import assert from "node:assert/strict";
import test from "node:test";
import { buildStructuredTripReply, buildBudgetReply, hasBudgetIntent } from "../src/lib/travelFastPaths";
import { getStructuredPriceGroups } from "../src/lib/travelFastPathsSearch";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW = new Date("2026-07-24T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "dalian",
    category: "шууд нислэгтэй аялал",
    operator_name: "Uudam Travel",
    route_name: "Далянь хотын шууд нислэгтэй аялал",
    duration_text: "8 өдөр / 7 шөнө",
    adult_price: 1420000,
    child_price: 1320000,
    currency: "MNT",
    departure_dates: ["8 сарын 7", "8 сарын 14"],
    seats_total: null,
    seats_left: null,
    has_food: true,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

// ---- Passenger total: count must bind to the right noun regardless of word order ----

test("total price reads '2 том хүн 1 хүүхэд' as 2 adults + 1 child (number-first order)", () => {
  const reply = buildStructuredTripReply("Далянь 2 том хүн 1 хүүхэд нийт хэд вэ?", [trip({})], NOW) || "";
  // 2*1,420,000 + 1*1,320,000 = 4,160,000
  assert.match(reply, /4,160,000/);
  assert.match(reply, /Том хүн 2/);
  assert.doesNotMatch(reply, /Том хүн 1/);
});

test("total price still reads 'том хүн 2 хүүхэд 1' as 2 adults + 1 child (noun-first order)", () => {
  const reply = buildStructuredTripReply("Далянь том хүн 2 хүүхэд 1 нийт хэд вэ?", [trip({})], NOW) || "";
  assert.match(reply, /4,160,000/);
  assert.match(reply, /Том хүн 2/);
});

// ---- An infant question must not switch the customer to another tour ----

test("infant question on a named trip is answered for THAT trip, not a sibling", () => {
  // Route names overlap heavily in this catalog: a standalone tour's name is
  // often a substring of a combined tour's name. The "borrow a sibling that has
  // an infant price" rule matched on one shared token, so naming the combined
  // tour and asking about infants returned the standalone tour's header AND its
  // infant fare — a wrong price under a wrong trip name.
  const standalone = trip({
    id: "standalone",
    route_name: "Зэт хаалга - шууд нислэгтэй",
    adult_price: 1230000,
    child_price: 1210000,
    extra: { child_rules: [{ label: "Нярай", price: 111111, age_range: "0-2 нас" }] },
  });
  const combined = trip({
    id: "combined",
    route_name: "Альфа + Зэт хаалга шууд нислэгтэй аялал",
    adult_price: 1270000,
    child_price: 1240000,
    extra: {},
  });
  const reply = buildStructuredTripReply(
    `${combined.route_name}\nнярай хүүхдийн үнэ хэд вэ?`,
    [standalone, combined],
    NOW,
  ) || "";
  assert.match(reply, /Альфа \+ Зэт хаалга/);
  assert.doesNotMatch(reply, /111,111/);
  assert.doesNotMatch(reply, /^✈️ Зэт хаалга - шууд нислэгтэй/m);
});

// ---- Budget ceilings phrased the way customers phrase them ----

test("hasBudgetIntent recognises everyday price-ceiling phrasings", () => {
  // Each of these previously fell through to the trip matcher, resolved to no
  // trip, and returned silence on a high-intent buying question.
  assert.equal(hasBudgetIntent("2 саяд багтах аялал байна уу?"), true);
  assert.equal(hasBudgetIntent("2 сая төгрөгт багтах аялал"), true);
  assert.equal(hasBudgetIntent("3 сая хүртэл аялал байна уу"), true);
  assert.equal(hasBudgetIntent("хямдхан аялал байна уу"), true);
  assert.equal(hasBudgetIntent("төсөв 2 сая, ямар аялал байна"), true);
  // still-supported originals
  assert.equal(hasBudgetIntent("хамгийн хямд аялал аль вэ?"), true);
  assert.equal(hasBudgetIntent("2 саяас доош аялал"), true);
});

test("hasBudgetIntent does not fire on ordinary 'until' phrasing", () => {
  assert.equal(hasBudgetIntent("8 сар хүртэл аялал байна уу?"), false);
  assert.equal(hasBudgetIntent("Шанхай аялал байна уу?"), false);
});

test("a budget ask with no amount falls through instead of listing everything", () => {
  // hasBudgetIntent is deliberately permissive, so buildBudgetReply stays the
  // real filter: "хөтөлбөрт багтах газрууд" is not a price question.
  assert.equal(buildBudgetReply("хөтөлбөрт багтах газрууд аль нь вэ", [trip({})], NOW), null);
});

// ---- Cheapest list must quote a fare the customer can actually book ----

test("cheapest list skips a date group whose departures are no longer bookable", () => {
  // The 1,100,000 tier only sells on 8 сарын 24, which is not a departure on
  // this trip — quoting it would advertise a fare with no date behind it.
  const cheaper = trip({
    id: "alpha5",
    route_name: "Альфа аялал - 5 өдөр 4 шөнө",
    adult_price: 1120000,
    child_price: 1105000,
    extra: { price_groups: [{ adult_price: 1100000, child_price: 1080000, display_dates: ["8 сарын 24"] }] },
  });
  const reply = buildBudgetReply("хамгийн хямд аялал", [cheaper], NOW) || "";
  assert.match(reply, /том хүн 1,120,000/);
  assert.match(reply, /хүүхэд 1,105,000/);
  assert.doesNotMatch(reply, /1,100,000/);
  assert.doesNotMatch(reply, /8 сарын 24|8\/24/);
});

test("cheapest list pairs a date-group fare with that group's own child price and dates", () => {
  // The cheaper tier is bookable (8 сарын 14), so it may be quoted — but only
  // alongside its own child fare and its own date, never the full date list.
  const grouped = trip({
    id: "beta5",
    route_name: "Бета аялал - 5 өдөр 4 шөнө",
    adult_price: 1180000,
    child_price: 1140000,
    extra: { price_groups: [{ adult_price: 1160000, child_price: 1130000, display_dates: ["8 сарын 14"] }] },
  });
  const reply = buildBudgetReply("хамгийн хямд аялал", [grouped], NOW) || "";
  assert.match(reply, /том хүн 1,160,000/);
  // the group's child fare, not the trip's base child fare
  assert.match(reply, /хүүхэд 1,130,000/);
  assert.doesNotMatch(reply, /1,140,000/);
  // 8 сарын 7 sells at the higher base fare and must not sit under this price
  assert.doesNotMatch(reply, /8\/7|8 сарын 7/);
});

// ---- Malformed infant-only price group backfills adult/child from base ----

test("getStructuredPriceGroups backfills adult/child on an infant-only group", () => {
  const t = trip({
    adult_price: 1110000,
    child_price: 1100000,
    extra: { price_groups: [{ adult_price: null, child_price: null, infant_price: 1020000 }] },
  });
  const groups = getStructuredPriceGroups(t);
  assert.equal(groups[0].adult_price, 1110000);
  assert.equal(groups[0].child_price, 1100000);
  assert.equal(groups[0].infant_price, 1020000);
});

test("well-formed price groups are left untouched", () => {
  const t = trip({
    extra: { price_groups: [{ adult_price: 1450000, child_price: 1380000, infant_price: null }] },
  });
  const groups = getStructuredPriceGroups(t);
  assert.equal(groups[0].adult_price, 1450000);
  assert.equal(groups[0].child_price, 1380000);
});
