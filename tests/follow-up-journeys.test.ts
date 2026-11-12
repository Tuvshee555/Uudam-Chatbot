import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { NEXT_QUESTION_DATE, NEXT_QUESTION_NEXT_STEP, NEXT_QUESTION_PARTY, NEXT_QUESTION_TEXTS } from "../src/lib/nextQuestionText";

/**
 * Owner, 2026-11-12: "in the last 5-10 days the chatbot was not asking questions / not doing follow-up …
 * if the person just left you on seen, make a follow-up question after 10 min … it won't message after
 * they clicked 'connect to human', etc." Real shape (10 days of chats): 59 threads ended on a bot reply the
 * customer never answered, 42 of them on a reply that asked nothing — a fare card, "<date>: захиалга
 * нээлттэй.", a bare programme link.
 *
 * Journeys through the real webhook and the real /api/cron/follow-up handler; only Meta, OpenAI and SQL
 * transports are mocked. The clock is mocked: the harness starts at 12:00 Ulaanbaatar. Invented trips.
 */
const norvel = {
  id: "norvel", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], website_slug: "norvel-hotyn-aylal", website_published: true,
    age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const velmor = { ...norvel, id: "velmor", route_name: "ВЕЛМОР НУУРЫН АЯЛАЛ", departure_dates: ["2098-03-20"],
  extra: { ...norvel.extra, aliases: ["Велмор"], website_slug: "velmor-nuuryn-aylal" } } as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "norvel" };
const MIN = 60_000;
const HOUR = 60 * MIN;
const ASK_PRICE = "Норвел хотын аялал үнэ";
const SETTINGS = { extra: { greeting: { enabled: false }, goodbye: { enabled: false }, reminder_enabled: false, contact_phones: "1111 0000 / 2222 0000" } };

test("follow-up journeys: one question after silence, never over a person, never twice", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog([norvel, velmor]);
  harness.settings(SETTINGS);
  const tick = (ms: number) => context.mock.timers.tick(ms);
  const fb = (sender: string, text: string, model: Record<string, unknown> = one) => harness.turn(sender, text, model, undefined, { platform: "facebook" });
  /** The Messenger thread as Meta returns it: the customer, then the bot's last message (known by its id). */
  const answeredThread = (sender: string, customerText: string, botText: string, after: Array<Record<string, unknown>> = []) =>
    harness.thread(sender, { messages: [
      { from: "customer", text: customerText, agoMs: 2_000 },
      { from: "page", text: botText, agoMs: 1_000, source: "web", id: harness.botMids().at(-1) },
      ...after as never[],
    ] });
  const cron = async () => {
    const run = await harness.runFollowUpCron();
    assert.equal(run.status, 200, JSON.stringify(run.body));
    return run;
  };
  const to = (run: { sends: Array<{ senderId: string; text: string }> }, sender: string) => run.sends.filter((send) => send.senderId === sender).map((send) => send.text);
  // Loaded after the harness set the fixture environment (a module read before it keeps the real one).
  const { hashIdentifier } = await import("../src/lib/observability");
  const { conversationSkipReason } = await import("../src/lib/followUp");
  const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
  const { AI_OUTAGE_HANDOFF_REPLY } = await import("../src/lib/reply");
  /** The persisted follow-up log rows for this customer (hashed id only). */
  const followUpLogs = (sender: string) => harness.logs.filter((log) => log.event.startsWith("follow_up.")
    && (log.senderHash === hashIdentifier(sender) || log.fields.senderHash === hashIdentifier(sender)));
  try {
    await context.test("(g) an answer left for more than 20 hours is not followed up (Meta's 24 h window, with room)", async () => {
      const answered = await fb("fu-late", ASK_PRICE);
      answeredThread("fu-late", ASK_PRICE, answered.sends[0].text);
      tick(21 * HOUR); // 09:00 the next day in Ulaanbaatar: not quiet hours
      assert.deepEqual(to(await cron(), "fu-late"), []);
      assert.equal(harness.followUpState("fu-late")?.sentAt, null);
    });

    await context.test("(a)+(i) a fare card gets the next question; 10 min of silence brings exactly one follow-up, never a second", async () => {
      const answered = await fb("fu-seen", ASK_PRICE);
      assert.equal(answered.sends.length, 1);
      assert.ok(answered.sends[0].text.endsWith(`\n\n${NEXT_QUESTION_DATE}`), `the fare card asks which departure: ${answered.sends[0].text}`);
      assert.match(answered.sends[0].text, /1,791,000₮/, "the answer itself is unchanged above the question");
      answeredThread("fu-seen", ASK_PRICE, answered.sends[0].text);
      tick(9 * MIN);
      assert.deepEqual(to(await cron(), "fu-seen"), [], "not before the delay");
      tick(2 * MIN);
      const first = await cron();
      // The date was just asked, so the follow-up asks the next thing: how many people.
      assert.deepEqual(to(first, "fu-seen"), [NEXT_QUESTION_PARTY]);
      assert.equal(harness.sendMetadata().filter((send) => send.senderId === "fu-seen").at(-1)?.metadata, BOT_MESSAGE_METADATA,
        "sent through the bot's own path: the send-time takeover guard applies");
      assert.equal(harness.history.filter((row) => row.sender_id === "fu-seen").at(-1)?.text, NEXT_QUESTION_PARTY, "stored as the bot's message");
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-seen"), [], "never a second follow-up for the same answer");
      // The customer answers, the bot answers again, and leaves it on seen again: still once per 24 h.
      const again = await fb("fu-seen", "3/29");
      assert.equal(again.sends.length, 1);
      answeredThread("fu-seen", "3/29", again.sends[0].text);
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-seen"), [], "at most one follow-up in 24 hours");
      await harness.settle(() => followUpLogs("fu-seen").some((log) => log.event === "follow_up.sent"));
      const sent = followUpLogs("fu-seen").find((log) => log.event === "follow_up.sent");
      assert.ok(sent, "the send is logged");
      assert.doesNotMatch(JSON.stringify(sent), /Норвел|үнэ|3\/29/u, "no customer text in the log");
    });

    await context.test("(b) the customer wrote before 10 minutes: nothing; a new answer restarts the 10 minutes", async () => {
      const answered = await fb("fu-wrote", ASK_PRICE);
      answeredThread("fu-wrote", ASK_PRICE, answered.sends[0].text);
      tick(4 * MIN);
      assert.deepEqual((await fb("fu-wrote", "😊", {})).sends, [], "an emoji is stored, not answered");
      tick(7 * MIN);
      assert.deepEqual(to(await cron(), "fu-wrote"), []);
      assert.equal(harness.followUpState("fu-wrote")?.slot, "", "the stale question is cleared");

      const first = await fb("fu-restart", ASK_PRICE);
      answeredThread("fu-restart", ASK_PRICE, first.sends[0].text);
      tick(5 * MIN);
      const second = await fb("fu-restart", "3/15");
      assert.ok(second.sends[0].text.endsWith(`\n\n${NEXT_QUESTION_PARTY}`), `a departure answer asks the party: ${second.sends[0].text}`);
      answeredThread("fu-restart", "3/15", second.sends[0].text);
      tick(6 * MIN);
      assert.deepEqual(to(await cron(), "fu-restart"), [], "11 minutes after the first answer, 6 after the last");
      tick(5 * MIN);
      // Trip and date known, the party just asked: the follow-up hands the booking to a consultant.
      assert.deepEqual(to(await cron(), "fu-restart"), [NEXT_QUESTION_NEXT_STEP]);
    });

    await context.test("(c) after 'connect to a person' (hand-off pause) nothing is sent", async () => {
      assert.equal((await fb("fu-human", ASK_PRICE)).sends.length, 1);
      assert.equal(harness.followUpState("fu-human")?.slot, "party", "the answer armed a follow-up");
      const handoff = await fb("fu-human", "Зөвлөхтэй холбогдох", {});
      assert.equal(handoff.sends.length, 1);
      assert.equal(harness.pauseState("fu-human")?.pause_reason, "handoff");
      assert.equal(harness.followUpState("fu-human")?.slot, "", "the hand-off reply cleared the armed question");
      assert.ok(!NEXT_QUESTION_TEXTS.some((question) => handoff.sends[0].text.includes(question)), "the hand-off reply asks nothing more");
      answeredThread("fu-human", "Зөвлөхтэй холбогдох", handoff.sends[0].text);
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-human"), []);
      // The hand-off marker written while the answer was still armed (another path paused the customer).
      const armed = await fb("fu-handoff-marker", ASK_PRICE);
      answeredThread("fu-handoff-marker", ASK_PRICE, armed.sends[0].text);
      harness.pause("fu-handoff-marker", new Date(Date.now() + HOUR).toISOString(), "handoff");
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-handoff-marker"), []);
      await harness.settle(() => followUpLogs("fu-handoff-marker").some((log) => log.event === "follow_up.skipped"));
      assert.equal(followUpLogs("fu-handoff-marker").find((log) => log.event === "follow_up.skipped")?.fields.reason, "paused:handoff");
    });

    await context.test("(d) a consultant in the thread, or in the last 30 days, means no follow-up and no added question", async () => {
      // A consultant answered in Business Suite after the bot; the customer has not written since, so only the
      // thread shows it: the sweep reads it right before sending.
      const answered = await fb("fu-staff", ASK_PRICE);
      answeredThread("fu-staff", ASK_PRICE, answered.sends[0].text,
        [{ from: "page", text: "Сайн байна уу, зөвлөх Номин байна", agoMs: 0, source: "mobile", id: "m_fu_staff_1" }]);
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-staff"), []);
      await harness.settle(() => followUpLogs("fu-staff").some((log) => log.event === "follow_up.skipped"));
      assert.equal(followUpLogs("fu-staff").find((log) => log.event === "follow_up.skipped")?.fields.reason, "staff_in_thread");
      // An existing customer: a consultant wrote ten days ago (stored from the thread). The answer stays as it was.
      harness.thread("fu-existing", { messages: [
        { from: "page", text: "Таны захиалга баталгаажлаа", agoMs: 10 * 24 * HOUR, source: "mobile", id: "m_fu_existing_1" },
        { from: "customer", text: ASK_PRICE, agoMs: 0 },
      ] });
      const existing = await fb("fu-existing", ASK_PRICE);
      assert.equal(existing.sends.length, 1);
      assert.ok(!NEXT_QUESTION_TEXTS.some((question) => existing.sends[0].text.includes(question)), `no sales question: ${existing.sends[0].text}`);
      assert.equal(harness.followUpState("fu-existing")?.slot ?? "", "", "and arms no follow-up");
      answeredThread("fu-existing", ASK_PRICE, existing.sends[0].text);
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-existing"), []);
    });

    await context.test("(e) 'Баярлалаа' closes the conversation: no follow-up", async () => {
      await fb("fu-thanks", ASK_PRICE);
      const thanks = await fb("fu-thanks", "Баярлалаа", {});
      assert.equal(thanks.sends.length, 1);
      assert.equal(harness.followUpState("fu-thanks")?.slot, "", "the thank-you reply cleared the armed question");
      answeredThread("fu-thanks", "Баярлалаа", thanks.sends[0].text);
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-thanks"), []);
    });

    await context.test("(h)+(i) a contact reply or an outage notice as the bot's last message: no follow-up, nothing added", async () => {
      await fb("fu-contact", ASK_PRICE);
      const contact = await fb("fu-contact", "Холбоо барих дугаар", {});
      assert.deepEqual(contact.sends.map((send) => send.text), ["Манай утасны дугаарууд:\n📞 1111 0000 / 2222 0000"], "the contact reply is unchanged");
      answeredThread("fu-contact", "Холбоо барих дугаар", contact.sends[0].text);
      await fb("fu-outage", ASK_PRICE);
      const outage = await fb("fu-outage", "Танай компани хэдэн жил ажиллаж байна", { unavailable: true });
      assert.deepEqual(outage.sends.map((send) => send.text), [AI_OUTAGE_HANDOFF_REPLY], "the outage notice is unchanged");
      answeredThread("fu-outage", "Танай компани хэдэн жил ажиллаж байна", outage.sends[0].text);
      tick(11 * MIN);
      assert.equal(harness.followUpState("fu-contact")?.slot, "", "the contact reply cleared the armed question");
      assert.equal(harness.followUpState("fu-outage")?.slot, "", "so did the outage notice");
      const run = await cron();
      assert.deepEqual(to(run, "fu-contact"), []);
      assert.deepEqual(to(run, "fu-outage"), []);
      // The same rule over the stored conversation, should an older question still be armed.
      const at = (minutes: number) => new Date(Date.parse("2098-02-02T01:00:00Z") + minutes * MIN).toISOString();
      const rows = (bot: string) => [
        { id: 1, role: "user" as const, text: "Норвел", attachments: [], created_at: at(0) },
        { id: 2, role: "assistant" as const, text: bot, attachments: [], created_at: at(0) },
      ];
      for (const bot of [AI_OUTAGE_HANDOFF_REPLY, "Манай утасны дугаарууд:\n📞 1111 0000", "Файл хүлээн авлаа.", NEXT_QUESTION_PARTY]) {
        assert.equal(conversationSkipReason(rows(bot), Date.parse(at(0)), Date.parse(at(11))), "bot_last_not_answer", bot);
      }
      assert.equal(conversationSkipReason(rows("НОРВЕЛ ХОТЫН АЯЛАЛ\nТом хүн 1,791,000₮"), Date.parse(at(0)), Date.parse(at(11))), null);
    });

    await context.test("(i) a bare programme link and a departure answer get a question; a list that already asks gets none", async () => {
      await fb("fu-program", "Норвел хотын аялал");
      const program = await fb("fu-program", "hutulbur", { ...one, topics: ["program"] });
      assert.equal(program.sends[0].text, `https://uudamtravel.mn/trips/norvel-hotyn-aylal\n\n${NEXT_QUESTION_PARTY}`);
      await fb("fu-date", ASK_PRICE);
      const date = await fb("fu-date", "3/15");
      assert.match(date.sends[0].text, /^3 сарын 15: захиалга нээлттэй/u);
      assert.ok(date.sends[0].text.endsWith(`\n\n${NEXT_QUESTION_PARTY}`), date.sends[0].text);
      const list = await fb("fu-list", "3 сарын аялал", {});
      assert.match(list.sends[0].text, /Аль аяллыг нь сонирхож байна вэ\?\n1 эсвэл 2 гэж бичээрэй 😊$/u, "the list asks already");
      assert.ok(!NEXT_QUESTION_TEXTS.some((question) => list.sends[0].text.includes(question)), "nothing added to it");
      // Instagram: the same answer asks the same question, but is never followed up (no takeover guard there).
      const instagram = await harness.turn("fu-instagram", ASK_PRICE, one);
      assert.ok(instagram.sends[0].text.endsWith(`\n\n${NEXT_QUESTION_DATE}`));
      assert.ok(!harness.followUpState("fu-instagram")?.slot, "an Instagram answer arms nothing");
    });

    await context.test("(j) a consultant takes over while the sweep reads the thread: the send is blocked", async () => {
      const answered = await fb("fu-race", ASK_PRICE);
      answeredThread("fu-race", ASK_PRICE, answered.sends[0].text);
      harness.onThreadRead("fu-race", () => harness.pause("fu-race", "2999-12-31T00:00:00.000Z", "manual"));
      tick(11 * MIN);
      assert.deepEqual(to(await cron(), "fu-race"), []);
      await harness.settle(() => followUpLogs("fu-race").some((log) => log.event === "follow_up.skipped"));
      assert.equal(followUpLogs("fu-race").find((log) => log.event === "follow_up.skipped")?.fields.reason, "paused_before_send:manual");
    });

    await context.test("(k) the owner's switch and the kill switch stop every follow-up", async () => {
      const answered = await fb("fu-off", ASK_PRICE);
      answeredThread("fu-off", ASK_PRICE, answered.sends[0].text);
      harness.settings({ extra: { ...SETTINGS.extra, follow_up_enabled: false } });
      tick(11 * MIN);
      const off = await cron();
      assert.equal(off.body.disabled, "settings");
      assert.deepEqual(to(off, "fu-off"), []);
      harness.settings(SETTINGS);
      process.env.FOLLOW_UP_ENABLED = "off";
      try {
        const killed = await cron();
        assert.equal(killed.body.disabled, "env");
        assert.deepEqual(to(killed, "fu-off"), []);
      } finally {
        delete process.env.FOLLOW_UP_ENABLED;
      }
      // Back on: the answer is still within its window and goes once.
      assert.deepEqual(to(await cron(), "fu-off"), [NEXT_QUESTION_PARTY]);
    });

    await context.test("(f) quiet hours 22:00-09:00 Ulaanbaatar: the follow-up waits until 09:00", async () => {
      tick(Date.parse("2098-02-02T13:55:00Z") - Date.now()); // 21:55 in Ulaanbaatar
      const answered = await fb("fu-night", ASK_PRICE);
      answeredThread("fu-night", ASK_PRICE, answered.sends[0].text);
      tick(11 * MIN); // 22:06
      const night = await cron();
      assert.equal(night.body.deferred, "quiet_hours");
      assert.deepEqual(to(night, "fu-night"), []);
      tick(Date.parse("2098-02-03T00:55:00Z") - Date.now()); // 08:55
      assert.deepEqual(to(await cron(), "fu-night"), []);
      tick(5 * MIN); // 09:00, 11 hours after the answer: inside the 20 h window
      assert.deepEqual(to(await cron(), "fu-night"), [NEXT_QUESTION_PARTY]);
    });
  } finally {
    await harness.close();
  }
});
