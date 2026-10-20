import assert from "node:assert/strict";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { applyTestEnv } from "./helpers/env";

test("reverse sync authenticates, rejects malformed facts before DB access, and acknowledges retries without writes", async context => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/fixture", WEBSITE_TRIP_SYNC_SECRET: "fixture-sync-secret" });
  delete process.env.BOOKING_DATABASE_URL;
  const { Pool } = await import("pg");
  const queries: string[] = [];
  let unavailable = false;
  const row = {
    id: "velmor-canonical", route_name: "Вэлмор аялал", notes: "Хадгалсан тайлбар", status: "draft", currency: "MNT",
    duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-17"], photo_urls: [], extra: {},
    updated_at: "2098-01-02T03:04:05.678Z", created_at: "2098-01-01T03:04:05.678Z",
  };
  context.mock.method(Pool.prototype, "query", (async (sql: string) => {
    queries.push(sql);
    if (unavailable) throw new Error("fixture database unavailable");
    assert.match(sql, /^\s*SELECT\b/i, "an already-applied payload must not write or initialize schemas");
    return { rows: [structuredClone(row)], rowCount: 1 };
  }) as unknown as typeof Pool.prototype.query);
  const { default: handler } = await import("../src/pages/api/internal/website-trip");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const request = (body: unknown, secret = "fixture-sync-secret", method = "POST") => ({
    method, body, headers: { "x-trip-sync-secret": secret },
  }) as unknown as NextApiRequest;
  const response = () => ({ statusCode: 200, body: undefined as unknown, headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; }, end() { return this; },
    setHeader(key: string, value: string) { this.headers[key] = value; },
  });
  try {
    for (const [req, code] of [
      [request({}, "wrong-secret"), 401],
      [request({ trip: { sourceTripId: row.id, departures: [{ startDate: "2098-02-30", status: "OPEN" }] } }), 400],
      [request({ trip: { sourceTripId: row.id, departures: [{ startDate: "2098-03-17", status: "UNKNOWN" }] } }), 400],
      [request({ action: "unexpected", trip: { sourceTripId: row.id } }), 400],
    ] as const) {
      const res = response();
      await handler(req, res as unknown as NextApiResponse);
      assert.equal(res.statusCode, code);
      assert.equal(queries.length, 0);
    }
    const method = response();
    await handler(request({}, "fixture-sync-secret", "GET"), method as unknown as NextApiResponse);
    assert.equal(method.statusCode, 405);
    assert.equal(method.headers.Allow, "POST");

    const retry = response();
    await handler(request({ trip: { sourceTripId: row.id, description: row.notes } }), retry as unknown as NextApiResponse);
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(retry.body, { ok: true, tripId: row.id });
    assert.equal(queries.length, 1);

    unavailable = true;
    context.mock.method(console, "error", () => {});
    const offline = response();
    await handler(request({ trip: { sourceTripId: row.id, description: "Өөр тайлбар" } }), offline as unknown as NextApiResponse);
    assert.equal(offline.statusCode, 503);
    assert.deepEqual(offline.body, { error: "trip_sync_failed" });
  } finally {
    await closeNeonPool();
  }
});
