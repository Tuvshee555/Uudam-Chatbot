import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { BOOKING_WEBSITE_URL } from "../src/lib/bookingWebsite";
import { applyTestEnv } from "./helpers/env";

test("the webhook carries official website identity through grounded price and program replies", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/web-journey-fixture", BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "off" });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00Z") });
  const { Pool } = await import("pg");
  const rows = [{ id: "web-a", route_name: "ВЭЛМОР АЯЛАЛ", currency: "MNT", adult_price: 1_700_000,
    status: "active", duration_text: "8 өдөр", departure_dates: ["2098-03-17"], photo_urls: [],
    extra: { website_slug: "trip-0123456789abcdef0123", website_published: true } }];
  let leads = 0;
  const query = async (sql: string) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows, rowCount: rows.length };
    if (/INSERT INTO travel_leads/i.test(sql)) { leads++; return { rows: [{ id: leads }], rowCount: 1 }; }
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
  const { getTripSelection, setTripSelection } = await import("../src/lib/tripSelectionState");
  const page = `${BOOKING_WEBSITE_URL}/trips/trip-0123456789abcdef0123`;
  try {
    for (const [index, text] of [`${page}?date=2098-03-10 үнэ хэд вэ`, `${page} хөтөлбөр`, `${BOOKING_WEBSITE_URL}/trips/velmor-old-page үнэ хэд вэ`].entries()) {
      webhook.resetWebhookStateForTests();
      const senderId = `web-customer-${index}`;
      if (index === 2) await setTripSelection(senderId, { tripId: "web-a", date: null, hotel: null, package: null, passengers: [] });
      sends.length = 0;
      const previousLeads = leads;
      const payload = { object: "instagram", entry: [{ id: "web-page", messaging: [{ sender: { id: senderId }, message: { mid: `web-message-${index}`, text } }] }] };
      const raw = Buffer.from(JSON.stringify(payload));
      const req = { method: "POST", url: "/api/webhook", query: {},
        headers: { "content-type": "application/json", "content-length": String(raw.length), "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
        async *[Symbol.asyncIterator]() { yield raw; } };
      let status = 200;
      const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
      await webhook.default(req as never, res as never);
      assert.equal(status, 200);
      if (index === 0) {
        assert.equal(sends.length, 1);
        assert.equal((await getTripSelection(senderId))?.tripId, "web-a");
        assert.match(sends[0], /1,700,000/);
      } else if (index === 1) {
        assert.equal(sends.length, 1);
        assert.ok(sends[0].includes(page), "program reply uses the current website even without a stored PDF");
      } else {
        assert.deepEqual(sends, [], "unknown website page must not borrow the old selection");
        assert.equal(leads, previousLeads + 1);
      }
      await setTripSelection(senderId, null);
    }
    assert.equal(aiCalls, 0);
  } finally { await closeNeonPool(); }
});
