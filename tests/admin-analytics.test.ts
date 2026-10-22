import assert from "node:assert/strict";
import test from "node:test";
import type { NextApiRequest, NextApiResponse } from "next";
import { analyticsWindow, collectAdminAnalytics, type AnalyticsQuery } from "../src/lib/adminAnalytics";
import { applyTestEnv } from "./helpers/env";

const now = new Date("2098-01-01T17:00:00.000Z");

function fixtureQuery(fail?: "core" | "activity" | "faq" | "errors"): AnalyticsQuery {
  return async (sql, params) => {
    assert.match(sql, /^SELECT /);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER)\b|\btrip_name\b|SELECT \*/i);
    if (sql.includes("FROM travel_leads")) {
      if (fail === "core") throw new Error("Fixture missing database");
      if (sql.includes("AS pending_handoffs")) return { rows: [{ total: "8", new: "5", bookings: "2", contacts: "6",
        pending_handoffs: "4", oldest_handoff: "2097-12-28T03:00:00Z", new_bookings: "1" }] };
      if (sql.includes("GROUP BY lead_status,kind")) return { rows: [
        { lead_status: "new_lead", kind: "handoff", count: "4" }, { lead_status: "new_lead", kind: "booking", count: "1" },
        { lead_status: "contacted", kind: "handoff", count: "2" }, { lead_status: "booked", kind: "booking", count: "1" },
      ] };
      assert.deepEqual(params, ["2097-12-26T16:00:00.000Z", now.toISOString()]);
      return { rows: [{ date: "2098-01-02", count: "2" }] };
    }
    if (sql.includes("FROM travel_trip_entries")) return { rows: [{ total: "3", active: "2" }] };
    if (sql.includes("FROM travel_conversations")) {
      if (fail === "activity") throw new Error("Fixture activity unavailable");
      assert.match(sql, /sender_id NOT LIKE 'demo:%'/, "test bot sessions must not inflate customer activity");
      assert.deepEqual(params, ["2097-12-26T16:00:00.000Z", now.toISOString()]);
      if (sql.includes("AS conversations")) {
        assert.match(sql, /DISTINCT \(platform,sender_id\)/);
        return { rows: [{ inbound: "11", assistant: "7", conversations: "5" }] };
      }
      assert.match(sql, /AT TIME ZONE 'Asia\/Ulaanbaatar'/);
      return { rows: [{ date: "2098-01-02", inbound: "11", assistant: "7" }] };
    }
    if (sql.includes("FROM travel_messages")) {
      if (fail === "faq") throw new Error("Fixture FAQ unavailable");
      if (sql.includes("ARRAY_AGG")) return { rows: [{ question: "Вэлмор аялал үнэ? example@example.invalid access_token=fixture-secret", count: "3" }] };
      return { rows: [{ count: "9" }] };
    }
    if (sql.includes("FROM travel_error_logs")) {
      if (fail === "errors") throw new Error("Fixture logs unavailable");
      return { rows: [{ event: "staff_alert.no_channel_configured", level: "error", count: "2", last_seen: now }] };
    }
    throw new Error("Unexpected fixture query");
  };
}

test("overview aggregates actual schema counts and fills local calendar gaps without reading customer records", async () => {
  const result = await collectAdminAnalytics(fixtureQuery(), 7, now);
  assert.equal(result.stats.totalLeads, 8);
  assert.equal(result.stats.newLeads, 5);
  assert.equal(result.stats.bookingLeads, 2, "booking requests are not completed bookings");
  assert.deepEqual({ ...result.stats.leadsByStatus }, { new_lead: 5, contacted: 2, booked: 1 });
  assert.equal(result.stats.leadsByDay.length, 7);
  assert.deepEqual(result.stats.leadsByDay.at(-1), { date: "2098-01-02", count: 2 });
  assert.equal(result.activity?.activeConversations, 5);
  assert.equal(result.activity?.inboundMessages, 11);
  assert.equal(result.activity?.assistantMessages, 7);
  assert.deepEqual(result.activity?.daily[0], { date: "2097-12-27", inboundMessages: 0, assistantMessages: 0 });
  assert.equal(result.attention?.pendingHandoffs, 4);
  assert.equal(result.attention?.newBookingRequests, 1);
  assert.equal(result.attention?.errors24h, 2);
  assert.equal(result.attention?.oldestPendingHandoffAt, "2097-12-28T03:00:00.000Z");
  assert.deepEqual(result.warnings, []);
  assert.match(result.faq!.week[0].question, /Вэлмор аялал/);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|example@example/);
});

test("unavailable optional data stays explicitly unknown while healthy metrics survive", async () => {
  for (const section of ["activity", "faq", "errors"] as const) {
    const result = await collectAdminAnalytics(fixtureQuery(section), 7, now);
    assert.equal(result.stats.totalLeads, 8);
    assert.equal(result.warnings.length, 1);
    if (section === "errors") assert.equal(result.attention?.errors24h, null);
    else assert.equal(result[section], null);
    assert.doesNotMatch(JSON.stringify(result), /Fixture .*unavailable/);
  }
});

test("missing core records and absent configuration cannot become an all-zero success", async () => {
  await assert.rejects(collectAdminAnalytics(fixtureQuery("core"), 7, now));
  await assert.rejects(collectAdminAnalytics(async () => null, 7, now));
  await assert.rejects(collectAdminAnalytics(async () => ({ rows: [] }), 7, now));
});

test("period windows cross month/year boundaries at agency midnight rather than host midnight", () => {
  const before = analyticsWindow(new Date("2098-01-01T15:59:59Z"), 7);
  const after = analyticsWindow(new Date("2098-01-01T16:00:00Z"), 30);
  assert.equal(before.dates.at(-1), "2098-01-01");
  assert.equal(after.dates.at(-1), "2098-01-02");
  assert.equal(after.dates.length, 30);
  assert.equal(after.start, "2097-12-03T16:00:00.000Z");
});

function response() {
  return { statusCode: 200, body: undefined as unknown, headers: {} as Record<string, unknown>,
    status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; },
    end() { return this; }, setHeader(name: string, value: unknown) { this.headers[name] = value; } };
}

test("analytics API protects access, rejects invalid periods and reports unavailable data honestly", async (context) => {
  applyTestEnv({ ADMIN_SECRET: "analytics-fixture-secret", NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/analytics-fixture" });
  const { Pool } = await import("pg");
  let reads = 0;
  context.mock.method(Pool.prototype, "query", async () => { reads++; throw new Error("Fixture DB failure"); });
  const { default: handler } = await import("../src/pages/api/admin/analytics");
  const request = (days?: unknown, authorized = true, method = "GET") => ({ method, headers: authorized ? { "x-admin-secret": "analytics-fixture-secret" } : {}, query: days === undefined ? {} : { days }, socket: {} }) as NextApiRequest;
  const run = async (req: NextApiRequest) => { const res = response(); await handler(req, res as unknown as NextApiResponse); return res; };
  try {
    assert.equal((await run(request(undefined, false))).statusCode, 401);
    for (const invalid of ["1", "all", ["7", "30"]]) assert.equal((await run(request(invalid))).statusCode, 400);
    assert.equal((await run(request("7", true, "POST"))).statusCode, 405);
    assert.equal(reads, 0, "invalid requests never touch customer data");
    const result = await run(request("30"));
    assert.equal(result.statusCode, 503);
    assert.equal((result.body as { ok: boolean }).ok, false);
    assert.equal(result.headers["Cache-Control"], "private, no-store");
    assert.doesNotMatch(JSON.stringify(result.body), /Fixture|postgres|fixture-secret/);
  } finally {
    const { closeNeonPool } = await import("../src/lib/neonDb");
    await closeNeonPool();
  }
});
