import assert from "node:assert/strict";
import test from "node:test";
import { enforcePaymentNeverSelfConfirmed, extractButtons, hasPaymentClaimIntent, isReferReply, rewriteRepeatedGenericClarifier, stripRepeatedGreeting } from "../src/lib/reply";

test("enforcePaymentNeverSelfConfirmed replaces a fabricated booking confirmation", () => {
  const userText = "би 2,990,000 төлсөн, баталгаажуул";
  const reply =
    "Таны 2,990,000₮-ийн төлбөрийг хүлээн авлаа. Одоо бид таны Тэнгэрийн хаалга - шууд нислэгтэй аяллыг баталгаажуулж байна.";
  const safe = enforcePaymentNeverSelfConfirmed(userText, reply);
  assert.doesNotMatch(safe, /баталгаажуулж байна/);
  assert.match(safe, /аяллын зөвлөх/);
});

test("enforcePaymentNeverSelfConfirmed blocks reassurance about a wrong-name payment", () => {
  const userText = "баримт дээр нэр өөр байгаа зүгээр үү?";
  const reply = "Тийм ээ, энэ зөв байх ёстой, санаа зоволтгүй.";
  const safe = enforcePaymentNeverSelfConfirmed(userText, reply);
  assert.doesNotMatch(safe, /зөв байх ёстой/);
});

test("enforcePaymentNeverSelfConfirmed blocks confirmation after a claimed screenshot", () => {
  const userText = "би screenshot явуулсан, одоо захиалга баталгаатай юу?";
  const reply =
    "Таны явуулсан скриншотыг хүлээн авлаа. Таны 2,990,000₮-ийн төлбөрийг хүлээн авсан бөгөөд захиалга баталгаажсан байна.";
  const safe = enforcePaymentNeverSelfConfirmed(userText, reply);
  assert.doesNotMatch(safe, /баталгаажсан байна/);
});

test("enforcePaymentNeverSelfConfirmed leaves unrelated replies untouched", () => {
  const reply = "✈️ Хайнан - Саньяа шууд нислэгтэй аялал\n💰 Том хүн: 2,990,000₮";
  const safe = enforcePaymentNeverSelfConfirmed("Хайнан Саньяа хэд вэ?", reply);
  assert.equal(safe, reply);
});

test("enforcePaymentNeverSelfConfirmed leaves normal trip replies untouched even if they mention баталгаажуулах in another sense", () => {
  const reply = "Захиалгаа баталгаажуулах бол нэр, утасны дугаараа үлдээгээрэй.";
  const safe = enforcePaymentNeverSelfConfirmed("Бээжин аялал хэд вэ?", reply);
  assert.equal(safe, reply);
});

test("hasPaymentClaimIntent detects a money-transfer claim even with a bare number in it", () => {
  // Real bug: "5 сая шилжүүлсэн" was hijacked by a trip fast-path because "5"
  // matched a trip alias containing "5 өдөр", and "8 сая" matched August
  // month availability — the payment claim was never acknowledged at all.
  assert.equal(hasPaymentClaimIntent("5 сая шилжүүлсэн, баталгаажуулаарай"), true);
  assert.equal(hasPaymentClaimIntent("8 сая шилжүүлсэн, баталгаажуулаарай"), true);
  assert.equal(hasPaymentClaimIntent("мөнгө шилжүүлсэн, баталгаажуулаарай"), true);
  assert.equal(hasPaymentClaimIntent("screenshot явуулсан"), true);
  assert.equal(hasPaymentClaimIntent("миний төлбөр орсон уу?"), true);
});

test("hasPaymentClaimIntent does not fire on an unrelated document/visa question", () => {
  // The looser PAYMENT_CLAIM_PATTERNS set (used by enforcePaymentNeverSelfConfirmed)
  // includes a bare /баримт/i, which also matches "бичиг баримт" (visa
  // documents) — fine there since it only fires if the REPLY separately
  // claims confirmation, but hasPaymentClaimIntent gates fast-path routing
  // directly, so it must not treat a document question as a payment claim.
  assert.equal(hasPaymentClaimIntent("Виз бүрдүүлэх бичиг баримт хэрэгтэй юу?"), false);
  assert.equal(hasPaymentClaimIntent("Бээжин аялал хэд вэ?"), false);
});

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
