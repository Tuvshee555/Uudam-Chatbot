import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Production 2026-11-12 → 11-14: the follow-up cron is scheduled every 5 minutes on GitHub Actions, which ran it a
 * few times a day; every follow-up went out 151–725 minutes after the answer, not 30. The sweeps now also run on
 * customer traffic (trafficSweep.ts): another customer's message 31 minutes later is enough. Invented trip.
 */
const norvel = {
  id: "norvel", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], website_slug: "norvel-hotyn-aylal", website_published: true,
    age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const MIN = 60_000;
const SETTINGS = { extra: { greeting: { enabled: false }, goodbye: { enabled: false }, reminder_enabled: false, contact_phones: "1111 0000 / 2222 0000" } };

test("the follow-up goes on time when other customers write, without waiting for the GitHub schedule", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([norvel]);
  harness.settings(SETTINGS);
  const tick = (ms: number) => context.mock.timers.tick(ms);
  const fb = (sender: string, text: string, model: Record<string, unknown> = { certainty: "one", tripId: "norvel" }) =>
    harness.turn(sender, text, model, undefined, { platform: "facebook" });
  const sentTo = (sender: string) => harness.sendMetadata().filter((send) => send.senderId === sender).length;
  process.env.TRAFFIC_SWEEP = "on";
  try {
    const answered = await fb("ts-quiet", "Норвел хотын аялал үнэ");
    harness.thread("ts-quiet", { messages: [
      { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 2_000 },
      { from: "page", text: answered.sends[0].text, agoMs: 1_000, source: "web", id: harness.botMids().at(-1) },
    ] });
    const before = sentTo("ts-quiet");
    tick(10 * MIN);
    await fb("ts-other-1", "Норвел хотын аялал үнэ");
    await harness.settle(() => false); // let a background sweep finish if one started
    assert.equal(sentTo("ts-quiet"), before, "not before 30 minutes");
    tick(21 * MIN);
    harness.thread("ts-quiet", { messages: [
      { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 31 * MIN + 2_000 },
      { from: "page", text: answered.sends[0].text, agoMs: 31 * MIN + 1_000, source: "web", id: harness.botMids()[0] },
    ] });
    await fb("ts-other-2", "Норвел хотын аялал үнэ");
    await harness.settle(() => sentTo("ts-quiet") > before);
    assert.equal(sentTo("ts-quiet"), before + 1, "another customer's message ran the sweep: the follow-up went at 31 minutes");
    // Off switch.
    process.env.TRAFFIC_SWEEP = "off";
    const { trafficSweepDisabledByEnv } = await import("../src/lib/trafficSweep");
    assert.equal(trafficSweepDisabledByEnv(), true);
    assert.equal(trafficSweepDisabledByEnv({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv), false, "on by default on Vercel");
    assert.equal(trafficSweepDisabledByEnv({} as unknown as NodeJS.ProcessEnv), true, "off in tests and local runs unless forced");
  } finally {
    delete process.env.TRAFFIC_SWEEP;
    await harness.close();
  }
});
