import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTripOffers, renderTripOfferReply, resolveTripOffer, resolveTripOfferFareCard, summarizeTripOfferPrices, type ResolvedTripOffer, type TripOfferSelection } from "../src/lib/tripOffers";
import { evaluateTripRequirement, isTripOfferPrice, quotablePrices, tripTransport } from "../src/lib/tripFacts";
import type { TravelTrip } from "../src/lib/travelTypes";

const NOW = new Date("2026-10-02T04:00:00Z");
function trip(fields: Partial<TravelTrip> = {}): TravelTrip {
  return { id: "test", category: "", operator_name: "Uudam", route_name: "Test trip", duration_text: "7 days",
    adult_price: 3_000_000, child_price: 2_000_000, infant_price: null, currency: "MNT",
    departure_dates: ["2026-10-08"], seats_total: null, seats_left: null, has_food: null,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {}, created_at: "", updated_at: "", ...fields };
}
function ready(value: TravelTrip, selection: TripOfferSelection = {}): ResolvedTripOffer {
  const result = resolveTripOffer(value, selection, NOW);
  assert.equal(result.status, "ready", JSON.stringify(result));
  if (result.status !== "ready") throw new Error("Expected ready");
  return result.offer;
}

test("passenger categories retain their own prices; swapped adult/child claims fail", () => {
  const value = trip();
  const offer = ready(value, { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] });
  assert.deepEqual(offer.prices.adult, { kind: "exact", amount: 3_000_000 });
  assert.deepEqual(offer.prices.child, { kind: "exact", amount: 2_000_000 });
  assert.deepEqual(offer.total, { kind: "exact", amount: 8_000_000 });
  assert.equal(isTripOfferPrice(value, {}, "adult", 2_000_000, NOW), false);
  assert.equal(isTripOfferPrice(value, {}, "child", 3_000_000, NOW), false);
  assert.equal(isTripOfferPrice(value, {}, "child", 2_000_000, NOW), true);
});

test("explicit departure year survives month/day date keys and distinguishes next year", () => {
  const value = trip({ departure_dates: ["2026-10-08", "2027-10-08"], extra: { price_groups: [
    { dates: ["2026-10-08"], date_keys: ["10-08"], adult_price: 4_000_000 },
    { dates: ["2027-10-08"], date_keys: ["10-08"], adult_price: 5_000_000 },
  ] } });
  const normalized = normalizeTripOffers(value, NOW);
  assert.deepEqual(normalized[1].dates, ["2026-10-08"]);
  assert.deepEqual(normalized[2].dates, ["2027-10-08"]);
  assert.deepEqual(ready(value, { date: "2027-10-08" }).prices.adult, { kind: "exact", amount: 5_000_000 });
  assert.equal(resolveTripOffer(value, { date: "10-08" }, NOW).status, "needs_selection");
  assert.equal(quotablePrices(value, "2027-10-08", NOW).has(4_000_000), false);
  assert.equal(resolveTripOffer(value, { date: "2028-10-08" }, NOW).status, "unavailable");
});

test("frozen catalog year grounds yearless group dates without drifting after New Year", () => {
  const value = trip({ departure_dates: ["1 сарын 4"], extra: {
    departure_dates_resolved: [{ text: "1 сарын 4", ymd: "2027-01-04" }],
    price_groups: [{ dates: ["1 сарын 04"], adult_price: 4_000_000 }],
  } });
  assert.deepEqual(normalizeTripOffers(value, NOW)[1].dates, ["2027-01-04"]);
  assert.deepEqual(ready(value, { date: "2027-01-04" }).prices.adult, { kind: "exact", amount: 4_000_000 });
  assert.equal(resolveTripOffer(value, {}, new Date("2028-01-01")).status, "unavailable");
});

test("a yearless group cannot silently attach to two different seasons", () => {
  const value = trip({ departure_dates: ["2026-10-08", "2027-10-08"], extra: {
    price_groups: [{ dates: ["10-08"], adult_price: 4_000_000 }],
  } });
  assert.equal(resolveTripOffer(value, { date: "2027-10-08" }, NOW).status, "conflict");
});

test("hotel and package ambiguity require selection and do not mix child fares", () => {
  const value = trip({ child_price: null, extra: { price_groups: [
    { id: "a", hotel_id: "hotel-a", hotel: "Hotel A", package_id: "standard", dates: ["2026-10-08"], adult_price: 4_000_000, child_price: 2_500_000 },
    { id: "b", hotel_id: "hotel-b", hotel: "Hotel B", package_id: "premium", dates: ["2026-10-08"], adult_price: 5_000_000, child_price: 3_500_000 },
  ] } });
  const ambiguous = resolveTripOffer(value, {}, NOW);
  assert.equal(ambiguous.status, "needs_selection");
  if (ambiguous.status === "needs_selection") assert.deepEqual(ambiguous.fields, ["hotel"]);
  if (ambiguous.status === "needs_selection") assert.deepEqual(ambiguous.options, ["Hotel A", "Hotel B"]);
  const offer = ready(value, { hotel: "Hotel B", package: "premium", passengers: [{ kind: "child", count: 1 }] });
  assert.equal(offer.hotelId, "hotel-b");
  assert.equal(offer.packageId, "premium");
  assert.deepEqual(offer.total, { kind: "exact", amount: 3_500_000 });
  assert.equal(resolveTripOffer(value, { hotel: "Other hotel" }, NOW).status, "unavailable");
  assert.deepEqual(ready(value, { hotelId: "hotel-a" }).prices.adult, { kind: "exact", amount: 4_000_000 });
  assert.deepEqual(ready(value, { hotel: "hotel-a" }).prices.adult, { kind: "exact", amount: 4_000_000 });
});

test("package selection narrows two packages at the same hotel", () => {
  const value = trip({ extra: { price_groups: [
    { hotel: "Hotel A", package_id: "one", adult_price: 4_000_000 },
    { hotel: "Hotel A", package_id: "two", adult_price: 5_000_000 },
  ] } });
  const ambiguous = resolveTripOffer(value, { hotel: "Hotel A" }, NOW);
  assert.equal(ambiguous.status, "needs_selection");
  if (ambiguous.status === "needs_selection") assert.deepEqual(ambiguous.fields, ["package"]);
  assert.deepEqual(ready(value, { package: "two" }).prices.adult, { kind: "exact", amount: 5_000_000 });
});

test("stored ages classify months and completed years exactly at boundaries", () => {
  const value = trip({ infant_price: 500_000, extra: { age_rules: { infant: "0-23 сар", child: "2-11 нас", adult: "12+ нас" } } });
  const month = (age: number) => ready(value, { passengers: [{ kind: "child", age, ageUnit: "month", count: 1 }] });
  assert.equal(month(23).passengerPrices[0].kind, "infant");
  assert.equal(month(24).passengerPrices[0].kind, "child");
  assert.equal(month(143).passengerPrices[0].kind, "child");
  assert.equal(month(144).passengerPrices[0].kind, "adult");
  assert.equal(ready(value, { passengers: [{ kind: "child", age: 12, count: 1 }] }).passengerPrices[0].kind, "adult");
});

test("overlapping infant/child bands fail safe at the shared age boundary", () => {
  const value = trip({ infant_price: 500_000, extra: { age_rules: { infant: "0-2 нас", child: "2-11 нас", adult: "12+ нас" } } });
  assert.equal(resolveTripOffer(value, { passengers: [{ kind: "child", age: 2, count: 1 }] }, NOW).status, "conflict");
});

test("passenger bands override derived flat fields and stale trip child rules", () => {
  const value = trip({ extra: { child_rules: [{ label: "child", age_range: "2-11 years", price: 9_000_000 }], price_groups: [
    { adult_price: 4_000_000, child_price: 1_000_000, passenger_prices: [
      { label: "child", age_range: "2-5 years", price: 1_500_000 },
      { label: "child", age_range: "6-11 years", price: 2_500_000 },
    ] },
  ] } });
  assert.deepEqual(ready(value, { passengers: [{ kind: "child", age: 6, count: 1 }] }).total, { kind: "exact", amount: 2_500_000 });
  assert.equal(resolveTripOffer(value, { passengers: [{ kind: "child", count: 1 }] }, NOW).status, "needs_selection");
  assert.equal(quotablePrices(value, "2026-10-08", NOW).has(9_000_000), false);
});

test("birth-year tiers require an exact birth year instead of guessing from age", () => {
  const value = trip({ child_price: null, extra: { price_groups: [{ passenger_prices: [
    { label: "child", age_range: "2015-2022 он", price: 1_500_000 },
  ] }] } });
  assert.equal(resolveTripOffer(value, { passengers: [{ kind: "child", age: 5, count: 1 }] }, NOW).status, "needs_selection");
  assert.equal(resolveTripOffer(value, { passengers: [{ kind: "child", count: 1 }] }, NOW).status, "needs_selection");
  assert.deepEqual(ready(value, { passengers: [{ kind: "child", birthYear: 2021, count: 1 }] }).total, { kind: "exact", amount: 1_500_000 });
});

test("free is explicit; zero, placeholders, and unknown passenger prices remain missing", () => {
  const missing = trip({ infant_price: 0 });
  assert.equal(resolveTripOffer(missing, { passengers: [{ kind: "infant", count: 1 }] }, NOW).status, "missing");
  const free = trip({ infant_price: 0, extra: { child_rules: [{ label: "infant", age_range: "0-23 months", price: 0, note: "free" }] } });
  assert.deepEqual(ready(free, { passengers: [{ kind: "infant", count: 1 }] }).total, { kind: "free", amount: 0 });
  assert.deepEqual(ready(free).prices.infant, { kind: "free", amount: 0 });
  assert.equal(resolveTripOffer(trip({ adult_price: 1, child_price: null }), {}, NOW).status, "missing");
  const explicitUnknown = trip({ extra: { price_groups: [{ passenger_prices: [{ label: "child", age_range: "2-11 years", price: null }] }] } });
  assert.equal(resolveTripOffer(explicitUnknown, { passengers: [{ kind: "child", age: 6, count: 1 }] }, NOW).status, "missing");
});

test("modern groups beat legacy/base summaries; equal authority contradictions block", () => {
  const value = trip({ extra: {
    departure_date_groups: [{ dates: ["2026-10-08"], adult_price: 4_000_000 }],
    price_groups: [{ dates: ["2026-10-08"], adult_price: 5_000_000 }],
  } });
  assert.deepEqual(ready(value).prices.adult, { kind: "exact", amount: 5_000_000 });
  const conflict = trip({ extra: { price_groups: [{ adult_price: 4_000_000 }, { adult_price: 5_000_000 }] } });
  assert.equal(resolveTripOffer(conflict, {}, NOW).status, "conflict");
  assert.equal(renderTripOfferReply(resolveTripOffer(conflict, {}, NOW)), null);
});

test("ranges stay ranges through passenger totals and rendering", () => {
  const value = trip({ extra: { adult_price_range: { min: 3_000_000, max: 4_000_000 } } });
  const result = resolveTripOffer(value, { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }, NOW);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.deepEqual(result.offer.total, { kind: "range", min: 8_000_000, max: 10_000_000 });
  assert.match(renderTripOfferReply(result) || "", /8,000,000.*10,000,000/);
  assert.equal(isTripOfferPrice(value, {}, "adult", 3_500_000, NOW), true);
  assert.equal(resolveTripOffer(trip({ extra: { adult_price_range: { min: 5_000_000, max: 4_000_000 } } }), {}, NOW).status, "conflict");
});

test("conditional discounts need recorded conditions; expiry is inclusive in Mongolia", () => {
  const value = trip({ extra: { discounts: [
    { id: "early", adult_price: 2_500_000, condition: "Pay before deadline", valid_until: "2026-10-02" },
  ] } });
  assert.deepEqual(ready(value).prices.adult, { kind: "exact", amount: 3_000_000 });
  assert.equal(resolveTripOffer(value, { discountId: "early" }, NOW).status, "needs_selection");
  assert.deepEqual(ready(value, { discountId: "early", confirmedDiscountConditions: ["Pay before deadline"] }).prices.adult, { kind: "exact", amount: 2_500_000 });
  assert.equal(resolveTripOffer(value, { discountId: "early" }, new Date("2026-10-02T16:01:00Z")).status, "unavailable");
  const automatic = trip({ extra: { discounts: [{ adult_price: 2_500_000, expires_at: "2026-10-02T05:00:00Z" }] } });
  assert.deepEqual(ready(automatic).prices.adult, { kind: "exact", amount: 2_500_000 });
  const expired = resolveTripOffer(automatic, {}, new Date("2026-10-02T06:00:00Z"));
  assert.equal(expired.status, "ready");
  if (expired.status === "ready") assert.deepEqual(expired.offer.prices.adult, { kind: "exact", amount: 3_000_000 });
});

test("closed availability remains scheduled, is not bookable, and preserves display fares", () => {
  const value = trip({ departure_dates: ["2026-10-15"], seats_left: 0, extra: {
    website_departure_availability: [{ date: "2026-10-08", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2026-10-15", status: "OPEN", seatsLeft: 8 }],
    price_groups: [{ dates: ["2026-10-08"], adult_price: 4_000_000 }, { dates: ["2026-10-15"], adult_price: 5_000_000 }],
  } });
  const closed = resolveTripOffer(value, { date: "2026-10-08" }, NOW);
  assert.equal(closed.status, "unavailable");
  if (closed.status === "unavailable") assert.equal(closed.reason, "sold_out");
  assert.equal(evaluateTripRequirement(value, { kind: "date", date: "2026-10-08" }, NOW), "match");
  assert.equal(evaluateTripRequirement(value, { kind: "date", date: "2027-10-08" }, NOW), "contradiction");
  assert.equal(ready(value, { date: "2026-10-15" }).availability.seatsLeft, 8);
  const display = resolveTripOfferFareCard(value, { date: "2026-10-08" }, NOW);
  assert.equal(display.status, "ready");
  if (display.status === "ready") {
    assert.equal(display.offer.availability.status, "sold_out");
    assert.deepEqual(display.offer.prices.adult, { kind: "exact", amount: 4_000_000 });
  }
  assert.equal(resolveTripOffer(value, { date: "2026-10-15", passengers: [{ kind: "adult", count: 9 }] }, NOW).status, "unavailable");
});

test("trip closure and conflicting departure rows fail safe", () => {
  assert.equal(resolveTripOffer(trip({ status: "paused" }), {}, NOW).status, "unavailable");
  const value = trip({ extra: { website_departure_availability: [
    { date: "2026-10-08", status: "OPEN", seatsLeft: 10 },
    { date: "2026-10-08", status: "SOLD_OUT", seatsLeft: 0 },
  ] } });
  assert.equal(resolveTripOffer(value, {}, NOW).status, "conflict");
});

test("invalid passenger selections, dates, and absent schedules return missing", () => {
  for (const count of [0, -1, 1.5, NaN]) assert.equal(resolveTripOffer(trip(), { passengers: [{ kind: "adult", count }] }, NOW).status, "missing");
  assert.equal(resolveTripOffer(trip(), { date: "2026-02-30" }, NOW).status, "missing");
  assert.equal(resolveTripOffer(trip({ departure_dates: [] }), {}, NOW).status, "missing");
  assert.equal(resolveTripOffer(trip(), { tripId: "another" }, NOW).status, "missing");
});

test("structured transport wins over contradictory description text", () => {
  for (const transport of ["direct_flight", "land", "land_flight", "cruise"] as const) {
    assert.equal(tripTransport(trip({ source_description: "газрын аялал шууд нислэг", extra: { transport_type: transport } })), transport);
  }
});

test("an explicit adult category can quote an unbanded fare without inventing default ages", () => {
  const offer = ready(trip(), { passengers: [{ kind: "adult", age: 16, count: 1 }] });
  assert.equal(offer.passengerPrices[0].kind, "adult");
  assert.equal(offer.passengerPrices[0].ageRange, null);
  assert.deepEqual(offer.total, { kind: "exact", amount: 3_000_000 });
});

test("normalization is immutable and keeps scoped identity, currency, and unknowns", () => {
  const value = trip({ currency: "USD", adult_price: 100, child_price: null, extra: { price_groups: [{
    id: "usd", hotel_id: "h", hotel: "Hotel", package_id: "p", dates: ["2026-10-08"], adult_price: 120,
    passenger_prices: [{ label: "infant", price: 0 }],
  }] } });
  const before = JSON.stringify(value);
  const normalized = normalizeTripOffers(value, NOW);
  assert.equal(JSON.stringify(value), before);
  assert.equal(normalized[1].id, "usd");
  assert.equal(normalized[1].hotelId, "h");
  assert.equal(normalized[1].packageId, "p");
  assert.equal(normalized[1].fares.find((f) => f.kind === "infant")?.fare.kind, "unknown");
  assert.deepEqual(ready(value).prices.adult, { kind: "exact", amount: 120 });
});

test("identical fares across future dates have an overview without selected date, seats, or totals", () => {
  const value = trip({ departure_dates: ["2026-10-08", "2026-10-15"], extra: {
    price_groups: [{ dates: ["2026-10-08"], adult_price: 4_000_000 }, { dates: ["2026-10-15"], adult_price: 4_000_000 }],
    website_departure_availability: [{ date: "2026-10-08", status: "SOLD_OUT", seatsLeft: 0 }, { date: "2026-10-15", status: "OPEN", seatsLeft: 10 }],
  } });
  assert.equal(resolveTripOffer(value, {}, NOW).status, "needs_selection");
  const overview = summarizeTripOfferPrices(value, {}, NOW);
  assert.equal(overview.status, "ready");
  if (overview.status === "ready") {
    assert.deepEqual(overview.summary.dates, ["2026-10-08", "2026-10-15"]);
    assert.deepEqual(overview.summary.prices.adult, { kind: "exact", amount: 4_000_000 });
    for (const field of ["date", "availability", "total", "passengerPrices"]) assert.equal(field in overview.summary, false);
    assert.ok(overview.summary.sourceOfferIds.length > 1);
  }
});

test("an undated overview does not combine different date fares, hotels, or age bands", () => {
  const value = trip({ departure_dates: ["2026-10-08", "2026-10-15"], extra: { price_groups: [
    { dates: ["2026-10-08"], adult_price: 4_000_000 }, { dates: ["2026-10-15"], adult_price: 5_000_000 },
  ] } });
  assert.equal(summarizeTripOfferPrices(value, {}, NOW).status, "needs_selection");
  const changedBand = trip({ departure_dates: value.departure_dates, extra: { price_groups: [
    { dates: ["2026-10-08"], passenger_prices: [{ label: "child", age_range: "2-11 years", price: 2_000_000 }] },
    { dates: ["2026-10-15"], passenger_prices: [{ label: "child", age_range: "2-6 years", price: 2_000_000 }] },
  ] } });
  assert.equal(summarizeTripOfferPrices(changedBand, {}, NOW).status, "needs_selection");
  const hotels = trip({ extra: { price_groups: [{ hotel: "Alpha", adult_price: 4_000_000 }, { hotel: "Beta", adult_price: 4_000_000 }] } });
  const unresolved = summarizeTripOfferPrices(hotels, {}, NOW);
  assert.equal(unresolved.status, "needs_selection");
  if (unresolved.status === "needs_selection") assert.deepEqual(unresolved.fields, ["hotel"]);
  assert.equal(summarizeTripOfferPrices(hotels, { hotel: "Alpha" }, NOW).status, "ready");
});
