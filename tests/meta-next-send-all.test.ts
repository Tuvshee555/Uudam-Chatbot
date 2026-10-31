import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * META_NEXT_SEND=all — the cutover (docs/meta-app-migration.md): every customer of the page is
 * answered and every thread read through the NEW app, with its own appsecret_proof. Deliveries
 * still verify from either app, since the old app stays subscribed until it is removed.
 * Fixture tokens, secrets and ids only.
 */
const city = {
  id: "city", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "city" };
const proof = (secret: string, token: string) => createHmac("sha256", secret).update(token).digest("hex");

test("cutover: everyone through the new app", async (context) => {
  const harness = await conversationGateHarness(context, { env: {
    META_APP_ID: "555000111",
    META_APP_SECRET_NEXT: "next-meta-secret",
    FACEBOOK_PAGES_NEXT: "1234567890:next-page-token",
    META_NEXT_SEND: "all",
  } });
  harness.catalog([city]);
  try {
    await context.test("1. a customer is answered and the thread read with the new app's token and proof", async () => {
      const before = harness.graphAuth().length;
      const reply = await harness.turn("cutover-customer", "Норвел хотын аялал үнэ", one, undefined, { platform: "facebook" });
      assert.equal(reply.sends.length, 1);
      const calls = harness.graphAuth().slice(before).filter((call) => call.kind !== "other");
      assert.ok(calls.some((call) => call.kind === "send") && calls.some((call) => call.kind === "thread"));
      for (const call of calls) {
        assert.equal(call.token, "next-page-token", call.kind);
        assert.equal(call.proof, proof("next-meta-secret", "next-page-token"), call.kind);
      }
    });

    await context.test("2. deliveries from the OLD app are still accepted and answered once", async () => {
      const viaOld = await harness.turn("cutover-customer", "Хүүхдийн үнэ хэд вэ?", one, "mid-cutover-1", { platform: "facebook" });
      assert.equal(viaOld.sends.length, 1);
      const viaNext = await harness.turn("cutover-customer", "Хүүхдийн үнэ хэд вэ?", one, "mid-cutover-1",
        { platform: "facebook", signSecret: "next-meta-secret" });
      assert.equal(viaNext.status, 200);
      assert.equal(viaNext.sends.length, 0, "the same mid from the second app is absorbed");
    });
  } finally {
    await harness.close();
  }
});
