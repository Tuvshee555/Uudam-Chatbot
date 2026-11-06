/**
 * A trip staff hid from customers (the admin's "Харагдах эсэх" off: extra.customer_visible ===
 * false) is never offered, matched or quoted by the customer bot (2026-11-06). The knowledge
 * text already left it out; the webhook's fast-path trip lists did not. Trip names and prices
 * are invented.
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";
import { buildStructuredTripReply, findTripMatches, isHiddenFromCustomers, resolveTripFromUserMessage, withoutHiddenTrips } from "../src/lib/travelFastPaths";

const NOW = new Date("2026-11-06T04:00:00Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t", category: "Аялал", operator_name: "Uudam", route_name: "Аялал", duration_text: "5 өдөр 4 шөнө",
    adult_price: 1_111_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: ["2026-12-02"],
    seats_total: null, seats_left: null, has_food: true, status: "active", notes: "", hotel: "", source_description: "",
    photo_urls: [], extra: {}, created_at: "", updated_at: "", ...fields,
  };
}

const shown = trip({ id: "velmor", route_name: "Вэлмор далайн аялал" });
const hidden = trip({ id: "narvel", route_name: "Нарвэл уулын аялал", adult_price: 1_234_000, extra: { customer_visible: false } });

test("a hidden trip is left out of the customer catalogue and never matched by name", () => {
  assert.equal(isHiddenFromCustomers(hidden), true);
  assert.equal(isHiddenFromCustomers(shown), false);
  assert.equal(isHiddenFromCustomers(trip({ extra: { customer_visible: true } })), false);
  const catalogue = withoutHiddenTrips([shown, hidden]);
  assert.deepEqual(catalogue.map((t) => t.id), ["velmor"]);
  // Over the customer catalogue the hidden trip is neither matched by its own name nor quoted.
  assert.equal(resolveTripFromUserMessage("Нарвэл уулын аялал", catalogue).status, "not_found");
  assert.deepEqual(findTripMatches("Нарвэл уулын аялал үнэ", catalogue).map((match) => match.trip.id), []);
  assert.doesNotMatch(buildStructuredTripReply("Нарвэл уулын аялал үнэ хэд вэ", catalogue, NOW) || "", /Нарвэл|1,234,000/);
  // The visible trip still answers.
  assert.match(buildStructuredTripReply("Вэлмор далайн аялал үнэ хэд вэ", catalogue, NOW) || "", /1,111,000₮/);
  // The matcher itself still knows the hidden trip: the admin assistant finds trips with it,
  // and "show it again" has to find a hidden one.
  assert.deepEqual(findTripMatches("Нарвэл уулын аялал", [shown, hidden]).map((match) => match.trip.id), ["narvel"]);
});

test("the webhook never lists, matches or quotes a hidden trip", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/hidden-trip-fixture", TRIP_UNDERSTANDING: "off" });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { Pool } = await import("pg");
  const rows = [
    { id: "week-shown", route_name: "ВЭЛМОР ДАЛАЙН АЯЛАЛ", currency: "MNT", status: "active", duration_text: "8 өдөр", adult_price: 1_111_000,
      departure_dates: ["2098-03-03"], photo_urls: [], extra: {} },
    { id: "week-hidden", route_name: "НАРВЭЛ УУЛЫН АЯЛАЛ", currency: "MNT", status: "active", duration_text: "8 өдөр", adult_price: 1_234_000,
      departure_dates: ["2098-03-05"], photo_urls: [], extra: { customer_visible: false } },
  ];
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
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // The model is mocked: it never answers (REFER), so whatever reaches the customer is a fast path.
    if (url.includes("api.openai.com")) return new Response(JSON.stringify({ choices: [{ message: { content: "REFER" } }] }), { status: 200 });
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
  const send = async (index: number, text: string) => {
    webhook.resetWebhookStateForTests();
    sends.length = 0;
    const payload = { object: "instagram", entry: [{ id: "hidden-page", messaging: [{ sender: { id: `hidden-customer-${index}` }, message: { mid: `hidden-message-${index}`, text } }] }] };
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
    return [...sends];
  };
  try {
    // A date-window list names the visible trip and never the hidden one beside it.
    const listed = await send(0, "3 сарын эхний 7 хоногт гарах аялал байна уу");
    assert.equal(listed.length, 1);
    assert.match(listed[0], /ВЭЛМОР ДАЛАЙН АЯЛАЛ/);
    assert.doesNotMatch(listed[0], /НАРВЭЛ|1,234,000/);
    // Asked by its own name, the hidden trip is not quoted: no fast path knows it.
    const named = await send(1, "НАРВЭЛ УУЛЫН АЯЛАЛ үнэ хэд вэ");
    assert.ok(named.every((reply) => !/НАРВЭЛ|1,234,000/.test(reply)), named.join("\n---\n"));
  } finally {
    await closeNeonPool();
  }
});

// Photos and files: photo-only mode and the reply-media sender load their own trip lists, so
// they need the same filter (review 2026-11-06: photo-only mode sent a hidden trip's photo).
const SHOWN_PHOTO = "https://res.cloudinary.com/invented/image/upload/shown-velmor-1.jpg";
const HIDDEN_PHOTO = "https://res.cloudinary.com/invented/image/upload/hidden-narvel-1.jpg";
const mediaRows = [
  { id: "media-shown", route_name: "ВЭЛМОР ДАЛАЙН АЯЛАЛ", currency: "MNT", status: "active", duration_text: "8 өдөр", adult_price: 1_111_000,
    departure_dates: ["2098-03-03"], photo_urls: [SHOWN_PHOTO], extra: {} },
  { id: "media-hidden", route_name: "НАРВЭЛ УУЛЫН АЯЛАЛ", currency: "MNT", status: "active", duration_text: "8 өдөр", adult_price: 1_234_000,
    departure_dates: ["2098-03-05"], photo_urls: [HIDDEN_PHOTO], extra: { customer_visible: false, source_file_attachment_id: "invented-hidden-file" } },
];

async function mockMediaWorld(context: test.TestContext, photoOnly: boolean) {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/hidden-media-fixture", TRIP_UNDERSTANDING: "off" });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00.000Z") });
  const { Pool } = await import("pg");
  const query = async (sql: string) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows: mediaRows, rowCount: mediaRows.length };
    if (photoOnly && /SELECT[\s\S]*FROM travel_bot_control/i.test(sql)) return { rows: [{ photo_only: true, bot_paused: false }], rowCount: 1 };
    if (/INSERT INTO travel_leads/i.test(sql)) return { rows: [{ id: 1, status: "new" }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  // Every message body sent to Messenger (text, image, file), as JSON text.
  const sent: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    // The model is mocked: no paid call is ever made.
    if (url.includes("api.openai.com")) return new Response(JSON.stringify({ choices: [{ message: { content: "REFER" } }] }), { status: 200 });
    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.message) sent.push(JSON.stringify(body.message));
    }
    return new Response(JSON.stringify({ recipient_id: "x", message_id: "m" }), { status: 200 });
  });
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  return sent;
}

test("photo-only mode never sends a hidden trip's photos or file", async (context) => {
  const sent = await mockMediaWorld(context, true);
  const webhook = await import("../src/pages/api/webhook");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const send = async (index: number, text: string) => {
    webhook.resetWebhookStateForTests();
    sent.length = 0;
    const payload = { object: "page", entry: [{ id: "1234567890", time: Date.now(), messaging: [{ sender: { id: `photo-only-customer-${index}` },
      recipient: { id: "1234567890" }, timestamp: Date.now(), message: { mid: `photo-only-message-${index}`, text } }] }] };
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
    return [...sent];
  };
  try {
    for (const [index, text] of ["НАРВЭЛ УУЛЫН АЯЛАЛ", "Нарвэл уулын аялал зураг"].entries()) {
      const out = await send(index, text);
      assert.ok(out.every((message) => !/hidden-narvel|invented-hidden-file|НАРВЭЛ/.test(message)), out.join("\n---\n"));
    }
    // The visible trip still gets its photo in photo-only mode.
    const shown = await send(9, "Вэлмор далайн аялал зураг");
    assert.ok(shown.some((message) => /shown-velmor-1\.jpg/.test(message)), shown.join("\n---\n"));
  } finally {
    await closeNeonPool();
  }
});

test("reply media never sends a hidden trip's photos or file", async (context) => {
  const sent = await mockMediaWorld(context, false);
  const { sendTripMediaForReply } = await import("../src/lib/webhookMedia");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const reply = "Аяллын зургуудыг доор хавсаргалаа.";
  try {
    await sendTripMediaForReply("facebook", "media-customer-1", reply, "НАРВЭЛ УУЛЫН АЯЛЛЫН зураг явуулаач", "test-page-token", "1234567890");
    assert.ok(sent.every((message) => !/hidden-narvel|invented-hidden-file/.test(message)), sent.join("\n---\n"));
    sent.length = 0;
    await sendTripMediaForReply("facebook", "media-customer-2", reply, "ВЭЛМОР ДАЛАЙН АЯЛЛЫН зураг явуулаач", "test-page-token", "1234567890");
    assert.ok(sent.some((message) => /shown-velmor-1\.jpg/.test(message)), sent.join("\n---\n"));
  } finally {
    await closeNeonPool();
  }
});
