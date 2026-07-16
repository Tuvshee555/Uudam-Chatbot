import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";

applyTestEnv();

const NOW = new Date("2026-07-16T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Shanghai + Heaven Gate",
    duration_text: "8 days / 7 nights",
    adult_price: 3590000,
    child_price: 3260000,
    currency: "MNT",
    departure_dates: [],
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

async function loadMaintenance() {
  const { sanitizeTripScheduleForCurrentDate } = await import("../src/lib/travelDb");
  return { sanitizeTripScheduleForCurrentDate };
}

test("schedule cleanup removes past dates and keeps future dates", async () => {
  const { sanitizeTripScheduleForCurrentDate } = await loadMaintenance();
  const result = sanitizeTripScheduleForCurrentDate(
    trip({
      departure_dates: ["6 сарын 27", "7 сарын 18", "8 сарын 8"],
      extra: {
        departure_dates_resolved: [
          { text: "6 сарын 27", ymd: "2026-06-27" },
          { text: "7 сарын 18", ymd: "2026-07-18" },
          { text: "8 сарын 8", ymd: "2026-08-08" },
        ],
      },
    }),
    NOW,
  );

  assert.equal(result.changed, true);
  assert.equal(result.trip.status, "active");
  assert.deepEqual(result.trip.departure_dates, ["7 сарын 18", "8 сарын 8"]);
  assert.deepEqual(result.trip.extra.departure_dates_resolved, [
    { text: "7 сарын 18", ymd: "2026-07-18" },
    { text: "8 сарын 8", ymd: "2026-08-08" },
  ]);
});

test("schedule cleanup archives active trips when all known dates have passed", async () => {
  const { sanitizeTripScheduleForCurrentDate } = await loadMaintenance();
  const result = sanitizeTripScheduleForCurrentDate(
    trip({
      departure_dates: ["6 сарын 7", "7 сарын 10"],
      extra: {
        departure_dates_resolved: [
          { text: "6 сарын 7", ymd: "2026-06-07" },
          { text: "7 сарын 10", ymd: "2026-07-10" },
        ],
      },
    }),
    NOW,
  );

  assert.equal(result.changed, true);
  assert.equal(result.trip.status, "archived");
  assert.deepEqual(result.trip.departure_dates, []);
  assert.equal(result.trip.extra.archived_reason, "all_departure_dates_passed");
});

test("schedule cleanup prunes stale dates inside structured price groups", async () => {
  const { sanitizeTripScheduleForCurrentDate } = await loadMaintenance();
  const result = sanitizeTripScheduleForCurrentDate(
    trip({
      departure_dates: ["6 сарын 27", "7 сарын 18", "8 сарын 8"],
      extra: {
        departure_dates_resolved: [
          { text: "6 сарын 27", ymd: "2026-06-27" },
          { text: "7 сарын 18", ymd: "2026-07-18" },
          { text: "8 сарын 8", ymd: "2026-08-08" },
        ],
        departure_date_groups: [
          {
            dates: ["6 сарын 27", "7 сарын 18", "8 сарын 8"],
            adult_price: 3590000,
          },
          {
            dates: ["6 сарын 7"],
            adult_price: 3290000,
          },
        ],
      },
    }),
    NOW,
  );

  assert.equal(result.changed, true);
  const groups = result.trip.extra.departure_date_groups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].dates, ["7 сарын 18", "8 сарын 8"]);
  assert.equal(groups[0].adult_price, 3590000);
});
