import assert from "node:assert/strict";
import test from "node:test";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { tripToPoster } from "../src/lib/connectedTripMapping";
import { normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import type { TravelTrip } from "../src/lib/travelTypes";

const trip: TravelTrip = {
  id: "structured", category: "", operator_name: "Uudam", route_name: "Trip",
  duration_text: "", adult_price: null, child_price: null, infant_price: null,
  currency: "MNT", departure_dates: [], seats_total: null, seats_left: null,
  has_food: null, status: "draft", notes: "", hotel: "", source_description: "",
  photo_urls: [], extra: {}, created_at: "", updated_at: "",
};

test("poster source facts survive the trip-save extra normalization", () => {
  const mapped = mapPosterTripToFields({
    title: "Trip", destinations: ["Lumia", " Nord ", "Lumia"],
    transport_type: "land_flight", duration_days: 6, duration_nights: 0,
  });
  assert.deepEqual(normalizeExtraPatch(mapped.extra || {}), {
    destinations: ["Lumia", "Nord"], transport_type: "land_flight",
    duration_days: 6, duration_nights: 0,
  });
});

test("poster title, itinerary and photos do not invent structured route facts", () => {
  const mapped = mapPosterTripToFields({
    title: "Lumia flight trip", days: [{ route: "Lumia to Nord", summary: "Fly home" }],
  });
  assert.equal(mapped.extra?.destinations, undefined);
  assert.equal(mapped.extra?.transport_type, undefined);
  assert.equal(mapped.extra?.duration_days, undefined);
  assert.equal(mapped.extra?.duration_nights, undefined);
  const invalid = mapPosterTripToFields({ transport_type: "flight", duration_days: -1, duration_nights: 1.5 });
  assert.equal(invalid.extra, undefined);
});

test("trip to poster updates explicit facts while preserving editor fields", () => {
  const prior = {
    destinations: ["Old"], transport_type: "land", duration_days: 4,
    style: { photoScale: 0.5 }, price_table: { rows: [{ cells: ["100"] }] },
  };
  const result = tripToPoster({ ...trip, extra: {
    destinations: ["Nord"], transport_type: "cruise", duration_days: 6, duration_nights: 5,
  } }, prior, trip);
  assert.deepEqual(result.destinations, ["Nord"]);
  assert.equal(result.transport_type, "cruise");
  assert.equal(result.duration_days, 6);
  assert.equal(result.duration_nights, 5);
  assert.deepEqual(result.style, prior.style);
  assert.deepEqual(result.price_table, prior.price_table);
});

test("poster price rows keep explicitly recorded years through source mapping", () => {
  const mapped = mapPosterTripToFields({ price_table: {
    columns: ["Том хүн"], rows: [
      { dates: "2026 оны 10 сарын 01, 2027 оны 10 сарын 01", cells: ["2,000,000"] },
    ],
  } });
  assert.deepEqual(mapped.departure_dates, ["2026 оны 10 сарын 01", "2027 оны 10 сарын 01"]);
  assert.deepEqual(mapped.extra?.price_groups?.[0].dates, mapped.departure_dates);
});
