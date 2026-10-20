import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { applyTestEnv } from "./helpers/env";

type Job = { trip_id: string; revision: string; synced_revision: string; attempts: number; last_error: string | null };

async function deliveryFixture(context: TestContext, ids: string[]) {
  const database = "postgres://fixture:fixture@127.0.0.1:1/sync-fixture";
  applyTestEnv({ NEON_DATABASE_URL: database, BOOKING_DATABASE_URL: database });
  const pg = await import("pg");
  const jobs = new Map(ids.map((id) => [id, { trip_id: id, revision: "1", synced_revision: "0", attempts: 0, last_error: null } as Job]));
  const busy = new Set<string>();
  const failures = new Set<string>();
  const projections: string[] = [];
  const queries: string[] = [];
  const releases: string[] = [];
  let selected = "";
  let afterRollback: (() => void) | undefined;
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push(sql);
    if (/SELECT trip_id FROM trip_website_sync/.test(sql)) {
      const excluded = new Set(Array.isArray(params[1]) ? params[1] as string[] : []);
      const next = [...jobs.values()].find((job) => BigInt(job.revision) > BigInt(job.synced_revision)
        && (!params[0] || params[0] === job.trip_id) && !excluded.has(job.trip_id));
      selected = next?.trip_id || "";
      return result(next ? [{ trip_id: next.trip_id }] : []);
    }
    if (/pg_try_advisory_xact_lock/.test(sql)) return result([{ locked: !busy.has(String(params[0])) }]);
    if (/SELECT \* FROM trip_website_sync/.test(sql)) {
      const job = jobs.get(String(params[0]));
      return result(job && BigInt(job.revision) > BigInt(job.synced_revision) ? [{ ...job }] : []);
    }
    if (/SELECT \* FROM travel_trip_entries/.test(sql)) return result();
    if (/UPDATE "Trip" SET "isPublished"=false/.test(sql)) {
      const id = String(params[0]);
      projections.push(id);
      if (failures.has(id)) throw new Error("Fixture projection unavailable");
      return result();
    }
    if (/UPDATE trip_website_sync SET synced_revision/.test(sql)) {
      const job = jobs.get(String(params[0]))!;
      job.synced_revision = String(params[1]);
      job.last_error = null;
      return result();
    }
    if (/UPDATE trip_website_sync SET attempts/.test(sql)) {
      const job = jobs.get(String(params[0]))!;
      if (params[2] !== undefined && String(params[2]) !== job.revision) return result();
      if (/revision\s*>\s*synced_revision/.test(sql) && BigInt(job.revision) <= BigInt(job.synced_revision)) return result();
      job.attempts++;
      job.last_error = String(params[1]);
      return result();
    }
    if (sql === "ROLLBACK") afterRollback?.();
    return result();
  };
  context.mock.method(pg.Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(pg.Pool.prototype, "connect", (async () => ({ query, release() { releases.push(selected); } })) as unknown as typeof Pool.prototype.connect);
  const sync = await import("../src/lib/websiteTripSync");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  return { jobs, busy, failures, projections, releases, queries, flush: sync.flushWebsiteSync,
    onRollback(callback: () => void) { afterRollback = callback; },
    async close() { await closeNeonPool(); await sync.closeBookingPool(); },
  };
}

test("a locked oldest delivery does not block unrelated queued trips", async (context) => {
  const fixture = await deliveryFixture(context, ["velmor-busy", "nerith-ready"]);
  fixture.busy.add("velmor-busy");
  try {
    assert.deepEqual(await fixture.flush(undefined, 5), { processed: 1 });
    assert.deepEqual(fixture.projections, ["nerith-ready"]);
    assert.equal(fixture.jobs.get("velmor-busy")?.synced_revision, "0");
    assert.equal(fixture.jobs.get("nerith-ready")?.synced_revision, "1");
  } finally { await fixture.close(); }
});

test("one failing trip is attempted once per batch and can retry on the next request", async (context) => {
  const fixture = await deliveryFixture(context, ["velmor-retry"]);
  fixture.failures.add("velmor-retry");
  try {
    assert.deepEqual(await fixture.flush(undefined, 5), { processed: 0 });
    assert.deepEqual(fixture.projections, ["velmor-retry"]);
    assert.equal(fixture.jobs.get("velmor-retry")?.attempts, 1);
    fixture.failures.clear();
    assert.deepEqual(await fixture.flush(undefined, 5), { processed: 1 });
    assert.equal(fixture.jobs.get("velmor-retry")?.last_error, null);
  } finally { await fixture.close(); }
});

test("a failed old revision cannot overwrite a newer edit's cleared error", async (context) => {
  const fixture = await deliveryFixture(context, ["velmor-newer"]);
  fixture.failures.add("velmor-newer");
  fixture.onRollback(() => { fixture.jobs.get("velmor-newer")!.revision = "2"; });
  try {
    await fixture.flush(undefined, 1);
    assert.equal(fixture.jobs.get("velmor-newer")?.last_error, null);
    assert.equal(fixture.jobs.get("velmor-newer")?.attempts, 0);
  } finally { await fixture.close(); }
});

test("a late failure cannot mark an already delivered revision as broken", async (context) => {
  const fixture = await deliveryFixture(context, ["velmor-delivered"]);
  fixture.failures.add("velmor-delivered");
  fixture.onRollback(() => { fixture.jobs.get("velmor-delivered")!.synced_revision = "1"; });
  try {
    await fixture.flush(undefined, 1);
    assert.equal(fixture.jobs.get("velmor-delivered")?.last_error, null);
  } finally { await fixture.close(); }
});

test("an unconfigured website keeps queued work untouched without opening database transactions", async (context) => {
  const fixture = await deliveryFixture(context, ["velmor-unconfigured"]);
  delete process.env.BOOKING_DATABASE_URL;
  try {
    assert.deepEqual(await fixture.flush(undefined, 5), { processed: 0 });
    assert.deepEqual(fixture.queries, []);
    assert.equal(fixture.jobs.get("velmor-unconfigured")?.attempts, 0);
    assert.equal(fixture.jobs.get("velmor-unconfigured")?.last_error, null);
    assert.equal(fixture.jobs.get("velmor-unconfigured")?.synced_revision, "0");
  } finally { await fixture.close(); }
});
