import assert from "node:assert/strict";
import test from "node:test";
import { adultFareOnDate, buildAmbiguousTripReply } from "../src/lib/travelFastPathsPricing";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { TravelTrip } from "../src/lib/travelTypes";

// Relative to the real clock: the list only shows future departures.
const isoInDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const [soon, later, latest] = [isoInDays(20), isoInDays(27), isoInDays(34)];
const customerDate = (iso: string) => `${Number(iso.slice(5, 7))} сарын ${Number(iso.slice(8, 10))}`;

function trip(id: string, fields: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id, category: "Аялал", operator_name: "", route_name: `Туршилтын аялал ${id}`, duration_text: "6 өдөр 5 шөнө",
    adult_price: 1_000_000, child_price: 800_000, infant_price: null, currency: "MNT", departure_dates: [soon, later, latest],
    seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: { age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" } },
    created_at: "", updated_at: "", ...fields,
  };
}

const pricedPerDate = trip("A", { extra: {
  age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" },
  price_groups: [
    { dates: [soon], adult_price: 1_100_000, child_price: 900_000 },
    { dates: [later, latest], adult_price: 1_000_000, child_price: 800_000 },
  ],
} });

test("a 'which trip?' line quotes the listed departure's own fare, not the trip's base price", () => {
  const reply = buildAmbiguousTripReply([pricedPerDate, trip("B")]);
  const line = reply.split("\n").find((entry) => entry.includes("Туршилтын аялал A"))!;
  assert.match(line, /том хүн 1,100,000₮ · хүүхэд 900,000₮/);
  assert.match(line, new RegExp(`гарах: ${customerDate(soon)}$`));
  assert.doesNotMatch(line, /1,000,000₮/);
});

test("the reply verifier lets that question through instead of silencing the customer", () => {
  const reply = buildAmbiguousTripReply([pricedPerDate, trip("B")]);
  assert.notEqual(verifyTripReply({ reply, trips: [pricedPerDate, trip("B")] }), "REFER");
});

test("departures selling at the same fare are listed together", () => {
  const line = buildAmbiguousTripReply([trip("B")]).split("\n")[1];
  assert.match(line, new RegExp(`гарах: ${customerDate(soon)}, ${customerDate(later)}, ${customerDate(latest)}$`));
});

test("a date written as '<month> сарын <day>' beside a child fare is not read as a child's age", () => {
  const plain = trip("B");
  const reply = `Туршилтын аялал B — хүүхэд 800,000₮ · гарах: ${customerDate(soon)}`;
  assert.equal(verifyTripReply({ reply, trips: [plain] }), reply);
});

test("a departure's adult fare comes from that date's offer, and two hotel prices give no single fare", () => {
  assert.equal(adultFareOnDate(pricedPerDate, soon), 1_100_000);
  assert.equal(adultFareOnDate(pricedPerDate, later), 1_000_000);
  const twoHotels = trip("C", { extra: {
    age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" },
    price_groups: [
      { dates: [soon], hotel: "Зочид буудал 1", adult_price: 1_200_000 },
      { dates: [soon], hotel: "Зочид буудал 2", adult_price: 1_400_000 },
    ],
  } });
  assert.equal(adultFareOnDate(twoHotels, soon), null);
});

test("a price without a hotel is true on a date sold at several hotel prices when one hotel sells at it", () => {
  const twoHotels = trip("D", { extra: {
    age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-1 нас" },
    price_groups: [
      { dates: [soon], hotel: "Зочид буудал 1", adult_price: 1_200_000 },
      { dates: [soon], hotel: "Зочид буудал 2", adult_price: 1_400_000 },
    ],
  } });
  const real = `Туршилтын аялал D — том хүн 1,200,000₮ · гарах: ${customerDate(soon)}`;
  assert.equal(verifyTripReply({ reply: real, trips: [twoHotels] }), real);
  assert.equal(verifyTripReply({ reply: `Туршилтын аялал D — том хүн 1,300,000₮ · гарах: ${customerDate(soon)}`, trips: [twoHotels] }), "REFER");
});
