import assert from "node:assert/strict";
import test from "node:test";
import { conversationGateHarness, type FixtureTrip } from "./helpers/conversationGateHarness";

/**
 * Human takeover from real message echoes (echoObserver.ts verifyHumanEcho, takeoverGuard.ts).
 * Production evidence (2026-10-31): consultants on the phone and Meta's own automations arrive
 * under the SAME app id (Meta's inbox app); only Meta's record of the message — source tag and
 * timing — tells them apart. These journeys replay that shape with invented ids and trips; the
 * model is mocked. INBOX is the inbox app id as listed in ECHO_HUMAN_APP_IDS.
 */
const city = {
  id: "city", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал",
  adult_price: 1_791_000, child_price: 1_591_000, infant_price: 381_000, currency: "MNT", status: "active",
  duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15", "2098-03-29"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "",
  extra: { customer_visible: true, aliases: ["Норвел"], age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-23 сар" } },
} as unknown as FixtureTrip;
const one = { certainty: "one", tripId: "city" };
const INBOX = "777000333";
const MIN = 60_000;

test("human takeover journeys", async (context) => {
  const harness = await conversationGateHarness(context, { env: {
    META_APP_SECRET_NEXT: "next-meta-secret",
    VERIFY_TOKEN_NEXT: "next-verify-token",
    META_APP_ID: "555000111",
    ECHO_TAKEOVER_MODE: "enforce",
    ECHO_HUMAN_APP_IDS: INBOX,
  } });
  harness.catalog([city]);
  const fb = (sender: string, text: string, model: Record<string, unknown> = one) => harness.turn(sender, text, model, undefined, { platform: "facebook" });
  const threadReads = (customer: string) => harness.graphAuth().filter((call) => call.kind === "thread" && call.customer === customer).length;
  const tick = (ms: number) => context.mock.timers.tick(ms);
  try {
    await context.test("1. the bot's own reply echoes back and never pauses (no Meta lookup needed)", async () => {
      const answered = await fb("bot-echo", "Норвел хотын аялал үнэ");
      assert.equal(answered.sends.length, 1);
      const { BOT_MESSAGE_METADATA } = await import("../src/lib/messenger");
      const before = threadReads("bot-echo");
      await harness.echoTurn("bot-echo", { metadata: BOT_MESSAGE_METADATA, appId: "999000111", mid: harness.botMids().at(-1), text: answered.sends[0].text });
      assert.equal(harness.pauseState("bot-echo"), null);
      assert.equal(threadReads("bot-echo"), before, "the bot's echo is known by its metadata alone");
      assert.equal(harness.echoes().at(-1)?.classification, "bot");
      assert.equal((await fb("bot-echo", "Хүүхдийн үнэ хэд вэ?")).sends.length, 1, "the customer keeps being answered");
    });

    await context.test("2. a consultant on the PHONE replies: the bot stops at once, the reply and who sent it are recorded", async () => {
      await fb("phone", "Норвел хотын аялал үнэ");
      harness.thread("phone", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 4 * MIN },
        { from: "page", text: "Сайн байна уу, би зөвлөх Номин байна", agoMs: 0, source: "mobile", id: "m_phone_1" },
      ] });
      const echo = await harness.echoTurn("phone", { appId: INBOX, mid: "m_phone_1", text: "Сайн байна уу, би зөвлөх Номин байна" });
      assert.equal(echo.status, 200);
      assert.equal(echo.sends.length, 0);
      assert.equal(harness.pauseState("phone")?.pause_reason, "operator_reply");
      assert.equal(harness.takeoverSource("phone"), "staff_mobile");
      assert.equal(harness.echoes().at(-1)?.verdict, "human");
      assert.ok(harness.history.some((row) => row.sender_id === "phone" && row.role === "staff" && row.text.includes("зөвлөх Номин")),
        "the consultant's message joins the conversation history");
      const after = await fb("phone", "Хүүхдийн үнэ хэд вэ?");
      assert.equal(after.sends.length, 0, "the consultant answers, not the bot");
      assert.ok(after.history.some((row) => row.role === "user" && row.text === "Хүүхдийн үнэ хэд вэ?"), "the customer's message is kept");
    });

    await context.test("3. a consultant in Business Suite on a COMPUTER replies (web, long after the customer): the bot stops", async () => {
      await fb("desktop", "Норвел хотын аялал үнэ");
      harness.thread("desktop", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 3 * MIN },
        { from: "page", text: "Болд байна, утсаар ярих уу?", agoMs: 0, source: "web", id: "m_desk_1" },
      ] });
      await harness.echoTurn("desktop", { appId: INBOX, mid: "m_desk_1", text: "Болд байна, утсаар ярих уу?" });
      assert.equal(harness.pauseState("desktop")?.pause_reason, "operator_reply");
      assert.equal(harness.takeoverSource("desktop"), "staff_web");
      assert.equal((await fb("desktop", "3 сарын 15")).sends.length, 0);
    });

    await context.test("4. Meta's automated replies under the SAME app id never pause: welcome greeting and instant reply", async () => {
      harness.thread("greeted", { messages: [
        { from: "page", text: "Сайн байна уу! Бид удахгүй хариулна.", agoMs: 0, source: "web", id: "m_greet_1" },
      ] });
      await harness.echoTurn("greeted", { appId: INBOX, mid: "m_greet_1", text: "Сайн байна уу! Бид удахгүй хариулна." });
      assert.equal(harness.pauseState("greeted"), null, "the conversation's opener is Meta's welcome greeting");
      assert.equal(harness.echoes().at(-1)?.verdict, "automation");
      assert.equal((await fb("greeted", "Норвел хотын аялал үнэ")).sends.length, 1, "the new customer is answered");

      tick(MIN);
      harness.thread("instant", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 5_000 },
        { from: "page", text: "Баярлалаа, таны мессежийг хүлээн авлаа.", agoMs: 2_000, source: "web", id: "m_instant_1" },
      ] });
      await harness.echoTurn("instant", { appId: INBOX, mid: "m_instant_1", text: "Баярлалаа, таны мессежийг хүлээн авлаа." });
      assert.equal(harness.pauseState("instant"), null, "3 s after the customer is Meta's instant reply, not a person");
      assert.equal(harness.echoes().at(-1)?.verdict, "automation");
    });

    await context.test("4b. a keyword automation repeating itself in a burst is not a consultant (production 2026-10-31)", async () => {
      // The live shape: the same automated line 4, 17 and 20.0 s after the customer, the last one
      // just outside the 20-s window and 11 s after the bot's reply. It paused a real customer.
      tick(MIN);
      await fb("burst", "Норвел хотын аялал үнэ");
      harness.thread("burst", { messages: [
        { from: "customer", text: "Утасны дугаар", agoMs: 20_000 },
        { from: "page", text: "Сайн байна уу, аяллынхаа нэрийг бичнэ үү", agoMs: 17_000, source: "web", id: "m_burst_1" },
        { from: "page", text: "11110000, 22220000", agoMs: 16_000, source: "web", id: "m_burst_2" },
        { from: "page", text: "Манай утасны дугаарууд: 1111 0000", agoMs: 11_000, source: "web", id: harness.botMids().at(-1) },
        { from: "page", text: "11110000, 22220000", agoMs: 3_000, source: "web", id: "m_burst_3" },
        { from: "page", text: "11110000, 22220000", agoMs: 0, source: "web", id: "m_burst_4" },
      ] });
      await harness.echoTurn("burst", { appId: INBOX, mid: "m_burst_4", text: "11110000, 22220000" });
      assert.equal(harness.echoes().at(-1)?.verdict, "automation", "a verbatim repeat / a burst after the bot is Meta's automation");
      assert.equal(harness.pauseState("burst"), null, "the customer is not silenced");
      assert.equal((await fb("burst", "Хүүхдийн үнэ хэд вэ?")).sends.length, 1, "and is answered");
    });

    await context.test("5. other Page-connected apps and comment private replies never pause", async () => {
      const before = threadReads("integration");
      await harness.echoTurn("integration", { appId: 424242424242, mid: "m_other_app_1", text: "Захиалгын баталгаа" });
      assert.equal(harness.pauseState("integration"), null);
      assert.equal(harness.echoes().at(-1)?.classification, "unknown");
      assert.equal(threadReads("integration"), before, "an app that is not a human surface is not even looked up");
      assert.equal((await fb("integration", "Норвел хотын аялал үнэ")).sends.length, 1);

      harness.thread("commenter", { messages: [
        { from: "page", text: "Дэлгэрэнгүйг мессежээр илгээлээ", agoMs: 0, source: "pages:private_reply", id: "m_private_1" },
      ] });
      await harness.echoTurn("commenter", { appId: INBOX, mid: "m_private_1", text: "Дэлгэрэнгүйг мессежээр илгээлээ" });
      assert.equal(harness.pauseState("commenter"), null, "a comment private reply proves no person");
      assert.equal(harness.echoes().at(-1)?.verdict, "other");
    });

    await context.test("6. an echo Meta's record does not show is unverified: no pause, the thread check stays the backstop", async () => {
      harness.thread("lagging", { messages: [{ from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 2 * MIN }] });
      await harness.echoTurn("lagging", { appId: INBOX, mid: "m_not_there", text: "Сайн байна уу" });
      assert.equal(harness.pauseState("lagging"), null);
      assert.equal(harness.echoes().at(-1)?.verdict, "unverified");
    });

    await context.test("7. the same echo delivered by both Meta apps is verified and acted on once", async () => {
      await fb("twice", "Норвел хотын аялал үнэ");
      harness.thread("twice", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 2 * MIN },
        { from: "page", text: "Би танд туслая", agoMs: 0, source: "mobile", id: "m_twice_1" },
      ] });
      const before = threadReads("twice");
      await harness.echoTurn("twice", { appId: INBOX, mid: "m_twice_1", text: "Би танд туслая" });
      await harness.echoTurn("twice", { appId: INBOX, mid: "m_twice_1", text: "Би танд туслая", signSecret: "next-meta-secret" });
      assert.equal(threadReads("twice") - before, 1, "one Meta lookup for one message");
      assert.deepEqual(harness.echoes().slice(-2).map((echo) => echo.verdict), ["human", "duplicate"]);
      assert.equal(harness.history.filter((row) => row.sender_id === "twice" && row.role === "staff").length, 1, "stored once");
      assert.equal(harness.pauseState("twice")?.pause_reason, "operator_reply");
    });

    await context.test("8. a consultant answers WHILE the bot composes: the bot's reply is never sent", async () => {
      await fb("race", "Норвел хотын аялал үнэ");
      // The consultant's echo lands (and pauses the customer) while the model is working.
      harness.duringNextModelCall(() => harness.pause("race", new Date(Date.now() + 3 * 86_400_000).toISOString(), "operator_reply"));
      const turn = await fb("race", "Хүүхдийн үнэ хэд вэ?");
      assert.equal(turn.status, 200, "not an error: Meta must not redeliver it");
      assert.equal(turn.sends.length, 0, "the bot never talks over the consultant");
      assert.ok(turn.history.some((row) => row.role === "user" && row.text === "Хүүхдийн үнэ хэд вэ?"), "the message is kept");
      assert.ok(!turn.history.slice(-1).some((row) => row.role === "assistant"), "no undelivered reply is recorded as sent");
      // The log row is persisted fire-and-forget.
      await harness.settle(() => harness.logs.some((log) => log.event === "webhook.staff_takeover_mid_reply"));
      assert.ok(harness.logs.some((log) => log.event === "webhook.staff_takeover_mid_reply"));
    });

    await context.test("9. \"Ботод буцаах\": the bot answers again, and a late copy of the old consultant echo does not re-take it", async () => {
      harness.resume("phone");
      tick(MIN);
      // The thread as Meta shows it now: the consultant's reply is from before the release.
      harness.thread("phone", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 8 * MIN },
        { from: "page", text: "Сайн байна уу, би зөвлөх Номин байна", agoMs: 4 * MIN, source: "mobile", id: "m_phone_1" },
      ] });
      const back = await fb("phone", "Норвел аяллын үнийг дахин хэлээч");
      assert.equal(back.sends.length, 1, "released: the bot answers");
      await harness.echoTurn("phone", { appId: INBOX, mid: "m_phone_1", text: "Сайн байна уу, би зөвлөх Номин байна", signSecret: "next-meta-secret" });
      assert.equal(harness.pauseState("phone"), null, "a redelivered old echo never re-pauses a released conversation");
      // A NEW consultant message after the release takes over again.
      tick(MIN);
      harness.thread("phone", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 9 * MIN },
        { from: "page", text: "Сайн байна уу, би зөвлөх Номин байна", agoMs: 5 * MIN, source: "mobile", id: "m_phone_1" },
        { from: "customer", text: "Норвел аяллын үнийг дахин хэлээч", agoMs: 2 * MIN },
        { from: "page", text: "Дахиад нэг асуулт байна уу?", agoMs: 0, source: "mobile", id: "m_phone_2" },
      ] });
      await harness.echoTurn("phone", { appId: INBOX, mid: "m_phone_2", text: "Дахиад нэг асуулт байна уу?" });
      assert.equal(harness.pauseState("phone")?.pause_reason, "operator_reply");
      assert.equal((await fb("phone", "Тийм, хүүхдийн үнэ")).sends.length, 0);
    });

    await context.test("10. \"Хүнтэй холбогдох\" from the Messenger menu hands off at any point", async () => {
      await fb("menu", "Норвел хотын аялал үнэ");
      const tap = await harness.turn("menu", "Хүнтэй холбогдох", {}, undefined, { platform: "facebook", postback: true });
      assert.equal(tap.sends.length, 1, "the customer is told a person will answer");
      assert.ok(tap.leads.some((lead) => lead.kind === "handoff"), "staff get a hand-off lead");
      assert.equal(harness.pauseState("menu")?.pause_reason, "handoff");
      // Once a consultant owns the conversation, a tap only reaches staff — the bot says nothing.
      tick(MIN);
      const again = await harness.turn("phone", "Хүнтэй холбогдох", {}, undefined, { platform: "facebook", postback: true });
      assert.equal(again.sends.length, 0, "no bot message over the consultant");
      assert.ok(again.history.some((row) => row.role === "user" && row.text === "Хүнтэй холбогдох"));
    });

    // 14-day study of 300 real threads (2026-10-31): every Page message read as a consultant on a
    // computer was Meta's own — a returning customer's welcome burst, inbox notices, a personalised
    // automated reply 21 s after the customer. None of these may silence a customer.
    await context.test("11. Meta's welcome burst for a returning customer — no customer message near it — is not a consultant", async () => {
      tick(MIN);
      await fb("returning", "Норвел хотын аялал үнэ");
      harness.thread("returning", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 18 * MIN },
        { from: "page", text: "Бат Болд replied to your automated welcome message.", agoMs: 3_000, source: "web", id: "m_ret_notice" },
        { from: "page", text: "Hi Бат! Please let us know how we can help you.", agoMs: 2_000, source: "web", id: "m_ret_greet" },
        { from: "page", text: "", agoMs: 1_000, source: "web", id: "m_ret_card" },
      ] });
      await harness.echoTurn("returning", { appId: INBOX, mid: "m_ret_greet", text: "Hi Бат! Please let us know how we can help you." });
      assert.equal(harness.echoes().at(-1)?.verdict, "automation", "a greeting a second after Meta's own notice");
      await harness.echoTurn("returning", { appId: INBOX, mid: "m_ret_card", attachments: [{ type: "template" }] });
      assert.equal(harness.echoes().at(-1)?.verdict, "automation", "the burst's card too");
      assert.equal(harness.pauseState("returning"), null);
    });

    await context.test("12. Meta's inbox notices (lead stage, comment private reply) are not consultants", async () => {
      tick(MIN);
      await fb("noticed", "Норвел хотын аялал үнэ");
      harness.thread("noticed", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 3 * MIN },
        { from: "page", text: "Lead stage set to Qualified", agoMs: 2 * MIN, source: "web", id: "m_lead_stage" },
        { from: "page", text: "You are responding to a user comment to a post on your Page.", agoMs: MIN, source: "web", id: "m_comment_notice" },
      ] });
      const next = await fb("noticed", "Хүүхдийн үнэ хэд вэ?");
      assert.equal(next.sends.length, 1, "no consultant wrote: the customer is answered");
      assert.equal(harness.pauseState("noticed"), null);
    });

    await context.test("13. a long automated reply arriving faster than anyone types is not a consultant", async () => {
      tick(MIN);
      await fb("typed-fast", "Норвел хотын аялал үнэ");
      const text = "Сайн байна уу Бат! Та сонирхож байгаа аяллынхаа нэрийг бичээд үлдээгээрэй. Манай зөвлөх тантай удахгүй "
        + "холбогдох болно. Бүх аяллын хуваарийг манай вэбсайтаас харах боломжтой. Баярлалаа, сайхан өдөр!";
      assert.ok(text.length / 21 > 6, "fixture: faster than 6 characters a second");
      harness.thread("typed-fast", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 21_000 },
        { from: "page", text, agoMs: 0, source: "web", id: "m_typed_fast" },
      ] });
      await harness.echoTurn("typed-fast", { appId: INBOX, mid: "m_typed_fast", text });
      assert.equal(harness.echoes().at(-1)?.verdict, "automation");
      assert.equal(harness.pauseState("typed-fast"), null);
    });

    await context.test("14. a consultant on a computer answering soon after the BOT's reply is recognised", async () => {
      // 22 s after the customer, 14 s after the bot: the bot's own reply opens no automation window
      // (9% of real consultant take-overs come within 20 s of the bot's reply).
      tick(MIN);
      await fb("desk-fast", "Норвел хотын аялал үнэ");
      harness.thread("desk-fast", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 36_000 },
        { from: "page", text: "НОРВЕЛ ХОТЫН АЯЛАЛ", agoMs: 28_000, source: "web", id: harness.botMids().at(-1) },
        { from: "page", text: "Болд байна, хэдүүлээ явах вэ?", agoMs: 14_000, source: "web", id: "m_desk_fast" },
      ] });
      await harness.echoTurn("desk-fast", { appId: INBOX, mid: "m_desk_fast", text: "Болд байна, хэдүүлээ явах вэ?" });
      assert.equal(harness.echoes().at(-1)?.verdict, "human");
      assert.equal(harness.pauseState("desk-fast")?.pause_reason, "operator_reply");
      assert.equal(harness.takeoverSource("desk-fast"), "staff_web");
    });

    // Owner, 2026-10-31: a consultant's conversation never returns to the bot by itself.
    await context.test("15. a consultant's conversation stays with staff after three days, until «Ботод буцаах»", async () => {
      tick(MIN);
      await fb("owned", "Норвел хотын аялал үнэ");
      harness.thread("owned", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 5 * MIN },
        { from: "page", text: "Сайн байна уу, Номин байна", agoMs: 0, source: "mobile", id: "m_owned_1" },
      ] });
      await harness.echoTurn("owned", { appId: INBOX, mid: "m_owned_1", text: "Сайн байна уу, Номин байна" });
      const { UNTIL_RELEASED_AT } = await import("../src/lib/travelSessionDb");
      assert.equal(harness.pauseState("owned")?.expires_at, UNTIL_RELEASED_AT, "no end date");
      tick(4 * 86_400_000);
      const later = await fb("owned", "Норвел аялал хэзээ гарах вэ?");
      assert.equal(later.sends.length, 0, "four days later the consultant still has the conversation");
      harness.resume("owned"); // staff press «Ботод буцаах»
      tick(MIN);
      harness.thread("owned", { messages: [
        { from: "customer", text: "Норвел хотын аялал үнэ", agoMs: 4 * 86_400_000 + 6 * MIN },
        { from: "page", text: "Сайн байна уу, Номин байна", agoMs: 4 * 86_400_000 + MIN, source: "mobile", id: "m_owned_1" },
        { from: "customer", text: "Норвел аялал хэзээ гарах вэ?", agoMs: 2 * MIN },
      ] });
      const back = await fb("owned", "Норвел аяллын хүүхдийн үнэ хэд вэ?");
      assert.equal(back.sends.length, 1, "«Ботод буцаах» hands the customer back to the bot");
    });
  } finally {
    await harness.close();
  }
});

// Known gap (docs/chatbot-followups.md): Meta tags a consultant on a computer and Meta's own
// automations alike (`source:web`, the inbox app id); timing is what tells them apart. A desktop
// consultant's FIRST reply within 20 s of the customer's message is read as an automation, so the
// bot can answer the customer's next message once — until that consultant's next message, or the
// thread check, takes over. Phone replies are never affected. Not yet seen in production (no
// desktop consultant in 14 days of threads); to be measured in the live desktop test.
test.todo("a desktop consultant's first reply within 20 s of the customer's message takes the conversation over");

test("takeover guard: only a person's pause blocks the bot's send; staff alerts always go", async (context) => {
  const harness = await conversationGateHarness(context);
  const { sendTextMessage } = await import("../src/lib/messenger");
  const { isStaffTakeoverSendBlocked } = await import("../src/lib/takeoverGuard");
  const sendsTo = (customer: string) => harness.graphAuth().filter((call) => call.kind === "send" && call.customer === customer).length;
  try {
    const until = new Date(Date.now() + 86_400_000).toISOString();
    for (const reason of ["operator_reply", "manual"]) {
      harness.pause(`guard-${reason}`, until, reason);
      await assert.rejects(sendTextMessage(`guard-${reason}`, "Норвел — үнэ", "test-page-token"), isStaffTakeoverSendBlocked);
      assert.equal(sendsTo(`guard-${reason}`), 0, `${reason}: nothing reaches Meta`);
      await sendTextMessage(`guard-${reason}`, "Шинэ лийд", "test-page-token", { allowDuringTakeover: true });
      assert.equal(sendsTo(`guard-${reason}`), 1, "a staff alert is never held");
    }
    for (const reason of ["booked_customer", "handoff"]) {
      harness.pause(`guard-${reason}`, until, reason);
      await sendTextMessage(`guard-${reason}`, "Норвел — үнэ", "test-page-token");
      assert.equal(sendsTo(`guard-${reason}`), 1, `${reason} is the bot's own marker, not a person`);
    }
  } finally {
    await harness.close();
  }
});

test("Messenger menu: \"Хүнтэй холбогдох\" is added first, the owner's items are kept, and it is idempotent", async () => {
  const { withHumanRequestItem } = await import("../src/lib/messengerMenu");
  const owner = [{ locale: "default", composer_input_disabled: false, call_to_actions: [
    { type: "postback", title: "Эхлэх", payload: "ACT::fixture-a" },
    { type: "postback", title: "Асуулт асуух", payload: "ACT::fixture-b" },
  ] }];
  const first = withHumanRequestItem(owner);
  assert.equal(first.changed, true);
  assert.deepEqual(first.menus[0].call_to_actions?.map((action) => action.title), ["Хүнтэй холбогдох", "Эхлэх", "Асуулт асуух"]);
  assert.equal(first.menus[0].call_to_actions?.[0].payload, "HUMAN_HANDOFF");
  assert.equal(withHumanRequestItem(first.menus).changed, false, "running it again changes nothing");
  assert.deepEqual(withHumanRequestItem(undefined).menus[0].call_to_actions?.map((action) => action.title), ["Хүнтэй холбогдох"]);
});
