import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Production 2026-10-30: leads raised "no realtime staff alert channel" although a Telegram
 * bot and chat were configured — under TELEGRAM_CHAT_ID, while the code only read
 * TELEGRAM_STAFF_CHAT_IDS. Both names are read now. A lead alert (customer message, phone)
 * goes only to a private chat or group, never a broadcast channel; each ping is recorded on
 * the lead and a lead pinged in the last ten minutes is not pinged again.
 */
applyTestEnv({
  NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/staff-alerts",
  TELEGRAM_BOT_TOKEN: "fixture-bot-token", TELEGRAM_CHAT_ID: "-100111", TELEGRAM_STAFF_CHAT_IDS: undefined, STAFF_NOTIFY_PSIDS: undefined,
});

type Lead = { id: string; sender_id: string; notify_status: string; notified_at: string | null; notify_error?: string };

async function install(context: test.TestContext, leads: Lead[]) {
  const query = async (sql: string, params: unknown[] = []) => {
    const out = (rows: unknown[]) => ({ rows, rowCount: rows.length });
    if (/FROM travel_leads WHERE sender_id=\$1 ORDER BY id DESC LIMIT 1/.test(sql)) return out(leads.filter((l) => l.sender_id === params[0]).slice(-1));
    if (/FROM travel_leads WHERE id=\$1/.test(sql)) return out(leads.filter((l) => l.id === String(params[0])));
    if (/UPDATE travel_leads SET notify_status=\$2/.test(sql)) {
      const lead = leads.find((l) => l.id === String(params[0]))!;
      Object.assign(lead, { notify_status: params[1], notify_error: params[2], notified_at: new Date().toISOString() });
      return out([]);
    }
    return out([]);
  };
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
}

function telegram(context: test.TestContext, chatTypes: Record<string, string | null>) {
  const sent: string[] = [];
  context.mock.method(globalThis, "fetch", async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/getChat?")) {
      const chatId = new URL(url).searchParams.get("chat_id")!;
      const type = chatTypes[chatId];
      return type ? Response.json({ ok: true, result: { type } }) : Response.json({ ok: false }, { status: 400 });
    }
    if (url.includes("/sendMessage")) { sent.push(JSON.parse(String(init?.body)).chat_id); return Response.json({ ok: true }); }
    throw new Error(`unexpected ${url}`);
  });
  return sent;
}

test("the chat Production configures as TELEGRAM_CHAT_ID receives staff alerts", async () => {
  const { getEnv } = await import("../src/lib/env");
  const { hasStaffAlertChannel } = await import("../src/lib/staffAlerts");
  assert.deepEqual(getEnv().telegramStaffChatIds, ["-100111"]);
  assert.equal(hasStaffAlertChannel(), true);
});

test("a lead alert goes to a group, is recorded on the lead, and is not repeated within ten minutes", async (context) => {
  const leads: Lead[] = [{ id: "7", sender_id: "fixture-customer", notify_status: "", notified_at: null }];
  await install(context, leads);
  const sent = telegram(context, { "-100111": "supergroup" });
  const { notifyStaffOfLead } = await import("../src/lib/staffAlerts");
  const alert = { kind: "booking" as const, platform: "facebook", customerMessage: "Захиалъя", senderId: "fixture-customer" };
  assert.deepEqual(await notifyStaffOfLead(alert), { attempted: 1, delivered: 1 });
  assert.deepEqual(sent, ["-100111"]);
  assert.equal(leads[0].notify_status, "sent", "the Leads tab can show staff were reached");
  assert.deepEqual(await notifyStaffOfLead(alert), { attempted: 0, delivered: 0, deduped: true }, "a second message minutes later reopens the lead without a second ping");
  assert.equal(sent.length, 1);
  leads[0].notified_at = new Date(Date.now() - 11 * 60_000).toISOString();
  await notifyStaffOfLead(alert);
  assert.equal(sent.length, 2, "after ten minutes staff are pinged again");
});

test("a broadcast channel or an unreachable chat never receives customer details and shows as a critical issue", async (context) => {
  telegram(context, { "-100222": "channel", "-100333": "group", "-100444": null });
  const { staffAlertIssues, telegramChatCheck } = await import("../src/lib/staffAlerts");
  const { getEnv } = await import("../src/lib/env");
  const env = (chatIds: string[], token: string | null = "fixture-bot-token") => ({ ...getEnv(), telegramBotToken: token, telegramStaffChatIds: chatIds, staffNotifyPsids: [] });
  assert.deepEqual((await staffAlertIssues(env(["-100222"])))[0]?.severity, "critical", "channel refused");
  assert.deepEqual(await staffAlertIssues(env(["-100333"])), [], "a staff group is fine");
  assert.match((await staffAlertIssues(env(["-100444"])))[0]?.message ?? "", /хүрэхгүй/, "unreachable");
  assert.equal((await staffAlertIssues(env([], null)))[0]?.severity, "warning", "no channel: a warning, the Leads tab still holds every lead");
  assert.deepEqual(await telegramChatCheck("fixture-bot-token", "-100222", 1000), { ok: true, type: "channel" });
});

test("a failed delivery is recorded as failed and the lead stays in the Leads tab", async (context) => {
  const leads: Lead[] = [{ id: "9", sender_id: "fixture-other", notify_status: "", notified_at: null }];
  await install(context, leads);
  context.mock.method(globalThis, "fetch", async (input: unknown) => {
    if (String(input).includes("/getChat?")) return Response.json({ ok: true, result: { type: "group" } });
    return new Response("Bad Gateway", { status: 502 });
  });
  const { notifyStaffOfLead } = await import("../src/lib/staffAlerts");
  const result = await notifyStaffOfLead({ kind: "handoff", platform: "facebook", customerMessage: "Хүнтэй ярья", leadId: 9 });
  assert.deepEqual(result, { attempted: 1, delivered: 0 });
  assert.equal(leads[0].notify_status, "failed");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});
