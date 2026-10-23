import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";
import { withBookableDepartureDates } from "../src/lib/departureAvailability";
import { resolveTripOffer } from "../src/lib/tripOffers";

const date = "2098-03-04";
const now = new Date("2098-01-01T00:00:00.000Z");
const current = { id: "current-velmor", startDate: `${date} 00:00:00`, endDate: "2098-03-06T00:00:00.000Z",
  status: "OPEN", seatsTotal: 12, seatsLeft: 5, price: 1_234_567, childPrice: null, infantPrice: null, label: "Invented departure" };
const history = { ...current, id: "historic-velmor", status: "CANCELLED", seatsLeft: 0, price: 7_654_321 };

function trip(id = "velmor"): TravelTrip {
  return { id, category: "", operator_name: "Invented", route_name: "Вэлмор аялал", duration_text: "3 өдөр 2 шөнө",
    adult_price: 1_234_567, child_price: null, infant_price: null, currency: "MNT", departure_dates: [date],
    seats_total: 12, seats_left: 5, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { poster_trip_id: `poster-${id}` }, created_at: "", updated_at: "" };
}

async function mockDatabase(context: TestContext, query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number }>) {
  const database = "postgres://fixture:fixture@127.0.0.1:1/departure-history-fixture";
  applyTestEnv({ NEON_DATABASE_URL: database, BOOKING_DATABASE_URL: database, SITE_URL: "https://catalog.invalid", NEXT_PUBLIC_SITE_URL: undefined });
  const pg = await import("pg");
  context.mock.method(pg.Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(pg.Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const sync = await import("../src/lib/websiteTripSync");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  return { sync, async close() { await closeNeonPool(); await sync.closeBookingPool(); } };
}

test("availability reads ignore cancelled and departed history in either row order", async (context) => {
  let departures: Record<string, unknown>[] = [];
  const fixture = await mockDatabase(context, async (sql) => {
    if (sql.includes('JOIN "Departure"')) return { rows: departures };
    if (sql.includes('FROM "Trip" t') && sql.includes('FROM "ItineraryDay"')) {
      assert.doesNotMatch(sql, /SELECT\s+t\.\*/i, "availability reads must not transfer the full website source snapshot");
      return { rows: [{ sourceTripId: "velmor", slug: "trip-velmor", isPublished: true }] };
    }
    return { rows: [] };
  });
  try {
    for (const status of ["CANCELLED", "DEPARTED"]) {
      for (const ordered of [[{ ...history, status }, current], [current, { ...history, status }]]) {
        departures = ordered.map(row => ({ ...row, sourceTripId: "velmor" }));
        const before = structuredClone(departures);
        const [result] = await fixture.sync.withWebsiteDepartureAvailability([trip()]);
        assert.deepEqual(result.extra.website_departure_availability, [{ date, status: "OPEN", seatsLeft: 5 }]);
        assert.deepEqual(withBookableDepartureDates(result, now).departure_dates, [date]);
        assert.equal(resolveTripOffer(result, { date }, now).status, "ready");
        assert.deepEqual(departures, before, "database results remain untouched");
      }
    }
  } finally { await fixture.close(); }
});

test("history selection stays per trip and preserves genuinely conflicting current rows", async (context) => {
  const fixture = await mockDatabase(context, async (sql) => {
    if (sql.includes('JOIN "Departure"')) return { rows: [
      { ...history, sourceTripId: "velmor" }, { ...current, sourceTripId: "velmor" },
      { ...current, id: "competing-velmor", seatsLeft: 2, sourceTripId: "velmor" },
      { ...history, sourceTripId: "nerith" },
    ] };
    return { rows: [] };
  });
  try {
    const [ambiguous, cancelled] = await fixture.sync.withWebsiteDepartureAvailability([trip(), trip("nerith")]);
    assert.equal(resolveTripOffer(ambiguous, { date }, now).status, "conflict");
    assert.deepEqual(cancelled.extra.website_departure_availability, [{ date, status: "CANCELLED", seatsLeft: 0 }]);
    assert.deepEqual(withBookableDepartureDates(cancelled, now).departure_dates, []);
  } finally { await fixture.close(); }
});

test("forward delivery updates the current departure identity and retains historical rows", async (context) => {
  const source = trip();
  let departures = [history, current];
  let synced = false;
  const updatedIds: unknown[] = [];
  const retainedIds: unknown[] = [];
  const errors: unknown[] = [];
  const fixture = await mockDatabase(context, async (sql, params = []) => {
    if (/SELECT trip_id FROM trip_website_sync/.test(sql)) return { rows: synced ? [] : [{ trip_id: source.id }] };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
    if (/SELECT \* FROM trip_website_sync/.test(sql)) return { rows: [{ trip_id: source.id, revision: "1" }] };
    if (/SELECT \* FROM travel_trip_entries/.test(sql)) return { rows: [source] };
    if (sql.includes("SELECT data FROM poster_trips")) return { rows: [{ data: { days: [] } }] };
    if (/SELECT \* FROM "Trip"/.test(sql)) return { rows: [{ id: "web-velmor", slug: "trip-velmor", categoryId: "category-fixture",
      sourceMetadata: { connectedSource: { ...source, photos: [], poster: { days: [] } } } }] };
    if (sql.startsWith('SELECT *, "startDate"::text')) return { rows: departures };
    if (sql.startsWith('UPDATE "Departure" SET label=')) { updatedIds.push(params[0]); assert.equal(params[3], "OPEN"); }
    if (sql.startsWith('UPDATE "Departure" SET status=\'CANCELLED\'')) retainedIds.push(params[1]);
    if (/INSERT INTO "Departure"|DELETE FROM "Departure"/.test(sql)) assert.fail("Existing current identity must be retained");
    if (sql.includes("UPDATE trip_website_sync SET synced_revision")) synced = true;
    if (sql.includes("UPDATE trip_website_sync SET attempts")) errors.push(params[1]);
    return { rows: [] };
  });
  try {
    for (const ordered of [[history, current], [current, history]]) {
      departures = ordered;
      synced = false;
      assert.deepEqual(await fixture.sync.flushWebsiteSync(source.id, 1), { processed: 1 });
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(updatedIds, ["current-velmor", "current-velmor"]);
    assert.deepEqual(retainedIds, [["current-velmor"], ["current-velmor"]], "only current row stays bookable; history is retained as cancelled");
  } finally { await fixture.close(); }
});
