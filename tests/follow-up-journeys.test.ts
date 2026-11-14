import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";
import { FOLLOW_UP_TRIP_WEB_LINE, NEXT_QUESTION_DATE, NEXT_QUESTION_PARTY, NEXT_QUESTION_PROGRAM, NEXT_QUESTION_TEXTS, PARTY_AND_PHONE_INVITE,
  PHONE_INVITE } from "../src/lib/nextQuestionText";
/** The phone ask beside a question that already carries the one emoji. */
const PHONE_ASK = PHONE_INVITE.replace(/\s*😊$/u, "");

/**
 * Owner, 2026-11-12: "in the last 5-10 days the chatbot was not asking questions / not doing follow-up …
 * if the person just left you on seen, make a follow-up question after 10 min … it won't message after
 * they clicked 'connect to human', etc." Real shape (10 days of chats): 59 threads ended on a bot reply the
 * customer never answered, 42 of them on a reply that asked nothing — a fare card, "<date>: захиалга
 * нээлттэй.", a bare programme link.
 *
 * Owner, 2026-11-13: "when someone doesn't answer for 30 minute send like 'хөтөлбөр авах уу' or send the web
 * with it": the delay is 30 minutes, and with one trip in play the follow-up offers its programme (its web page
 * above the question, the «Хөтөлбөр үзэх» button below; a typed "тийм" is that button).
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
const NORVEL_PAGE = "https://uudamtravel.mn/trips/norvel-hotyn-aylal";
/** The follow-up with one trip in play: its page (when the bot has not shown it yet), then the programme offer. */
const PROGRAM_OFFER = `${FOLLOW_UP_TRIP_WEB_LINE} ${NORVEL_PAGE}\n${NEXT_QUESTION_PROGRAM}`;
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

    await context.test("(a)+(i) a fare card gets the next question; 30 min of silence brings exactly one follow-up, never a second", async () => {
      const answered = await fb("fu-seen", ASK_PRICE);
      assert.equal(answered.sends.length, 1);
      // Which departure, then how many and the phone in one line (owner, 2026-11-14: "wanted numbers most").
      assert.ok(answered.sends[0].text.endsWith(`\n\n${NEXT_QUESTION_DATE}\n\n${PARTY_AND_PHONE_INVITE}`),
        `the fare card asks which departure, how many and the phone: ${answered.sends[0].text}`);
      assert.match(answered.sends[0].text, /1,791,000₮/, "the answer itself is unchanged above the questions");
      answeredThread("fu-seen", ASK_PRICE, answered.sends[0].text);
      tick(29 * MIN);
      assert.deepEqual(to(await cron(), "fu-seen"), [], "not before the delay");
      tick(2 * MIN);
      const first = await cron();
      // One trip in play, its programme not sent yet: the follow-up offers it, with the trip's web page.
      assert.deepEqual(to(first, "fu-seen"), [PROGRAM_OFFER]);
      const lastSend = harness.sendMetadata().filter((send) => send.senderId === "fu-seen").at(-1);
      assert.equal(lastSend?.metadata, BOT_MESSAGE_METADATA, "sent through the bot's own path: the send-time takeover guard applies");
      assert.deepEqual(lastSend?.quickReplies, ["Хөтөлбөр үзэх"], "with the programme button");
      assert.equal(harness.history.filter((row) => row.sender_id === "fu-seen").at(-1)?.text, PROGRAM_OFFER, "stored as the bot's message");
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "fu-seen"), [], "never a second follow-up for the same answer");
      // The customer answers, the bot answers again, and leaves it on seen again: still once per 24 h.
      const again = await fb("fu-seen", "3/29");
      assert.equal(again.sends.length, 1);
      answeredThread("fu-seen", "3/29", again.sends[0].text);
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "fu-seen"), [], "at most one follow-up in 24 hours");
      await harness.settle(() => followUpLogs("fu-seen").some((log) => log.event === "follow_up.sent"));
      const sent = followUpLogs("fu-seen").find((log) => log.event === "follow_up.sent");
      assert.ok(sent, "the send is logged");
      assert.doesNotMatch(JSON.stringify(sent), /Норвел|үнэ|3\/29/u, "no customer text in the log");
    });

    await context.test("(b) the customer wrote before 30 minutes: nothing; a new answer restarts the 30 minutes", async () => {
      const answered = await fb("fu-wrote", ASK_PRICE);
      answeredThread("fu-wrote", ASK_PRICE, answered.sends[0].text);
      tick(4 * MIN);
      assert.deepEqual((await fb("fu-wrote", "😊", {})).sends, [], "an emoji is stored, not answered");
      tick(27 * MIN);
      assert.deepEqual(to(await cron(), "fu-wrote"), []);
      assert.equal(harness.followUpState("fu-wrote")?.slot, "", "the stale question is cleared");

      const first = await fb("fu-restart", ASK_PRICE);
      answeredThread("fu-restart", ASK_PRICE, first.sends[0].text);
      tick(5 * MIN);
      const second = await fb("fu-restart", "3/15");
      // The first answer just asked how many and the phone: the departure answer does not ask them again.
      assert.match(second.sends[0].text, /^3 сарын 15: захиалга нээлттэй/u);
      assert.ok(!second.sends[0].text.includes(NEXT_QUESTION_PARTY) && !second.sends[0].text.includes("утасны дугаар"),
        `never the question the bot just asked: ${second.sends[0].text}`);
      answeredThread("fu-restart", "3/15", second.sends[0].text);
      tick(26 * MIN);
      assert.deepEqual(to(await cron(), "fu-restart"), [], "31 minutes after the first answer, 26 after the last");
      tick(5 * MIN);
      // Trip and date known, the party just asked: the follow-up offers the programme (not sent yet).
      assert.deepEqual(to(await cron(), "fu-restart"), [PROGRAM_OFFER]);
    });

    await context.test("(l) 'тийм' under the programme offer sends the programme; the offer never comes once it was sent", async () => {
      const answered = await fb("fu-yes", ASK_PRICE);
      answeredThread("fu-yes", ASK_PRICE, answered.sends[0].text);
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "fu-yes"), [PROGRAM_OFFER]);
      for (const [index, yes] of ["тийм", "за", "Авъя"].entries()) {
        const sender = `fu-yes-${index}`;
        const card = await fb(sender, ASK_PRICE);
        answeredThread(sender, ASK_PRICE, card.sends[0].text);
        tick(31 * MIN);
        assert.deepEqual(to(await cron(), sender), [PROGRAM_OFFER], `${sender}: offered`);
        const reply = await fb(sender, yes, {});
        assert.ok(reply.sends.length > 0, `"${yes}": answered`);
        assert.ok(reply.sends[0].text.startsWith(NORVEL_PAGE), `"${yes}" gets the programme of the trip in play: ${reply.sends[0].text}`);
      }
      // A "yes" not under the offer is not the button.
      const { programOfferAccepted } = await import("../src/lib/programOffer");
      assert.equal(programOfferAccepted([{ role: "assistant", text: "НОРВЕЛ ХОТЫН АЯЛАЛ\n\nАль өдөр нь танд тохирох вэ?" }], "тийм"), null);
      assert.equal(programOfferAccepted([{ role: "assistant", text: PROGRAM_OFFER }], "тийм, гэхдээ үнэ нь хэд вэ"), null, "a longer message is read as written");
      assert.equal(programOfferAccepted([{ role: "assistant", text: PROGRAM_OFFER }], "тиймээ"), "Хөтөлбөр үзэх");
      // The programme already went out in the conversation: the follow-up asks the next thing instead.
      const { nextQuestion } = await import("../src/lib/nextQuestion");
      const base = { reply: "НОРВЕЛ ХОТЫН АЯЛАЛ\nPDF хөтөлбөрийг хавсаргалаа.", history: [], customerText: "Хөтөлбөр үзэх",
        selection: { tripId: "norvel", date: null, dateScope: null, passengers: [] } as never, pendingTripIds: [], ledger: null,
        trips: [norvel] as never, phoneKnown: false, now: new Date("2098-02-01T04:00:00Z") };
      assert.notEqual(nextQuestion({ ...base, purpose: "follow_up" })?.slot, "program");
    });

    await context.test("(c) after 'connect to a person' (hand-off pause) nothing is sent", async () => {
      assert.equal((await fb("fu-human", ASK_PRICE)).sends.length, 1);
      assert.equal(harness.followUpState("fu-human")?.slot, "program", "the answer armed a follow-up");
      const handoff = await fb("fu-human", "Зөвлөхтэй холбогдох", {});
      assert.equal(handoff.sends.length, 1);
      assert.equal(harness.pauseState("fu-human")?.pause_reason, "handoff");
      assert.equal(harness.followUpState("fu-human")?.slot, "", "the hand-off reply cleared the armed question");
      assert.ok(!NEXT_QUESTION_TEXTS.some((question) => handoff.sends[0].text.includes(question)), "the hand-off reply asks nothing more");
      answeredThread("fu-human", "Зөвлөхтэй холбогдох", handoff.sends[0].text);
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "fu-human"), []);
      // The hand-off marker written while the answer was still armed (another path paused the customer).
      const armed = await fb("fu-handoff-marker", ASK_PRICE);
      answeredThread("fu-handoff-marker", ASK_PRICE, armed.sends[0].text);
      harness.pause("fu-handoff-marker", new Date(Date.now() + HOUR).toISOString(), "handoff");
      tick(31 * MIN);
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
      tick(31 * MIN);
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
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "fu-existing"), []);
    });

    await context.test("(e) 'Баярлалаа' closes the conversation: no follow-up", async () => {
      await fb("fu-thanks", ASK_PRICE);
      const thanks = await fb("fu-thanks", "Баярлалаа", {});
      assert.equal(thanks.sends.length, 1);
      assert.equal(harness.followUpState("fu-thanks")?.slot, "", "the thank-you reply cleared the armed question");
      answeredThread("fu-thanks", "Баярлалаа", thanks.sends[0].text);
      tick(31 * MIN);
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
      tick(31 * MIN);
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

    await context.test("(i) answers right after the questions do not re-ask them; a list that already asks gets only the phone ask", async () => {
      // The first answer asks which departure, how many and the phone ((a) above). Right after it, the programme link
      // asks nothing again (never the question the bot just asked; the follow-up after silence offers the programme).
      const opening = await fb("fu-program", "Норвел хотын аялал");
      assert.ok(opening.sends[0].text.endsWith(PARTY_AND_PHONE_INVITE), opening.sends[0].text);
      const program = await fb("fu-program", "hutulbur", { ...one, topics: ["program"] });
      assert.equal(program.sends[0].text, "https://uudamtravel.mn/trips/norvel-hotyn-aylal");
      await fb("fu-date", ASK_PRICE);
      const date = await fb("fu-date", "3/15");
      assert.match(date.sends[0].text, /^3 сарын 15: захиалга нээлттэй/u);
      assert.ok(!date.sends[0].text.includes(NEXT_QUESTION_PARTY) && !date.sends[0].text.includes("утасны дугаар"), date.sends[0].text);
      const list = await fb("fu-list", "3 сарын аялал", {});
      assert.match(list.sends[0].text, /Аль аяллыг нь сонирхож байна вэ\?\n1 эсвэл 2 гэж бичээрэй 😊/u, "the list asks already");
      const ownQuestions = NEXT_QUESTION_TEXTS.filter((question) => question !== PHONE_INVITE && question !== PARTY_AND_PHONE_INVITE);
      assert.ok(!ownQuestions.some((question) => list.sends[0].text.includes(question)), "no second 'which one?' added to it");
      assert.ok(list.sends[0].text.endsWith(PARTY_AND_PHONE_INVITE.replace(/\s*😊$/u, "")), `only the phone ask follows: ${list.sends[0].text}`);
      // Instagram: the same answer asks the same questions, but is never followed up (no takeover guard there).
      const instagram = await harness.turn("fu-instagram", ASK_PRICE, one);
      assert.ok(instagram.sends[0].text.endsWith(`\n\n${NEXT_QUESTION_DATE}\n\n${PARTY_AND_PHONE_INVITE}`), instagram.sends[0].text);
      assert.ok(!harness.followUpState("fu-instagram")?.slot, "an Instagram answer arms nothing");
    });

    await context.test("(j) a consultant takes over while the sweep reads the thread: the send is blocked", async () => {
      const answered = await fb("fu-race", ASK_PRICE);
      answeredThread("fu-race", ASK_PRICE, answered.sends[0].text);
      harness.onThreadRead("fu-race", () => harness.pause("fu-race", "2999-12-31T00:00:00.000Z", "manual"));
      tick(31 * MIN);
      assert.deepEqual(to(await cron(), "fu-race"), []);
      await harness.settle(() => followUpLogs("fu-race").some((log) => log.event === "follow_up.skipped"));
      assert.equal(followUpLogs("fu-race").find((log) => log.event === "follow_up.skipped")?.fields.reason, "paused_before_send:manual");
    });

    await context.test("(k) the owner's switch and the kill switch stop every follow-up", async () => {
      const answered = await fb("fu-off", ASK_PRICE);
      answeredThread("fu-off", ASK_PRICE, answered.sends[0].text);
      harness.settings({ extra: { ...SETTINGS.extra, follow_up_enabled: false } });
      tick(31 * MIN);
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
      assert.deepEqual(to(await cron(), "fu-off"), [PROGRAM_OFFER]);
    });

    await context.test("(f) quiet hours 22:00-09:00 Ulaanbaatar: the follow-up waits until 09:00", async () => {
      tick(Date.parse("2098-02-02T13:55:00Z") - Date.now()); // 21:55 in Ulaanbaatar
      const answered = await fb("fu-night", ASK_PRICE);
      answeredThread("fu-night", ASK_PRICE, answered.sends[0].text);
      tick(31 * MIN); // 22:06
      const night = await cron();
      assert.equal(night.body.deferred, "quiet_hours");
      assert.deepEqual(to(night, "fu-night"), []);
      tick(Date.parse("2098-02-03T00:55:00Z") - Date.now()); // 08:55
      assert.deepEqual(to(await cron(), "fu-night"), []);
      tick(5 * MIN); // 09:00, 11 hours after the answer: inside the 20 h window
      assert.deepEqual(to(await cron(), "fu-night"), [PROGRAM_OFFER]);
    });
  } finally {
    await harness.close();
  }
});
