import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Owner, 2026-11-14: "when someone says get started the Facebook automatic thing answers … and we lost it. My
 * client wanted something like 'where are you looking to travel? see the trips here, or if you have a question
 * leave your phone number', with the calendar link, when the person doesn't text for 30 minutes after they clicked
 * Get Started." Real shape: «Get Started», Meta's automated greeting, then nothing.
 *
 * Journeys through the real webhook (the tap) and the real /api/cron/follow-up handler (the sweep); Meta, OpenAI
 * and SQL transports are mocked, the clock starts at 12:00 Ulaanbaatar. Invented trip.
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
const META_GREETING = "Сайн байна уу! Та сонирхож байгаа аяллынхаа нэрийг бичиж үлдээнэ үү. Манай 1111 0000 дугаарт холбогдож мэдээлэл авах эсвэл холбоо барих дугаараа үлдээнэ үү.";

test("get-started nudge: one message with the calendar after 30 silent minutes, never over a person, never twice", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([norvel]);
  harness.settings(SETTINGS);
  const tick = (ms: number) => context.mock.timers.tick(ms);
  const fb = (sender: string, text: string, model: Record<string, unknown> = {}) => harness.turn(sender, text, model, undefined, { platform: "facebook" });
  /** The Messenger thread as Meta returns it: the tap, Meta's automated greeting 2 s later, then `after`. */
  const tappedThread = (sender: string, tapAgoMs: number, after: Array<Record<string, unknown>> = []) => harness.thread(sender, { messages: [
    { from: "customer", text: "Get Started", agoMs: tapAgoMs },
    { from: "page", text: META_GREETING, agoMs: tapAgoMs - 2_000, source: "web" },
    ...after as never[],
  ] });
  const cron = async () => {
    const run = await harness.runFollowUpCron();
    assert.equal(run.status, 200, JSON.stringify(run.body));
    return run;
  };
  const to = (run: { sends: Array<{ senderId: string; text: string }> }, sender: string) => run.sends.filter((send) => send.senderId === sender).map((send) => send.text);
  const { GET_STARTED_NUDGE_TEXT, DEPARTURES_CALENDAR_URL, storedSkipReason } = await import("../src/lib/getStartedNudge");
  const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
  try {
    // The bot has sent before (production records its message ids since 2026-10-30): Page messages are classified.
    await fb("gs-warmup", "Норвел хотын аялал үнэ", { certainty: "one", tripId: "norvel" });

    await context.test("(a) a tap and 30 silent minutes: one message with the calendar and the phone ask, once", async () => {
      const tap = await fb("gs-silent", "Get Started");
      assert.deepEqual(tap.sends, [], "the tap itself is answered by Meta's automation, not the bot");
      assert.ok(harness.getStartedState("gs-silent")?.tappedAt, "the tap is recorded");
      tappedThread("gs-silent", 0);
      tick(29 * MIN);
      tappedThread("gs-silent", 29 * MIN);
      assert.deepEqual(to(await cron(), "gs-silent"), [], "not before 30 minutes");
      tick(2 * MIN);
      tappedThread("gs-silent", 31 * MIN);
      assert.deepEqual(to(await cron(), "gs-silent"), [GET_STARTED_NUDGE_TEXT]);
      assert.match(GET_STARTED_NUDGE_TEXT, /хаашаа аялах/u, "asks where they want to go");
      assert.ok(GET_STARTED_NUDGE_TEXT.includes(DEPARTURES_CALENDAR_URL) && DEPARTURES_CALENDAR_URL.endsWith("/departures"), "carries the calendar");
      assert.match(GET_STARTED_NUDGE_TEXT, /утасны дугаараа үлдээгээрэй/u, "asks for the phone");
      assert.equal(harness.sendMetadata().filter((send) => send.senderId === "gs-silent").at(-1)?.metadata, BOT_MESSAGE_METADATA,
        "sent through the bot's own path: the send-time takeover guard applies");
      assert.equal(harness.history.filter((row) => row.sender_id === "gs-silent").at(-1)?.text, GET_STARTED_NUDGE_TEXT, "stored as the bot's message");
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "gs-silent"), [], "never a second time for the same tap");
    });

    await context.test("(b) the customer asked something after the tap: the bot answered, no get-started nudge", async () => {
      await fb("gs-asked", "Get Started");
      tick(5 * MIN);
      const answered = await fb("gs-asked", "Норвел хотын аялал үнэ", { certainty: "one", tripId: "norvel" });
      assert.ok(answered.sends.length > 0, "the question is answered");
      tappedThread("gs-asked", 36 * MIN, [{ from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 31 * MIN },
        { from: "page", text: answered.sends[0].text, agoMs: 31 * MIN - 1_000, source: "web", id: harness.botMids().at(-1) }]);
      tick(31 * MIN);
      // The answer's own follow-up (followUp.ts) may go; the get-started message never does.
      const sent = to(await cron(), "gs-asked");
      assert.ok(!sent.includes(GET_STARTED_NUDGE_TEXT), `no get-started nudge after a real question: ${JSON.stringify(sent)}`);
      assert.ok(sent.length <= 1, "at most the one follow-up of the answer");
    });

    await context.test("(c) only 'hi' after the tap: still lost, the nudge goes", async () => {
      await fb("gs-hi", "Get Started");
      tick(1 * MIN);
      assert.deepEqual((await fb("gs-hi", "сайн байна уу")).sends, [], "a bare greeting right after the tap is not answered twice");
      tick(30 * MIN);
      tappedThread("gs-hi", 31 * MIN, [{ from: "customer", text: "сайн байна уу", agoMs: 30 * MIN }]);
      assert.deepEqual(to(await cron(), "gs-hi"), [GET_STARTED_NUDGE_TEXT]);
    });

    await context.test("(d) a consultant wrote after the tap, or knows the customer: no nudge", async () => {
      await fb("gs-staff", "Get Started");
      tick(31 * MIN);
      tappedThread("gs-staff", 31 * MIN, [{ from: "page", text: "Сайн байна уу, зөвлөх Номин байна", agoMs: 10 * MIN, source: "mobile", id: "m_gs_staff_1" }]);
      assert.deepEqual(to(await cron(), "gs-staff"), []);
      await fb("gs-paused", "Get Started");
      harness.pause("gs-paused");
      tick(31 * MIN);
      tappedThread("gs-paused", 31 * MIN);
      assert.deepEqual(to(await cron(), "gs-paused"), []);
    });

    await context.test("(e) the owner's switch stops it; quiet hours make it wait until 09:00", async () => {
      await fb("gs-off", "Get Started");
      harness.settings({ extra: { ...SETTINGS.extra, get_started_nudge_enabled: false } });
      tick(31 * MIN);
      tappedThread("gs-off", 31 * MIN);
      const off = await cron();
      assert.equal((off.body as { getStarted?: { disabled?: string } }).getStarted?.disabled, "settings");
      assert.deepEqual(to(off, "gs-off"), []);
      harness.settings(SETTINGS);
      assert.deepEqual(to(await cron(), "gs-off"), [GET_STARTED_NUDGE_TEXT], "back on: still inside the window, goes once");

      tick(Date.parse("2098-02-02T13:50:00Z") - Date.now()); // 21:50 in Ulaanbaatar
      await fb("gs-night", "Get Started");
      tick(31 * MIN); // 22:21
      tappedThread("gs-night", 31 * MIN);
      const night = await cron();
      assert.equal((night.body as { getStarted?: { deferred?: string } }).getStarted?.deferred, "quiet_hours");
      assert.deepEqual(to(night, "gs-night"), []);
      const wait = Date.parse("2098-02-03T01:00:00Z") - Date.now(); // 09:00
      tick(wait);
      tappedThread("gs-night", 31 * MIN + wait);
      assert.deepEqual(to(await cron(), "gs-night"), [GET_STARTED_NUDGE_TEXT]);
    });

    await context.test("the stored-conversation rule on its own", () => {
      const at = (minutes: number) => new Date(Date.parse("2098-02-05T04:00:00Z") + minutes * MIN).toISOString();
      const row = (role: "user" | "assistant" | "staff", text: string, minutes: number) => ({ id: minutes + 100, role, text, attachments: [], created_at: at(minutes) });
      const tapped = Date.parse(at(0));
      assert.equal(storedSkipReason([], tapped, Date.parse(at(31))), null);
      assert.equal(storedSkipReason([row("user", "hi", 1)], tapped, Date.parse(at(31))), null, "a greeting is not a message");
      assert.equal(storedSkipReason([row("user", "Норвел үнэ", 2)], tapped, Date.parse(at(31))), "customer_wrote");
      assert.equal(storedSkipReason([row("assistant", "НОРВЕЛ ХОТЫН АЯЛАЛ", 2)], tapped, Date.parse(at(31))), "bot_spoke");
      assert.equal(storedSkipReason([row("staff", "Сайн байна уу", -60)], tapped, Date.parse(at(31))), "existing_customer");
      assert.equal(storedSkipReason([], tapped, Date.parse(at(21 * 60))), "window_closed");
    });
  } finally {
    await harness.close();
  }
});
