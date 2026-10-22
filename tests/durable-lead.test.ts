import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("handoff persistence and booking completion survive database and delivery failures", async (context) => {
  applyTestEnv({ NEON_DATABASE_URL: "postgres://test:test@127.0.0.1:1/durable-lead-fixture",
    STAFF_NOTIFY_PSIDS: undefined, TELEGRAM_BOT_TOKEN: undefined, TELEGRAM_STAFF_CHAT_IDS: undefined });
  const { Pool } = await import("pg");
  const existing = new Set<string>();
  const effects: string[] = [];
  let leadFailure: "throw" | "empty" | null = null;
  let failPause = false;
  let inserts = 0;
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT[\s\S]*FROM travel_trip_entries/i.test(sql)) return { rows: [{ id: "velmor", route_name: "Вэлмор аялал",
      status: "active", departure_dates: ["2098-03-17"], extra: {}, photo_urls: [] }], rowCount: 1 };
    if (/FROM travel_leads[\s\S]*COUNT|COUNT[\s\S]*FROM travel_leads/i.test(sql)) {
      return { rows: [{ count: existing.has(`${params[0]}:${params[1]}`) ? "1" : "0" }], rowCount: 1 };
    }
    if (/INSERT INTO travel_leads/i.test(sql)) {
      inserts++;
      if (leadFailure === "throw") throw new Error("fixture lead storage unavailable");
      if (leadFailure === "empty") return { rows: [], rowCount: 0 };
      existing.add(`${params[2]}:${params[0]}`);
      effects.push("lead");
      return { rows: [{ id: inserts, kind: params[0], platform: params[1], sender_id: params[2],
        customer_message: params[3], contact_phone: params[4], context: params[5], status: "new" }], rowCount: 1 };
    }
    if (/UPDATE travel_senders[\s\S]*pause_reason = 'auto_handoff'/i.test(sql)) {
      if (failPause) throw new Error("fixture pause storage unavailable");
      effects.push("handoff");
    }
    if (/INSERT INTO travel_senders \(sender_id, paused,/i.test(sql)) effects.push("pause");
    return { rows: [], rowCount: 0 };
  };
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request in durable-lead test"); });
  const { ensureDurableLead } = await import("../src/lib/durableLead");
  const { continueBookingCollect } = await import("../src/lib/bookingCollectFlow");
  const { getCollectState, setCollectState, startCollectState } = await import("../src/lib/bookingCollect");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const leadInput = { kind: "handoff" as const, platform: "facebook", senderId: "durable-customer", customerMessage: "Нерит аялал нэмэлт мэдээлэл" };
  const bookingContext = (senderId: string, send: () => Promise<void>) => ({ platform: "facebook" as const, senderId,
    text: "99110000", contextualUserText: "99110000", send });
  try {
    await context.test("a missing insert result and a thrown insert both remain retryable", async () => {
      leadFailure = "empty";
      await assert.rejects(ensureDurableLead(leadInput), /lead_persistence_failed:handoff/);
      leadFailure = "throw";
      await assert.rejects(ensureDurableLead(leadInput), /lead_persistence_failed:handoff/);
      assert.deepEqual(effects, []);
      leadFailure = null;
      const created = await ensureDurableLead(leadInput);
      assert.equal(created.created, true);
      assert.equal(created.lead?.sender_id, leadInput.senderId);
      const before = inserts;
      assert.deepEqual(await ensureDurableLead(leadInput), { created: false, lead: null });
      assert.equal(inserts, before, "a retry reuses the unresolved lead");
    });
    await context.test("failed booking persistence preserves collection state and never claims completion", async () => {
      const senderId = "booking-storage-failure";
      await setCollectState(senderId, startCollectState("Захиалах", "Вэлмор аялал"));
      effects.length = 0;
      const ctx = bookingContext(senderId, async () => { effects.push("confirmation"); });
      leadFailure = "throw";
      await assert.rejects(continueBookingCollect(ctx), /lead_persistence_failed:booking/);
      assert.equal((await getCollectState(senderId))?.step, "phone");
      assert.deepEqual(effects, []);
      leadFailure = null;
      assert.equal(await continueBookingCollect(ctx), true);
      assert.deepEqual(effects, ["lead", "confirmation", "handoff", "pause"]);
      assert.equal(await getCollectState(senderId), null);
    });
    await context.test("a confirmation delivery failure retries without creating another booking lead", async () => {
      const senderId = "booking-send-failure";
      await setCollectState(senderId, startCollectState("Захиалах", "Вэлмор аялал"));
      effects.length = 0;
      const before = inserts;
      let failSend = true;
      const ctx = bookingContext(senderId, async () => {
        if (failSend) throw new Error("fixture send failed");
        effects.push("confirmation");
      });
      await assert.rejects(continueBookingCollect(ctx), /fixture send failed/);
      assert.equal((await getCollectState(senderId))?.step, "done");
      assert.deepEqual(effects, ["lead"], "customer is not paused before acknowledgement delivery");
      failSend = false;
      assert.equal(await continueBookingCollect(ctx), true);
      assert.equal(inserts, before + 1);
      assert.deepEqual(effects, ["lead", "confirmation", "handoff", "pause"]);
      assert.equal(await getCollectState(senderId), null);
    });
    await context.test("a pause failure finishes on retry without repeating the accepted confirmation", async () => {
      const senderId = "booking-pause-failure";
      await setCollectState(senderId, startCollectState("Захиалах", "Вэлмор аялал"));
      effects.length = 0;
      const before = inserts;
      const ctx = bookingContext(senderId, async () => { effects.push("confirmation"); });
      failPause = true;
      await assert.rejects(continueBookingCollect(ctx), /fixture pause storage unavailable/);
      assert.equal((await getCollectState(senderId))?.confirmationSent, true);
      assert.deepEqual(effects, ["lead", "confirmation"]);
      failPause = false;
      assert.equal(await continueBookingCollect(ctx), true);
      assert.equal(inserts, before + 1);
      assert.deepEqual(effects, ["lead", "confirmation", "handoff", "pause"]);
      assert.equal(await getCollectState(senderId), null);
    });
  } finally { await closeNeonPool(); }
});
