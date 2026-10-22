import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTripOffers, resolveTripOffer, summarizeTripOfferPrices } from "../src/lib/tripOffers";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { verifyTripReply } from "../src/lib/tripReplyVerification";
import type { TravelTrip } from "../src/lib/travelTypes";

const NOW = new Date("2098-02-01T04:00:00Z");
function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return { id: "velmor", route_name: "Вэлмор аялал", category: "", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 1_700_000, child_price: 1_300_000, infant_price: null, currency: "MNT", departure_dates: ["2098-03-17"],
    seats_total: 20, seats_left: 8, has_food: null, status: "active", notes: "", hotel: "Hotel Velmor", source_description: "", photo_urls: [],
    extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" } }, created_at: "", updated_at: "", ...fields };
}

test("the known accommodation can be stated explicitly without inventing selectable hotel packages", () => {
  const value = trip();
  assert.ok(normalizeTripOffers(value, NOW).every(offer => offer.hotel === null && offer.hotelId === null));
  const result = resolveTripOffer(value, { hotel: "  hotel velmor  " }, NOW);
  assert.equal(result.status, "ready");
  if (result.status !== "ready") return;
  assert.equal(result.offer.hotel, value.hotel);
  assert.deepEqual(result.offer.prices.adult, { kind: "exact", amount: 1_700_000 });
  assert.equal(resolveTripOffer(value, { hotel: "Hotel Nerith" }, NOW).status, "unavailable");
  assert.equal(resolveTripOffer(value, { hotelId: "invented-hotel-id", hotel: value.hotel }, NOW).status, "unavailable");
});

test("accommodation metadata preserves date selection and differing dated fares", () => {
  const value = trip({ departure_dates: ["2098-03-17", "2098-03-24"], extra: { price_groups: [
    { dates: ["2098-03-17"], adult_price: 1_700_000 }, { dates: ["2098-03-24"], adult_price: 1_900_000 },
  ] } });
  assert.equal(resolveTripOffer(value, { hotel: value.hotel }, NOW).status, "needs_selection");
  const result = resolveTripOffer(value, { date: "2098-03-24", hotel: value.hotel }, NOW);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.offer.prices.adult, { kind: "exact", amount: 1_900_000 });
  assert.equal(summarizeTripOfferPrices(value, { hotel: value.hotel }, NOW).status, "needs_selection");
});

test("structured hotel choices remain authoritative over trip accommodation text", () => {
  const value = trip({ extra: { price_groups: [
    { dates: ["2098-03-17"], hotel: "Hotel Nerith", adult_price: 1_900_000 },
    { dates: ["2098-03-17"], hotel: "Hotel Telun", adult_price: 2_100_000 },
  ] } });
  assert.equal(resolveTripOffer(value, { hotel: value.hotel }, NOW).status, "unavailable");
  assert.equal(resolveTripOffer(value, {}, NOW).status, "needs_selection");
  const selected = resolveTripOffer(value, { hotel: "Hotel Nerith" }, NOW);
  assert.equal(selected.status, "ready");
  if (selected.status === "ready") assert.deepEqual(selected.offer.prices.adult, { kind: "exact", amount: 1_900_000 });
});

test("a party request naming known accommodation gets the source-grounded total", () => {
  const value = trip();
  const result = buildTripAnswerPlan({ text: "Вэлмор аялал Hotel Velmor 2 том хүн 1 хүүхэд 6 настай нийт үнэ хэд вэ",
    trips: [value], route: { matchText: "", scopedClarify: null, chosenTripId: value.id }, now: NOW })!;
  assert.equal(result.status, "answered");
  assert.match(result.reply, /Hotel Velmor/);
  assert.match(result.reply, /Нийт: 4,700,000₮/);
  assert.deepEqual(result.missingFacts, []);
  assert.equal(verifyTripReply({ reply: result.reply, trips: [value], selection: result.selection, now: NOW }), result.reply);
});
