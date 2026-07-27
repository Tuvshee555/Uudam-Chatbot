import assert from "node:assert/strict";
import test from "node:test";
import { buildHandoffAcknowledgement, enforcePaymentNeverSelfConfirmed, extractButtons, hasPaymentClaimIntent, isReferReply, rewriteRepeatedGenericClarifier, shouldSilenceNoDataReply, stripRepeatedGreeting } from "../src/lib/reply";

test("enforcePaymentNeverSelfConfirmed replaces a fabricated booking confirmation", () => {
  const userText = "би 1,430,000 төлсөн, баталгаажуул";
  const reply =
    "Таны 1,430,000₮-ийн төлбөрийг хүлээн авлаа. Одоо бид таны Тэнгэрийн хаалга - шууд нислэгтэй аяллыг баталгаажуулж байна.";
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
    "Таны явуулсан скриншотыг хүлээн авлаа. Таны 1,430,000₮-ийн төлбөрийг хүлээн авсан бөгөөд захиалга баталгаажсан байна.";
  const safe = enforcePaymentNeverSelfConfirmed(userText, reply);
  assert.doesNotMatch(safe, /баталгаажсан байна/);
});

test("enforcePaymentNeverSelfConfirmed leaves unrelated replies untouched", () => {
  const reply = "✈️ Хайнан - Саньяа шууд нислэгтэй аялал\n💰 Том хүн: 1,430,000₮";
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

test("hasPaymentClaimIntent handles the completive -чих- forms customers actually type", () => {
  // Mongolian marks a finished action with the infix -чих-. The patterns only
  // allowed a bare past ending, so the most colloquial way of saying "I've
  // paid" fell through to the trip matcher: "төлбөрөө хийчихлээ, 2 хүн" was
  // read as a passenger count, resolved to no trip, and answered with silence.
  assert.equal(hasPaymentClaimIntent("төлчихлөө"), true);
  assert.equal(hasPaymentClaimIntent("би төлчихсөн"), true);
  assert.equal(hasPaymentClaimIntent("шилжүүлчихлээ"), true);
  assert.equal(hasPaymentClaimIntent("банкаар шилжүүлчихсэн"), true);
  assert.equal(hasPaymentClaimIntent("төлбөрөө хийчихлээ шалгаад өгөөч"), true);
  assert.equal(hasPaymentClaimIntent("төлбөрөө хийчихлээ, 2 хүн"), true);
});

test("hasPaymentClaimIntent covers transfer nouns beyond төлбөр/шилжүүлэх", () => {
  assert.equal(hasPaymentClaimIntent("гүйлгээ хийсэн шалгана уу"), true);
  assert.equal(hasPaymentClaimIntent("гүйлгээ хийчихлээ"), true);
  assert.equal(hasPaymentClaimIntent("мөнгө явуулсан"), true);
  assert.equal(hasPaymentClaimIntent("мөнгө илгээлээ"), true);
  assert.equal(hasPaymentClaimIntent("урьдчилгаагаа өглөө"), true);
  assert.equal(hasPaymentClaimIntent("дансанд хийчихсэн"), true);
});

test("hasPaymentClaimIntent still ignores questions about HOW to pay", () => {
  // These decide whether the customer gets an answer or "only a consultant can
  // verify payments", so the verb has to be finished, not asked about.
  assert.equal(hasPaymentClaimIntent("яаж төлбөрөө хийх вэ?"), false);
  assert.equal(hasPaymentClaimIntent("урьдчилгаа хэд төлөх ёстой вэ?"), false);
  assert.equal(hasPaymentClaimIntent("хаана төлөх вэ?"), false);
  assert.equal(hasPaymentClaimIntent("данс руу яаж шилжүүлэх вэ?"), false);
  assert.equal(hasPaymentClaimIntent("гүйлгээний хураамж хэд вэ?"), false);
});

test("hasPaymentClaimIntent does not read 'төлөвлөгөө' as a payment claim", () => {
  // /төл(?:өв)/ matched inside "төлөвлөгөө" (itinerary) and "төлөвлөж байна"
  // ("I'm planning a trip"), so asking for the programme was answered with the
  // payment-verification deferral.
  assert.equal(hasPaymentClaimIntent("аяллын төлөвлөгөө харуулаач"), false);
  assert.equal(hasPaymentClaimIntent("төлөвлөгөө байгаа юу"), false);
  assert.equal(hasPaymentClaimIntent("би аялал төлөвлөж байна"), false);
});

test("rewrites repeated generic clarifier after recent trip details", () => {
  const rewritten = rewriteRepeatedGenericClarifier({
    userText: "Mun bna kkk",
    replyText:
      "Сайн байна уу? 😊 Таны аяллын талаар мэдээлэл авахад бэлэн байна. Ямар аялалд сонирхож байна вэ? Жишээлбэл, Бээжин, Шанхай, Хайнан гэх мэт. Тодорхой мэдээлэл өгвөл илүү сайн туслах боломжтой. ✈️",
    recentAssistantReplies: [
      "✈️ Шар тэнгис буюу Бэйдайхэ-Бээжингийн газрын аялал — 9 өдөр / 8 шөнө\n💰 Том хүн: 1,120,000₮ | Хүүхэд: 850,000₮",
      "Сайн байна уу? 😊 Таны аяллын талаар мэдээлэл авахад бэлэн байна. Ямар аялалд сонирхож байна вэ? Жишээлбэл, Бээжин, Шанхай, Хайнан гэх мэт. Тодорхой мэдээлэл өгвөл илүү сайн туслах боломжтой. ✈️",
    ],
  });

  assert.match(rewritten, /Дээрх аяллын талаар/);
  assert.doesNotMatch(rewritten, /Жишээлбэл, Бээжин, Шанхай, Хайнан/);
});

test("leaves normal non-generic replies unchanged", () => {
  const reply = "✈️ Хайнан - Саньяа шууд нислэгтэй аялал\n💰 Том хүн: 1,430,000₮";
  const rewritten = rewriteRepeatedGenericClarifier({
    userText: "Хайнан Саньяа хэд вэ?",
    replyText: reply,
    recentAssistantReplies: [],
  });

  assert.equal(rewritten, reply);
});

test("strips repeated greeting after the first assistant turn", () => {
  const reply = "Сайн байна уу!\n\n✈️ Бээжин аялал\n💰 Том хүн: 1,210,000₮";
  const stripped = stripRepeatedGreeting(reply, true);

  assert.equal(stripped, "✈️ Бээжин аялал\n💰 Том хүн: 1,210,000₮");
});

test("isReferReply catches REFER and legacy SILENT, ignores normal replies", () => {
  assert.equal(isReferReply("REFER"), true);
  assert.equal(isReferReply("refer\nBUTTONS:"), true);
  assert.equal(isReferReply("SILENT"), true);
  assert.equal(isReferReply("  SILENT  "), true);
  assert.equal(isReferReply("✈️ Бээжин аялал — 5 хоног"), false);
  assert.equal(isReferReply("Танд REFER гэдэг үг хэрэгтэй юу?"), false);
});

test("handoff acknowledgement text stays safe when used", () => {
  const noData = buildHandoffAcknowledgement();
  assert.match(noData, /аяллын зөвлөхөд дамжууллаа/);
  assert.doesNotMatch(noData, /REFER|SILENT|database|тодорхойгүй/i);

  const outage = buildHandoffAcknowledgement({ aiOutage: true });
  assert.match(outage, /зөвлөхөд дамжууллаа/);
  assert.doesNotMatch(outage, /Уучлаарай|түр саатал|чадахгүй/i);
});

test("shouldSilenceNoDataReply catches unknown-detail fallback wording", () => {
  const unknownDetail =
    "\u041d\u0438\u0441\u043b\u044d\u0433\u0438\u0439\u043d \u0442\u0438\u0439\u0437 \u04af\u043d\u044d\u0434 \u043e\u0440\u0441\u043e\u043d \u044d\u0441\u044d\u0445 \u043c\u044d\u0434\u044d\u044d\u043b\u044d\u043b \u0442\u043e\u0434\u043e\u0440\u0445\u043e\u0439\u0433\u04af\u0439 \u0431\u0430\u0439\u043d\u0430. \u0410\u044f\u043b\u043b\u044b\u043d \u0437\u04e9\u0432\u043b\u04e9\u0445\u04e9\u04e9\u0440 \u0431\u0430\u0442\u0430\u043b\u0433\u0430\u0430\u0436\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.";
  const paymentVerification =
    "\u041c\u0430\u043d\u0430\u0439 \u0430\u044f\u043b\u043b\u044b\u043d \u0437\u04e9\u0432\u043b\u04e9\u0445 \u0448\u0430\u043b\u0433\u0430\u0430\u0434 \u0431\u0430\u0442\u0430\u043b\u0433\u0430\u0430\u0436\u0443\u0443\u043b\u043d\u0430.";

  assert.equal(shouldSilenceNoDataReply(unknownDetail), true);
  assert.equal(shouldSilenceNoDataReply(paymentVerification), false);
});

test("shouldSilenceNoDataReply catches missing passport/document data wording", () => {
  const passportMiss =
    "\u042d\u043d\u044d \u0430\u044f\u043b\u0430\u043b\u0434 \u043f\u0430\u0441\u043f\u043e\u0440\u0442 \u0448\u0430\u0430\u0440\u0434\u043b\u0430\u0433\u0430\u0442\u0430\u0439 \u044d\u0441\u044d\u0445 \u0442\u0430\u043b\u0430\u0430\u0440 \u043c\u044d\u0434\u044d\u044d\u043b\u044d\u043b \u0431\u0430\u0439\u0445\u0433\u04af\u0439 \u0431\u0430\u0439\u043d\u0430.";

  assert.equal(shouldSilenceNoDataReply(passportMiss), true);
});

test("shouldSilenceNoDataReply never suppresses a real answer that merely lacks photos", () => {
  // Regression: this exact reply shape (complete program answer + the old
  // no-photos footnote) was being suppressed, ghosting customers on every
  // photo-less trip — 18 of 25 active trips at the time. Missing pictures
  // are not missing data; even if a stale build still emits the footnote,
  // the reply must go out.
  const fullProgramAnswer = [
    "✈️ БЭЭЖИН - ЖИНИН – ЖАНЖАКОУ - ЭРЭЭН – 4 ХОТЫН АЯЛАЛ",
    "",
    "⏱ 8 өдөр 7 шөнө",
    "💰 Насанд хүрэгч: 1,170,000₮ | Хүүхэд: 1,130,000₮",
    "📅 Гарах өдрүүд: Ням гараг бүр",
    "",
    "Одоогоор энэ аяллын нэмэлт зураг системд ороогүй байна. 🙌",
  ].join("\n");
  assert.equal(shouldSilenceNoDataReply(fullProgramAnswer), false);
});

test("shouldSilenceNoDataReply catches deterministic fast-path no-data replies", () => {
  const budgetMiss =
    "Одоогоор 3,000,000 MNT-аас доош шууд нислэгтэй аялал тодорхой олдсонгүй. Аяллын зөвлөхөөр ойролцоо хувилбар шалгуулъя.";
  const directMiss =
    "Тэр чиглэлд яг шууд нислэгтэй аялал одоогоор тодорхой олдсонгүй.\nОйролцоо байгаа хувилбарууд:\n• Бээжин газрын аялал";
  const pastDateMiss =
    "6 сарын 27-д тохирох үнийн мэдээлэл олдсонгүй. Аяллын зөвлөхтэй холбогдоорой.";

  assert.equal(shouldSilenceNoDataReply(budgetMiss), true);
  assert.equal(shouldSilenceNoDataReply(directMiss), true);
  assert.equal(shouldSilenceNoDataReply(pastDateMiss), true);
});

test("shouldSilenceNoDataReply catches date availability no-trip wording", () => {
  assert.equal(
    shouldSilenceNoDataReply(
      "\u0037 \u0441\u0430\u0440\u044b\u043d \u0031\u0030-\u043d\u0434 \u0433\u0430\u0440\u0430\u0445 \u0430\u044f\u043b\u0430\u043b \u0430\u043b\u0433\u0430 \u0431\u0430\u0439\u043d\u0430. \u041e\u0439\u0440\u044b\u043d \u0433\u0430\u0440\u0430\u043b\u0442\u0443\u0443\u0434:",
    ),
    true,
  );
  assert.equal(
    shouldSilenceNoDataReply(
      "\u0039 \u0441\u0430\u0440\u0434 \u0433\u0430\u0440\u0430\u0445 \u0430\u044f\u043b\u0430\u043b \u043e\u0434\u043e\u043e\u0433\u0438\u0439\u043d \u043c\u044d\u0434\u044d\u044d\u043b\u044d\u043b\u0434 \u0430\u043b\u0433\u0430 \u0431\u0430\u0439\u043d\u0430.",
    ),
    true,
  );
});

test("extractButtons keeps up to 10 buttons (disambiguation lists)", () => {
  const labels = Array.from({ length: 12 }, (_, i) => `Аялал ${i + 1}`);
  const { buttons } = extractButtons(`Сонгоно уу:\nBUTTONS: ${labels.join("|")}`);
  assert.equal(buttons.length, 10);
  assert.equal(buttons[0], "Аялал 1");
  assert.equal(buttons[9], "Аялал 10");
});

test("the trip-media silence token survives sanitize and is suppressed", async () => {
  const { sanitizeAssistantReply, TRIP_MEDIA_UNAVAILABLE_SILENT } = await import("../src/lib/reply");
  const { appendLeadCaptureCta } = await import("../src/lib/travelFastPaths");
  // stripMarkdown once ate the underscores out of "NO_TRIP_MEDIA", so the
  // silence pattern missed and the raw token leaked to the customer. The
  // token must round-trip sanitize unchanged and always be silenced.
  const sanitized = sanitizeAssistantReply(TRIP_MEDIA_UNAVAILABLE_SILENT);
  assert.equal(shouldSilenceNoDataReply(sanitized), true);
  assert.equal(shouldSilenceNoDataReply(TRIP_MEDIA_UNAVAILABLE_SILENT), true);
  assert.equal(
    shouldSilenceNoDataReply(appendLeadCaptureCta(TRIP_MEDIA_UNAVAILABLE_SILENT, false)),
    true,
  );
});
