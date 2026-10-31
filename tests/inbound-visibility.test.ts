import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Some customer messages never reached the conversation table, and with runtime logs kept
 * for an hour nobody could tell why (2026-10-30 audit). Production showed one question
 * redelivered 31 times on 2026-10-10 — failing each time, never stored or answered — and
 * 39 failed deliveries on 2026-10-24. Every message now leaves a persisted, privacy-safe
 * trail, and one that keeps failing is kept for staff instead of being lost.
 */
const city = {
  id: "city", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "9 өдөр 8 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "city" };

test("every inbound message leaves a persisted trail; one that keeps failing is kept and handed to staff", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([city]);
  const of = (event: string) => harness.logs.filter((log) => log.event === event);
  // Log rows are persisted fire-and-forget: wait until the turn's outcome row has landed (the
  // retry-attempt count is read back from those rows, as Meta's spaced redeliveries would find them).
  const outcomes = () => of("webhook.inbound_outcome").length;
  const settle = (before = outcomes()) => harness.settle(() => outcomes() > before);
  try {
    await context.test("an answered message: received, stored, answered", async () => {
      const before = outcomes();
      const turn = await harness.turn("trail-ok", "Норвел хотын аялал үнэ", one, "trail-event-1");
      assert.equal(turn.sends.length, 1);
      await settle(before);
      await harness.settle(() => of("webhook.inbound_received").length > 0);
      const [received] = of("webhook.inbound_received");
      assert.equal(received.fields.kind, "text");
      assert.equal(received.fields.textLength, "Норвел хотын аялал үнэ".length);
      const outcome = of("webhook.inbound_outcome").at(-1)!;
      assert.equal(outcome.fields.status, "answered");
      assert.equal(outcome.fields.stored, true);
      assert.equal(outcome.fields.sent, 1);
      assert.equal(outcome.fields.eventKeyHash, received.fields.eventKeyHash, "receipt and outcome join on the event");
      for (const log of [received, outcome]) {
        assert.doesNotMatch(JSON.stringify(log), /trail-ok|Норвел хотын|trail-event/, "no raw ids or message text are persisted");
      }
    });

    await context.test("a redelivery of a processed message is recorded as a duplicate", async () => {
      const again = await harness.turn("trail-ok", "Норвел хотын аялал үнэ", one, "trail-event-1");
      assert.equal(again.sends.length, 0);
      await harness.settle(() => of("webhook.inbound_duplicate").length > 0);
      assert.equal(of("webhook.inbound_duplicate").at(-1)?.fields.state, "already_completed");
    });

    await context.test("a deliberate silence says why", async () => {
      harness.pause("trail-paused");
      const before = outcomes();
      await harness.turn("trail-paused", "Үнэ хэд вэ", one);
      await settle(before);
      const outcome = of("webhook.inbound_outcome").at(-1)!;
      assert.equal(outcome.fields.status, "silent");
      assert.equal(outcome.fields.silent, "paused:manual");
      assert.equal(outcome.fields.stored, true);
    });

    await context.test("a message whose reply keeps failing is kept, handed to staff, and the loop ends", async () => {
      harness.failSends("trail-fail");
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const before = outcomes();
        const failed = await harness.turn("trail-fail", "Норвел хотын аялал үнэ", one, "trail-event-fail");
        assert.equal(failed.status, 503, `attempt ${attempt} stays retryable`);
        await settle(before);
        const outcome = of("webhook.inbound_outcome").at(-1)!;
        assert.equal(outcome.fields.status, "failed");
        assert.equal(outcome.fields.attempt, attempt);
        assert.match(String(outcome.fields.reason), /^delivery_failed:/, "a delivery failure is told apart from a processing failure");
      }
      const last = await harness.turn("trail-fail", "Норвел хотын аялал үнэ", one, "trail-event-fail");
      assert.equal(last.status, 200, "accepted: Meta stops redelivering");
      await harness.settle(() => of("webhook.inbound_preserved_after_failures").length > 0);
      assert.equal(last.history.filter((row) => row.role === "user" && row.text === "Норвел хотын аялал үнэ").length, 1,
        "the customer's message is in the conversation once, not once per failed attempt");
      assert.equal(last.leads.length, 1, "staff get it");
      assert.match(last.leads[0].context, /6 удаа боловсруулж чадсангүй \(delivery_failed\)/);
      assert.equal(of("webhook.inbound_preserved_after_failures").length, 1);
    });
  } finally {
    await harness.close();
  }
});
