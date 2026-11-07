import assert from "node:assert/strict";
import test from "node:test";
import { analyzeCatalogueText, detectCatalogueIntent, isBareResendRequest, isSoftCatalogueRequest } from "../src/lib/catalogue/intent";
import { extractGroupSize, extractMonth, parseAllTripCodes, parseTripCodeRequest, readTripCode } from "../src/lib/catalogue/tripCodeRequest";

const kind = (text: string) => detectCatalogueIntent(text);
const edition = (text: string, want: "quick" | "complete") => {
  const result = kind(text);
  assert.equal(result.kind, "catalogue", `${text} -> ${JSON.stringify(result)}`);
  assert.equal(result.kind === "catalogue" ? result.edition : null, want, `${text} -> ${JSON.stringify(result)}`);
  return result;
};
const quick = (text: string) => edition(text, "quick");
const complete = (text: string) => edition(text, "complete");
const none = (text: string) => assert.deepEqual(kind(text), { kind: "none" }, text);

// Owner decision 2026-11-07: every broad catalogue ask (company, team, group, "all trips", a bare "каталог")
// gets the COMPLETE edition. These tables used to expect Quick for company phrasing; recall is unchanged, only the
// edition moved. Quick is sent only when the customer asks for a short selection in words (see the quick tests below).
test("company, team and group trip phrasing asks for the Complete catalogue (Cyrillic)", () => {
  for (const text of [
    "байгууллагын аяллуудаа харуул", "Байгууллагын аялал", "байгууллагын аяллын сонголтууд", "хамт олны аялал", "хамт олноороо аялах сонголт",
    "компанийн аялал байна уу", "Манай компани аялал хийх гэсэн юм", "багийн аялал", "ажилчдын аялал", "бүлгийн аялал",
    "байгууллагын аяллын санал өгөөч", "хамт олны аяллын сонголтууд",
  ]) complete(text);
});

test("Latin, transliterated and mistyped spellings reach the same decision", () => {
  for (const text of [
    "baiguullagiin aylal", "hamt olnii aylal", "baiguullagiin aylaliin songoltuud", "baigulagiin ayal", "baiguulagiin aylaluud harulaach",
    "hamt olnoor aylah", "hamtolnii aylal", "kompaniin aylal", "BAIGUULLAGIIN AYLAL", "bayguullagiin aylal", "baiguulagin aylal haruul",
    "aylaliin songoltuud", "хамт олнй аялал", "байгууллагийн аялал",
  ]) complete(text);
});

test("an explicit ask for the short selection gets the Quick catalogue (Cyrillic, Latin, English)", () => {
  for (const text of [
    "байгууллагын аяллын товч каталог", "товч жагсаалт явуул", "товчхон аяллууд харуулаач", "богино жагсаалт өгөөч", "сонгосон аяллуудаа явуулаач",
    "шилдэг аяллуудаа харуул", "хураангуй каталог", "байгууллагын аялал товчхон", "tovch katalog", "tovchhon baiguullagiin aylal",
    "shortlist of corporate trips", "quick catalogue", "quick trip list please", "send top trips", "show me top 5 trips", "short list of trips",
    "company trips shortlist", "baiguullagiin aylal tovch",
  ]) quick(text);
  // The same words that are not a request for the short list stay out.
  none("богино аялал байна уу");
  none("шилдэг аялал юу вэ");
  none("товч мэдээлэл өгөөч");
  none("top level domain");
});

test("a broad ask spelled any way gets the Complete edition; a resend repeats the edition last sent", () => {
  for (const text of [
    "аяллын мэдээлэл", "аяллуудаа явуулаач", "аяллуудаа явуул", "ayaluudaa yavuul", "trip info", "байгууллагын аялал", "baigulgin aylal haruul",
    "baiguulgiin aylal hari", "baigulgin aylal", "корпорат аялал", "all trips", "бүх аялал", "хамт олны аялал", "company trip", "corporate trip", "каталог",
  ]) complete(text);
  // Pointing at one trip keeps the existing flow: never the catalogue.
  none("энэ аяллын мэдээлэл");
  none("тэр аяллуудыг явуул");
});

test("English phrasing", () => {
  complete("corporate trip catalog");
  complete("company trips brochure please");
  complete("team building trips");
  complete("Corporate travel options");
  complete("trip brochure");
  complete("all tours");
  complete("all trips please");
  complete("send me the catalogue");
});

test("a bare catalogue request and an explicit 'all' ask for the Complete catalogue", () => {
  for (const text of ["каталог явуул", "каталог", "katalog yavuul", "бүх аяллаа", "бүх аялал", "бүх аяллаа харуулаач", "bvh aylal",
    "buh ayalaa haruul", "байгууллагын бүх аялал", "бүх аяллын каталог", "каталог илгээнэ үү"]) complete(text);
});

test("the resend flag follows the customer's words", () => {
  const again = kind("каталог дахин явуул");
  assert.equal(again.kind === "catalogue" && again.resend, true);
  const first = kind("байгууллагын аялал");
  assert.equal(first.kind === "catalogue" && first.resend, false);
  assert.equal(isBareResendRequest("дахин явуул"), true);
  assert.equal(isBareResendRequest("dahin yavuul"), true);
  assert.equal(isBareResendRequest("resend"), true);
  assert.equal(isBareResendRequest("каталог дахин явуул"), false, "a catalogue word is a catalogue request, not a bare resend");
  assert.equal(isBareResendRequest("Тест-далай аялал дахин хэлээч"), false);
});

test("specific-trip questions, greetings and look-alike words are not catalogue requests", () => {
  for (const text of [
    "Тест-далай аяллын үнэ хэд вэ", "Жишиг-хөдөө аяллын хөтөлбөр явуулаач", "ямар аялал байна", "аялал байна уу", "Сайн байна уу",
    "гэр бүлийн аялал", "ger buliin aylal", "гэр бүлээрээ аялмаар байна", "1-р сарын 9-нд гарах аялал", "хөтөлбөр илгээнэ үү",
    "pdf явуулаач", "зураг явуул", "үнийн санал өгөөч", "захиалах", "утасны дугаар", "A01 25 хүн 1-р сар", "багц хэд вэ",
    "хамт олон гэж юу вэ", "энэ аяллын шууд нислэг байна уу", "visa хэрэгтэй юу", "байгууллага хаана байдаг вэ",
    "", "   ", "😊",
  ]) none(text);
  none(`байгууллагын аялал ${"сайхан ".repeat(80)}`);
});

test("a long story that merely mentions the word is not a request", () => {
  none("Өчигдөр найз надад каталог гэдэг үгийг ярьсан ч би юу ч ойлгосонгүй тэгээд л хэн нэгэн ирж байна гэж хэлсэн болохоор очиж харсан");
});

test("a request for a group quotation is routed to a staff hand-off, not to the PDF", () => {
  for (const text of [
    "30 хүнтэй байгууллагын аялалд үнийн санал гаргаж өгөөч", "хамт олны аяллын үнийн санал", "baiguullagiin aylal unin sanal",
    "company trip quotation for 40 people", "20 хүний аялалд quote", "багийн аяллын үнийн санал",
  ]) {
    const result = kind(text);
    assert.equal(result.kind, "group_quote", `${text} -> ${JSON.stringify(result)}`);
  }
  // Both asked: the catalogue is sent and its text already invites the quotation.
  assert.equal(kind("байгууллагын аяллын каталог болон үнийн санал").kind, "catalogue");
});

test("only vague requests are 'soft': the existing trip flow answers them if the catalogue cannot be sent", () => {
  assert.equal(isSoftCatalogueRequest("бүх аяллаа"), true);
  assert.equal(isSoftCatalogueRequest("аяллын сонголтууд"), true);
  assert.equal(isSoftCatalogueRequest("каталог явуул"), false);
  assert.equal(isSoftCatalogueRequest("байгууллагын аялал"), false);
});

test("analysis exposes the words that decided", () => {
  const signals = analyzeCatalogueText("30 хүнтэй байгууллагын аяллын каталог");
  assert.equal(signals.corporate && signals.travel && signals.catalogue && signals.groupSize, true);
});

test("trip-code replies: code, head count and month in any of the customer's spellings", () => {
  const cases: Array<[string, { code: string; groupSize: number | null; month: number | null }]> = [
    ["A01, 25 хүн, 1-р сар", { code: "A01", groupSize: 25, month: 1 }],
    ["A04 25 хүн", { code: "A04", groupSize: 25, month: null }],
    ["a02 15 human 3 sar", { code: "A02", groupSize: 15, month: 3 }],
    ["А07 40 хүн 12-р сард", { code: "A07", groupSize: 40, month: 12 }],
    ["a1 10 hun 2 sard", { code: "A01", groupSize: 10, month: 2 }],
    ["B03 - 30 people - March", { code: "B03", groupSize: 30, month: 3 }],
    ["A12, 8 хүн", { code: "A12", groupSize: 8, month: null }],
    ["A05", { code: "A05", groupSize: null, month: null }],
    ["Код A09 хамт олон 50 хүн нэгдүгээр сард", { code: "A09", groupSize: 50, month: 1 }],
    ["a 03 25 hun", { code: "A03", groupSize: 25, month: null }],
    ["A04 25", { code: "A04", groupSize: 25, month: null }],
    ["A11 20 хүнтэй 10 сард явна", { code: "A11", groupSize: 20, month: 10 }],
    ["A06 арван хоёрдугаар сар 35 хүн", { code: "A06", groupSize: 35, month: 12 }],
    ["A01,25 хүн,1-р сар", { code: "A01", groupSize: 25, month: 1 }],
  ];
  for (const [text, want] of cases) {
    const got = parseTripCodeRequest(text);
    assert.ok(got, text);
    assert.equal(got.code, want.code, text);
    assert.equal(got.groupSize, want.groupSize, text);
    assert.equal(got.month, want.month, text);
    assert.equal(got.raw, text.trim());
  }
});

test("a code-shaped word in an ordinary sentence is not a trip code", () => {
  for (const text of ["A4 цаасан дээр хэвлэж өгнө үү", "миний утас B2 байна", "миний утас B21 байна", "Сайн байна уу", "25 хүн 1-р сар", "A100 25 хүн",
    "hello A1 world and many other long words that do not look like a request at all really"]) {
    assert.equal(parseTripCodeRequest(text), null, text);
  }
});

test("several codes in one message are all listed, the first is the request", () => {
  assert.deepEqual(parseAllTripCodes("A01 болон A03, 20 хүн"), ["A01", "A03"]);
  assert.equal(parseTripCodeRequest("A01 болон A03, 20 хүн")?.code, "A01");
  assert.deepEqual(parseAllTripCodes("A01 A01"), ["A01"]);
});

test("head count and month readers", () => {
  assert.equal(extractGroupSize("25 хүн"), 25);
  assert.equal(extractGroupSize("25 хүнтэй"), 25);
  assert.equal(extractGroupSize("1-р сар"), null);
  assert.equal(extractGroupSize("1000 хүн"), 1000);
  assert.equal(extractGroupSize("0 хүн"), null);
  assert.equal(extractGroupSize("хүн 12"), 12);
  assert.equal(extractMonth("1-р сар"), 1);
  assert.equal(extractMonth("12 сард"), 12);
  assert.equal(extractMonth("13 сар"), null);
  assert.equal(extractMonth("january"), 1);
  assert.equal(extractMonth("gurvadugaar sar"), 3);
  assert.equal(extractMonth("25 хүн"), null);
  assert.equal(extractMonth("2027-01-09"), null, "a full date is not a stated month");
});

// ── Precision AND recall, locked together ─────────────────────────────────────────────────────────
// Every row is (message, decision). The positives are the phrases the owner's master prompt requires
// (Cyrillic, Latin transliterations, typos, English); the negatives are ordinary chat the catalogue
// must never take: specific-trip questions, inclusions, itinerary, holidays, group-tour wording,
// look-alike English words, phone numbers, dates and a code-shaped "A1" inside other text.
type Decision = "quick" | "complete" | "group_quote" | "none";
const decide = (text: string): Decision => {
  const result = kind(text);
  return result.kind === "catalogue" ? result.edition : result.kind === "group_quote" ? "group_quote" : "none";
};

const POSITIVES: Array<[string, Decision]> = [
  ["байгууллагын аяллуудаа харуул", "complete"], ["байгууллагын аяллуудаа явуулаач", "complete"], ["хамт олноороо аялах сонголт", "complete"],
  ["baiguullagiin aylal", "complete"], ["corporate trip catalog", "complete"], ["hamt olnii aylal", "complete"],
  ["baiguullagiin aylaliin songoltuud", "complete"], ["Корпорэйт аялал", "complete"], ["корпорейт аялал", "complete"],
  ["Корпорэйт аялал үнэ", "complete"], ["корпоратив аялал", "complete"], ["korporeit aylal", "complete"],
  ["компанийн аялал байна уу", "complete"], ["Манай компани аялал хийх гэсэн юм", "complete"], ["kompaniin aylal", "complete"],
  ["company trip", "complete"], ["company trips brochure please", "complete"], ["багийн аялал", "complete"], ["бүлгийн аялал", "complete"],
  ["ажилчдын аялал", "complete"], ["team building trips", "complete"], ["Corporate travel options", "complete"],
  ["хамт олны аяллын сонголтууд", "complete"], ["baigulagiin ayal", "complete"], ["bayguullagiin aylal", "complete"],
  ["corporate tour", "complete"], ["our team trip", "complete"], ["BAIGUULLAGIIN AYLAL", "complete"],
  ["каталог явуул", "complete"], ["katalog yavuul", "complete"], ["бүх аяллаа", "complete"], ["бүх аялал", "complete"],
  ["бүх аяллаа харуулаач", "complete"], ["бүх аяллуудаа явуулаач", "complete"], ["бүх аяллыг харуулаач", "complete"],
  ["bvh aylal", "complete"], ["buh ayalaa haruul", "complete"], ["all tours", "complete"], ["all trips please", "complete"],
  ["show me all your tours", "complete"], ["trip brochure", "complete"], ["send me the catalogue", "complete"],
  ["full catalogue", "complete"], ["байгууллагын бүх аялал", "complete"],
  ["30 хүнтэй байгууллагын аялалд үнийн санал гаргаж өгөөч", "group_quote"], ["baiguullagiin aylal unin sanal", "group_quote"],
  ["company trip quotation for 40 people", "group_quote"],
];

const NEGATIVES: string[] = [
  // "all" as an adjective of something else, not the list of trips
  "энэ аялалд бүх зүйл багтсан уу", "энэ аяллын бүх хөтөлбөр", "аяллын бүх зардал багтсан уу", "бүтэн өдрийн аялал байна уу",
  "бүх нийтийн баярын аялал байна уу", "full day tour", "tour all inclusive", "very nice trip", "have you ever been on a trip",
  "do all tours include lunch", "бүх аяллын үнэ хэд вэ", "бүх хүүхэд аялалд явж болох уу", "энэ аялалд бүх хүн явж болох уу",
  // every public trip is a group tour; look-alike words
  "групп аялал байна уу", "энэ групп аялал уу", "group tour", "энэ аялал багийн хэдэн хүнтэй вэ", "аялал жуулчлалын компани уу",
  "танай компани аялал зохион байгуулдаг уу", "Bulgaria trip", "bulgaria aylal", "companion tour", "teammate trip",
  "your team has trips", "тийм аялал авмаар байна", "энэ аяллыг байгууллагаар явж болох уу",
  // ordinary chat, specific-trip questions, numbers
  "Сайн байна уу", "ямар аялал байна", "аялал байна уу", "Тест-далай аяллын үнэ хэд вэ", "99112233 дугаар руу залгаарай",
  "1-р сарын 9-нд гарах аялал", "2027-01-09 аялал", "A1 цаасан дээр хэвлэж өгнө үү", "MA1N trip A1", "pdf явуулаач",
  "энэ аяллын шууд нислэг байна уу", "visa хэрэгтэй юу", "хамт олон гэж юу вэ", "байгууллага хаана байдаг вэ",
  "гэр бүлийн аялал", "ger buliin aylal",
  // "again" next to thanks or a question
  "дахин баярлалаа", "дахиад нэг асуулт байна", "үнийг дахиад хэлээч", "thanks again",
];

test("table: the phrases the owner requires are all recognised (recall)", () => {
  assert.ok(POSITIVES.length >= 40);
  for (const [text, want] of POSITIVES) assert.equal(decide(text), want, text);
});

test("table: ordinary chat, specific-trip questions and look-alike words are never a catalogue request (precision)", () => {
  assert.ok(NEGATIVES.length >= 40);
  for (const text of NEGATIVES) assert.equal(decide(text), "none", text);
});

test("an 'all' that is not the object of a listing does not make the Complete catalogue; typos of other words cannot become 'all'", () => {
  assert.equal(analyzeCatalogueText("very nice trip").all, false, "very is not every");
  assert.equal(analyzeCatalogueText("have you ever been").all, false, "ever is not every");
  assert.equal(analyzeCatalogueText("бүтэн өдрийн аялал").allListing, false);
  assert.equal(analyzeCatalogueText("бүх аяллаа").allListing, true);
  assert.equal(analyzeCatalogueText("энэ аялалд бүх зүйл багтсан уу").demonstrative, true, "the webhook keeps this inside the trip under discussion");
  // A catalogue word still picks the edition by any "all" it holds.
  complete("бүтэн каталог");
});

test("company, team and group words fire only as the customer's own side", () => {
  for (const [text, corporate] of [
    ["компанийн аялал", true], ["манай компани аялал", true], ["company trip", true], ["company's trip", true], ["our company retreat trip", true],
    ["аялал жуулчлалын компани", false], ["танай компани аялал", false], ["Your company trips", false], ["group trips", false], ["групп аялал", false],
    ["Bulgaria trip", false], ["companion tour", false], ["teammate trip", false], ["тийм аялал", false], ["аялал багийн хэдэн хүнтэй", false],
    ["зохион байгуулдаг аялал", false], ["корпорэйт аялал", true], ["Корпорейт аялал", true], ["korporeit aylal", true], ["корпоратив аялал", true],
  ] as const) {
    assert.equal(analyzeCatalogueText(text).corporate, corporate, text);
  }
});

test("a bare resend asks for something to be sent again, or is nothing but 'again' (recall and precision)", () => {
  for (const text of ["дахин явуул", "dahin yavuul", "resend", "send again", "дахин", "again please", "дахиад явуулаач", "pdf дахин явуул", "дахин илгээнэ үү"]) {
    assert.equal(isBareResendRequest(text), true, text);
  }
  for (const text of [
    "баярлалаа дахин хандъя", "дахиад нэг асуулт байна", "үнийг дахиад хэлээч", "дахин хэлээч", "дахин ярья", "thanks again", "дахин баярлалаа",
    "үнийг дахин явуулаач", "тэр хөтөлбөрийг дахин явуул", "Тест-далай аялал дахин хэлээч", "дахин асуух зүйл байна",
  ]) {
    assert.equal(isBareResendRequest(text), false, text);
  }
  // "дахин" in a catalogue request that holds no send word is not an explicit resend either
  const asked = kind("байгууллагын аялалын талаар дахин асуух зүйл байна");
  assert.equal(asked.kind === "catalogue" && asked.resend, false);
});

test("trip codes: a code inside a short sentence is a candidate, a question about a coded trip is flagged, a date is not a head count", () => {
  assert.equal(parseTripCodeRequest("Сайн байна уу, A02 аяллыг сонирхож байна"), null, "by shape alone it is not a code reply");
  const sentence = readTripCode("Сайн байна уу, A02 аяллыг сонирхож байна", { loose: true });
  assert.deepEqual([sentence?.code, sentence?.loose, sentence?.question], ["A02", true, false], "the greeting's 'уу' is not a question");
  assert.equal(readTripCode("Сайн байна уу A01", { loose: true })?.code, "A01");
  assert.equal(readTripCode("миний утас B21 байна")?.code, undefined, "without loose it is still no code");
  assert.equal(readTripCode("миний утас B21 байна", { loose: true })?.loose, true, "a candidate only: the store decides whether B21 exists");
  assert.equal(readTripCode("A4 цаасан дээр хэвлэж өгнө үү", { loose: true }), null, "a one-digit code is never loose");
  assert.equal(readTripCode("the long story " + "word ".repeat(14) + "A02", { loose: true }), null, "a long text with a code in it is not a reply");
  for (const text of ["A01 хөтөлбөр юу вэ", "A02 үнэ хэд вэ", "A03 ямар зочид буудал вэ?", "A01 хэдэн хоног вэ"]) {
    const reading = readTripCode(text);
    assert.ok(reading, text);
    assert.deepEqual([reading.leading, reading.question, reading.stated], [true, true, false], text);
  }
  assert.equal(readTripCode("A01 25 хүн хэдэн сард аялах вэ")?.stated, true, "a stated head count makes it a quotation whatever else it asks");
  assert.equal(readTripCode("A05")?.question, false);
  const ageOf = (text: string) => [parseTripCodeRequest(text)?.groupSize, parseTripCodeRequest(text)?.month];
  assert.deepEqual(ageOf("A01 3-р сарын 15"), [null, 3], "the 15th is not 15 people");
  assert.deepEqual(ageOf("A01 12-р сарын 15"), [null, 12]);
  assert.deepEqual(ageOf("A01 2027 оны 1-р сар"), [null, 1], "a year is not a head count");
  assert.deepEqual(ageOf("A01 March 15"), [null, 3]);
  assert.deepEqual(ageOf("A01 15 March"), [null, 3]);
  assert.deepEqual(ageOf("A01 5 хоног"), [null, null], "a length of time is not a head count");
  assert.deepEqual(ageOf("A01 600"), [null, null], "above a plausible group");
  assert.deepEqual(ageOf("A04 25"), [25, null], "a lone number is still a head count");
  assert.deepEqual(ageOf("A04 25 3-р сард"), [25, 3]);
  assert.deepEqual(ageOf("A04 3-р сард 25"), [25, 3]);
});

test("the way customers really type 'байгууллагын аялал' (baigulgin, baiguulgiin) asks for the catalogue; look-alikes do not", () => {
  for (const text of ["baigulgin aylal hari", "baigulgin aylal", "baiguulgiin aylal hari", "baigulgiin aylal", "байгулгин аялал харуул"]) {
    assert.equal(detectCatalogueIntent(text).kind, "catalogue", text);
  }
  for (const text of ["zohion baiguulah aylal", "baiguulsan hun", "baigal aylal", "tailand aylal hed ve"]) {
    assert.equal(detectCatalogueIntent(text).kind, "none", text);
  }
});

test("a trip name with a head count or month: the details are read, and taken out before the name is resolved", async () => {
  const { withoutQuoteDetails } = await import("../src/lib/catalogue/tripCodeRequest");
  assert.deepEqual([extractGroupSize("Тест 25 хүн 1-р сард"), extractMonth("Тест 25 хүн 1-р сард")], [25, 1]);
  assert.deepEqual([extractGroupSize("Tailand 15 humn 3 sar"), extractMonth("Tailand 15 humn 3 sar")], [15, 3]);
  assert.deepEqual([extractGroupSize("Хайнан 10 хүн"), extractMonth("Хайнан 10 хүн")], [10, null]);
  assert.deepEqual([extractGroupSize("Хайнан 2 сар"), extractMonth("Хайнан 2 сар")], [null, 2]);
  assert.equal(withoutQuoteDetails("Тест 25 хүн 1-р сард"), "Тест");
  assert.equal(withoutQuoteDetails("Tailand 15 humn 3 sar"), "Tailand");
  assert.equal(withoutQuoteDetails("Тест 8 хүнтэй нэгдүгээр сард"), "Тест нэгдүгээр");
  assert.equal(withoutQuoteDetails("Тест March 12 people"), "Тест");
});
