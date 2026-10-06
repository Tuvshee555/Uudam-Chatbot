import assert from "node:assert/strict";
import test from "node:test";
import { websiteDepartureSchedule, websiteDepartures, websiteExtraDetails } from "../src/lib/connectedTripMapping";
import { websiteAvailabilityForResync, websiteTripPayload } from "../src/lib/websiteTripPayload";
import type { TravelTrip } from "../src/lib/travelTypes";
import { withBookableDepartureDates } from "../src/lib/departureAvailability";

const now = new Date("2026-09-01T00:00:00Z");
const trip: TravelTrip = {
  id: "website", category: "", operator_name: "Uudam", route_name: "Trip",
  duration_text: "3 өдөр 2 шөнө", adult_price: 9_000_000, child_price: 8_000_000,
  infant_price: null, currency: "MNT", departure_dates: ["2026-10-01"],
  seats_total: 20, seats_left: 8, has_food: null, status: "active", notes: "", hotel: "",
  source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "",
};
const payload = (source: TravelTrip) => websiteTripPayload(source, websiteDepartureSchedule(source, now), now);

test("unknown seats keep website departures bookable while preserving prices and canonical unknown availability", () => {
  const projected = payload({ ...trip, seats_left: null });
  assert.equal(projected.departures[0].status, "OPEN");
  assert.equal(projected.departures[0].seatsLeft, null);
  assert.equal(projected.departures[0].price, trip.adult_price);
  const card = projected.canonicalOffers.entries[0].fareCard;
  assert.equal(card.status, "ready");
  if (card.status === "ready") assert.deepEqual(card.offer.availability, { status: "unknown", seatsLeft: null });
  assert.equal(projected.priceGroups[0].availability.status, "unknown");
});

test("an explicit OPEN departure confirms booking status without inventing a seat count", () => {
  const projected = payload({ ...trip, seats_left: null, extra: {
    website_departure_availability: [{ date: "2026-10-01", status: "OPEN", seatsLeft: null }],
  } });
  assert.equal(projected.departures[0].status, "OPEN");
  assert.equal(projected.departures[0].seatsLeft, null);
  assert.equal(projected.priceGroups[0].availability.status, "open");
  assert.equal(payload(trip).departures[0].status, "OPEN");
});

test("resync retains unknown availability and can reopen an automatic pause when seats become known", () => {
  const initial = payload({ ...trip, seats_left: null });
  // Projections stored before unknown seats became bookable recorded the pause.
  const legacy = { ...initial.canonicalOffers, departures: (initial.canonicalOffers.departures as Array<Record<string, unknown>>)
    .map((departure) => ({ ...departure, status: "PAUSED" })) };
  const row = { date: "2026-10-01", status: "PAUSED", seatsLeft: null };
  assert.deepEqual(websiteAvailabilityForResync(row, initial.canonicalOffers), row);
  const restored = websiteAvailabilityForResync(row, legacy);
  assert.equal(restored.status, "UNKNOWN");
  const customerTrip = withBookableDepartureDates({ ...trip, seats_left: null, extra: { website_departure_availability: [restored] } }, now);
  assert.equal(customerTrip.status, "active");
  assert.deepEqual(customerTrip.departure_dates, ["2026-10-01"]);
  const unchanged = payload({ ...trip, seats_left: null, extra: { website_departure_availability: [restored] } });
  assert.equal(unchanged.departures[0].status, "OPEN");
  assert.equal(unchanged.priceGroups[0].availability.status, "unknown");
  const confirmed = payload({ ...trip, extra: { website_departure_availability: [{ ...restored, seatsLeft: 8 }] } });
  assert.equal(confirmed.departures[0].status, "OPEN");
  assert.deepEqual(websiteAvailabilityForResync({ ...row, status: "SOLD_OUT", seatsLeft: 0 }, initial.canonicalOffers), {
    ...row, status: "SOLD_OUT", seatsLeft: 0,
  });
  assert.deepEqual(websiteAvailabilityForResync(row, undefined), row);
  const staffPaused = payload({ ...trip, status: "paused", seats_left: null });
  assert.deepEqual(websiteAvailabilityForResync(row, staffPaused.canonicalOffers), row);
});

test("website canonical prices keep the full departure year", () => {
  const projected = payload({ ...trip, departure_dates: ["2026-10-01", "2027-10-01"], extra: {
    price_groups: [
      { dates: ["2026-10-01"], adult_price: 2_000_000, child_price: 1_500_000 },
      { dates: ["2027-10-01"], adult_price: 3_000_000, child_price: 2_500_000 },
    ],
  } });
  assert.deepEqual(projected.departures.map(departure => [departure.start.slice(0, 10), departure.price]), [
    ["2026-10-01", 2_000_000], ["2027-10-01", 3_000_000],
  ]);
  assert.deepEqual(projected.priceGroups.map(group => group.date_keys), [["2026-10-01"], ["2027-10-01"]]);
});

test("cheapest calendar fare preserves one hotel's passenger prices and every age band in metadata", () => {
  const projected = payload({ ...trip, extra: { price_groups: [
    { hotel: "Alpha", dates: ["2026-10-01"], adult_price: 3_000_000, child_price: 1_000_000 },
    { hotel: "Delta", dates: ["2026-10-01"], adult_price: 2_000_000, passenger_prices: [
      { label: "Хүүхэд", age_range: "2-5 нас", price: 1_500_000 },
      { label: "Хүүхэд", age_range: "6-11 нас", price: 1_700_000 },
      { label: "Нярай", age_range: "0-23 сар", price: 0, note: "Үнэгүй" },
    ] },
  ] } });
  assert.equal(projected.departures[0].price, 2_000_000);
  assert.equal(projected.departures[0].childPrice, null);
  assert.equal(projected.departures[0].infantPrice, 0);
  assert.equal(projected.priceGroups.length, 2);
  const delta = projected.priceGroups.find(group => group.hotel === "Delta")!;
  assert.deepEqual(delta.passenger_prices.map(fare => [fare.age_range, fare.price]), [
    ["2-5 нас", 1_500_000], ["6-11 нас", 1_700_000], ["0-23 сар", 0],
  ]);
  assert.ok(projected.canonicalOffers.entries.every(entry => entry.fareCard.status === "ready"));
});

test("a published main child fare survives alongside multiple child age bands", () => {
  const projected = payload({ ...trip, extra: { price_groups: [{
    dates: ["2026-10-01"], adult_price: 4_990_000, child_price: 4_590_000, infant_price: 390_000,
    passenger_prices: [
      { label: "Хүүхэд", age_range: "6-11 нас", price: 4_590_000 },
      { label: "Хүүхэд", age_range: "2-5 нас", price: 4_190_000 },
      { label: "Нярай", age_range: "0-2 нас", price: 390_000 },
    ],
  }] } });

  // The specialised tiers remain available to the booking UI, while the
  // legacy per-departure columns retain the explicitly published headline.
  assert.equal(projected.departures[0].childPrice, 4_590_000);
  assert.equal(projected.departures[0].infantPrice, 390_000);
  assert.equal(projected.priceGroups[0].child_price, 4_590_000);
  assert.deepEqual(projected.priceGroups[0].passenger_prices.map(fare => [fare.age_range, fare.price]), [
    ["6-11 нас", 4_590_000], ["2-5 нас", 4_190_000], ["0-2 нас", 390_000],
  ]);
});

test("trip-level included hotel text does not create hotel choices", () => {
  const projected = payload({ ...trip, hotel: "Jomtien Palm Beach / Pullman Bangkok", extra: { price_groups: [
    { dates: ["2026-10-01"], adult_price: 2_000_000, child_price: 1_500_000 },
  ] } });

  assert.equal(projected.departures[0].price, 2_000_000);
  assert.equal(projected.priceGroups[0].hotel, undefined);
  const ready = projected.canonicalOffers.entries.filter(entry => entry.fareCard.status === "ready");
  assert.equal(ready.length, 1);
  if (ready[0]?.fareCard.status === "ready") assert.equal(ready[0].fareCard.offer.hotel, null);
});

test("website fare cards retain closed departure prices without reopening or borrowing another year's availability", () => {
  const projected = payload({ ...trip, departure_dates: ["2026-10-01", "2027-10-01"], extra: {
    price_groups: [{ dates: ["2026-10-01"], adult_price: 2_000_000 }],
    website_departure_availability: [
      { date: "2026-10-01", status: "SOLD_OUT", seatsLeft: 0 },
      { date: "2027-10-01", status: "OPEN", seatsLeft: 6 },
    ],
  } });
  assert.equal(projected.departures[0].price, 2_000_000);
  assert.equal(projected.departures[0].status, "SOLD_OUT");
  assert.equal(projected.departures[0].seatsLeft, 0);
  assert.equal(projected.departures[1].status, "OPEN");
  assert.equal(projected.departures[1].seatsLeft, 6);
  assert.equal(projected.canonicalOffers.entries[0].result.status, "unavailable");
});

test("ranges and conflicting fares do not become exact bookable calendar prices", () => {
  const range = payload({ ...trip, extra: { price_groups: [{
    dates: ["2026-10-01"], adult_price: 2_000_000, adult_price_range: { min: 2_000_000, max: 3_000_000 },
  }] } });
  assert.equal(range.departures[0].price, null);
  assert.equal(range.departures[0].status, "PAUSED");
  assert.deepEqual(range.priceGroups[0].adult_price_range, { min: 2_000_000, max: 3_000_000 });
  const conflict = payload({ ...trip, extra: { price_groups: [
    { dates: ["2026-10-01"], adult_price: 2_000_000 },
    { dates: ["2026-10-01"], adult_price: 3_000_000 },
  ] } });
  assert.equal(conflict.departures[0].price, null);
  assert.equal(conflict.departures[0].status, "PAUSED");
  assert.equal(conflict.canonicalOffers.entries[0].result.status, "conflict");
});

test("website projection retains solo-room source fields and only explicit free passenger notes", () => {
  const source = { ...trip, extra: { price_groups: [{
    dates: ["2026-10-01"], adult_price: 2_000_000, single_price: 2_800_000,
    passenger_prices: [{ label: "Нярай", age_range: "0-23 сар", price: 0, note: "Үнэгүй" }],
  }] } };
  const projected = payload(source);
  const details = websiteExtraDetails({ ...source.extra, price_groups: projected.priceGroups }, {
    adult: projected.price, child: projected.childPrice, infant: projected.infantPrice, currency: "MNT",
  });
  assert.equal(projected.priceGroups[0].single_price, 2_800_000);
  assert.match(details.roomPrices[0], /2,800,000/);
  assert.ok(details.childPriceNotes.some(line => line.includes("Үнэгүй")));
  assert.ok(!websiteExtraDetails({}, { adult: null, child: null, infant: 0, currency: "MNT" })
    .childPriceNotes.some(line => line.includes("Үнэгүй")));
});

test("canonical group-only departure dates are projected even without a base date list", () => {
  const projected = payload({ ...trip, departure_dates: [], extra: { price_groups: [{
    dates: ["2027-10-01"], adult_price: 2_000_000,
  }] } });
  assert.equal(projected.departures[0].start, "2027-10-01T00:00:00.000Z");
  assert.equal(projected.departures[0].price, 2_000_000);
});

test("hotel and package dimensions stay associated when projecting choices", () => {
  const projected = payload({ ...trip, extra: { price_groups: [
    { hotel: "Alpha", package_id: "standard", dates: ["2026-10-01"], adult_price: 2_000_000 },
    { hotel: "Alpha", package_id: "suite", dates: ["2026-10-01"], adult_price: 3_000_000 },
    { hotel: "Delta", package_id: "standard", dates: ["2026-10-01"], adult_price: 2_500_000 },
  ] } });
  assert.equal(projected.priceGroups.length, 3);
  assert.deepEqual(projected.priceGroups.map(group => [group.hotel, group.package_id, group.adult_price]), [
    ["Alpha", "standard", 2_000_000], ["Alpha", "suite", 3_000_000], ["Delta", "standard", 2_500_000],
  ]);
});

test("website prices use active canonical discounts and exclude expired or conditional discounts", () => {
  const projected = payload({ ...trip, extra: { discounts: [
    { id: "expired", dates: ["2026-10-01"], adult_price: 1_000_000, valid_until: "2026-08-01" },
    { id: "conditional", dates: ["2026-10-01"], adult_price: 1_200_000, condition: "Members only" },
    { id: "current", dates: ["2026-10-01"], adult_price: 2_000_000, valid_until: "2026-09-30" },
  ] } });
  assert.equal(projected.departures[0].price, 2_000_000);
  assert.equal(projected.price, 2_000_000);
});

test("weekly departures and explicit source duration share the canonical projection", () => {
  const source = { ...trip, departure_dates: ["Пүрэв гараг бүр"], extra: { duration_days: 5 } };
  const departures = websiteDepartures(source, now);
  assert.equal(departures.length, 12);
  assert.equal(departures[0].start, "2026-09-03T00:00:00.000Z");
  assert.equal(departures[0].end, "2026-09-07T00:00:00.000Z");
  assert.equal(departures[0].price, trip.adult_price);
});
