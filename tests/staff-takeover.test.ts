import test from "node:test";
import assert from "node:assert/strict";
import { latestStaffReplyAt, type ThreadMessage } from "../src/lib/staffTakeover";

const PAGE = "page-1";
const now = new Date("2099-05-10T12:00:00Z");
const msg = (from: string, at: string, source: "mobile" | "web", message = "x"): ThreadMessage => ({
  from: { id: from }, message, created_time: at, tags: { data: [{ name: "inbox" }, { name: `source:${source}` }] },
});

test("a staff message typed in the Page app means staff own the conversation", () => {
  const messages = [
    msg("customer", "2099-05-10T08:00:00Z", "mobile", "Захиалга өгье"),
    msg(PAGE, "2099-05-10T08:00:05Z", "web", "бот хариулт"),
    msg(PAGE, "2099-05-10T09:30:00Z", "mobile", "Дансны дугаар: …"),
  ];
  assert.equal(latestStaffReplyAt({ messages, pageId: PAGE, now })?.toISOString(), "2099-05-10T09:30:00.000Z");
});

test("the bot's own replies and Meta's welcome messages are not staff", () => {
  const messages = [
    msg(PAGE, "2099-05-10T08:00:00Z", "web", "Hi Bat! Please let us know how we can help you."),
    msg(PAGE, "2099-05-10T08:00:01Z", "web", "Bat replied to your automated welcome message."),
    msg("customer", "2099-05-10T08:01:00Z", "mobile", "Үнэ хэд вэ"),
    msg(PAGE, "2099-05-10T08:05:00Z", "web", "✈️ Аялал — үнэ …"),
  ];
  assert.equal(latestStaffReplyAt({ messages, pageId: PAGE, now }), null);
});

test("a staff message older than the takeover window lets the bot answer again", () => {
  const messages = [msg(PAGE, "2099-05-01T09:00:00Z", "mobile", "Өдрийн мэнд")];
  assert.equal(latestStaffReplyAt({ messages, pageId: PAGE, now }), null);
});

/*
 * 2026-10-30 rebuild. Production threads: the bot, a consultant on a computer (Business
 * Suite) and Meta's automations are all `source:web`; only the phone app is `source:mobile`.
 * The bot's own messages are known by the id it recorded when sending; anything else the Page
 * wrote on the web is a consultant, unless it is Meta's automation (within seconds of the
 * customer, or an inbox notice). Messages from before the ids were recorded count as before.
 */
const at = (iso: string) => Date.parse(iso);
const page = (iso: string, source: "mobile" | "web", text: string, id?: string): ThreadMessage =>
  ({ ...msg(PAGE, iso, source, text), ...(id ? { id } : {}) });
const recorded = { pageId: PAGE, recordingSince: at("2099-05-01T00:00:00Z") };

test("a consultant writing from Business Suite on a computer owns the conversation", async () => {
  const { latestStaffReply } = await import("../src/lib/staffTakeover");
  const messages = [
    msg("customer", "2099-05-10T08:00:00Z", "mobile", "Захиалъя"),
    page("2099-05-10T08:00:03Z", "web", "бот хариулт", "m_bot1"),
    page("2099-05-10T08:12:00Z", "web", "Сайн байна уу, би зөвлөх байна", "m_staff1"),
  ];
  assert.deepEqual(latestStaffReply({ messages, now, botMids: new Set(["m_bot1"]), ...recorded }),
    { at: new Date("2099-05-10T08:12:00Z"), origin: "staff_web" });
});

test("the bot's own web messages, Meta's instant reply and inbox notices are not a consultant", async () => {
  const { latestStaffReply, classifyPageMessage } = await import("../src/lib/staffTakeover");
  const messages = [
    msg("customer", "2099-05-10T08:00:00Z", "mobile", "Сайн уу"),
    page("2099-05-10T08:00:02Z", "web", "Hi Bat! Please let us know how we can help you.", "m_meta"),
    page("2099-05-10T08:00:40Z", "web", "Bat replied to your automated welcome message.", "m_notice"),
    page("2099-05-10T09:30:00Z", "web", "✈️ Аялал — үнэ …", "m_bot2"),
  ];
  assert.equal(latestStaffReply({ messages, now, botMids: new Set(["m_bot2"]), ...recorded }), null);
  assert.equal(classifyPageMessage(messages[1], at("2099-05-10T08:00:00Z"), recorded), "automation", "within seconds of the customer");
  assert.equal(classifyPageMessage(messages[2], at("2099-05-10T08:00:00Z"), recorded), "automation", "an inbox notice");
  // An unrecorded bot reply is still recognised by the reply the bot stored at that moment.
  assert.equal(classifyPageMessage(page("2099-05-10T09:30:00Z", "web", "✈️ Аялал — үнэ …"), at("2099-05-10T09:25:00Z"),
    { ...recorded, botReplies: [{ at: at("2099-05-10T09:29:58Z"), text: "✈️ Аялал — үнэ … дэлгэрэнгүй" }] }), "bot");
});

test("web messages from before the bot recorded its ids count as before (phone app only)", async () => {
  const { classifyPageMessage, latestStaffReply } = await import("../src/lib/staffTakeover");
  const old = page("2099-04-30T10:00:00Z", "web", "Өдрийн мэнд, зөвлөх");
  assert.equal(classifyPageMessage(old, at("2099-04-30T09:00:00Z"), recorded), "legacy");
  assert.equal(classifyPageMessage(old, at("2099-04-30T09:00:00Z"), { pageId: PAGE, recordingSince: null }), "legacy");
  assert.equal(latestStaffReply({ messages: [old], now: new Date("2099-05-01T12:00:00Z"), ...recorded }), null);
});

test("a thread that cannot be read is reported as unverified, never as 'no consultant'", async (context) => {
  const { fetchThreadMessages } = await import("../src/lib/staffTakeover");
  const cases: Array<[() => Promise<Response>, string]> = [
    [async () => { throw Object.assign(new Error("timed out"), { name: "TimeoutError" }); }, "timeout"],
    [async () => Response.json({ error: { code: 200, message: "permission" } }, { status: 403 }), "permission"],
    [async () => Response.json({ error: { code: 190 } }, { status: 400 }), "permission"],
    [async () => Response.json({ error: { code: 2 } }, { status: 500 }), "api_error"],
    [async () => Response.json({ paging: {} }), "incomplete"],
    [async () => Response.json({ data: [{ id: "t_1" }] }), "incomplete"],
  ];
  for (const [respond, reason] of cases) {
    context.mock.method(globalThis, "fetch", respond);
    assert.deepEqual(await fetchThreadMessages({ token: "fixture", senderId: "fixture-customer", timeoutMs: 100 }), { status: "unverified", reason });
    context.mock.restoreAll();
  }
  context.mock.method(globalThis, "fetch", async () => Response.json({ data: [] }));
  assert.deepEqual(await fetchThreadMessages({ token: "fixture", senderId: "fixture-customer", timeoutMs: 100 }), { status: "ok", messages: [] });
});

/*
 * Hotfix 2026-10-31. Live 2026-10-30 22:37 UTC: a brand-new customer's first message got
 * silence because Meta's automated welcome greeting, sent 5 s before it, was read as a
 * consultant on a computer. And a consultant's photo (no text) sent from the phone right after a
 * bot reply was read as the bot, because the stored-reply match ran before the phone check.
 */
const welcome = "Hi Bat! Please let us know how we can help you.";

test("1. Meta's automated greeting that opens the conversation never silences the bot", async () => {
  const { latestStaffReply, classifyPageMessage } = await import("../src/lib/staffTakeover");
  const messages = [page("2099-05-10T08:00:00Z", "web", welcome, "m_greeting"), msg("customer", "2099-05-10T08:00:05Z", "mobile", "Сайн байна уу")];
  assert.equal(latestStaffReply({ messages, now, botMids: new Set(), ...recorded }), null);
  assert.equal(classifyPageMessage(messages[0], null, recorded, true), "automation");
  // A full page of 25 messages may not start at the conversation's start: nothing is assumed there.
  assert.equal(latestStaffReply({ messages, now, botMids: new Set(), ...recorded, threadComplete: false })?.origin, "staff_web");
  // Only the opening run: a web message the bot did not send, after the bot's own message, is a
  // consultant even when the thread shows no customer message before it.
  assert.equal(latestStaffReply({ messages: [page("2099-05-10T08:00:00Z", "web", "НОРВЕЛ", "m_bot0"),
    page("2099-05-10T08:05:00Z", "web", "Захиалгыг тань авлаа", "m_x")], now, botMids: new Set(["m_bot0"]), ...recorded })?.origin, "staff_web");
});

test("2. a genuine desktop consultant reply after the greeting still takes the conversation over", async () => {
  const { latestStaffReply } = await import("../src/lib/staffTakeover");
  const messages = [
    page("2099-05-10T08:00:00Z", "web", welcome, "m_greeting"),
    msg("customer", "2099-05-10T08:00:05Z", "mobile", "Үнэ хэд вэ"),
    page("2099-05-10T08:00:09Z", "web", "НОРВЕЛ ХОТЫН АЯЛАЛ", "m_bot1"),
    page("2099-05-10T08:06:00Z", "web", "Сайн байна уу, би аяллын зөвлөх", "m_staff"),
  ];
  assert.deepEqual(latestStaffReply({ messages, now, botMids: new Set(["m_bot1"]), ...recorded }),
    { at: new Date("2099-05-10T08:06:00Z"), origin: "staff_web" });
});

test("3. the bot's own messages are never a consultant, including its images", async () => {
  const { latestStaffReply } = await import("../src/lib/staffTakeover");
  const messages = [
    msg("customer", "2099-05-10T08:00:00Z", "mobile", "Зураг байна уу"),
    page("2099-05-10T08:00:04Z", "web", "Аяллын зураг", "m_bot_text"),
    // The bot's photo whose id was not recorded: matched to the stored reply that carried it.
    page("2099-05-10T08:00:40Z", "web", "", "m_bot_photo_unrecorded"),
  ];
  assert.equal(latestStaffReply({ messages, now, botMids: new Set(["m_bot_text"]), ...recorded,
    botReplies: [{ at: at("2099-05-10T08:00:39Z"), text: "", attachments: 2 }] }), null);
});

test("4. a consultant's photo (no text) right after a bot reply is a consultant, from the phone or a computer", async () => {
  const { latestStaffReply } = await import("../src/lib/staffTakeover");
  const replies = [{ at: at("2099-05-10T08:00:04Z"), text: "НОРВЕЛ ХОТЫН АЯЛАЛ — үнэ", attachments: 0 }];
  for (const source of ["mobile", "web"] as const) {
    const messages = [
      msg("customer", "2099-05-10T08:00:00Z", "mobile", "Дансны дугаар"),
      page("2099-05-10T08:00:04Z", "web", "НОРВЕЛ ХОТЫН АЯЛАЛ — үнэ", "m_bot"),
      page("2099-05-10T08:01:00Z", source, "", "m_staff_photo"),
    ];
    assert.deepEqual(latestStaffReply({ messages, now, botMids: new Set(["m_bot"]), ...recorded, botReplies: replies }),
      { at: new Date("2099-05-10T08:01:00Z"), origin: source === "mobile" ? "staff_mobile" : "staff_web" }, source);
  }
});
