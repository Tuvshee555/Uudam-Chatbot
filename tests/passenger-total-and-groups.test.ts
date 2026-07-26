import assert from "node:assert/strict";
import test from "node:test";
import { buildStructuredTripReply, buildBudgetReply } from "../src/lib/travelFastPaths";
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

// ---- Cheapest list must not pair a discounted adult with a base-price child ----

test("cheapest list omits child when the shown adult is a lower date-group price", () => {
  // Base adult 1,120,000 but a date group drops to 1,100,000; base child is 1,100,000.
  const hailaar = trip({
    id: "hailaar5",
    route_name: "Хайлаар Манжуурын аялал - 5 өдөр 4 шөнө",
    adult_price: 1120000,
    child_price: 1100000,
    extra: { price_groups: [{ adult_price: 1100000, child_price: 1100000, display_dates: ["8 сарын 24"] }] },
  });
  const reply = buildBudgetReply("хамгийн хямд аялал", [hailaar], NOW) || "";
  assert.match(reply, /1,100,000/); // cheapest adult surfaces
  // must NOT show the mismatched base child (1,100,000) as this trip's child line
  assert.doesNotMatch(reply, /хүүхэд 1,100,000/);
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
