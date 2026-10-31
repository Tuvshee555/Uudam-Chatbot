import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { TestContext } from "node:test";
import type { TravelTrip } from "../../src/lib/travelTypes";
import { applyTestEnv } from "./env";

export type FixtureTrip = TravelTrip & { id: string };
type HistoryRow = { id: number; sender_id: string; role: string; text: string; attachments: unknown[]; created_at: string };
type LeadRow = { id: number; sender_id: string; kind: string; platform: string; customer_message: string; contact_phone: string; context: string; status: string;
  lead_status: string; created_at: string; seen_at: string | null };
/** A Messenger thread as Meta's Conversations API returns it, or how reading it fails. */
export type ThreadScript =
  | { fail: "timeout" | "permission" | "api_error" | "incomplete" }
  | { messages: Array<{ from: "customer" | "page"; text?: string; agoMs: number; source?: "mobile" | "web" | "pages:private_reply"; id?: string }> };
export type ModelOverride = Partial<{ tripId: string; place: string | null; date: string | null; hotel: string | null;
  passengers: Array<{ kind: "adult" | "child"; count: number; age?: number }>; topics: string[]; certainty: string; intent: string; finalReply: string;
  /** The provider refuses every call (HTTP 429 insufficient_quota), as during the 2026-10-30 credit outage. */
  unavailable: boolean }>;

/** The actual handler runs unchanged; only external SQL/provider transports are replaced. */
export async function conversationGateHarness(context: TestContext, options: { env?: Record<string, string | undefined> } = {}) {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/conversation-gate",
    BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "on", STAFF_NOTIFY_PSIDS: undefined,
    TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STAFF_CHAT_IDS: undefined, ...options.env });
  context.mock.timers.enable({ apis: ["Date"], now: new Date("2098-02-01T04:00:00Z") });
  const history: HistoryRow[] = [], leads: LeadRow[] = [], sends: Array<{ senderId: string; text: string }> = [];
  const pauses = new Map<string, { paused: boolean; expires_at: string | null; pause_reason: string }>();
  const logs: Array<{ level: string; event: string; senderHash: string; fields: Record<string, unknown> }> = [];
  const failingRecipients = new Set<string>();
  const seen = new Map<string, number>();
  const models: Array<{ user: string; response: ModelOverride }> = [];
  const answerModels: string[] = [];
  const blockedNetwork: string[] = [];
  let catalog: FixtureTrip[] = [];
  let override: ModelOverride = {};
  let serial = 0;
  // Staff takeover (staffTakeover.ts): the scripted Meta thread per customer, the ids the bot
  // recorded for its own sends, and when a consultant last replied.
  const threads = new Map<string, ThreadScript>();
  const outbound = new Map<string, { recipient: string; at: number }>();
  const lastStaffReply = new Map<string, string>();
  // Which surface a consultant took over from (travel_senders.takeover_source).
  const takeoverSource = new Map<string, string>();
  // When staff handed the conversation back to the bot (travel_senders.bot_released_at).
  const released = new Map<string, string>();
  const graphAuth: Array<{ kind: "send" | "thread" | "other"; customer: string; token: string; proof: string }> = [];
  // Echo observations (travel_echo_events): shape and app id, never text (echoObserver.ts).
  const echoes: Array<{ recipient: string; appId: string; classification: string; hasBotMetadata: boolean; deliveredBy: string; verdict: string }> = [];
  // Runs once at the next model call: something that happens while the bot is composing.
  let duringModel: (() => void) | null = null;
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  /** Waits (real time, up to 2 s) until fire-and-forget writes make `done` true. Only Date is mocked. */
  const settle = async (done: () => boolean) => {
    for (let waited = 0; waited < 2000 && !done(); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  const query = async (sql: string, params: unknown[] = []) => {
    const sender = String(params[0] ?? "");
    if (/INSERT INTO travel_outbound_messages/i.test(sql)) {
      if (!outbound.has(sender)) outbound.set(sender, { recipient: String(params[1] ?? ""), at: Date.now() });
      return result();
    }
    if (/SELECT mid FROM travel_outbound_messages WHERE mid = ANY/i.test(sql)) {
      return result(((params[0] as string[]) || []).filter((mid) => outbound.has(mid)).map((mid) => ({ mid })));
    }
    if (/SELECT min\(created_at\) AS since FROM travel_outbound_messages/i.test(sql)) {
      const first = Math.min(...[...outbound.values()].map((entry) => entry.at));
      return result([{ since: Number.isFinite(first) ? new Date(first).toISOString() : null }]);
    }
    if (/SELECT created_at AS at, text FROM travel_conversations/i.test(sql)) {
      return result(history.filter((row) => row.sender_id === sender && row.role === "assistant").map((row) => ({ at: row.created_at, text: row.text })));
    }
    if (/UPDATE travel_senders SET last_staff_reply_at/i.test(sql)) {
      lastStaffReply.set(sender, String(params[1]));
      if (params[2]) takeoverSource.set(sender, String(params[2]));
      return result();
    }
    if (/SELECT bot_released_at AS released FROM travel_senders/i.test(sql)) {
      return result([{ released: released.get(sender) ?? null }]);
    }
    if (/INSERT INTO travel_echo_events/i.test(sql)) {
      echoes.push({ recipient: String(params[1]), appId: String(params[3]), hasBotMetadata: Boolean(params[4]),
        classification: String(params[5]), deliveredBy: String(params[8]), verdict: String(params[9] ?? "") });
      return result();
    }
    // A consultant's message read from the thread or proven by its echo (dbAppendStaffMessages):
    // role 'staff', stored once per Meta message id.
    if (/INSERT INTO travel_conversations \(sender_id, role, text, attachments, created_at, mid\)/i.test(sql)) {
      if (!history.some((row) => (row as HistoryRow & { mid?: string }).mid === String(params[3]))) {
        history.push(Object.assign({ id: (history.at(-1)?.id || 0) + 1, sender_id: sender, role: "staff", text: String(params[1]),
          attachments: [], created_at: String(params[2]) }, { mid: String(params[3]) }));
      }
      return result();
    }
    if (/AS staff,[\s\S]*AS assigned,[\s\S]*AS open/i.test(sql)) {
      const staffAt = lastStaffReply.get(sender);
      const releasedAt = released.get(sender);
      const open = leads.some((lead) => lead.sender_id === sender && ["new_lead", "contacted", "no_answer"].includes(lead.lead_status)
        && Date.now() - Date.parse(lead.created_at) < 3 * 86_400_000);
      return result([{ staff: Boolean(staffAt && Date.now() - Date.parse(staffAt) < 7 * 86_400_000
        && (!releasedAt || Date.parse(staffAt) > Date.parse(releasedAt))), assigned: false, open }]);
    }
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
      const id = (history.at(-1)?.id || 0) + 1;
      history.push({ id, sender_id: sender, role: String(params[1]), text: String(params[2]),
        attachments: JSON.parse(String(params[3] || "[]")), created_at: new Date().toISOString() });
      return result([{ id }]);
    }
    if (/DELETE FROM travel_conversations WHERE sender_id = \$1 AND role = 'user' AND id = ANY/i.test(sql)) {
      const ids = new Set((params[1] as number[]).map(Number));
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].sender_id === sender && history[index].role === "user" && ids.has(history[index].id)) history.splice(index, 1);
      }
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
        customer_message: String(params[3]), contact_phone: String(params[4] || ""), context: String(params[5]), status: "new",
        lead_status: "new_lead", created_at: new Date().toISOString(), seen_at: null };
      leads.push(lead); return result([lead]);
    }
    if (/INSERT INTO travel_error_logs/i.test(sql)) {
      logs.push({ level: String(params[0]), event: String(params[1]), senderHash: String(params[5] || ""), fields: JSON.parse(String(params[6] || "{}")) });
      return result();
    }
    if (/SELECT COUNT\(\*\)::int AS n FROM travel_error_logs WHERE event = 'webhook.inbound_outcome'/i.test(sql)) {
      return result([{ n: logs.filter(log => log.event === "webhook.inbound_outcome" && log.fields.eventKeyHash === params[0] && log.fields.status === "failed").length }]);
    }
    if (/SELECT \* FROM travel_leads WHERE sender_id = \$1/i.test(sql)) {
      const own = leads.filter(lead => lead.sender_id === sender).sort((a, b) => Number(b.kind === "booking") - Number(a.kind === "booking") || b.id - a.id);
      return result(own.slice(0, 1));
    }
    if (/UPDATE travel_leads SET status = 'new'/i.test(sql)) {
      const lead = leads.find(row => row.id === Number(params[0]));
      if (!lead) return result();
      lead.status = "new"; lead.seen_at = null; lead.context = `${lead.context}\n${String(params[1])}`;
      return result([{ id: lead.id }]);
    }
    if (/SELECT paused, expires_at(?:, pause_reason)? FROM travel_senders/i.test(sql)) return result(pauses.has(sender) ? [pauses.get(sender)!] : []);
    if (/INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) {
      pauses.set(sender, { paused: true, expires_at: String(params[2]), pause_reason: String(params[1]) }); return result();
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
    if (url === "https://api.openai.com/v1/chat/completions" && override.unavailable) {
      return new Response(JSON.stringify({ error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } }), { status: 429 });
    }
    if (url === "https://api.openai.com/v1/chat/completions") {
      if (duringModel) { const hook = duringModel; duringModel = null; hook(); }
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
    if (/^https:\/\/graph\.facebook\.com\//.test(url)) {
      // Which page token (and appsecret_proof) each Graph call used: the Meta-app migration sends
      // through one app or the other per customer.
      const { searchParams: params, pathname } = new URL(url);
      graphAuth.push({ kind: pathname.endsWith("/me/conversations") ? "thread" : pathname.endsWith("/me/messages") ? "send" : "other",
        customer: params.get("user_id") || String(body.recipient?.id || ""),
        token: params.get("access_token") || "", proof: params.get("appsecret_proof") || "" });
    }
    if (/^https:\/\/graph\.facebook\.com\/[^/]+\/me\/conversations\?platform=messenger&user_id=/.test(url)) {
      const customer = new URL(url).searchParams.get("user_id") || "";
      const script = threads.get(customer);
      if (script && "fail" in script) {
        if (script.fail === "timeout") throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
        if (script.fail === "permission") return Response.json({ error: { message: "(#200) Permissions error", code: 200 } }, { status: 403 });
        if (script.fail === "api_error") return Response.json({ error: { message: "An unknown error occurred", code: 1 } }, { status: 500 });
        return Response.json({ paging: {} });
      }
      const messages = (script?.messages ?? []).map((entry, index) => ({
        id: entry.id ?? `m_thread_${index}`,
        from: { id: entry.from === "page" ? "1234567890" : customer },
        message: entry.text ?? "",
        created_time: new Date(Date.now() - entry.agoMs).toISOString(),
        tags: { data: [{ name: "inbox" }, { name: "read" }, { name: "sent" }, ...(entry.from === "page" ? [{ name: `source:${entry.source ?? "web"}` }] : [])] },
      }));
      return Response.json(script ? { data: [{ messages: { data: messages } }] } : { data: [] });
    }
    if (/^https:\/\/graph\.(?:facebook|instagram)\.com\//.test(url)) {
      if (failingRecipients.has(String(body.recipient?.id || ""))) {
        return new Response(JSON.stringify({ error: { message: "(#100) Length of param message[text] must be less than or equal to 2000", code: 100 } }), { status: 400 });
      }
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
  /** POST one signed webhook delivery and collect the handler's effects. */
  const deliver = async (payload: unknown, signSecret = "test-meta-secret") => {
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json", "content-length": String(raw.length),
      "x-hub-signature-256": `sha256=${createHmac("sha256", signSecret).update(raw).digest("hex")}` },
      async *[Symbol.asyncIterator]() { yield raw; } };
    let status = 200;
    const res = { status(code: number) { status = code; return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, get statusCode() { return status; } };
    await webhook.default(req as never, res as never);
    return status;
  };
  const turn = async (senderId: string, text: string, model: ModelOverride = {}, eventId = `gate-event-${++serial}`,
    options: { platform?: "facebook" | "instagram"; signSecret?: string; postback?: boolean } = {}) => {
    override = model;
    const beforeSend = sends.length, beforeLead = leads.length, beforeModel = models.length, beforeAnswerModel = answerModels.length;
    // A button tap: no message, no mid — only the postback's title (webhook derives the text).
    const event = options.postback
      ? { sender: { id: senderId }, recipient: { id: "1234567890" }, timestamp: Date.now(), postback: { title: text, payload: text } }
      : { sender: { id: senderId }, recipient: { id: "1234567890" }, timestamp: Date.now(), message: { mid: eventId, text } };
    // Facebook (the configured fixture page): the bot reads the Messenger thread before replying.
    const payload = options.platform === "facebook"
      ? { object: "page", entry: [{ id: "1234567890", time: Date.now(), messaging: [event] }] }
      : { object: "instagram", entry: [{ id: "gate-page", messaging: [{ sender: { id: senderId }, message: { mid: eventId, text } }] }] };
    const status = await deliver(payload, options.signSecret);
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
  return { turn, demoTurn, history, leads, models, blockedNetwork, logs,
    /** Meta rejects every message to this customer (as the over-long replies of 2026-10-24). */
    failSends(senderId: string, failing = true) { if (failing) failingRecipients.add(senderId); else failingRecipients.delete(senderId); },
    catalog(value: FixtureTrip[]) { catalog = value; webhook.resetWebhookStateForTests(); },
    /** The Messenger thread Meta returns for this customer (or how reading it fails). */
    thread(senderId: string, script: ThreadScript) { threads.set(senderId, script); },
    /** Ids of the messages the bot sent (recorded at send time, staffTakeover.ts). */
    botMids() { return [...outbound.keys()]; },
    /** A consultant hands the conversation back ("Ботод буцаах"), as dbResumeSender writes it:
     * the pause is cleared AND bot_released_at is set, so the old staff reply still visible in
     * the thread no longer re-takes the conversation. */
    resume(senderId: string) { pauses.delete(senderId); released.set(senderId, new Date().toISOString()); },
    /** A message echo from Meta: the Page (any app) sent `customerId` a message. */
    async echoTurn(customerId: string, echo: { appId?: string | number; metadata?: string; text?: string; mid?: string;
      attachments?: Array<{ type?: string }>; signSecret?: string } = {}) {
      const beforeSend = sends.length, beforeEchoes = echoes.length;
      const status = await deliver({ object: "page", entry: [{ id: "1234567890", time: Date.now(), messaging: [{
        sender: { id: "1234567890" }, recipient: { id: customerId }, timestamp: Date.now(),
        message: { is_echo: true, mid: echo.mid ?? `m_echo_${++serial}`, ...(echo.appId === undefined ? {} : { app_id: echo.appId }),
          ...(echo.metadata === undefined ? {} : { metadata: echo.metadata }), ...(echo.text === undefined ? {} : { text: echo.text }),
          ...(echo.attachments === undefined ? {} : { attachments: echo.attachments }) } }] }] }, echo.signSecret);
      // recordEchoEvent is fire-and-forget; let it land before the test reads `echoes`. Every
      // accepted echo is recorded, so wait (up to 2 s) for its row rather than a single tick,
      // which was not enough on a loaded machine.
      await settle(() => status !== 200 || echoes.length > beforeEchoes);
      return { status, sends: sends.slice(beforeSend) };
    },
    /** The echo observations recorded so far (travel_echo_events). */
    echoes() { return [...echoes]; },
    /** Token and appsecret_proof of every Graph call (sends and thread reads), per customer. */
    graphAuth() { return [...graphAuth]; },
    /** A raw signed delivery (e.g. a `standby` entry); returns status and any sends it caused. */
    async rawDelivery(payload: unknown, signSecret?: string) {
      const beforeSend = sends.length;
      const status = await deliver(payload, signSecret);
      return { status, sends: sends.slice(beforeSend) };
    },
    pauseState(senderId: string) { return pauses.get(senderId) ?? null; },
    /** Which surface the consultant took over from, as markStaffReply recorded it. */
    takeoverSource(senderId: string) { return takeoverSource.get(senderId) ?? null; },
    /** Runs `hook` at the next model call — e.g. a consultant replies while the bot composes. */
    duringNextModelCall(hook: () => void) { duringModel = hook; },
    /** Waits (up to 2 s) for fire-and-forget writes — persisted logs, echo rows — to land. */
    settle,
    /** A staff member took this conversation over: the stored pause the webhook honours. */
    pause(senderId: string, until = new Date(Date.now() + 3 * 86_400_000).toISOString(), reason = "manual") { pauses.set(senderId, { paused: true, expires_at: until, pause_reason: reason }); },
    /** Staff changed the lead in the Leads tab (seen, or a CRM status such as "no_answer"). */
    updateLead(id: number, fields: Partial<Pick<LeadRow, "lead_status" | "status" | "seen_at">>) { Object.assign(leads.find(lead => lead.id === id)!, fields); },
    reset() { webhook.resetWebhookStateForTests(); },
    async close() { await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(blockedNetwork, [], "all nonfixture network must stay blocked"); await closeNeonPool(); },
  };
}
