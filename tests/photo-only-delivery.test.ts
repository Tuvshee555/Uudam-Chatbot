import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("photo-only delivery distinguishes sent media, missing data and upstream failure", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/photo-delivery-fixture", BOOKING_DATABASE_URL: undefined });
  const { Pool } = await import("pg");
  let row: Record<string, unknown>;
  let leads = 0;
  const pauseReasons: unknown[] = [];
  const recorded: Array<{ role: unknown; attachments: Array<{ url: string }> }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_bot_control/i.test(sql)) return { rows: [{ photo_only: true, bot_paused: false }], rowCount: 1 };
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows: [row], rowCount: 1 };
    if (/INSERT INTO travel_leads/i.test(sql)) { leads++; return { rows: [{ id: leads }], rowCount: 1 }; }
    if (/INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) pauseReasons.push(params[1]);
    if (/INSERT INTO travel_conversations/i.test(sql)) recorded.push({ role: params[1], attachments: JSON.parse(String(params[3])) });
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  let failPhotos = new Set<string>();
  const sends: Array<Record<string, unknown>> = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    assert.match(String(input), /^https:\/\/graph\.facebook\.com\//, "no model calls or other live requests");
    const body = JSON.parse(String(init?.body || "{}"));
    if (body.message) sends.push(body.message);
    const image = body.message?.attachment?.payload?.url;
    return failPhotos.has(image) ? new Response("fixture failure", { status: 400 })
      : new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
  const { handlePhotoOnlyMode } = await import("../src/lib/webhookPhotoOnly");
  const { getPhotoOnlyState } = await import("../src/lib/photoOnlyState");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const replies: Array<{ reply: string; tag: string }> = [];
  const remembered: string[] = [];
  const run = async (senderId: string, extra: Record<string, unknown> = {}, photos: string[] = []) => {
    row = { id: "velmor", route_name: "Вэлмор аялал", status: "active", departure_dates: ["2098-03-17"],
      currency: "MNT", photo_urls: photos, extra };
    sends.length = 0; recorded.length = 0; replies.length = 0; remembered.length = 0;
    return handlePhotoOnlyMode({ platform: "facebook", senderId, pageId: "photo-page", token: "test-token",
      text: "Вэлмор аялал зураг", contextualUserText: "Вэлмор аялал зураг",
      rememberTurn: async (source) => { remembered.push(source); },
      deliverReply: async (reply, tag) => { replies.push({ reply, tag }); },
    });
  };
  try {
    await context.test("a successful brochure is recorded without generating a handoff", async () => {
      await run("photo-brochure", { source_file_attachment_id: "invented-file-id" });
      assert.equal(leads, 0);
      assert.equal(sends.length, 1);
      assert.deepEqual(replies, []);
      assert.deepEqual(recorded.filter((message) => message.role === "assistant").flatMap((message) => message.attachments), [{ type: "file", url: "invented-file-id" }]);
      assert.equal((await getPhotoOnlyState("photo-brochure"))?.activeTripId, "velmor");
    });
    await context.test("a published website needs no PDF and uses the shared text boundary", async () => {
      await run("photo-website", { website_slug: "velmor-invented-trip", website_published: true });
      assert.equal(leads, 0);
      assert.deepEqual(sends, [], "the module must not send text around the webhook boundary");
      assert.equal(replies.length, 1);
      assert.match(replies[0].reply, /\/trips\/velmor-invented-trip/);
      assert.equal(replies[0].tag, "photo_only_trip_link");
      assert.equal((await getPhotoOnlyState("photo-website"))?.activeTripId, "velmor");
    });
    await context.test("only accepted photos appear in conversation history", async () => {
      const accepted = "https://example.test/velmor-accepted.jpg";
      const failed = "https://example.test/velmor-failed.jpg";
      failPhotos = new Set([failed]);
      await run("photo-partial", {}, [accepted, failed]);
      assert.equal(sends.length, 2);
      assert.deepEqual(recorded.filter((message) => message.role === "assistant").flatMap((message) => message.attachments), [{ type: "image", url: accepted }]);
      assert.deepEqual(replies, []);
      assert.equal(leads, 0);
    });
    await context.test("complete photo failure is retryable and is never recorded as sent", async () => {
      const failed = "https://example.test/velmor-failed.jpg";
      failPhotos = new Set([failed]);
      await assert.rejects(run("photo-failure", {}, [failed]), /delivery_failed:photo_only_photos/);
      assert.deepEqual(recorded.filter((message) => message.role === "assistant"), []);
      assert.equal(await getPhotoOnlyState("photo-failure"), null);
      assert.deepEqual(replies, []);
      assert.deepEqual(remembered, []);
      assert.equal(leads, 0);
    });
    await context.test("missing media uses the shared silent handoff boundary", async () => {
      await run("photo-missing");
      assert.deepEqual(sends, []);
      assert.deepEqual(replies, [{ reply: "REFER", tag: "photo_only_no_photos" }]);
    });
    await context.test("the real webhook persists the missing-media lead without sending an answer or pausing", async () => {
      const webhook = await import("../src/pages/api/webhook");
      webhook.resetWebhookStateForTests();
      const payload = { object: "page", entry: [{ id: "1234567890", messaging: [{ sender: { id: "photo-webhook-missing" },
        message: { mid: "photo-missing-invented-event", text: "Вэлмор аялал зураг" } }] }] };
      const raw = Buffer.from(JSON.stringify(payload));
      const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json",
        "content-length": String(raw.length), "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
        async *[Symbol.asyncIterator]() { yield raw; } };
      let status = 200;
      const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; },
        end() { return res; }, setHeader() {}, get statusCode() { return status; } };
      const before = leads;
      sends.length = 0;
      await webhook.default(req as never, res as never);
      assert.equal(status, 200);
      assert.equal(leads, before + 1);
      // No pause: the customer's next, answerable message is still answered.
      assert.ok(!pauseReasons.includes("no_data_handoff"));
      assert.deepEqual(sends, []);
    });
  } finally { await closeNeonPool(); }
});
