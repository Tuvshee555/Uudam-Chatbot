import { NO_HELP, WINDOW, paraphrases, reworded, underModel } from "./understandingScenarioKit";
import { M, RE, X, scenario, type Scenario } from "./understandingScenarioTypes";

/**
 * The owner's 17 historical conversations (2026-10-28 .. 2026-11-06) rebuilt on the invented
 * catalogue: same shape, same wording style (Cyrillic, Latin transliteration, typos), invented
 * names. Each case has the original and unseen paraphrases of its decisive message; the business
 * cases also run with the provider down and with a model that mislabels or invents.
 */

/** How a reply says that a named trip has no open seat or date. */
const SOLD_OUT_WORDS = /дууссан|дүүрсэн|дүүрэн|нээлттэй өдөр алга|захиалгад нээлттэй|суудал(?: үлдээгүй| байхгүй)/i;

const COMPETITION = "Сайн байна уу.  2027 оны 1-р сарын 14–18-ны хооронд Тарвиягийн Лумар хот руу 1 том хүн, 9 болон 11 настай 2 хүүхэдтэй аялах хүсэлтэй байна.  "
  + "Хүүхдүүд 1-р сарын 16-нд Лумарын Конвенц Төвд болох ЛОМТ-2027 олон улсын математикийн тэмцээнд оролцоно.  Иймд энгийн аяллын хөтөлбөрт хамрагдахгүйгээр дараах үйлчилгээний үнийн санал авмаар байна.  "
  + "* Улаанбаатар–Лумар–Улаанбаатар хоёр талын нислэг * 1-р сарын 14–18-ны 4 шөнийн буудал * Конвенц Төвтэй ойр, 3 хүн нэг өрөөнд байрлах боломжтой буудал * Нисэх буудлаас тосох, хүргэж өгөх үйлчилгээ "
  + "* Тэмцээний өдөр Конвенц Төвд хүргэх унаа * Аяллын даатгал  Нийт 3 хүний зардлыг багтаасан үнийн санал болон үйлчилгээний нөхцөлийг явуулна уу.  Баярлалаа.";

const THANKS = "Өглөөний мэнд танай компанид баярлалаа гэж хэлэх гээд завгүй заримдаа мартаж явсаар одоо нэг бичиж байна аа бидний аялалд сэтгэлээрээ хандаж бүх боломж бололцоогоороо бид бүхний ая тухыг хангаж үйлчилсэн "
  + "танд болон танай компанийн хамт олон, хөтөч нартаа баярлалаа😊😊😊 Хөтөлбөрт нэмэх хасах, өөрчилж сайжруулах санал хүсэлт болгоныг минь маш уриалгахан хүлээж авч шийдвэрлэх гэж хичээж байсан танд баярлалаа "
  + "ажилдаа их хичээл зүтгэлтэй хүн шиг санагдсан шүү 😇😇😇 Олон зүйл шаардаж  төвөг удсанд бас уучлаарай🙏🏻🙏🏻🙏🏻Танай хамт олонд ажлын амжилт хүсье😊😊😊";

const holidayListAfterCountry = (id: string, texts: [string, string, string], title: string, tags: string[]): Scenario => scenario(["case", "date", "holiday", "context", ...tags], {
  id, historicalCase: "CASE-1", title,
  turns: [
    { text: texts[0], setup: true, model: { intent: "trip", certainty: "several", topics: [] } },
    { text: texts[1], setup: true, model: M.topics(["dates"], { certainty: "several", month: 2 }) },
    { text: texts[2], model: { intent: "catalog", topics: ["dates"], certainty: "none" },
      expect: { mustAnswer: true, mustMatch: [/Цагаан сарын үеэр/], mustNotMatch: [/Манай аяллууд/, RE.noDepartureHeading], datesWithin: WINDOW.tsagaanSar, noClarification: true } },
  ],
});

export const CASE_SCENARIOS: Scenario[] = [];
const add = (...items: Scenario[]) => { CASE_SCENARIOS.push(...items); };

// ---- CASE-1: a country, then "2 сард", then the holiday asked in other words
add(
  holidayListAfterCountry("CASE-1", ["Тарвия", "2 сард", "цагаан сарын үейр ямар аялалууд байна"], "country list, month, then the holiday", ["hist"]),
  holidayListAfterCountry("CASE-1.p1", ["Тарвия", "2 сард", "tsagaan sariin uyeer yamar ayaluud bga"], "same, Latin transliteration", ["paraphrase"]),
  holidayListAfterCountry("CASE-1.p2", ["Тарвия", "2 сард", "Цагаан сараар ямар аялал байна"], "same, shorter", ["paraphrase"]),
  holidayListAfterCountry("CASE-1.p3", ["Тарвия аялал", "2-р сард", "цагаан сарын үеээр ямр аялалууд бга вэ"], "same, typos", ["paraphrase"]),
);

// ---- CASE-2: a holiday plus a place that has no departure in that window
const case2 = scenario(["case", "date", "trip", "holiday", "hist"], {
  id: "CASE-2", historicalCase: "CASE-2", title: "holiday + place with no departure then",
  turns: [{
    text: "Цагаан сарын үeээр Пекара хотын хэрэм үзэх аялал сонирхоё", // the Latin "e" in "үeээр" is as typed
    model: { intent: "trip", certainty: "several", topics: ["dates"], place: "Пекара" },
    expect: { mustAnswer: true, mustMatch: [/Цагаан сар/], datesWithin: WINDOW.february, noClarification: true },
  }],
});
add(case2, ...paraphrases(case2, [
  "Цагаан сараар Пекара явмаар байна",
  "tsagaan sarar pekara yavmaar bn",
  "Цагаан сарын амралтаар Пекара явах аялал байгаа юу",
  "Цагаан сарын дараа Пекара явах аялал байна уу",
]));

// ---- CASE-3: the ad's trip is on screen; date follow-ups in ordinary words
const case3 = scenario(["case", "date", "context", "holiday", "hist"], {
  id: "CASE-3", historicalCase: "CASE-3", title: "ad trip selected, holiday and month follow-ups", before: { selection: { tripId: "karmina-ad" } },
  model: M.trip("karmina-ad", ["dates"]),
  turns: [
    { text: "Он гараад цагаан сар тааруулсан ийм хөтөлбөртэй аялал гарах уу?", expect: { mustAnswer: true, anyOf: [/КАРМИНА|11 сарын 19|11\/19|Цагаан сарын үеэр|2 сард гарах аяллууд/], noClarification: true, noOutage: true } },
    { text: "2027 ионы 2-р сард аялах юмаа", expect: { mustAnswer: true, anyOf: [/КАРМИНА|11 сарын 19|11\/19|Цагаан сарын үеэр|2 сард гарах аяллууд/], noClarification: true, noOutage: true } },
  ],
});
const case3single = scenario(["case", "date", "context", "holiday", "paraphrase"], {
  id: "CASE-3.q", historicalCase: "CASE-3", title: "ad trip selected, one date follow-up", before: { selection: { tripId: "karmina-ad" } }, model: M.trip("karmina-ad", ["dates"]),
  turns: [{ text: "2 сард явмаар байна", expect: { mustAnswer: true, anyOf: [/КАРМИНА|11 сарын 19|11\/19|Цагаан сарын үеэр|2 сард гарах аяллууд/], noClarification: true, noOutage: true } }],
});
add(case3, case3single, ...paraphrases(case3single, [
  "тэгвэл цагаан сараар гарах уу",
  "2-р сард аялж болох уу",
  "dahin 2 sard yavmaar bn",
  "Он гараад 2 сард явж болох уу?",
  "Цагаан сарын үеэр гарах боломжтой юу",
], 0, "q"));

// ---- CASE-4: New Year / Tsagaan Sar / a month, plus a place no active trip goes to
const case4 = scenario(["case", "trip", "need", "holiday", "hist"], {
  id: "CASE-4", historicalCase: "CASE-4", title: "New Year + a border town that only has an archived trip",
  turns: [
    { text: "12 сарын шинэ жилийн хөтөлбөртэй Нелмарын аялал байна уу?", model: M.unknownPlace("Нелмар", ["dates"]), expect: X.service },
    { text: "Нелмарын шинэ жилийн хөтөлбөртэй аялал.", model: M.unknownPlace("Нелмар"), expect: X.service },
  ],
});
const case4single = scenario(["case", "trip", "need", "holiday", "paraphrase"], {
  id: "CASE-4.q", historicalCase: "CASE-4", title: "a holiday or month plus a place no trip goes to",
  turns: [{ text: "Шинэ жилээр Оролго явах аялал байна уу?", model: M.unknownPlace("Оролго", ["dates"]), expect: X.service }],
});
add(case4, case4single, ...paraphrases(case4single, [
  "Цагаан сараар Оролго явмаар байна",
  "12 сард Оролго явах аялал байна уу",
  "shine jileer orolgo yavah ayal bnu",
], 0, "q"));

// ---- CASE-5: a family asks New Year abroad, then child fares by age
const case5 = scenario(["case", "date", "multi", "holiday", "context", "hist"], {
  id: "CASE-5", historicalCase: "CASE-5", title: "family New Year abroad, then fares for two children by age",
  turns: [
    { text: "Hello, ger buleeree gadaad temdegleh gesen ym. Shine jiliin uyeer ali ali ulsruu aylaltai bga ve?", model: { intent: "catalog", topics: ["dates"], certainty: "none" },
      expect: { mustAnswer: true, anyOf: [/ШИНЭ ЖИЛИЙН АЯЛАЛ/], mustNotMatch: [/ШИНЖИЛГЭЭТЭЙ/], datesWithin: WINDOW.newYear } },
    { text: "4 bolon 7 nastai huuhed tulbur hed ve?",
      model: M.topics(["price"], { certainty: "several", passengers: [{ kind: "child", count: 1, age: 4 }, { kind: "child", count: 1, age: 7 }] }),
      expect: { mustAnswer: true, anyOf: [/3,990,000₮|2,690,000₮|760,000₮|3,590,000₮/], noClarification: true, mustNotMatch: [/сонгоно уу/] } },
  ],
});
const case5fares = scenario(["case", "date", "multi", "holiday", "context", "paraphrase"], {
  id: "CASE-5.q", historicalCase: "CASE-5", title: "fares for children under the New Year list",
  turns: [
    { text: "Shine jiliin uyeer ali ali ulsruu aylaltai bga ve?", setup: true, model: { intent: "catalog", topics: ["dates"], certainty: "none" } },
    { text: "хүүхэд 5 настай үнэ хэд вэ", model: M.topics(["price"], { certainty: "several", passengers: [{ kind: "child", count: 1, age: 5 }] }),
      expect: { mustAnswer: true, anyOf: [/3,990,000₮|2,690,000₮|760,000₮|3,590,000₮/], noClarification: true, mustNotMatch: [/сонгоно уу/] } },
  ],
});
add(case5, case5fares, ...paraphrases(case5fares, [
  "Хүүхэд 7 настай, төлбөр хэд вэ",
  "2 том 2 хүүхэдтэй явбал нийт хэд вэ",
  "huuhdiin une hed ve",
], 1, "q"),
reworded(case5, "t1a", { 0: "Шинэ жилээр гэр бүлээрээ гадаад явмаар байна, ямар аялал байна вэ?", 1: "4, 7 настай хүүхдийн үнэ хэд вэ" }),
reworded(case5, "t1b", { 0: "shine jilr gadaad ayal bgaa yu", 1: "huuhed 4 ba 7 nastai ne yaaj tulhu ve" }),
);

// ---- CASE-6: an advertised price typed as a bare number
const case6 = scenario(["case", "trip", "context", "hist"], {
  id: "CASE-6", historicalCase: "CASE-6", title: "New Year question, then the advertised price as a bare number",
  turns: [
    { text: "Sain bnuu ene shine jiliin ayalal haashaa be", setup: true, model: { intent: "catalog", topics: ["dates"], certainty: "none" } },
    { text: "860000 geed bga yum", model: M.topics(["price"]),
      expect: { mustAnswer: true, mustMentionTripIds: ["jorvin"], mustNotMentionTripIds: ["hortan-check"], mustNotMatch: [/Нярай/], noClarification: true } },
  ],
});
add(case6, ...paraphrases(case6, ["860k", "860k багц", "860 мянгатай аялал байна уу", "860000 төгрөгийн аялал байна уу"]));

// ---- CASE-7: an organisation, and the provider is down
const case7 = scenario(["case", "need", "corporate", "nonmodel", "hist"], {
  id: "CASE-7", historicalCase: "CASE-7", title: "'information please', then an organisation of 50-60",
  turns: [
    { text: "мэдээлэл авья", setup: true, model: M.smalltalk },
    { text: "50-60хүнтэй байгууллага байгаа юм", model: M.none, expect: X.business },
  ],
});
add(case7, underModel(case7, "down", M.down, ["outage"]), underModel(case7, "mislabel", M.mislabel, [], [1]),
  ...paraphrases(case7, ["Манай 40 хүнтэй компани байгаа", "hamt olnoor 30 hun yavmaar bna", "50-60 ажилтантай байгууллага байгаа юм", "baiguulaga 50 hun"]));

// ---- CASE-8: after a list of two trips: group discount, then barter
const case8 = scenario(["case", "need", "policy", "corporate", "nonmodel", "hist"], {
  id: "CASE-8", historicalCase: "CASE-8", title: "two trips listed, then a group discount question the model answers with an invented policy, then barter",
  turns: [
    { text: "sain baina uu norvel velmor 2 aylalin tlr medeelel awy", setup: true, model: { intent: "trip", certainty: "several", topics: [] } },
    { text: "baiguullagara 40-45 hun ywah bol hymdral uzuuldeg uu",
      model: M.invents("Тийм. 40-45 хүнтэй группт тусгай хямдрал санал болгодог. Нарийн үнийг манай аяллын зөвлөхөөс лавлана уу.", { intent: "other", topics: ["discount"], certainty: "none" }),
      expect: X.business },
    { text: "barter awdag u", model: M.mislabel, expect: X.business },
  ],
});
add(case8,
  underModel(case8, "reads-other", M.none, [], [1, 2]),
  underModel(case8, "down", M.down, ["outage"], [1, 2]),
  { ...case8, id: "CASE-8.noinvent", turns: case8.turns.map((turn, index) => (index === 1 ? { ...turn, model: M.none } : turn)) },
  ...paraphrases(case8, [
    "Байгууллагаар 30 хүн явбал хөнгөлөлт үзүүлдэг үү",
    "hongololt uzuuldeg uu 40 hun",
    "group discount bga yu",
  ], 1),
  ...paraphrases(case8, ["бартер авдаг уу", "barter hiij boloh uu", "бартераар аялж болох уу"], 2, "b"));

// ---- CASE-9: a group wants a city no trip reaches directly
const case9 = scenario(["case", "need", "corporate", "trip", "nonmodel", "hist"], {
  id: "CASE-9", historicalCase: "CASE-9", title: "a company group of 20-25 wants Zorgan directly, nothing else",
  turns: [
    { text: "Zorgan hotruuu aylah tuluwtui bga manai hamt olon niit 20s 25 hun", model: M.trip("zorgan-pkg", ["availability"]), expect: X.business },
    { text: "Shuud zorgan oroh naaguurn yuch uzhgui", model: M.trip("zorgan-pkg", ["program"]), expect: X.business },
  ],
});
add(case9, underModel(case9, "reads-other", M.none), underModel(case9, "down", M.down, ["outage"]),
  ...paraphrases(case9, [
    "Зорган хот руу 25 хүнтэй багаар шууд явъя, өөр хот үзэхгүй",
    "zorgan ruu 20 hun shuud yavmaar bn, busad hotiig uzehgui",
    "Зорган руу манай 22 ажилтан шууд явна. Шэнзар, Макор хэрэггүй",
  ], 0));

// ---- CASE-10: a pick-up request from a border town, a service the agency does not sell
const case10 = scenario(["case", "need", "service", "trip", "nonmodel", "hist"], {
  id: "CASE-10", historicalCase: "CASE-10", title: "can you pick a person up from a border town and bring them to Ulaanbaatar",
  turns: [
    { text: "Сайн байна уу", setup: true, model: M.smalltalk },
    { text: "Хорвата Нелмараас Улаанбаатар орох хүн авах боломж байдаг уу", model: M.none, expect: { ...X.service, mustNotMatch: [/Утасны дугаараа/] } },
  ],
});
add(case10, underModel(case10, "mislabel", M.mislabel, [], [1]), underModel(case10, "down", M.down, ["outage"], [1]),
  ...paraphrases(case10, [
    "Horvata Nelmaraas Ulaanbaatar ruu hun avah bolomj bga yu",
    "УБ руу буцах хүн авах уу",
    "Хорвата хилээс Улаанбаатар хүртэл автобусаар хүргэж өгөх үү",
    "Нелмараас Улаанбаатар хүртэл нэг талдаа явах тийз авч болох уу",
    "Хорватаас Улаанбаатар буцахад онгоцны тийз тусад нь авч болох уу",
  ]));

// ---- CASE-11: a land trip is picked, then "can it fly from the border town"
const case11 = scenario(["case", "trip", "context", "hist"], {
  id: "CASE-11", historicalCase: "CASE-11", title: "land trip selected, 'does it fly from the border town', then date and party",
  before: { selection: { tripId: "erdan-land" } },
  turns: [
    { text: "Эрдэнээс нисэх юм уу", model: M.trip("erdan-land", ["transport"]),
      expect: { mustAnswer: true, selectionAfter: "erdan-land", mustNotMentionTripIds: ["volda-fly"], mustNotMatch: [RE.tripList], anyOf: [/Газрын аялал|газраар|галт тэрэг|автобус|нислэггүй|нислэг(?:гүй| байхгүй)/i] } },
    { text: "11/25-ны аялал", model: M.trip("erdan-land", ["dates"], { date: "2026-11-25" }),
      expect: { mustAnswer: true, selectionAfter: "erdan-land", mustNotMentionTripIds: ["volda-fly"], mustNotMatch: [RE.noDepartureHeading] } },
    { text: "2 хүн", model: M.trip("erdan-land", ["price"], { passengers: [{ kind: "adult", count: 2 }] }),
      expect: { mustAnswer: true, selectionAfter: "erdan-land", mustNotMentionTripIds: ["volda-fly"], anyOf: [/2,414,000₮|1,207,000₮/] } },
  ],
});
const case11single = scenario(["case", "trip", "context", "paraphrase"], {
  id: "CASE-11.q", historicalCase: "CASE-11", title: "a question with the selected trip's own place word", before: { selection: { tripId: "erdan-land" } },
  model: M.trip("erdan-land", ["transport"]),
  turns: [{ text: "Эрдэнээс нисэх үү", expect: { selectionAfter: "erdan-land", mustNotMentionTripIds: ["volda-fly"], mustNotMatch: [RE.tripList], allowSilence: true } }],
});
add(case11, case11single, ...paraphrases(case11single, [
  "Эрдэнээс онгоцоор явах уу",
  "erdenees niseh uu",
  "Эрдэн хотод хэд хононо вэ",
  "Эрдэнээс буцах уу",
], 0, "q"));

// ---- CASE-12: the weather of a city + landmark, typed in Latin letters
const case12 = scenario(["case", "need", "trip", "weather", "hist"], {
  id: "CASE-12", historicalCase: "CASE-12", title: "weather of city + landmark where the exact trip is fully booked",
  model: { intent: "trip", certainty: "several", topics: ["weather"], place: "Verdan zorentiin haalga" },
  turns: [{ text: "Tsag agaar n Verdan zorentiin haalga odoo ymar bga ve",
    expect: { mustAnswer: true, mustMatch: [/Очих хотуудад одоогоор/], mustNotMatch: [RE.tripList, /₮/], noClarification: true } }],
});
add(case12, ...paraphrases(case12, [
  "Вердан хотын цаг агаар ямар байна",
  "Verdan tsag agaar yamar bn",
  "Вердан зорентын хаалга хүйтэн үү",
  "Вердан хэдэн хэм байна",
]));
add({ ...case12, id: "CASE-12.down", weather: "down", tags: [...case12.tags, "external"], title: "the same, the weather service is down: no invented weather, no trip list",
  turns: [{ text: case12.turns[0].text, expect: { ...X.service, mustNotMatch: [RE.tripList, /\d+\s*°|хэм/] } }] });

// ---- CASE-13: the customer names a trip that is fully booked
const case13 = scenario(["case", "trip", "hist"], {
  id: "CASE-13", historicalCase: "CASE-13", title: "price and programme of a named trip that is fully booked, next to an open sibling",
  model: M.trip("zorent-sold", ["price", "program"]),
  turns: [{ text: "вердан зорентын хаалга аялал үнэ болон хөтөлбөр авья",
    expect: { mustAnswer: true, mustMatch: [/ВЕРДАН \+ ЗОРЕНТЫН ХААЛГА/, SOLD_OUT_WORDS] } }],
});
add(case13, ...paraphrases(case13, [
  "verdan zorentiin haalga une hed ve",
  "вердан зорентын хаалга хэзээ гарах вэ",
  "вердан зорентын хаалга 2 хүн явъя",
]),
  // Without the city word the phrase fits the open sibling too: that trip's own card is a fair answer, a general city list is not.
  {
    ...reworded(case13, "p0", { 0: "зорентын хаалга хэд вэ" }),
    turns: [{ text: "зорентын хаалга хэд вэ", model: M.trip("zorent-sold", ["price"]), expect: { mustAnswer: true, mustMatch: [/ЗОРЕНТЫН ХААЛГ/], mustNotMatch: [RE.tripList] } }],
  });

// ---- CASE-14: a long thank-you that contains the words "programme", "add/remove" and "suggestion"
const case14 = scenario(["case", "need", "social", "nonmodel", "hist"], {
  id: "CASE-14", historicalCase: "CASE-14", title: "a long thank-you containing 'Хөтөлбөрт нэмэх хасах ... санал хүсэлт'",
  turns: [{ text: THANKS, model: M.friendly(), expect: X.social }],
});
add(case14, underModel(case14, "mislabel", M.friendly(M.mislabel)), underModel(case14, "down", M.down, ["outage"]),
  ...paraphrases(case14, [
    "Санал болгосонд баярлалаа",
    "Танайх маш сайн үйлчилдэг, санал хүсэлт байхгүй. Баярлалаа",
    "bayrlalaa, sanal hvseltee daraa ilgeene",
    "Санамж өгсөнд баярлалаа",
    "Хөтөлбөр нь их сайхан байсан, баярлалаа",
    "Хөтөч маш сайн байсан, баярлалаа",
    "Thank you so much",
    "bayarlalaa",
  ]));

// ---- CASE-15: "official organisation" after a bare price question
const case15 = scenario(["case", "need", "corporate", "nonmodel", "hist"], {
  id: "CASE-15", historicalCase: "CASE-15", title: "'Une' then 'Alban baiguulaga'",
  turns: [
    { text: "Une", setup: true, model: M.mislabel },
    { text: "Alban baiguulaga", model: M.mislabel, expect: X.business },
  ],
});
add(case15, underModel(case15, "reads-other", M.none, [], [1]), underModel(case15, "down", M.down, ["outage"], [1]),
  ...paraphrases(case15, ["baiguulaga", "Албан байгууллага", "компанийн аялал хийх гэсэн юм", "alban baiguullagiin aylal"]));

// ---- CASE-16: a traveller the agency already served asks about her own closed departure, then the flight time
const case16 = scenario(["case", "need", "date", "context", "existing", "hist"], {
  id: "CASE-16", historicalCase: "CASE-16", title: "customer with staff history asks '11.3 verdan', then 'what time does it fly'",
  at: "2026-11-02T04:00:00Z", staffHistoryAgoMs: 5 * 86_400_000,
  turns: [
    { text: "11.3 nii verdan", model: M.topics(["dates"], { place: "Verdan" }),
      expect: { allowSilence: true, leadIfSilent: true, mustNotMatch: [RE.noDepartureHeading], ifReplyMustMatch: [/дууссан|дүүрсэн|хаагдсан|өнгөрсөн|хаалттай/i], noOutage: true } },
    { text: "Heden tsagt niseh ve", before: { selection: { tripId: "verdan-nov" } }, model: M.trip("verdan-nov", ["dates", "transport"]),
      expect: { allowSilence: true, leadIfSilent: true, ifReplyMustMatch: [/\d{1,2}:\d{2}/], mustNotMatch: [/^Шууд нислэгтэй аялал\.?\s*$/m], noOutage: true } },
  ],
});
const case16time = scenario(["case", "need", "context", "existing", "paraphrase"], {
  id: "CASE-16.q", historicalCase: "CASE-16", title: "flight time asked of the selected trip", at: "2026-11-02T04:00:00Z", before: { selection: { tripId: "verdan-nov" } },
  model: M.trip("verdan-nov", ["dates", "transport"]),
  turns: [{ text: "Нислэг хэдэн цагт вэ", expect: { allowSilence: true, leadIfSilent: true, ifReplyMustMatch: [/\d{1,2}:\d{2}/], mustNotMatch: [/^Шууд нислэгтэй аялал\.?\s*$/m], noOutage: true } }],
});
const case16date = scenario(["case", "need", "date", "existing", "paraphrase"], {
  id: "CASE-16.d", historicalCase: "CASE-16", title: "her own closed departure named another way", at: "2026-11-02T04:00:00Z", staffHistoryAgoMs: 5 * 86_400_000,
  model: M.topics(["dates"], { place: "Verdan" }),
  turns: [{ text: "11 сарын 3-ны вердан", expect: { allowSilence: true, leadIfSilent: true, mustNotMatch: [RE.noDepartureHeading], ifReplyMustMatch: [/дууссан|дүүрсэн|хаагдсан|өнгөрсөн|хаалттай/i], noOutage: true } }],
});
add(case16,
  ...paraphrases(case16time, ["Онгоц хэдэн цагт хөөрөх вэ", "Буцах нислэг хэдэн цагт вэ", "Хэдэн цагийн нислэг вэ", "Hezhe tsagt niseh ve"], 0, "q"),
  ...paraphrases(case16date, ["11/3 ны аялал вердан", "verdan 11.3 nii ayal"], 0, "d"));

// ---- CASE-17: a competition trip that needs a custom quote
const case17 = scenario(["case", "need", "corporate", "multi", "nonmodel", "hist"], {
  id: "CASE-17", historicalCase: "CASE-17", title: "children's competition trip: flights + 4 nights near the venue + transfers + insurance, 'not a standard programme'",
  turns: [{ text: COMPETITION, model: M.topics(["price"], { certainty: "several", passengers: [{ kind: "adult", count: 1 }, { kind: "child", count: 1, age: 9 }, { kind: "child", count: 1, age: 11 }] }),
    expect: { ...X.business, mustNotMatch: [/Нийт/, /15,870,000/] } }],
});
add(case17, underModel(case17, "reads-other", M.none), underModel(case17, "down", M.down, ["outage"]),
  ...paraphrases(case17, [
    "4 хүн нислэг, зочид буудал, унаа л авъя. хөтөлбөр хэрэггүй, үнийн санал өгөөч",
    "2 том 1 хүүхэд багцгүй зөвхөн нислэгийн тийз, буудал, трансфер авна",
    "Тарвия руу 25 сурагч 3 багш тэмцээнд явна, тусгайлан хөтөлбөр гаргаад үнийн санал өгнө үү",
  ], 0));

// Not used further, but exported so the data reads as one list.
void NO_HELP;
