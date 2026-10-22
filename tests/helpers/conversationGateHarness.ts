import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { TestContext } from "node:test";
import type { TravelTrip } from "../../src/lib/travelTypes";
import { applyTestEnv } from "./env";

export type FixtureTrip = TravelTrip & { id: string };
type HistoryRow = { id: number; sender_id: string; role: string; text: string; attachments: unknown[]; created_at: string };
type LeadRow = { id: number; sender_id: string; kind: string; platform: string; customer_message: string; context: string; status: string };
export type ModelOverride = Partial<{ tripId: string; place: string | null; date: string | null; hotel: string | null;
  passengers: Array<{ kind: "adult" | "child"; count: number; age?: number }>; topics: string[]; certainty: string; intent: string; finalReply: string }>;

/** The actual handler runs unchanged; only external SQL/provider transports are replaced. */
export async function conversationGateHarness(context: TestContext) {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/conversation-gate",
    BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "on", STAFF_NOTIFY_PSIDS: undefined,
    TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STAFF_CHAT_IDS: undefined });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00Z") });
  const history: HistoryRow[] = [], leads: LeadRow[] = [], sends: Array<{ senderId: string; text: string }> = [];
  const pauses = new Map<string, { paused: boolean; expires_at: string | null }>();
  const seen = new Map<string, number>();
  const models: Array<{ user: string; response: ModelOverride }> = [];
  const answerModels: string[] = [];
  const blockedNetwork: string[] = [];
  let catalog: FixtureTrip[] = [];
  let override: ModelOverride = {};
  let serial = 0;
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const query = async (sql: string, params: unknown[] = []) => {
    const sender = String(params[0] ?? "");
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) {
      if (/WHERE\s+id\s*=\s*\$1/i.test(sql)) return result(catalog.filter(trip => trip.id === sender));
      if (params[1] === "archived") return result();
      return result(catalog);
    }
    if (/SELECT[\s\S]*FROM travel_bot_settings/i.test(sql)) return result([{
      business_name: "Fixture agency", system_prompt: "Use catalog facts only", handoff_enabled: true,
      handoff_keywords: [], quick_info_keywords: [], chat_buttons: [],
      extra: { greeting: { enabled: false }, goodbye: { enabled: false }, reminder_enabled: false },
    }]);
    if (/SELECT[\s\S]*FROM travel_(?:bot_control|page_control)/i.test(sql)) return result([{ bot_paused: false, photo_only: false }]);
    if (/INSERT INTO travel_conversations/i.test(sql)) {
      history.push({ id: history.length + 1, sender_id: sender, role: String(params[1]), text: String(params[2]),
        attachments: JSON.parse(String(params[3] || "[]")), created_at: new Date().toISOString() });
      return result();
    }
    if (/SELECT[\s\S]*FROM travel_conversations/i.test(sql)) {
      const rows = history.filter(row => row.sender_id === sender);
      return /id > \$2/.test(sql) ? result(rows.filter(row => row.id > Number(params[1])))
        : result(rows.slice(-Number(params[1] || 50)).reverse());
    }
    if (/COUNT[\s\S]*FROM travel_leads/i.test(sql)) return result([{ count: String(leads.filter(lead => lead.sender_id === sender && lead.kind === params[1]).length) }]);
    if (/INSERT INTO travel_leads/i.test(sql)) {
      const lead = { id: leads.length + 1, kind: String(params[0]), platform: String(params[1]), sender_id: String(params[2]),
        customer_message: String(params[3]), context: String(params[5]), status: "new" };
      leads.push(lead); return result([lead]);
    }
    if (/SELECT paused, expires_at FROM travel_senders/i.test(sql)) return result(pauses.has(sender) ? [pauses.get(sender)!] : []);
    if (/INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) {
      pauses.set(sender, { paused: true, expires_at: String(params[2]) }); return result();
    }
    if (/INSERT INTO travel_senders \(sender_id, platform,/i.test(sql)) {
      seen.set(sender, (seen.get(sender) || 0) + 1);
      return result([{ msg_count: seen.get(sender), prev_msg_at: null, get_started_at: null }]);
    }
    // Memory projections, document stores and nonessential claims start empty;
    // the full turn history above stays durable across handler invocations.
    return result();
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body || "{}"));
    if (url === "https://api.openai.com/v1/chat/completions") {
      const messages = body.messages as Array<{ content: string | Array<{ text?: string }> }>;
      const prompt = messages.map(message => typeof message.content === "string" ? message.content : message.content.map(part => part.text || "").join("\n")).join("\n");
      let content = "REFER";
      if (prompt.includes("Catalog (key | name | length | next departures):")) {
        const target = catalog.find(trip => trip.id === override.tripId);
        const key = [...prompt.matchAll(/^(T\d+) \| ([^|\n]+)/gm)].find(match => target && match[2].trim().startsWith(target.route_name))?.[1];
        const response = { place: null, intent: "trip", topics: ["price"], trips: key ? [key] : [], certainty: key ? "one" : "none",
          date: null, from: null, to: null, month: null, days: null, transport: null, hotel: null, package: null, passengers: [], unknown_destination: null,
          ...override };
        delete (response as Record<string, unknown>).tripId;
        delete (response as Record<string, unknown>).finalReply;
        models.push({ user: prompt, response: override });
        content = JSON.stringify(response);
      } else if (prompt.includes("maintain long-term memory")) content = "";
      else if (prompt.includes("Reply rules:")) { answerModels.push(prompt); content = override.finalReply || "REFER"; }
      return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 });
    }
    if (/^https:\/\/graph\.(?:facebook|instagram)\.com\//.test(url)) {
      if (body.message?.text) sends.push({ senderId: String(body.recipient?.id || ""), text: body.message.text });
      return new Response(JSON.stringify({ recipient_id: body.recipient?.id || "fixture", message_id: `fixture-${++serial}`, data: [] }), { status: 200 });
    }
    blockedNetwork.push(url);
    throw new Error(`Conversation gate blocked unexpected network endpoint: ${new URL(url).hostname}`);
  });
  const env = await import("../../src/lib/env");
  env.resetEnvCacheForTests();
  const webhook = await import("../../src/pages/api/webhook");
  const demo = await import("../../src/pages/api/demo");
  const { getTripSelection } = await import("../../src/lib/tripSelectionState");
  const { closeNeonPool } = await import("../../src/lib/neonDb");
  const turn = async (senderId: string, text: string, model: ModelOverride = {}, eventId = `gate-event-${++serial}`) => {
    override = model;
    const beforeSend = sends.length, beforeLead = leads.length, beforeModel = models.length, beforeAnswerModel = answerModels.length;
    const payload = { object: "instagram", entry: [{ id: "gate-page", messaging: [{ sender: { id: senderId }, message: { mid: eventId, text } }] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json", "content-length": String(raw.length),
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` },
      async *[Symbol.asyncIterator]() { yield raw; } };
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
    await webhook.default(req as never, res as never);
    if (process.env.CONVERSATION_GATE_TRACE === "1") console.log(`CONVERSATION_GATE_TURN ${JSON.stringify({ senderId, text, sends: sends.slice(beforeSend), selection: await getTripSelection(senderId) })}`);
    return { status, sends: sends.slice(beforeSend), leads: leads.slice(beforeLead), modelCalls: models.length - beforeModel, answerModelCalls: answerModels.length - beforeAnswerModel,
      selection: await getTripSelection(senderId), history: history.filter(row => row.sender_id === senderId) };
  };
  const demoTurn = async (conversationId: string, text: string, model: ModelOverride = {}) => {
    override = model;
    let status = 200;
    let body: Record<string, unknown> = {};
    const req = { method: "POST", url: "/api/demo", query: {}, headers: { "x-uudam-demo-qa": "1" },
      body: { text, conversationId }, socket: { remoteAddress: "127.0.0.1" } };
    const res = { status(code: number) { status = code; return res; }, json(value: Record<string, unknown>) { body = value; return res; },
      send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
    await demo.default(req as never, res as never);
    const senderId = `demo:${conversationId}`;
    return { status, body, selection: await getTripSelection(senderId), history: history.filter(row => row.sender_id === senderId) };
  };
  return { turn, demoTurn, history, leads, models, blockedNetwork,
    catalog(value: FixtureTrip[]) { catalog = value; webhook.resetWebhookStateForTests(); },
    reset() { webhook.resetWebhookStateForTests(); },
    async close() { await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(blockedNetwork, [], "all nonfixture network must stay blocked"); await closeNeonPool(); },
  };
}
