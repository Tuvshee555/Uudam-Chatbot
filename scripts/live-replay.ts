/**
 * Live conversation replay (npm run qa:live): customer journeys through the REAL webhook handler,
 * with a read-only snapshot of the live catalogue and the REAL model. Database writes stay in
 * memory and every Meta send is captured, so nothing reaches a customer and nothing is stored.
 *
 * Fails when a reply carries an amount or date the catalogue does not hold, a total that does not
 * add up, or a code placeholder. Scenarios: LIVE_SCENARIOS (default scripts/live-replay-scenarios.json).
 * Directives: "#tapN" sends the Nth quick-reply button just offered, "#pause" is a staff takeover,
 * "#later" ages the conversation by 40 days. The report (customer text) goes to tmp/, never to Git.
 * Spends model credit, so it runs only through scripts/lib/evalGuard.mjs: EVAL_RUN_APPROVED=1 for this run, at most
 * EVAL_MAX_MODEL_CALLS calls, one run at a time.
 * Needs NEON_DATABASE_URL (read only).
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { evaluationCallBudget, requireApprovedEvaluation } from "./lib/evalGuard.mjs";
import { processAiTotals } from "../src/lib/aiUsage";
import test from "node:test";

/** channel "facebook" sends through the Page (the production channel); Instagram otherwise. */
type Scenario = { id: string; turns: string[]; channel?: "facebook" | "instagram" };
const scenarios: Scenario[] = JSON.parse(readFileSync(process.env.LIVE_SCENARIOS || "scripts/live-replay-scenarios.json", "utf8"));

test("live replay", { timeout: 900_000 }, async (context) => {
  // The replay spends model credit, so it is opted in and capped: on 2026-10-30 a day of
  // uncontrolled replays helped exhaust the balance.
  const turnCount = scenarios.reduce((count, scenario) => count + scenario.turns.length, 0);
  const openaiKey = requireApprovedEvaluation({ name: "live replay", estimatedModelCalls: turnCount * 3 });
  const callBudget = evaluationCallBudget();
  let modelCalls = 0;

  // 1. Snapshot the real catalogue + settings on a separate read-only connection. The bot's own
  // database module is only loaded after the fixture URL is in place: loaded first, it kept the
  // production URL and late log writes reached the production error log.
  const { Client } = await import("pg");
  const snapshot = new Client({ connectionString: process.env.NEON_DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await snapshot.connect();
  const catalogRows = (await snapshot.query("SELECT * FROM travel_trip_entries")).rows as Array<{ id: string; status: string }>;
  const settingsRow = (await snapshot.query("SELECT * FROM travel_bot_settings LIMIT 1")).rows[0];
  await snapshot.end();
  assert.ok(catalogRows.length > 0);
  const { applyTestEnv } = await import("../tests/helpers/env");
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/live-replay", BOOKING_DATABASE_URL: undefined,
    OPENAI_API_KEY: openaiKey, TRIP_UNDERSTANDING: "on", OPENAI_TIMEOUT_MS: "45000", OPENAI_MAX_RETRIES: "1",
    STAFF_NOTIFY_PSIDS: undefined, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STAFF_CHAT_IDS: undefined });

  // 2. In-memory database (same contract as tests/helpers/conversationGateHarness.ts).
  const history: Array<{ id: number; sender_id: string; role: string; text: string; attachments: unknown[]; created_at: string }> = [];
  const leads: Array<Record<string, string>> = [];
  const pauses = new Map<string, { paused: boolean; expires_at: string | null; pause_reason: string }>();
  const seen = new Map<string, number>();
  const quick = new Set<string>();
  const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length });
  const query = async (sql: string, params: unknown[] = []) => {
    const sender = String(params[0] ?? "");
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) {
      if (/WHERE\s+id\s*=\s*\$1/i.test(sql)) return result(catalogRows.filter((trip: { id: string }) => trip.id === sender));
      if (params[1] === "archived") return result(catalogRows.filter((trip: { status: string }) => trip.status === "archived"));
      return result(catalogRows);
    }
    // Before the history pattern: the claim's NOT EXISTS clause also reads travel_conversations.
    if (/SET quick_info_sent_at = NOW\(\)/i.test(sql)) { if (quick.has(sender)) return result(); quick.add(sender); return result([{ claimed: true }]); }
    if (/SET quick_info_sent_at = NULL/i.test(sql)) { quick.delete(sender); return result(); }
    if (/SELECT[\s\S]*FROM travel_bot_settings/i.test(sql)) return result([settingsRow]);
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
      const rows = history.filter((row) => row.sender_id === sender);
      return /id > \$2/.test(sql) ? result(rows.filter((row) => row.id > Number(params[1]))) : result(rows.slice(-Number(params[1] || 50)).reverse());
    }
    if (/COUNT[\s\S]*FROM travel_leads/i.test(sql)) return result([{ count: String(leads.filter((lead) => lead.sender_id === sender && lead.kind === params[1]).length) }]);
    if (/INSERT INTO travel_leads/i.test(sql)) {
      const lead = { id: String(leads.length + 1), kind: String(params[0]), platform: String(params[1]), sender_id: String(params[2]), customer_message: String(params[3]),
        contact_phone: String(params[4] || ""), context: String(params[5]), status: "new", lead_status: "new_lead", created_at: new Date().toISOString() };
      leads.push(lead); return result([lead]);
    }
    if (/SELECT \* FROM travel_leads WHERE sender_id = \$1/i.test(sql)) {
      const own = leads.filter((lead) => lead.sender_id === sender).sort((a, b) => Number(b.kind === "booking") - Number(a.kind === "booking") || Number(b.id) - Number(a.id));
      return result(own.slice(0, 1));
    }
    if (/UPDATE travel_leads SET status = 'new'/i.test(sql)) {
      const lead = leads.find((row) => row.id === String(params[0]));
      if (!lead) return result();
      lead.status = "new"; lead.context = `${lead.context}\n${String(params[1])}`;
      return result([{ id: Number(lead.id) }]);
    }
    if (/SELECT paused, expires_at(?:, pause_reason)? FROM travel_senders/i.test(sql)) return result(pauses.has(sender) ? [pauses.get(sender)!] : []);
    if (/INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) { pauses.set(sender, { paused: true, expires_at: String(params[2]), pause_reason: String(params[1]) }); return result(); }
    if (/INSERT INTO travel_senders \(sender_id, platform,/i.test(sql)) {
      seen.set(sender, (seen.get(sender) || 0) + 1);
      return result([{ msg_count: seen.get(sender), prev_msg_at: null, get_started_at: null }]);
    }
    return result();
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  const realFetch = globalThis.fetch;
  const sends: Array<{ senderId: string; text: string; buttons: string[] }> = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("https://api.openai.com/")) {
      // Hard cap: a run that grows past its approved budget stops instead of draining the key.
      if (++modelCalls > callBudget) throw new Error(`live replay stopped: model call budget of ${callBudget} reached`);
      return realFetch(input as string, init);
    }
    if (/^https:\/\/graph\.(?:facebook|instagram)\.com\//.test(url)) {
      const body = JSON.parse(String(init?.body || "{}"));
      if (body.message?.text) sends.push({ senderId: String(body.recipient?.id || ""), text: body.message.text,
        buttons: (body.message.quick_replies || []).map((reply: { title: string }) => reply.title) });
      else if (body.message?.attachment) sends.push({ senderId: String(body.recipient?.id || ""), text: `[attachment:${body.message.attachment.type}]`, buttons: [] });
      return new Response(JSON.stringify({ recipient_id: body.recipient?.id || "x", message_id: `m-${sends.length}`, data: [] }), { status: 200 });
    }
    throw new Error(`blocked network: ${new URL(url).hostname}`);
  });
  const env = await import("../src/lib/env");
  env.resetEnvCacheForTests();
  const webhook = await import("../src/pages/api/webhook");
  let serial = 0;
  const turn = async (senderId: string, text: string, channel: Scenario["channel"] = "instagram") => {
    const before = sends.length, beforeLeads = leads.length;
    const message = { sender: { id: senderId }, message: { mid: `replay-${++serial}`, text } };
    const payload = channel === "facebook"
      ? { object: "page", entry: [{ id: "1234567890", messaging: [{ ...message, recipient: { id: "1234567890" } }] }] }
      : { object: "instagram", entry: [{ id: "replay-page", messaging: [message] }] };
    const raw = Buffer.from(JSON.stringify(payload));
    const req = { method: "POST", url: "/api/webhook", query: {}, headers: { "content-type": "application/json", "content-length": String(raw.length),
      "x-hub-signature-256": `sha256=${createHmac("sha256", "test-meta-secret").update(raw).digest("hex")}` }, async *[Symbol.asyncIterator]() { yield raw; } };
    const res = { status() { return res; }, json() { return res; }, send() { return res; }, end() { return res; }, setHeader() {}, statusCode: 200 };
    await webhook.default(req as never, res as never);
    return { sends: sends.slice(before), leads: leads.slice(beforeLeads) };
  };
  const { setTripSelection } = await import("../src/lib/tripSelectionState");
  const { clearClarificationState } = await import("../src/lib/clarificationState");
  // Independent fact check against the raw catalogue rows: every amount is a stored number or a
  // total that adds up; every month/day is a stored departure of some trip.
  const catalogJson = JSON.stringify(catalogRows);
  const storedNumbers = new Set([...catalogJson.matchAll(/\d{5,}/g)].map((match) => Number(match[0])));
  const storedDays = new Set([...catalogJson.matchAll(/20\d\d-(\d\d)-(\d\d)/g)].map((match) => `${Number(match[1])}/${Number(match[2])}`));
  for (const match of catalogJson.matchAll(/(\d{1,2}) сарын (\d{1,2})/g)) storedDays.add(`${Number(match[1])}/${Number(match[2])}`);
  const factIssues = (reply: string): string[] => {
    const issues: string[] = [];
    const total = /Нийт:\s*(\d{1,3}(?:,\d{3})+)₮/.exec(reply);
    const sum = [...reply.matchAll(/x\s*(\d+):\s*(\d{1,3}(?:,\d{3})+)₮/g)].reduce((acc, match) => acc + Number(match[1]) * Number(match[2].replace(/,/g, "")), 0);
    if (total && Number(total[1].replace(/,/g, "")) !== sum) issues.push(`total ${total[1]} != ${sum}`);
    for (const match of reply.matchAll(/(\d{1,3}(?:,\d{3})+)₮/g)) {
      const amount = Number(match[1].replace(/,/g, ""));
      if (!storedNumbers.has(amount) && !(total && match[1] === total[1])) issues.push(`amount ${match[1]} not in catalogue`);
    }
    for (const match of reply.replace(/[^\n]*хооронд[^\n]*/g, "").matchAll(/(?<![\d,.])(\d{1,2})\/(\d{1,2})(?![\d,])|(\d{1,2}) сарын (\d{1,2})/g)) {
      const day = match[1] ? `${Number(match[1])}/${Number(match[2])}` : `${Number(match[3])}/${Number(match[4])}`;
      if (!storedDays.has(day)) issues.push(`date ${day} not a stored departure`);
    }
    if (/undefined|null|NaN|Invalid Date/.test(reply)) issues.push("broken value");
    return issues;
  };
  const report: Array<{ id: string; turns: Array<{ user: string; bot: string[]; leads: string[]; issues?: string[] }> }> = [];
  for (const scenario of scenarios) {
    webhook.resetWebhookStateForTests();
    const sender = `replay-${scenario.id}-${Date.now()}`;
    const turns = [];
    let lastButtons: string[] = [];
    for (const raw of scenario.turns) {
      // "#tap3": send exactly the third quick-reply button the bot last offered, as Messenger does.
      const tap = /^#tap(\d)$/.exec(raw);
      const text = tap ? lastButtons[Number(tap[1]) - 1] || raw : raw;
      if (text === "#pause") { pauses.set(sender, { paused: true, expires_at: new Date(Date.now() + 86_400_000).toISOString(), pause_reason: "manual" }); turns.push({ user: text, bot: [], leads: [] }); continue; }
      if (text === "#later") {
        // Back after 40 days: the stored turns age, short-lived selection and list state expire.
        for (const row of history) if (row.sender_id === sender) row.created_at = new Date(Date.parse(row.created_at) - 40 * 86_400_000).toISOString();
        await setTripSelection(sender, null); await clearClarificationState(sender);
        turns.push({ user: text, bot: [], leads: [] }); continue;
      }
      const out = await turn(sender, text, scenario.channel);
      lastButtons = out.sends.flatMap((send) => send.buttons);
      const issues = out.sends.flatMap((send) => factIssues(send.text));
      turns.push({ user: text, bot: out.sends.map((send) => send.text + (send.buttons.length ? `\n  [buttons: ${send.buttons.join(" | ")}]` : "")),
        leads: out.leads.map((lead) => `${lead.kind}: ${lead.context.slice(0, 160)}`), ...(issues.length ? { issues } : {}) });
    }
    report.push({ id: scenario.id, turns });
  }
  mkdirSync("tmp", { recursive: true });
  writeFileSync(process.env.LIVE_REPORT || "tmp/live-replay-report.json", JSON.stringify(report, null, 1));
  const issues = report.flatMap((scenario) => scenario.turns.flatMap((turn) => (turn.issues || []).map((issue) => `${scenario.id} / ${turn.user}: ${issue}`)));
  const silent = report.flatMap((scenario) => scenario.turns.filter((turn) => !turn.user.startsWith("#") && !turn.bot.length).map((turn) => `${scenario.id} / ${turn.user}`));
  const spend = processAiTotals();
  console.log(`model use: ${spend.calls} calls, ${spend.promptTokens + spend.completionTokens} tokens, about ${spend.costUsd.toFixed(2)} (environment "evaluation")`);
  console.log(`live replay: ${report.length} journeys, ${report.reduce((n, s) => n + s.turns.length, 0)} turns, ${issues.length} fact issues, ${silent.length} silent turns`);
  for (const turn of silent) console.log(`  silent: ${turn}`);
  assert.deepEqual(issues, [], "every amount and date must come from the catalogue");
  // Background writes (memory merge, persisted logs) finish against the in-memory database before
  // the mocks are restored, never against a real one.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
});
