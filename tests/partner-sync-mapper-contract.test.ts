import test from "node:test";
import assert from "node:assert/strict";
import { partnerTripFields } from "../src/lib/partnerSync/tripPayload";
import { normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import type { TravelTrip } from "../src/lib/travelTypes";
import { prices, row, tour } from "./fixtures/partner-tour";

const source = (input = tour()): TravelTrip => ({
  id: "sample-trip", category: "sample", operator_name: "Sample", route_name: "Sample tour", duration_text: "", adult_price: null,
  child_price: null, infant_price: null, currency: "MNT", departure_dates: [], seats_total: null, seats_left: null, has_food: null,
  status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "",
  ...partnerTripFields(input), extra: normalizeExtraPatch(partnerTripFields(input).extra ?? {}),
});
const groups = (extra: Record<string, unknown>) => extra.price_groups as Record<string, unknown>[];
const now = new Date("2099-06-01T00:00:00Z");

test("normalization preserves every date, hotel, passenger band and availability", () => {
  const trip = source();
  const extra = normalizeExtraPatch(trip.extra);
  assert.equal(groups(extra).length, 4);
  const group = groups(extra)[0];
  assert.deepEqual(group.dates, ["2099-06-12"]);
  assert.equal(group.adult_price, 2100000);
  assert.equal(group.infant_price, 320000);
  assert.equal(group.single_price, 520000);
  assert.equal(group.partner_source, true);
  assert.equal(group.status, "open");
  assert.equal((group.passenger_prices as unknown[]).length, 3);
});

test("website projection preserves distinct fares and both child age bands", () => {
  const trip = source();
  const website = websiteTripPayload(trip, websiteDepartureSchedule(trip, now), now);
  assert.equal(website.price, 2100000);
  assert.equal(website.departures.length, 2);
  assert.equal(website.priceGroups.length, 4);
  const first = website.priceGroups.find((g) => g.adult_price === 2100000)!;
  assert.equal(first.infant_price, 320000);
  assert.equal(first.single_price, 520000);
  assert.deepEqual((first.passenger_prices as { price: number }[]).map((p) => p.price).sort((a,b) => a-b), [320000, 1200000, 1600000]);
  assert.ok((first.passenger_prices as { label: string }[]).some((p) => /оргүй/.test(p.label)), "no-bed condition survives projection");
});

test("a sold-out hotel does not close another hotel on the same date", () => {
  const trip = source(tour([row(undefined, "Example Bay", { open: false, seats: 0 }), row(undefined, "Example Garden")]));
  const website = websiteTripPayload(trip, websiteDepartureSchedule(trip, now), now);
  assert.equal(website.departures[0].status, "OPEN");
  assert.equal(website.priceGroups.length, 4);
  for (const group of website.priceGroups) {
    const availability = group.availability as { status: string };
    assert.equal(availability.status, String(group.hotel).includes("Bay") ? "sold_out" : "open");
  }
});

test("all sold-out source offers close the departure and removed fares are explicitly null", () => {
  const trip = source(tour([row(undefined, undefined, { open: false, prices: prices({ infant: null, child2to5: null, child6to11: null, programAdult: null }) })]));
  assert.equal(trip.child_price, null);
  assert.equal(trip.infant_price, null);
  assert.deepEqual(trip.extra.departure_date_groups, []);
  const website = websiteTripPayload(trip, websiteDepartureSchedule(trip, now), now);
  assert.equal(website.departures[0].status, "SOLD_OUT");
});
