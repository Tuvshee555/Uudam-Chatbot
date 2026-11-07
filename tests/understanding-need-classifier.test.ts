import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMessageNeed,
  extractNeedConstraints,
  headcountIn,
  isSocialMessage,
  needCueMatches,
  type MessageNeed,
} from "../src/lib/messageNeed";
import { GROUP_INQUIRY_REPLY, shouldSilenceNoDataReply } from "../src/lib/reply";
import { buildGroupInquiryReply, isGroupInquiryReply } from "../src/lib/groupInquiry";
import { parseModelNeed } from "../src/lib/tripUnderstanding";

/**
 * messageNeed.ts names what the customer needs BEFORE any trip is looked up. Every string below is
 * invented (places and trips are made up) but has the shape of a real customer message that once got a
 * price card, a phone ask, a list of trips or the "system is down" line. Precision comes first: the
 * negative list is ordinary trip questions that must keep today's path.
 */
const POSITIVE: Record<MessageNeed, string[]> = {
  business_group: [
    "50-60хүнтэй байгууллага байгаа юм",
    "Alban baiguulaga",
    "alban baiguullaga",
    "baiguulaga",
    "baiguullagara 40-45 hun ywah bol hymdral uzuuldeg uu",
    "Манай 35 ажилтныг шинэ жилээр дулаан орон руу явуулах гэсэн юм.",
    "Манай 60 хүний багт 2 сарын эхээр тусгай маршрут гаргах уу?",
    "Dorvel hotruuu aylah tuluwtui bga manai hamt olon niit 20s 25 hun",
    "Бид энгийн аяллын хөтөлбөрт хамрагдахгүйгээр нислэг, 4 шөнийн буудал, трансфер, даатгалтай нийт үнийн санал авмаар байна. 1 том 2 хүүхэд.",
    "Байгууллагын аялал",
    "Гэр бүл, хамт олны аяллын үнэ сонирхоё",
    "компаниараа 12 сард аялалд явах гэсэн юм, 15 хүн",
    "Манай компанийн 80 ажилтан Нордавад явмаар байна",
    "baiguulaga 30 hun aylah",
    "Hamt olnoo 25 hun aylah bolomjtoi yu",
    "Бидэнд тусгай маршрут гаргаж өгөх боломжтой юу",
    "tusgai marshrut gargaj ugch bolh uu",
    "Our company wants a team building trip for 40 people",
    "Манай сургуулийн 45 сурагч хаврын амралтаар аялах",
    "Хорин хүнтэй хамт олон дулаан газар явмаар байна",
    "Za. Hyamdralin huwi gej bhgui yu? Neg baiguullagin 5 hvn deer",
    "Manai kompani 70 ajiltantai, jil bur aylah gej bn",
    "Баг бүрэлдэхүүн 30 хүнтэй, тусгайлан хөтөлбөр гаргуулах гэсэн юм",
  ],
  commercial_policy: [
    "barter awdag u",
    "Бартер авдаг уу",
    "Бартер эсвэл байгууллагын гэрээгээр төлж болох уу?",
    "Нэхэмжлэх гаргаж өгөх үү",
    "Manaih ebarimt awah bolomjtoi yu",
    "Хэсэгчлэн төлж болох уу",
    "Картаар төлж болох уу",
    "Зээлээр аялж болох уу",
    "Групп хямдрал байдаг уу",
    "Group discount bdag uu",
    "Танайх бартер сонирхох уу?",
    "Хуваан төлөх боломж байна уу",
  ],
  transport_only: [
    "Калдор руу онгоцны тийз л авъя аялал биш",
    "Нельмара хилээс Улаанбаатар орох хүн авах боломж байдаг уу",
    "Хорвата хилээс Улаанбаатар хүртэл автобусаар хүргэж өгөх үү",
    "Нельмара хотоос Улаанбаатар хүртэл нэг талдаа явах тийз авч болох уу",
    "Велтанагаас Улаанбаатар буцахад онгоцны тийз тусад нь авч болох уу",
    "зөвхөн тийз авмаар байна",
    "Tanaih buudal zahialga hiihuu",
    "12сарын 3наас 10ны хооронд буудал захиалга",
    "nisleh buudlaas hun avah bolomj bga yu",
    "Нисэх буудлаас авах боломжтой юу",
  ],
  existing_booking: [
    "захиалгаа цуцлах боломжтой юу",
    "миний захиалга баталгаажсан уу",
    "Захиалга маань юу болсон бэ",
    "Захиалгаа өөрчилж болох уу",
    "zahialgaa cuclah bolomjtoi yu",
    "minii zahialga batalgaajsan uu",
    "Хэзээ холбогдох вэ?",
    "Захиалгаа цуцалъя",
    "захиалсан мөнгөө буцаан авч болох уу",
  ],
  complaint: [
    "Калдор аялалд явсан чинь хоол муу байсан гомдолтой байна",
    "Би гомдол гаргамаар байна",
    "gomdol garga",
    "Үйлчилгээнд сэтгэл дундуур байлаа",
    "Хөтөч муу байсан",
    "Бид хуурагдсан, залилсан байна",
    "Буудал муухай байсан",
  ],
  social: [
    "Баярлалаа",
    "bayarlalaa",
    "Bayrlalaa",
    "thanks",
    "thank you so much",
    "Аялал маш сайхан боллоо. Баярлалаа.",
    "Мэдээлэл өгсөнд баярлалаа",
    "Хөтөлбөрийг маш сайхан зохион байгуулсан байсан. Тэр өдрийн санал хүсэлт болгоныг анхаарч үзсэнд танай компанид баярлалаа. Хөтөч нартаа ч баярлалаа.",
    "ok",
    "ок",
    "Ok",
    "okay",
    "за ойлголоо",
    "Ойлголоо баярлалаа",
    "за бодоод үзье",
    "Баяртай",
    "сайхан амраарай",
    "Хөтөлбөр нь их сайхан байсан",
    "Аялал сайхан байлаа",
  ],
};

const NEGATIVE: string[] = [
  "Калдор хотын аяллын үнэ хэд вэ",
  "3 сарын 14-нд гарах аялал байна уу",
  "хүүхдийн үнэ хэд вэ",
  "50 хүн",
  "50-60 хүн",
  "2 том 2 хүүхэд",
  "Бид 3 хүн, 2 том 1 хүүхэд",
  "4 хүн",
  "10 хүн явбал үнэ хэд вэ?",
  "Гэр бүлээрээ 6 хүн явна",
  "Баярлалаа, үнэ хэд вэ?",
  "Баярлалаа. Хөтөлбөрөө илгээгээрэй",
  "Баярлалаа, дараагийн аялал хэзээ гарах вэ",
  "bayarlalaa une hed ve",
  "нислэгийн тийз багтсан уу",
  "хөтөлбөр илгээнэ үү",
  "Хайнан цаг агаар ямар байна",
  "Танай байгууллагын хаяг хаана вэ",
  "хоол багтсан уу",
  "яаж захиалах вэ",
  "урьдчилгаа хэд вэ",
  "сайн байна уу",
  "hi",
  "Калдор аялал хэзээ гарах вэ",
  "нисэх буудлаас буудал хүртэл трансфер багтсан уу",
  "тийзгүй багц байна уу",
  "Онгоцны билетээ өөрсдөө авна",
  "хямдрал байна уу",
  "тусгай санал байна уу",
  "Захиалъя",
  "захиалгаа өгье",
  "Захиалга өгч болох уу",
  "Захиалгын нөхцөл ямар вэ",
  "цуцлалтын нөхцөл ямар вэ",
  "Орвелия гэр бүлийн амралт үнэ",
  "11 сарын 5-наас 11 сарын 12 хүртэл аялал байна уу",
  "хамгийн хямд аялал аль вэ",
  "Нярай хүүхдийн үнэ?",
  "Хүүхдийн хөнгөлөлт байна уу",
  "Оюутан хөнгөлөлт",
  "Групп аялал байна уу",
  "ажилтантай холбогдмоор байна",
  "Сургуулийн амралтаар явах аялал",
  "Тайланд явмаар байна",
  "Хоол муу байх уу",
  "бодоод үзье үнэ хэд вэ",
  "Үнийн санал өгөөч",
  "Гэрээ хийх үү",
  "Шууд нислэгтэй аялал байна уу",
  "Хөтөлбөр нь ямар байна",
  "Калдор руу ирэх сард явмаар байна",
  "Лунариа парк 12 сард үнэ хэд",
  "tsag agaar yamar bn",
  "Ямар санал байна вэ",
  "за",
  "Тийм",
  "Зураг явуулаарай",
];

test("every positive shape is classified as its need", () => {
  let total = 0;
  const wrong: string[] = [];
  for (const [need, texts] of Object.entries(POSITIVE) as Array<[MessageNeed, string[]]>) {
    for (const text of texts) {
      total += 1;
      const hit = classifyMessageNeed(text, { lastBotReply: "Үнэ 1,000,000₮." });
      if ((hit?.need ?? null) !== need || !hit!.signals.length) wrong.push(`${need} <= ${text} -> ${hit?.need ?? null} [${hit?.signals.join(",") ?? ""}]`);
    }
  }
  assert.deepEqual(wrong, []);
  assert.ok(total >= 40, `at least 40 positives, got ${total}`);
});

test("ordinary trip questions and mixed messages are NOT classified (precision first)", () => {
  assert.ok(NEGATIVE.length >= 40, `at least 40 negatives, got ${NEGATIVE.length}`);
  const wrong: string[] = [];
  for (const text of NEGATIVE) {
    const hit = classifyMessageNeed(text, { lastBotReply: "Үнэ 1,000,000₮." });
    if (hit) wrong.push(`${text} -> ${hit.need} [${hit.signals.join(",")}]`);
  }
  assert.deepEqual(wrong, [], "these must keep today's path");
});

test("a bare acknowledgement right after a question from the bot may be its answer, so it is left to the pipeline", () => {
  assert.equal(classifyMessageNeed("ok", { lastBotReply: "Та аль өдрөөр явах вэ?" }), null);
  assert.equal(classifyMessageNeed("за ойлголоо", { lastBotReply: "Хөтөлбөр илгээх үү?" }), null);
  assert.equal(classifyMessageNeed("ok", { lastBotReply: "Үнэ: 1,000,000₮" })?.social, "ack");
  assert.equal(classifyMessageNeed("ok")?.social, "ack", "a cold ok is still only an acknowledgement");
  // Thanks is a real close even after a question.
  assert.equal(classifyMessageNeed("Баярлалаа", { lastBotReply: "Та аль өдрөөр явах вэ?" })?.social, "thanks");
});

test("thanks and praise get a reply, acknowledgements and farewells stay silent", () => {
  assert.equal(classifyMessageNeed("Аялал маш сайхан боллоо. Баярлалаа.")?.social, "thanks");
  assert.equal(classifyMessageNeed("Хөтөлбөр нь их сайхан байсан")?.social, "praise");
  assert.equal(classifyMessageNeed("Баяртай")?.social, "farewell");
  assert.equal(classifyMessageNeed("ок")?.social, "ack");
  assert.ok(isSocialMessage("Аялал маш сайхан боллоо. Баярлалаа."));
  assert.ok(isSocialMessage("bayarlalaa"));
  assert.ok(!isSocialMessage("Баярлалаа, үнэ хэд вэ?"));
});

test("thanks followed by preferences or instructions is not swallowed as a thank-you", () => {
  assert.equal(classifyMessageNeed("Өдрийн мэнд. Баярлалаа. Буцах суудал купе байхад л болно. Нэг нь доор нэг нь дээр байхад болно. Баярлалаа."), null);
  assert.equal(classifyMessageNeed("Баярлалаа, мэдээллээ явуулаарай"), null);
});

test("head counts are read in both scripts, ranges and number words", () => {
  assert.equal(headcountIn("50-60хүнтэй байгууллага"), 60);
  assert.equal(headcountIn("niit 20s 25 hun"), 25);
  assert.equal(headcountIn("40-45 hun"), 45);
  assert.equal(headcountIn("35 ажилтан"), 35);
  assert.equal(headcountIn("хорин хүн"), 20);
  assert.equal(headcountIn("2 том 2 хүүхэд"), null);
  assert.equal(headcountIn("3 хоног"), null);
});

test("constraints: group size, destination hints, month and period are read from the message", () => {
  const c = extractNeedConstraints("Манай 35 ажилтныг шинэ жилээр дулаан орон руу явуулах гэсэн юм.");
  assert.equal(c.groupSize, 35);
  assert.equal(c.period, "шинэ жил");
  assert.deepEqual(c.destinationWords, ["дулаан орон"]);
  const d = extractNeedConstraints("Dorvel hotruuu aylah tuluwtui bga manai hamt olon niit 20s 25 hun");
  assert.equal(d.groupSize, 25);
  assert.deepEqual(d.destinationWords, ["dorvel"]);
  const m = extractNeedConstraints("Манай 60 хүний багт 2 сарын эхээр тусгай маршрут гаргах уу?");
  assert.equal(m.month, 2);
  assert.equal(m.groupSize, 60);
  assert.equal(extractNeedConstraints("Alban baiguulaga").groupSize, undefined);
  // The question particle "уу" typed on its own is not a direction.
  assert.equal(extractNeedConstraints("baiguullagara 40-45 hun ywah bol hymdral uzuuldeg uu").destinationWords, undefined);
  assert.equal(extractNeedConstraints("төсөв 3 сая").budgetMentioned, true);
});

test("after the group-inquiry question, a short plain answer is recognised as the answer", () => {
  const asked = `${GROUP_INQUIRY_REPLY} Таны хүсэлтийг аяллын зөвлөхөд дамжууллаа.\n\nНийт хэдэн хүн явах вэ?`;
  assert.ok(isGroupInquiryReply(asked));
  assert.ok(!isGroupInquiryReply("Үнэ 1,000,000₮"));
  for (const answer of ["40 хүн", "Нордавад", "2 сард", "35 hun"]) {
    const hit = classifyMessageNeed(answer, { lastBotReply: asked });
    assert.equal(hit?.need, "business_group", answer);
    assert.deepEqual(hit?.signals, ["inquiry_answer"], answer);
  }
  // A real question after the inquiry keeps its own path; thanks stays thanks.
  assert.equal(classifyMessageNeed("Калдор аяллын үнэ хэд вэ", { lastBotReply: asked }), null);
  assert.equal(classifyMessageNeed("Баярлалаа", { lastBotReply: asked })?.need, "social");
  assert.equal(classifyMessageNeed("40 хүн", { lastBotReply: "Үнэ 1,000,000₮" }), null);
});

test("the group-inquiry reply is only the company's wording, one question, and never a discount or a price", () => {
  const withLead = buildGroupInquiryReply({ leadSaved: true, constraints: { groupSize: 50 } });
  assert.ok(withLead?.startsWith(GROUP_INQUIRY_REPLY));
  assert.match(withLead!, /дамжууллаа/);
  assert.match(withLead!, /Аль чиглэлд/, "group size is known, so the destination is asked");
  assert.equal((withLead!.match(/\?/g) || []).length, 1, "exactly one question");
  assert.doesNotMatch(withLead!, /хямдр|хөнгөлөлт|бартер|үнэгүй|\d[\d,]*\s*₮|баталгаатай үнэ/i);
  assert.ok(!shouldSilenceNoDataReply(withLead!), "the exit boundary must not treat it as a no-data reply");
  // The question order: head count, destination, month, budget.
  assert.match(buildGroupInquiryReply({ leadSaved: true, constraints: {} })!, /Нийт хэдэн хүн/);
  assert.match(buildGroupInquiryReply({ leadSaved: true, constraints: { groupSize: 20, destinationWords: ["dorvel"] } })!, /Аль сард/);
  assert.match(buildGroupInquiryReply({ leadSaved: true, constraints: { groupSize: 20, destinationWords: ["dorvel"], month: 2 } })!, /төсөв/);
  // Everything known: no question at all.
  const complete = buildGroupInquiryReply({ leadSaved: true, constraints: { groupSize: 20, destinationWords: ["dorvel"], month: 2, budgetMentioned: true } });
  assert.doesNotMatch(complete!, /\?/);
  // The lead was not saved: the hand-off sentence and the promise of an offer are NOT made; only the question is.
  const noLead = buildGroupInquiryReply({ leadSaved: false, constraints: { groupSize: 50 } });
  assert.equal(noLead, "Аль чиглэлд явахыг хүсэж байна вэ?");
  assert.doesNotMatch(noLead!, /дамжууллаа|бэлтгэнэ/);
  assert.equal(buildGroupInquiryReply({ leadSaved: false, constraints: { groupSize: 20, destinationWords: ["dorvel"], month: 2, budgetMentioned: true } }), null);
});

test("a model-proposed need is kept only with evidence in the customer's words and a cue of its class", () => {
  const text = "Манай 35 ажилтныг шинэ жилээр дулаан орон руу явуулах гэсэн юм.";
  assert.deepEqual(parseModelNeed("business_group", "Манай 35 ажилтныг", text), { need: "business_group", evidence: "Манай 35 ажилтныг" });
  // not in the message
  assert.equal(parseModelNeed("business_group", "50 хүний баг", text), null);
  // not a known class
  assert.equal(parseModelNeed("price", "Манай 35 ажилтныг", text), null);
  assert.equal(parseModelNeed(null, null, text), null);
  // evidence present but no cue of the class: a place word is not a barter
  assert.equal(parseModelNeed("commercial_policy", "дулаан орон руу", text), null);
  // a thanks word inside a question is not a social close
  assert.equal(parseModelNeed("social", "Баярлалаа", "Баярлалаа, үнэ хэд вэ?"), null);
  assert.deepEqual(parseModelNeed("social", "Баярлалаа", "Аялал сайхан байсан. Баярлалаа."), { need: "social", evidence: "Баярлалаа" });
  assert.ok(needCueMatches("transport_only", "онгоцны тийз л авъя"));
  assert.ok(!needCueMatches("transport_only", "үнэ хэд вэ"));
});

// Paraphrases written AFTER the classifier existed and never tuned one by one: Cyrillic, Latin transliteration,
// typos and a different word order. A miss here means a word FAMILY is missing, not that a sentence needs an entry.
const UNSEEN: Array<[string, MessageNeed | "social" | null]> = [
  ["Манай хамт олон 25 хүнтэй, хаврын амралтаар Азийн орон руу явмаар байна", "business_group"],
  ["Бид нийт 18 ажилтантай компани, жилийн эцэст нэг аялал хийхсэн", "business_group"],
  ["hamt olonoor 30 hun ywmaar bn, tusgai tsag zuuhii ve", "business_group"],
  ["Манай байгууллагын 45 хүнд зориулсан аялал байдаг уу", "business_group"],
  ["albanii baiguullaga aylal zohion baiguulj ugdug uu", "business_group"],
  ["Манай сургуулийн 40 багшийн аялал зохион байгуулах уу", "business_group"],
  ["Бидэнд өөрсдийн хүссэн маршрутаар аялмаар байна, санал өгч чадах уу", "business_group"],
  ["Байгууллагын гэрээ хийж аялуулдаг уу", "business_group"],
  ["Компаниас нь нэхэмжлэх гаргаад төлбөр хийж болох уу", "commercial_policy"],
  ["Бартераар аялж болдог уу", "commercial_policy"],
  ["barteraar aylj bolh uu", "commercial_policy"],
  ["Сараар хувааж төлж болох уу", "commercial_policy"],
  ["Группт хөнгөлөлт үзүүлдэг үү", "commercial_policy"],
  ["Онгоцны билет л хэрэгтэй байна, аялал авахгүй", "transport_only"],
  ["Хилээс нисэх буудал хүртэл хүн хүргэж өгдөг үү", "transport_only"],
  ["tiz l avmaar bna aylal bish", "transport_only"],
  ["Миний захиалсан аяллыг хойшлуулж болох уу", "existing_booking"],
  ["zahialgaa uurchluh bolomjtoi yu", "existing_booking"],
  ["Захиалга маань батлагдсан уу", "existing_booking"],
  ["Хөтөч нь хоцорсон, үйлчилгээнд сэтгэл дундуур байна", "complaint"],
  ["Маш муу үйлчилгээ байсан, гомдолтой байна", "complaint"],
  ["gomdol baina", "complaint"],
  ["Аяллын хөтөлбөр гайхалтай байлаа, баярлалаа", "social"],
  ["Маш их баярлалаа, амжилт хүсье", "social"],
  ["thank u", "social"],
  ["bayrlalaa", "social"],
  ["За ойлголоо баярлалаа", "social"],
  ["Ок, баярлалаа", "social"],
  ["okey", "social"],
  // positive controls: ordinary questions that merely share a word with a class
  ["Нисэх буудалд угтаж авах үйлчилгээ байдаг уу", null],
  ["Төлбөр төлсөн, захиалга ороод байгаа юу", null],
  ["Норвел хотын аялал хэдэн өдөр вэ", null],
  ["Калдор руу 3 сард явах аялал байна уу", null],
  ["Хүүхдийн нас хэд хүртэл хөнгөлөлттэй вэ", null],
  ["Хоолны мэдээлэл өгөөч", null],
  ["Баярлалаа, хөтөлбөрийг нь илгээгээрэй", null],
  ["10 хүн явахад үнэ хэд болох вэ", null],
  ["Төлбөрөө хэрхэн хийх вэ", null],
  ["Виз хэрэгтэй юу", null],
  ["Буудал нь хэдэн одтой вэ", null],
  ["Манай гэр бүл 5 хүнтэй, 3 сард явмаар байна", null],
];

test("unseen paraphrases are classified by word family, and ordinary questions stay unclassified", () => {
  const wrong: string[] = [];
  for (const [text, want] of UNSEEN) {
    const hit = classifyMessageNeed(text, { lastBotReply: "Үнэ 1,000,000₮." });
    const got = hit ? hit.need : null;
    if (got !== want) wrong.push(`${text} -> ${got} (wanted ${want})`);
  }
  assert.deepEqual(wrong, []);
});

test("an acknowledgement under a question that sits above a list of options is left to the pipeline", () => {
  const asked = "Норвел\n\nАль гарах өдрөөр аялах вэ?\n• 3 сарын 15\n• 3 сарын 29";
  assert.equal(classifyMessageNeed("ok", { lastBotReply: asked }), null);
  assert.equal(classifyMessageNeed("ок", { lastBotReply: "Аль аяллыг нь сонирхож байна вэ?\n1, 2 эсвэл 3 гэж бичээрэй 😊" }), null);
  // A farewell is a close wherever it comes.
  assert.equal(classifyMessageNeed("Баяртай", { lastBotReply: asked })?.social, "farewell");
  assert.equal(classifyMessageNeed("ok", { lastBotReply: "Норвел\nТом хүн: 1,791,000₮" })?.social, "ack");
});
