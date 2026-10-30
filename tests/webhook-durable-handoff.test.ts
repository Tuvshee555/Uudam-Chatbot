import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("the webhook retries unavailable grounding and handoff persistence before completing events", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/webhook-durable-fixture", BOOKING_DATABASE_URL: undefined,
    TRIP_UNDERSTANDING: "off", STAFF_NOTIFY_PSIDS: undefined, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STAFF_CHAT_IDS: undefined });
  const { Pool } = await import("pg");
  let failLead = false;
  let failGrounding = false;
  let groundingReadFailed = false;
  let failedSends = 0;
  const leads = new Set<string>();
  const pauses: string[] = [];
  const messages: Array<{ senderId: string; role: string; text: string }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) {
      if (failGrounding && /getGroundingTrips/.test(new Error().stack || "")) {
        groundingReadFailed = true;
        throw new Error("fixture grounding catalog unavailable");
      }
      return { rows: [{ id: "velmor", route_name: "Вэлмор аялал", status: "active", duration_text: "5 өдөр",
        departure_dates: ["2098-03-17"], adult_price: 1_700_000, currency: "MNT", photo_urls: [], extra: {} }], rowCount: 1 };
    }
    if (/COUNT[\s\S]*FROM travel_leads/i.test(sql)) return { rows: [{ count: leads.has(String(params[0])) ? "1" : "0" }], rowCount: 1 };
    if (/INSERT INTO travel_leads/i.test(sql)) {
      if (failLead) throw new Error("fixture lead insertion unavailable");
      leads.add(String(params[2]));
      return { rows: [{ id: leads.size, kind: params[0], platform: params[1], sender_id: params[2], status: "new" }], rowCount: 1 };
    }
    if (/INSERT INTO travel_conversations/i.test(sql)) messages.push({ senderId: String(params[0]), role: String(params[1]), text: String(params[2]) });
    if (/UPDATE travel_senders[\s\S]*pause_reason = 'auto_handoff'/i.test(sql) || /INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) pauses.push(String(params[0]));
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const sends: string[] = [];
  let modelCalls = 0;
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) { modelCalls++; throw new Error("Unexpected model call"); }
    assert.match(url, /^https:\/\/graph\.(?:facebook|instagram)\.com\//);
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.message?.text) {
      if (failedSends > 0) { failedSends--; return new Response("fixture send failure", { status: 500 }); }
      sends.push(body.message.text);
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const webhook = await import("../src/pages/api/webhook");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const { getMetricsSnapshot } = await import("../src/lib/observability");
  const call = async (senderId: string, text: string) => {
    const payload = { object: "instagram", entry: [{ id: "durable-page", messaging: [{ sender: { id: senderId },
      message: { mid: `${senderId}-event`, text } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json",
      "content-length": String(raw.length), "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
      async *[Symbol.asyncIterator]() { yield raw; } };
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; },
      end() { return res; }, setHeader() {}, get statusCode() { return status; } };
    await webhook.default(req as never, res as never);
    return status;
  };
  const reset = () => { webhook.resetWebhookStateForTests(); sends.length = 0; pauses.length = 0; messages.length = 0; };
  try {
    await context.test("a failed exit-grounding read sends nothing and leaves the event retryable", async () => {
      reset();
      failGrounding = true;
      assert.equal(await call("grounding-failure", "Вэлмор аялал үнэ хэд вэ"), 503);
      assert.ok(groundingReadFailed, "the injected failure must occur in the final exit-grounding read");
      assert.ok(getMetricsSnapshot().counters.some((counter) => counter.name === "webhook.retryable_failure_total" && counter.tags.reason === "grounding_unavailable"));
      assert.deepEqual(sends, []);
      assert.equal(pauses.length, 0);
      assert.equal(webhook.getWebhookRuntimeDiagnostics().processedEvents, 0);
      failGrounding = false;
      assert.equal(await call("grounding-failure", "Вэлмор аялал үнэ хэд вэ"), 200);
      assert.equal(sends.length, 1);
      assert.match(sends[0], /1,700,000/);
      assert.equal(webhook.getWebhookRuntimeDiagnostics().processedEvents, 1);
      assert.equal(await call("grounding-failure", "Вэлмор аялал үнэ хэд вэ"), 200);
      assert.equal(sends.length, 1, "completed event redelivery cannot send a duplicate answer");
    });
    await context.test("an operator request cannot pause or claim handoff until its lead persists", async () => {
      reset();
      failLead = true;
      assert.equal(await call("operator-lead-failure", "Зөвлөхтэй холбогдох"), 503);
      assert.deepEqual(sends, []);
      assert.equal(pauses.length, 0);
      assert.equal(webhook.getWebhookRuntimeDiagnostics().processedEvents, 0);
      failLead = false;
      assert.equal(await call("operator-lead-failure", "Зөвлөхтэй холбогдох"), 200);
      assert.equal(sends.length, 1);
      assert.ok(leads.has("operator-lead-failure"));
      assert.ok(pauses.includes("operator-lead-failure"));
      assert.ok(messages.some((message) => message.senderId === "operator-lead-failure" && message.role === "user" && message.text === "Зөвлөхтэй холбогдох"));
      assert.equal(await call("operator-lead-failure", "Зөвлөхтэй холбогдох"), 200);
      assert.equal(sends.length, 1);
    });
    await context.test("phone-only capture retains the inbound message alongside the persisted booking lead", async () => {
      reset();
      assert.equal(await call("phone-only-retention", "99110000"), 200);
      assert.ok(leads.has("phone-only-retention"));
      assert.ok(pauses.includes("phone-only-retention"));
      assert.equal(sends.length, 1);
      assert.ok(messages.some((message) => message.senderId === "phone-only-retention" && message.role === "user" && message.text === "99110000"));
    });
    await context.test("a question containing a phone number pauses only after its answer is accepted", async () => {
      reset();
      failedSends = 1;
      const text = "Вэлмор аялал үнэ хэд вэ 99110000";
      assert.equal(await call("phone-question-send-failure", text), 503);
      assert.ok(leads.has("phone-question-send-failure"));
      assert.deepEqual(sends, []);
      assert.equal(pauses.length, 0);
      assert.equal(webhook.getWebhookRuntimeDiagnostics().processedEvents, 0);
      assert.equal(await call("phone-question-send-failure", text), 200);
      assert.equal(sends.length, 1);
      assert.match(sends[0], /1,700,000/);
      assert.ok(pauses.includes("phone-question-send-failure"));
    });
    assert.equal(modelCalls, 0, "deterministic regressions must not call a model");
  } finally { await closeNeonPool(); }
});
