import assert from "node:assert/strict";
import test from "node:test";
import { buildArchivedTripNotice } from "../src/lib/travelFastPaths";
import { findTripMatches } from "../src/lib/travelFastPathsSearch";
import type { TravelTrip } from "../src/lib/travelOps";

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Хайлаар Манжуурын аялал",
    duration_text: "4 өдөр 3 шөнө",
    adult_price: 990000,
    child_price: 890000,
    currency: "MNT",
    departure_dates: ["7 сарын 6", "7 сарын 13"],
    seats_total: null,
    seats_left: null,
    has_food: true,
    status: "archived",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: { archived_reason: "all_departure_dates_passed" },
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("naming an expired trip by its full name gets told it is inactive, not silence", () => {
  const notice = buildArchivedTripNotice("Хайлаар Манжуурын аялал явна уу", [trip({})]);
  assert.ok(notice);
  assert.equal(notice!.trip.route_name, "Хайлаар Манжуурын аялал");
  assert.match(notice!.reply, /идэвхгүй/);
  assert.match(notice!.reply, /Хайлаар Манжуурын аялал/);
});

test("a trip archived for any OTHER reason is never auto-explained as expired", () => {
  const manuallyArchived = trip({ extra: { archived_reason: "owner_cancelled" } });
  const notice = buildArchivedTripNotice("Хайлаар Манжуурын аялал явна уу", [manuallyArchived]);
  assert.equal(notice, null);
});

test("a vague message that does not name a specific trip returns nothing", () => {
  const notice = buildArchivedTripNotice("сайн байна уу", [trip({})]);
  assert.equal(notice, null);
});

test("no archived trips at all returns nothing", () => {
  assert.equal(buildArchivedTripNotice("Хайлаар Манжуурын аялал", []), null);
});

test("an active trip with the same name is never mistaken for the archived one", () => {
  // buildArchivedTripNotice only ever receives an archived-only list from its
  // callers, but the underlying matcher must still not silently match a
  // status it wasn't told to include.
  const activeTrip = trip({ status: "active", extra: {} });
  const matches = findTripMatches("Хайлаар Манжуурын аялал", [activeTrip]);
  assert.equal(matches.length, 1, "active trips match by default");

  const archivedTrip = trip({});
  const withoutFlag = findTripMatches("Хайлаар Манжуурын аялал", [archivedTrip]);
  assert.equal(withoutFlag.length, 0, "archived trips are excluded unless includeArchived is set");
  const withFlag = findTripMatches("Хайлаар Манжуурын аялал", [archivedTrip], { includeArchived: true });
  assert.equal(withFlag.length, 1);
});

test("an ambiguous or loose match never fires the notice", () => {
  const twoTrips = [
    trip({ id: "a", route_name: "Хайлаар Манжуурын аялал" }),
    trip({ id: "b", route_name: "Хайлаар Дулаанхааны аялал" }),
  ];
  // A bare, generic word shared by both must not verify-match either one.
  const notice = buildArchivedTripNotice("Хайлаар аялал", twoTrips);
  assert.equal(notice, null);
});
