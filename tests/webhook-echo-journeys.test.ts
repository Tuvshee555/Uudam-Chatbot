import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Meta-app migration journeys, observe mode (the default — docs/meta-app-migration.md):
 * both apps deliver every event, echoes are recorded but NEVER silence a customer, and the
 * duplicate memory is long for Meta message ids yet short for button taps. Invented
 * catalogue; the model is mocked; all app ids and secrets are fixtures.
 */
const city = {
  id: "city", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "city" };
const MIN = 60_000;

test("dual-app migration journeys (observe mode)", async (context) => {
  const harness = await conversationGateHarness(context, { env: {
    META_APP_SECRET_NEXT: "next-meta-secret",
    VERIFY_TOKEN_NEXT: "next-verify-token",
    META_APP_ID: "555000111",
    ECHO_HUMAN_APP_IDS: "777000333",
  } });
  harness.catalog([city]);
  const fb = (sender: string, text: string, model: Record<string, unknown> = {}, eventId?: string,
    options: { signSecret?: string; postback?: boolean } = {}) =>
    harness.turn(sender, text, model, eventId, { platform: "facebook", ...options });
  const tick = (ms: number) => context.mock.timers.tick(ms);
  try {
    await context.test("1. a delivery signed with the NEW app's secret is served; a wrong signature is refused and absorbs nothing", async () => {
      const viaNext = await fb("sig-next", "Норвел хотын аялал үнэ", one, "mid-signed-next", { signSecret: "next-meta-secret" });
      assert.equal(viaNext.status, 200);
      assert.equal(viaNext.sends.length, 1, "the new app's delivery reaches the customer");
      const forged = await fb("sig-next", "Хүүхдийн үнэ хэд вэ?", one, "mid-forged", { signSecret: "wrong-secret" });
      assert.equal(forged.status, 401);
      assert.equal(forged.sends.length, 0);
      // The refused delivery must not have marked the event processed: the honest retry answers.
      const retried = await fb("sig-next", "Хүүхдийн үнэ хэд вэ?", one, "mid-forged");
      assert.equal(retried.sends.length, 1);
    });

    await context.test("2. the same message delivered by both apps — simultaneously or hours apart — is answered once", async () => {
      const first = await fb("both-apps", "Норвел хотын аялал үнэ", one, "mid-both-apps");
      assert.equal(first.sends.length, 1);
      const second = await fb("both-apps", "Норвел хотын аялал үнэ", one, "mid-both-apps", { signSecret: "next-meta-secret" });
      assert.equal(second.sends.length, 0, "the second app's delivery of the SAME mid is absorbed");
      tick(3 * 60 * MIN);
      const lateRetry = await fb("both-apps", "Норвел хотын аялал үнэ", one, "mid-both-apps");
      assert.equal(lateRetry.sends.length, 0, "a redelivery hours later is still absorbed (48-hour mid memory)");
      const newMessage = await fb("both-apps", "Хүүхдийн үнэ хэд вэ?", one, "mid-both-apps-2");
      assert.equal(newMessage.sends.length, 1, "a NEW message is a new mid and is answered");
    });

    await context.test("3. a button tap repeated after the short window is answered again, not silently discarded", async () => {
      const tap = await fb("tapper", "Норвел хотын аялал үнэ", one, undefined, { postback: true });
      assert.equal(tap.sends.length, 1, "the tap (no mid) is answered");
      const immediateRetap = await fb("tapper", "Норвел хотын аялал үнэ", one, undefined, { postback: true });
      assert.equal(immediateRetap.sends.length, 0, "an immediate duplicate is Meta's redelivery, absorbed");
      tick(3 * MIN);
      const laterRetap = await fb("tapper", "Норвел хотын аялал үнэ", one, undefined, { postback: true });
      assert.equal(laterRetap.sends.length, 1, "the customer tapping the same button again IS answered");
    });

    await context.test("4. the bot's own echoes (metadata or its own app id) never pause anyone", async () => {
      const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
      const byMetadata = await harness.echoTurn("echo-bot", { metadata: BOT_MESSAGE_METADATA, appId: 999888777, text: "НОРВЕЛ — үнэ" });
      assert.equal(byMetadata.status, 200);
      const byAppId = await harness.echoTurn("echo-bot", { appId: "555000111", text: "НОРВЕЛ — огноо" });
      assert.equal(byAppId.status, 200);
      assert.equal(harness.pauseState("echo-bot"), null);
      assert.deepEqual(harness.echoes().map((echo) => echo.classification), ["bot", "bot"]);
    });

    await context.test("5. an unknown app id is recorded, never a consultant: the customer keeps being answered", async () => {
      // The shape of Meta's own automated welcome greeting: an echo, no metadata, a foreign app id.
      const greeting = await harness.echoTurn("echo-new", { appId: 263902037430900, text: "Hi! Please let us know how we can help you." });
      assert.equal(greeting.status, 200);
      assert.equal(harness.pauseState("echo-new"), null, "an unknown app id NEVER silences the customer");
      const answered = await fb("echo-new", "Норвел хотын аялал үнэ", one);
      assert.equal(answered.sends.length, 1, "the brand-new customer is answered after the greeting echo");
      assert.equal(harness.echoes().at(-1)?.classification, "unknown");
    });

    await context.test("6. observe mode: even a LISTED human app id only records — enforcement is a separate, explicit deploy", async () => {
      const human = await harness.echoTurn("echo-human", { appId: "777000333", text: "Сайн байна уу, зөвлөх байна" });
      assert.equal(human.status, 200);
      assert.equal(harness.pauseState("echo-human"), null, "observe mode never pauses");
      assert.equal(harness.echoes().at(-1)?.classification, "human");
      const answered = await fb("echo-human", "Норвел хотын аялал үнэ", one);
      assert.equal(answered.sends.length, 1, "the thread check, not the echo, remains the enforcement path");
    });
  } finally {
    await harness.close();
  }
});
