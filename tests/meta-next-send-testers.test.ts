import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * META_NEXT_SEND=testers (docs/meta-app-migration.md): while the new app is unpublished it may
 * message only people with a role on it, so only the listed testers are answered through it —
 * with ITS token and an appsecret_proof made with ITS secret. Every customer keeps the old app.
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

test("new-app sends for listed testers only", async (context) => {
  const harness = await conversationGateHarness(context, { env: {
    META_APP_ID: "555000111",
    META_APP_SECRET_NEXT: "next-meta-secret",
    FACEBOOK_PAGES_NEXT: "1234567890:next-page-token",
    META_NEXT_SEND: "testers",
    META_NEXT_TESTER_IDS: "1000000001",
  } });
  harness.catalog([city]);
  const fb = (sender: string, text: string) => harness.turn(sender, text, one, undefined, { platform: "facebook" });
  try {
    await context.test("1. a listed tester is answered through the NEW app, with its token and its secret's proof", async () => {
      const before = harness.graphAuth().length;
      const reply = await fb("1000000001", "Норвел хотын аялал үнэ");
      assert.equal(reply.sends.length, 1);
      const calls = harness.graphAuth().slice(before).filter((call) => call.customer === "1000000001" && call.kind !== "other");
      assert.ok(calls.some((call) => call.kind === "send"), "a send happened");
      assert.ok(calls.some((call) => call.kind === "thread"), "the thread was read");
      for (const call of calls) {
        assert.equal(call.token, "next-page-token", `${call.kind}: the new app's token`);
        assert.equal(call.proof, proof("next-meta-secret", "next-page-token"), `${call.kind}: proof from the NEW app's secret`);
      }
    });

    await context.test("2. every other customer keeps the OLD app: token and proof unchanged", async () => {
      const before = harness.graphAuth().length;
      const reply = await fb("customer-not-tester", "Норвел хотын аялал үнэ");
      assert.equal(reply.sends.length, 1);
      const calls = harness.graphAuth().slice(before).filter((call) => call.customer === "customer-not-tester" && call.kind !== "other");
      assert.ok(calls.length >= 2);
      for (const call of calls) {
        assert.equal(call.token, "test-page-token", `${call.kind}: the old app's token`);
        assert.equal(call.proof, proof("test-meta-secret", "test-page-token"), `${call.kind}: proof from the OLD app's secret`);
      }
    });
  } finally {
    await harness.close();
  }
});
