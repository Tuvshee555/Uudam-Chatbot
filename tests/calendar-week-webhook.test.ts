import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("the webhook routes calendar weeks past whole-month lists and hands unsupported windows to staff silently", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/calendar-week-fixture", TRIP_UNDERSTANDING: "off" });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { Pool } = await import("pg");
  const rows = [1, 7, 8, 14, 15, 25, 31].map((day) => ({
    id: `week-${day}`, route_name: `ВЭЛМОР ${day} АЯЛАЛ`, currency: "MNT", status: "active", duration_text: "8 өдөр",
    departure_dates: [`2098-03-${String(day).padStart(2, "0")}`], photo_urls: [], extra: {},
  }));
  const leads: unknown[][] = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows, rowCount: rows.length };
    if (/INSERT INTO travel_leads/i.test(sql)) {
      leads.push(params);
      return { rows: [{ id: leads.length, kind: params[0], platform: params[1], sender_id: params[2], customer_message: params[3], status: "new" }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const sends: string[] = [];
  let aiCalls = 0;
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) {
      aiCalls++;
      return new Response(JSON.stringify({ choices: [{ message: { content: "REFER" } }] }), { status: 200 });
    }
    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.message?.text) sends.push(body.message.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  const webhook = await import("../src/pages/api/webhook");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  try {
    for (const [index, text] of [
      "3 сарын эхний 7 хоногт гарах аялал байна уу",
      "3 сарын эхний 7 хоногт биш 3 сарын сүүлийн 7 хоногт аялал байна уу",
      "3 сарын эхний 7 хоног эсвэл 4 сарын эхний 7 хоногт аялал байна уу",
    ].entries()) {
      webhook.resetWebhookStateForTests();
      sends.length = 0;
      const priorLeads = leads.length;
      const payload = { object: "instagram", entry: [{ id: "week-page", messaging: [{ sender: { id: `week-customer-${index}` }, message: { mid: `week-message-${index}`, text } }] }] };
      const raw = Buffer.from(JSON.stringify(payload));
      const req = {
        method: "POST", url: "/api/webhook", query: {},
        headers: { "content-type": "application/json", "content-length": String(raw.length), "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
        async *[Symbol.asyncIterator]() { yield raw; },
      };
      let status = 200;
      const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
      await webhook.default(req as never, res as never);
      assert.equal(status, 200);
      if (index === 0) {
        assert.equal(sends.length, 1);
        assert.match(sends[0], /3 сарын 1–7/);
        assert.match(sends[0], /ВЭЛМОР 7 АЯЛАЛ/);
        assert.doesNotMatch(sends[0], /ВЭЛМОР (?:8|14|15|25|31) АЯЛАЛ/);
        assert.equal(leads.length, priorLeads);
      } else {
        assert.deepEqual(sends, [], text);
        assert.equal(leads.length, priorLeads + 1, "unsupported constraints create a staff lead");
      }
    }
    assert.equal(aiCalls, 0, "all requests must use the grounded date path");
  } finally {
    await closeNeonPool();
  }
});
