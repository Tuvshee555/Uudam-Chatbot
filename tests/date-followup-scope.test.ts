import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test, { before } from "node:test";
import type { Pool } from "pg";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";

const now = new Date("2098-01-01T04:00:00.000Z");
const wanted = "2098-04-11";
let routing: typeof import("../src/lib/fastPathRouting");
let clarification: typeof import("../src/lib/clarificationState");
let selection: typeof import("../src/lib/tripSelectionState");

before(async () => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/date-scope-fixture", BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "off" });
  routing = await import("../src/lib/fastPathRouting");
  clarification = await import("../src/lib/clarificationState");
  selection = await import("../src/lib/tripSelectionState");
});

function trip(id: string, name: string, date: string): TravelTrip {
  return { id, route_name: name, category: "", operator_name: "Invented", duration_text: "3 өдөр 2 шөнө",
    adult_price: 1_234_567, child_price: null, infant_price: null, currency: "MNT", departure_dates: [date],
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { aliases: [id.startsWith("nerith") ? "Нерит" : "Вэлмор"] }, created_at: "", updated_at: "" };
}

const baseTrips = [trip("nerith-lake", "НЕРИТ НУУРЫН АЯЛАЛ", "2098-04-12"), trip("nerith-ridge", "НЕРИТ УУЛЫН АЯЛАЛ", "2098-04-16"), trip("velmor", "ВЭЛМОР ЦЭЦГИЙН АЯЛАЛ", wanted)];
const history = [{ role: "user" as const, text: "Нерит аялал" }, { role: "assistant" as const, text: "НЕРИТ НУУРЫН АЯЛАЛ\nНЕРИТ УУЛЫН АЯЛАЛ\nАль аяллыг нь сонирхож байна вэ?" }];

async function cleanup(sender: string) {
  await clarification.clearClarificationState(sender);
  await selection.setTripSelection(sender, null);
}

test("a missing date under an offered destination never reaches unrelated catalog matching or the model", async () => {
  const senderId = "date-scope-miss";
  await clarification.setClarificationState(senderId, baseTrips.slice(0, 2).map(trip => trip.id));
  let modelCalls = 0;
  try {
    const result = await routing.routeFastPathText({ senderId, text: "4.11 nii", contextualUserText: "4.11 nii", trips: baseTrips, history, now,
      understand: async () => { modelCalls++; return null; } });
    assert.equal(modelCalls, 0);
    assert.equal(result.chosenTripId, undefined);
    assert.equal(result.unavailableDateWithinScope, true);
    assert.deepEqual(result.scopedClarify?.map(trip => trip.id), ["nerith-lake", "nerith-ridge"]);
  } finally { await cleanup(senderId); }
});

test("a date shared by several offered trips retains exactly those candidates", async () => {
  const senderId = "date-scope-several";
  const trips = baseTrips.map(trip => ({ ...trip, departure_dates: [wanted] }));
  await clarification.setClarificationState(senderId, trips.slice(0, 2).map(trip => trip.id));
  try {
    const result = await routing.routeFastPathText({ senderId, text: "4.11 nii", contextualUserText: "4.11 nii", trips, history, now,
      understand: async () => { assert.fail("a scoped date does not need model interpretation"); } });
    assert.equal(result.unavailableDateWithinScope, false);
    assert.deepEqual(result.scopedClarify?.map(trip => trip.id), ["nerith-lake", "nerith-ridge"]);
    const { buildDateQuestionReply } = await import("../src/lib/travelFastPaths");
    const reply = buildDateQuestionReply("4.11 nii", result.matchText, result.scopedClarify || trips) || "";
    assert.match(reply, /НЕРИТ НУУРЫН АЯЛАЛ/);
    assert.match(reply, /НЕРИТ УУЛЫН АЯЛАЛ/);
    assert.doesNotMatch(reply, /ВЭЛМОР/);
  } finally { await cleanup(senderId); }
});

test("a date selects the one departing offered trip before any model guess", async () => {
  const senderId = "date-scope-one";
  const trips = [{ ...baseTrips[0], departure_dates: [wanted] }, ...baseTrips.slice(1)];
  await clarification.setClarificationState(senderId, trips.slice(0, 2).map(trip => trip.id));
  try {
    const result = await routing.routeFastPathText({ senderId, text: "4.11 nii", contextualUserText: "4.11 nii", trips, history, now,
      understand: async () => { assert.fail("a scoped date does not need model interpretation"); } });
    assert.equal(result.chosenTripId, "nerith-lake");
    assert.equal(result.selection?.date, wanted);
  } finally { await cleanup(senderId); }
});

test("a selected trip's missing date stays scoped, while an explicitly new destination can switch trips", async () => {
  const senderId = "date-scope-selected";
  await selection.setTripSelection(senderId, { tripId: "nerith-lake", date: "2098-04-12", hotel: null, package: null, passengers: [] });
  try {
    const miss = await routing.routeFastPathText({ senderId, text: "4.11 nii", contextualUserText: "4.11 nii", trips: baseTrips, now });
    assert.equal(miss.unavailableDateWithinScope, true);
    assert.deepEqual(miss.scopedClarify?.map(trip => trip.id), ["nerith-lake"]);
    const changed = await routing.routeFastPathText({ senderId, text: "Вэлмор аялал 2098-04-11", contextualUserText: "Вэлмор аялал 2098-04-11", trips: baseTrips, now });
    assert.equal(changed.chosenTripId, "velmor");
    assert.equal(changed.unavailableDateWithinScope, undefined);
  } finally { await cleanup(senderId); }
});

test("Messenger date follow-ups either hand off silently or answer only the offered destination", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now });
  const pg = await import("pg");
  let catalog = baseTrips;
  const conversations = new Map<string, Array<Record<string, unknown>>>();
  const leads: unknown[][] = [];
  const sends: string[] = [];
  let nextId = 1;
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/.test(sql)) return { rows: catalog };
    if (/SELECT id, role, text, attachments, created_at FROM travel_conversations/.test(sql)) {
      return { rows: [...(conversations.get(String(params[0])) || [])].reverse() };
    }
    if (/INSERT INTO travel_conversations/.test(sql)) {
      const rows = conversations.get(String(params[0])) || [];
      rows.push({ id: nextId++, role: params[1], text: params[2], attachments: [], created_at: now.toISOString() });
      conversations.set(String(params[0]), rows);
    }
    if (/INSERT INTO travel_leads/.test(sql)) {
      leads.push(params);
      return { rows: [{ id: leads.length, kind: params[0], platform: params[1], sender_id: params[2], customer_message: params[3], status: "new" }] };
    }
    return { rows: [] };
  };
  context.mock.method(pg.Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(pg.Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("api.openai.com")) return new Response(JSON.stringify({ choices: [{ message: { content: "REFER" } }] }), { status: 200 });
    if (url.includes("/messages")) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.message?.text) sends.push(body.message.text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
  const webhook = await import("../src/pages/api/webhook");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const send = async (sender: string, text: string) => {
    const payload = { object: "instagram", entry: [{ id: "date-scope-page", messaging: [{ sender: { id: sender }, message: { mid: `date-scope-${nextId++}`, text } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json", "content-length": String(raw.length),
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` }, async *[Symbol.asyncIterator]() { yield raw; } };
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
    await webhook.default(req as never, res as never);
    assert.equal(status, 200);
  };
  try {
    for (const matching of [false, true]) {
      const sender = `date-scope-messenger-${matching}`;
      webhook.resetWebhookStateForTests();
      catalog = matching ? baseTrips.map(trip => ({ ...trip, departure_dates: [wanted] })) : baseTrips;
      await send(sender, "Нерит аялал");
      assert.match(sends.at(-1) || "", /НЕРИТ/);
      sends.length = 0;
      const priorLeads = leads.length;
      await send(sender, "4.11 nii");
      if (matching) {
        assert.equal(sends.length, 1);
        assert.match(sends[0], /НЕРИТ НУУРЫН АЯЛАЛ/);
        assert.match(sends[0], /НЕРИТ УУЛЫН АЯЛАЛ/);
        assert.doesNotMatch(sends[0], /ВЭЛМОР/);
        assert.equal(leads.length, priorLeads);
      } else {
        assert.deepEqual(sends, []);
        assert.equal(leads.length, priorLeads + 1);
      }
      await cleanup(sender);
      sends.length = 0;
    }
  } finally { await closeNeonPool(); }
});
