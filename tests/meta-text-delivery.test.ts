import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("Messenger preserves complete answers within request limits and resumes interrupted events", async context => {
  applyTestEnv();
  const { splitMessengerText, deliverMessengerText } = await import("../src/lib/metaTextDelivery");
  const { sendTextMessage, sendQuickReplies, BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
  const { sendPlatformMessage } = await import("../src/lib/webhookMedia");
  const text = Array.from({ length: 65 }, (_, i) => `ВЭЛМОР ${i + 1}: ${"Хөтөлбөрийн баталгаатай мэдээлэл 😊 ".repeat(3)}\n`).join("");
  const attempted: Array<{ text: string; metadata?: string; quick_replies?: unknown[] }> = [];
  const accepted: string[] = [];
  let failAt = -1;
  context.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.ok(body.message.text.length <= 2000, "oversized requests must never reach Meta");
    assert.equal(body.message.metadata, BOT_MESSAGE_METADATA);
    attempted.push(body.message);
    if (attempted.length === failAt) return new Response(JSON.stringify({ error: { message: "fixture transport failure" } }), { status: 503 });
    accepted.push(body.message.text);
    return new Response(JSON.stringify({ message_id: `fixture-${attempted.length}` }), { status: 200 });
  });

  await context.test("split boundaries preserve every source character and complete emoji", () => {
    for (const source of ["а".repeat(1999) + "😊" + "б".repeat(2001), text, "x".repeat(6001), "x".repeat(2000)]) {
      const chunks = splitMessengerText(source);
      assert.equal(chunks.join(""), source);
      assert.ok(chunks.every(chunk => chunk.length <= 2000 && chunk.isWellFormed()));
    }
  });
  await context.test("send complete verified prose in ordered bounded messages", async () => {
    attempted.length = 0; accepted.length = 0;
    await sendTextMessage("fixture-recipient", text, "fixture-token");
    assert.ok(accepted.length > 1);
    assert.equal(accepted.join(""), text);
  });
  await context.test("buttons belong to the final part", async () => {
    attempted.length = 0; accepted.length = 0;
    await sendQuickReplies("fixture-recipient", text, ["Хөтөлбөр үзэх"], "fixture-token");
    assert.equal(accepted.join(""), text);
    assert.ok(attempted.slice(0, -1).every(part => !part.quick_replies));
    assert.equal(attempted.at(-1)?.quick_replies?.length, 1);
  });
  await context.test("failed part stops delivery; event retry resumes without repeating accepted prefix", async () => {
    attempted.length = 0; accepted.length = 0; failAt = 2;
    const trace = { requestId: "first-attempt", correlationId: "fixture", source: "fixture", deliveryKey: "fixture-event" };
    assert.equal(await sendPlatformMessage("facebook", "fixture-recipient", text, "fixture-token", "fixture-page", null, trace), false);
    assert.equal(attempted.length, 2);
    assert.equal(accepted.length, 1);
    failAt = -1;
    assert.equal(await sendPlatformMessage("facebook", "fixture-recipient", text, "fixture-token", "fixture-page", null,
      { ...trace, requestId: "retry-attempt" }), true);
    assert.equal(accepted.join(""), text);
    const sent = attempted.length;
    await sendTextMessage("fixture-recipient", text, "fixture-token", trace);
    assert.equal(attempted.length, sent, "completed parts stay checkpointed until event completion");
    await sendTextMessage("fixture-recipient", text, "fixture-token", { ...trace, deliveryKey: "new-fixture-event" });
    assert.equal(accepted.join(""), text + text, "a fresh customer event can request the same answer again");
  });
  await context.test("no-data sentinels stay silent before splitting", async () => {
    const before = attempted.length;
    await sendTextMessage("fixture-recipient", "REFER", "fixture-token");
    await sendQuickReplies("fixture-recipient", "SILENT", ["fixture"], "fixture-token");
    assert.equal(attempted.length, before);
  });
  await context.test("receipt capacity fails before sending an uncheckpointed prefix", async () => {
    const { sharedMap } = await import("../src/lib/processState");
    const { getEnv } = await import("../src/lib/env");
    const state = sharedMap<string, { next: number; at: number }>("meta_text_delivery.receipts");
    const maximum = getEnv().rateLimitMaxBuckets;
    getEnv().rateLimitMaxBuckets = state.size;
    let sends = 0;
    try {
      await assert.rejects(deliverMessengerText("fixture-recipient", text, async () => { sends++; }, "new-capacity-fixture"), /capacity/);
      assert.equal(sends, 0);
    } finally { getEnv().rateLimitMaxBuckets = maximum; }
  });
  await context.test("unavailable durable receipts fail before sending a partial reply", async () => {
    const { resetEnvCacheForTests } = await import("../src/lib/env");
    process.env.REDIS_REPLAY_ENABLED = "true";
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    resetEnvCacheForTests();
    let sends = 0;
    try {
      await assert.rejects(deliverMessengerText("fixture-recipient", text, async () => { sends++; }, "unavailable-fixture"), /receipts unavailable/);
      assert.equal(sends, 0);
    } finally {
      process.env.REDIS_REPLAY_ENABLED = "false";
      delete process.env.REDIS_URL;
      resetEnvCacheForTests();
    }
  });
});
