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
