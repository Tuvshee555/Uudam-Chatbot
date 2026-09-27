/**
 * The price/data verifier added after the 2026-09-27 check: every ₮ amount in
 * an AI reply must be a real, quotable price on the trip(s) the turn actually
 * resolved to. Code-only check, no second model — see project memory for why.
 * Trip names and prices here are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TravelTrip } from "../src/lib/travelOps";
import { guardUnverifiedPrices } from "../src/lib/reply";

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t1",
    category: "Аялал",
    operator_name: "Test",
    route_name: "Альфа аялал",
    duration_text: "8 өдөр 7 шөнө",
    adult_price: 1111111,
    child_price: 999999,
    infant_price: null,
    currency: "MNT",
    departure_dates: ["12 сарын 8"],
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

test("a real base fare passes untouched", () => {
  const t = trip({});
  const reply = "Альфа аялал: том хүн 1,111,111₮, хүүхэд 999,999₮.";
  assert.equal(guardUnverifiedPrices(reply, [t]), reply);
});

test("a price that matches no trip's data becomes REFER", () => {
  const t = trip({});
  const reply = "Альфа аялал: том хүн 2,500,000₮.";
  assert.equal(guardUnverifiedPrices(reply, [t]), "REFER");
});

test("a price-group fare for a DIFFERENT date than base is still confirmed", () => {
  // This is the exact live bug: base fare 3,390,000 but the 10/8 departure is
  // priced 3,490,000 in a price group. The reply quoting the group price must
  // pass, not be treated as invented just because it isn't the base fare.
  const t = trip({
    adult_price: 3390000,
    extra: {
      price_groups: [
        { dates: ["10 сарын 15"], adult_price: 3390000 },
        { dates: ["10 сарын 8"], adult_price: 3490000 },
      ],
    },
  });
  const reply = "Улаанбаатар – Альфа аялал 10 сарын 8-нд: том хүн 3,490,000₮.";
  assert.equal(guardUnverifiedPrices(reply, [t]), reply);
});

test("a base fare quoted for a date priced differently is still allowed through this guard alone", () => {
  // This guard only confirms the amount is SOME real price on the trip — it
  // cannot know which date the sentence is about. That's why adultFareOnDate
  // (the date-formatting fix) is the real fix for date-specific answers; this
  // guard is the backstop for amounts that are not real at all.
  const t = trip({
    adult_price: 3390000,
    extra: { price_groups: [{ dates: ["10 сарын 8"], adult_price: 3490000 }] },
  });
  const reply = "10 сарын 8-нд: том хүн 3,390,000₮.";
  assert.equal(guardUnverifiedPrices(reply, [t]), reply);
});

test("a fully invented amount with no resolved trip is left alone (nothing to verify against)", () => {
  const reply = "Манай аяллуудын үнэ дунджаар 2,000,000₮ орчим байдаг.";
  assert.equal(guardUnverifiedPrices(reply, []), reply);
});

test("a reply with no ₮ amount at all is never touched", () => {
  const t = trip({});
  const reply = "Тийм ээ, энэ аялал 8 өдөр 7 шөнө үргэлжилнэ.";
  assert.equal(guardUnverifiedPrices(reply, [t]), reply);
});

test("child/infant rule tiers and legacy departure_date_groups fares are all quotable", () => {
  const t = trip({
    adult_price: 1111111,
    child_price: null,
    infant_price: null,
    extra: {
      child_rules: [{ label: "2014-2015 он", price: 888888 }],
      departure_date_groups: [{ dates: ["12 сарын 8"], infant_price: 222222 }],
    },
  });
  const reply = "Том хүн 1,111,111₮, хүүхэд 888,888₮, нярай 222,222₮.";
  assert.equal(guardUnverifiedPrices(reply, [t]), reply);
});

test("a placeholder sub-1,000₮ figure never counts as a quotable price to match against", () => {
  const t = trip({ infant_price: 1 });
  // Even if the model somehow echoed "1₮", a real amount elsewhere must still
  // be checked against genuine fares only — the placeholder must not silently
  // legitimize other made-up numbers.
  const reply = "Том хүн 1,111,111₮, нярай 500,000₮.";
  assert.equal(guardUnverifiedPrices(reply, [t]), "REFER");
});

test("amounts in different real-world formats are all recognised", () => {
  const t = trip({ adult_price: 3490000 });
  for (const formatted of ["3,490,000₮", "3.490.000₮", "3490000 төгрөг", "3,490,000 MNT"]) {
    assert.equal(guardUnverifiedPrices(`Үнэ: ${formatted}.`, [t]), `Үнэ: ${formatted}.`, formatted);
  }
});

test("multiple candidate trips (an ambiguous list) can each supply the confirmed price", () => {
  const a = trip({ id: "a", route_name: "Альфа аялал", adult_price: 1000000 });
  const b = trip({ id: "b", route_name: "Бета аялал", adult_price: 2000000 });
  const reply = "Альфа аялал 1,000,000₮, Бета аялал 2,000,000₮.";
  assert.equal(guardUnverifiedPrices(reply, [a, b]), reply);
});
