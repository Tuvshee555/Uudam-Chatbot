import assert from "node:assert/strict";
import test from "node:test";
import { extractButtons, isReferReply, rewriteRepeatedGenericClarifier, stripRepeatedGreeting } from "../src/lib/reply";

test("rewrites repeated generic clarifier after recent trip details", () => {
  const rewritten = rewriteRepeatedGenericClarifier({
    userText: "Mun bna kkk",
    replyText:
      "Сайн байна уу? 😊 Таны аяллын талаар мэдээлэл авахад бэлэн байна. Ямар аялалд сонирхож байна вэ? Жишээлбэл, Бээжин, Шанхай, Хайнан гэх мэт. Тодорхой мэдээлэл өгвөл илүү сайн туслах боломжтой. ✈️",
    recentAssistantReplies: [
      "✈️ Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал — 9 өдөр / 8 шөнө\n💰 Том хүн: 1,190,000₮ | Хүүхэд: 850,000₮",
      "Сайн байна уу? 😊 Таны аяллын талаар мэдээлэл авахад бэлэн байна. Ямар аялалд сонирхож байна вэ? Жишээлбэл, Бээжин, Шанхай, Хайнан гэх мэт. Тодорхой мэдээлэл өгвөл илүү сайн туслах боломжтой. ✈️",
    ],
  });

  assert.match(rewritten, /Дээрх аяллын талаар/);
  assert.doesNotMatch(rewritten, /Жишээлбэл, Бээжин, Шанхай, Хайнан/);
});

test("leaves normal non-generic replies unchanged", () => {
  const reply = "✈️ Хайнан - Саньяа шууд нислэгтэй аялал\n💰 Том хүн: 2,990,000₮";
  const rewritten = rewriteRepeatedGenericClarifier({
    userText: "Хайнан Саньяа хэд вэ?",
    replyText: reply,
    recentAssistantReplies: [],
  });

  assert.equal(rewritten, reply);
});

test("strips repeated greeting after the first assistant turn", () => {
  const reply = "Сайн байна уу!\n\n✈️ Бээжин аялал\n💰 Том хүн: 1,890,000₮";
  const stripped = stripRepeatedGreeting(reply, true);

  assert.equal(stripped, "✈️ Бээжин аялал\n💰 Том хүн: 1,890,000₮");
});

test("isReferReply catches REFER and legacy SILENT, ignores normal replies", () => {
  assert.equal(isReferReply("REFER"), true);
  assert.equal(isReferReply("refer\nBUTTONS:"), true);
  assert.equal(isReferReply("SILENT"), true);
  assert.equal(isReferReply("  SILENT  "), true);
  assert.equal(isReferReply("✈️ Бээжин аялал — 5 хоног"), false);
  assert.equal(isReferReply("Танд REFER гэдэг үг хэрэгтэй юу?"), false);
});

test("extractButtons keeps up to 10 buttons (disambiguation lists)", () => {
  const labels = Array.from({ length: 12 }, (_, i) => `Аялал ${i + 1}`);
  const { buttons } = extractButtons(`Сонгоно уу:\nBUTTONS: ${labels.join("|")}`);
  assert.equal(buttons.length, 10);
  assert.equal(buttons[0], "Аялал 1");
  assert.equal(buttons[9], "Аялал 10");
});
