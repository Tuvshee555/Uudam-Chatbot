import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";

applyTestEnv();

// Static imports are hoisted above applyTestEnv(), and the env module
// validates on load — so pull the DB module in only after the env is set.
let filterTripsForListing: typeof import("../src/lib/travelDb").filterTripsForListing;
before(async () => {
  ({ filterTripsForListing } = await import("../src/lib/travelDb"));
});

function trip(id: string, status: TravelTrip["status"]): TravelTrip {
  return {
    id,
    category: "Аялал",
    operator_name: "UUDAM TRAVEL AGENCY",
    route_name: id,
    duration_text: "5 өдөр",
    adult_price: 1_000_000,
    child_price: 900_000,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
    status,
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "2026-09-01T00:00:00.000Z",
    updated_at: "2026-09-01T00:00:00.000Z",
  } as TravelTrip;
}

const catalogue = [trip("a", "active"), trip("b", "archived"), trip("c", "draft"), trip("d", "sold_out")];

test("bot-facing default listing never includes archived trips", () => {
  const ids = filterTripsForListing(catalogue).map((t) => t.id);
  assert.deepEqual(ids, ["a", "c", "d"]);
});

test("admin 'all statuses' listing includes auto-archived trips so they can be fixed", () => {
  const ids = filterTripsForListing(catalogue, { includeArchived: true }).map((t) => t.id);
  assert.deepEqual(ids, ["a", "b", "c", "d"]);
});

test("an explicit status filter wins over includeArchived either way", () => {
  assert.deepEqual(
    filterTripsForListing(catalogue, { status: "archived" }).map((t) => t.id),
    ["b"],
  );
  assert.deepEqual(
    filterTripsForListing(catalogue, { status: "active", includeArchived: true }).map((t) => t.id),
    ["a"],
  );
});
