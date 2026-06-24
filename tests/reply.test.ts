import assert from "node:assert/strict";
import test from "node:test";
import { rewriteRepeatedGenericClarifier } from "../src/lib/reply";

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
