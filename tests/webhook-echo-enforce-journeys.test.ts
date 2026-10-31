import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Echo enforcement (ECHO_TAKEOVER_MODE=enforce) — turned on only AFTER real echoes have
 * proven which app ids are human inbox surfaces (docs/meta-app-migration.md). Even then an
 * unknown app id never counts as a consultant. Invented ids; the model is mocked.
 */
const city = {
  id: "city", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "city" };

test("echo enforcement journeys", async (context) => {
  const harness = await conversationGateHarness(context, { env: {
    META_APP_ID: "555000111",
    ECHO_TAKEOVER_MODE: "enforce",
    ECHO_HUMAN_APP_IDS: "777000333",
  } });
  harness.catalog([city]);
  const fb = (sender: string, text: string) => harness.turn(sender, text, one, undefined, { platform: "facebook" });
  try {
    await context.test("1. a PROVEN human surface's echo silences the bot for that customer", async () => {
      const first = await fb("enforced", "Норвел хотын аялал үнэ");
      assert.equal(first.sends.length, 1);
      const consultant = await harness.echoTurn("enforced", { appId: "777000333", text: "Сайн байна уу, би зөвлөх байна" });
      assert.equal(consultant.status, 200);
      assert.equal(harness.pauseState("enforced")?.pause_reason, "operator_reply");
      const held = await fb("enforced", "Хүүхдийн үнэ хэд вэ?");
      assert.equal(held.sends.length, 0, "the consultant answers, not the bot");
    });

    await context.test("2. an unknown app id never silences anyone, even with enforcement on", async () => {
      const stranger = await harness.echoTurn("stranger", { appId: 424242424242, text: "Automated greeting" });
      assert.equal(stranger.status, 200);
      assert.equal(harness.pauseState("stranger"), null);
      const answered = await fb("stranger", "Норвел хотын аялал үнэ");
      assert.equal(answered.sends.length, 1, "unknown app id: the customer is still answered");
      assert.equal(harness.echoes().find((echo) => echo.recipient === "stranger")?.classification, "unknown");
    });

    await context.test("3. the bot's own echoes still never pause", async () => {
      const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
      await harness.echoTurn("self", { metadata: BOT_MESSAGE_METADATA, text: "НОРВЕЛ — үнэ" });
      await harness.echoTurn("self", { appId: "555000111", text: "НОРВЕЛ — огноо" });
      assert.equal(harness.pauseState("self"), null);
      const answered = await fb("self", "Норвел хотын аялал үнэ");
      assert.equal(answered.sends.length, 1);
    });
  } finally {
    await harness.close();
  }
});
