import assert from "node:assert/strict";
import test from "node:test";
import { CHATBOT_REPLY_RULES, compactReplyOptions, presentAssistantReply, replyPreferences } from "../src/lib/chatbotReplyPolicy";

test("focused adult question removes independent child fares, not date, hotel or conditions", () => {
  const reply = presentAssistantReply({ userText: "tom hun une hed ve", reply: "2026-10-08\nHotel Lumi\nТом хүн: 2,000,000₮ - 3,000,000₮\nХүүхэд: 1,500,000₮\nНярай: 400,000₮\nЗөвхөн хоёр хүн нэг өрөөнд байрлах нөхцөлтэй." });
  assert.match(reply, /2,000,000₮ - 3,000,000₮/);
  assert.match(reply, /Hotel Lumi|2026-10-08/);
  assert.match(reply, /Зөвхөн хоёр хүн/);
  assert.doesNotMatch(reply, /Хүүхэд:|Нярай:/);
});

test("do not hide child fares in totals or shared paragraphs", () => {
  for (const original of ["Том хүн x 2: 2,000,000₮\nХүүхэд x 1: 1,500,000₮\nНийт: 5,500,000₮", "Том хүн: 2,000,000₮, Хүүхэд: 1,500,000₮"]) {
    assert.equal(presentAssistantReply({ userText: "2 том хүн нийт хэд", reply: original }), original);
  }
});

test("a full-fare request keeps every category; missing requested tier is never disguised", () => {
  const original = "Том хүн: 2,000,000₮\nХүүхэд: 1,500,000₮";
  assert.equal(presentAssistantReply({ userText: "бүх үнэ том хүүхэд", reply: original }), original);
  assert.equal(presentAssistantReply({ userText: "нярай үнэ", reply: original }), original);
});

test("contact asks are conditional and repeated asks are stripped without deleting the answer", () => {
  const reply = "Хугацаа: 6 өдөр.\n\nУтасны дугаараа үлдээвэл зөвлөх холбогдоно.";
  assert.equal(presentAssistantReply({ userText: "хэдэн өдөр вэ", reply }), "Хугацаа: 6 өдөр.");
  assert.match(presentAssistantReply({ userText: "зөвлөхтэй холбогдоё", reply }), /дугаараа/);
  assert.doesNotMatch(presentAssistantReply({ userText: "захиалъя", reply, phoneAlreadyRequested: true }), /дугаараа/);
});

test("repeated greetings disappear, one emoji remains, presentation is idempotent", () => {
  const input = { userText: "үнэ", hasPriorReply: true, reply: "Сайн байна уу!\n\nТом хүн: 2,000,000₮ 😊\nГарах: 2026-10-08 📅\nБуудал: Hotel Lumi 🏨" };
  const reply = presentAssistantReply(input);
  assert.doesNotMatch(reply, /Сайн байна уу|📅|🏨/);
  assert.match(reply, /😊/);
  assert.equal(presentAssistantReply({ ...input, reply }), reply);
});

test("control tokens stay intact and long factual conditions are never truncated", () => {
  assert.equal(presentAssistantReply({ userText: "үнэ", reply: "REFER" }), "REFER");
  assert.equal(presentAssistantReply({ userText: "үнэ", reply: "SILENT" }), "SILENT");
  const reply = "Нөхцөл: " + "баталгаатай нөхцөл ".repeat(100);
  assert.equal(presentAssistantReply({ userText: "үнэ", reply }), reply.trim());
  assert.match(presentAssistantReply({ userText: "зураг", reply: "Зураг 😊\nhttps://example.com/🌊.jpg\nГалерей 🏨" }), /https:\/\/example.com\/🌊\.jpg/);
});

test("compact menus disclose omitted options and explicitly requested full lists remain available", () => {
  const options = ["A", "B", "C", "D", "E"];
  assert.equal(compactReplyOptions(options, "сонголт").length, 4);
  assert.match(compactReplyOptions(options, "сонголт")[3], /Өөр 2/);
  assert.deepEqual(compactReplyOptions(options, "бүх сонголт"), options);
});

test("presentation preferences scope deposit, meal, ticket and multiple questions", () => {
  assert.deepEqual(replyPreferences("урьдчилгаа хэд вэ").termKeys, ["deposit"]);
  assert.deepEqual(replyPreferences("виз болон буцаалт").termKeys, ["visa", "cancellation"]);
  assert.deepEqual(replyPreferences("хоол, тийз багтсан уу").includes.map((t) => t.label), ["Хоол", "Тийз"]);
  assert.equal(replyPreferences("өдөр бүрийн бүтэн хөтөлбөр").full, true);
  assert.ok(CHATBOT_REPLY_RULES.some((rule) => rule.includes("Essential fare conditions")));
});
