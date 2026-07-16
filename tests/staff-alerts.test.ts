import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

async function loadStaffAlertsModule() {
  const envModule = await import("../src/lib/env");
  envModule.resetEnvCacheForTests();
  return import("../src/lib/staffAlerts");
}

test("buildAlertText labels a handoff request distinctly from a booking request", async () => {
  applyTestEnv();
  const { buildAlertText } = await loadStaffAlertsModule();

  const handoff = buildAlertText({
    kind: "handoff",
    platform: "facebook",
    customerMessage: "Хүнтэй ярья",
  });
  assert.match(handoff, /хүнтэй ярихыг хүсэв/);

  const booking = buildAlertText({
    kind: "booking",
    platform: "facebook",
    customerMessage: "Захиалга хийе",
  });
  assert.match(booking, /захиалгын сонирхол/);
});

test("buildAlertText labels the channel correctly for facebook vs instagram", async () => {
  applyTestEnv();
  const { buildAlertText } = await loadStaffAlertsModule();

  const fb = buildAlertText({ kind: "handoff", platform: "facebook", customerMessage: "hi" });
  assert.match(fb, /Суваг: Facebook/);

  const ig = buildAlertText({ kind: "handoff", platform: "instagram", customerMessage: "hi" });
  assert.match(ig, /Суваг: Instagram/);
});

test("buildAlertText includes the contact phone only when provided", async () => {
  applyTestEnv();
  const { buildAlertText } = await loadStaffAlertsModule();

  const withoutPhone = buildAlertText({
    kind: "booking",
    platform: "facebook",
    customerMessage: "hi",
  });
  assert.doesNotMatch(withoutPhone, /Утас:/);

  const withPhone = buildAlertText({
    kind: "booking",
    platform: "facebook",
    customerMessage: "hi",
    contactPhone: "99112233",
  });
  assert.match(withPhone, /Утас: 99112233/);
});

test("buildAlertText truncates a long customer message so the alert stays readable", async () => {
  applyTestEnv();
  const { buildAlertText } = await loadStaffAlertsModule();

  const longMessage = "a".repeat(1000);
  const text = buildAlertText({
    kind: "handoff",
    platform: "facebook",
    customerMessage: longMessage,
  });
  // 300 chars from the message plus the surrounding quotes in the template.
  assert.ok(text.includes("a".repeat(300)));
  assert.ok(!text.includes("a".repeat(301)));
});

test("notifyStaffOfLead never throws even when zero channels are configured", async () => {
  // STAFF_NOTIFY_PSIDS and TELEGRAM_BOT_TOKEN are both left unset by
  // applyTestEnv's defaults — this is the "lead delivered nowhere" case that
  // must be a logged no-op, never an unhandled rejection reaching the webhook.
  applyTestEnv();
  const { notifyStaffOfLead } = await loadStaffAlertsModule();

  let result: Awaited<ReturnType<typeof notifyStaffOfLead>> | null = null;
  await assert.doesNotReject(async () => {
    result = await notifyStaffOfLead({
      kind: "handoff",
      platform: "facebook",
      customerMessage: "Хүнтэй ярья",
    });
  });
  assert.deepEqual(result, { attempted: 0, delivered: 0 });
});

test("notifyStaffOfLead reports successful realtime delivery", async () => {
  applyTestEnv({ STAFF_NOTIFY_PSIDS: "staff-1" });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch;

  try {
    const { notifyStaffOfLead } = await loadStaffAlertsModule();
    const result = await notifyStaffOfLead({
      kind: "handoff",
      platform: "facebook",
      customerMessage: "Хүнтэй ярья",
    });
    assert.deepEqual(result, { attempted: 1, delivered: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
