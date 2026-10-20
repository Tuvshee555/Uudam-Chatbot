import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("sync status protects diagnostics, distinguishes missing configuration and reports failures honestly", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/sync-status-fixture", BOOKING_DATABASE_URL: undefined });
  const { Pool } = await import("pg");
  const queries: string[] = [];
  let failStatus = false;
  const rows = [{ trip_id: "velmor", trip_name: "Вэлмор аялал", trip_status: "active", synced: true,
    last_error: null, website_slug: "velmor", content_conflict: true, shared_conflict_count: 0 }];
  const query = async (sql: string) => {
    queries.push(sql);
    if (/SELECT s.trip_id/.test(sql)) {
      if (failStatus) throw new Error("Fixture database unavailable");
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const { default: handler } = await import("../src/pages/api/admin/website-sync");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const { closeBookingPool } = await import("../src/lib/websiteTripSync");
  async function call(method: string, authorized = true) {
    const response = { statusCode: 200, body: {} as Record<string, unknown>, headers: {} as Record<string, unknown>,
      setHeader(name: string, value: unknown) { this.headers[name] = value; },
      status(code: number) { this.statusCode = code; return this; },
      json(value: Record<string, unknown>) { this.body = value; return this; }, end() { return this; } };
    await handler({ method, headers: authorized ? { "x-admin-secret": "test-admin-secret" } : {}, query: {} } as never, response as never);
    return response;
  }
  try {
    const unauthorized = await call("GET", false);
    assert.equal(unauthorized.statusCode, 401);
    assert.deepEqual(queries, [], "unauthorized requests never read trip state");
    const unconfigured = await call("POST");
    assert.equal(unconfigured.statusCode, 409);
    assert.equal(unconfigured.body.error, "website_sync_not_configured");
    assert.deepEqual(queries, [], "missing configuration cannot start deliveries");
    const status = await call("GET");
    assert.equal(status.statusCode, 200);
    assert.equal(status.headers["Cache-Control"], "no-store");
    assert.equal(status.body.configured, false);
    assert.equal((status.body.summary as { conflicts: number }).conflicts, 1);
    assert.equal(queries.some(sql => /SELECT trip_id FROM trip_website_sync/.test(sql)), false);
    failStatus = true;
    const unavailable = await call("GET");
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.body.error, "website_sync_status_unavailable");
    assert.equal(unavailable.body.trips, undefined, "an outage must not look like an empty successful result");
  } finally { await closeNeonPool(); await closeBookingPool(); }
});
