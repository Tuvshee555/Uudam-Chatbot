import { WINDOW, paraphrases, underModel } from "./understandingScenarioKit";
import { M, RE, X, scenario, type Scenario } from "./understandingScenarioTypes";

/**
 * The owner's ten paraphrases of the failed conversations (2026-11-06), with the trip and place
 * names replaced by the invented ones (Beijing-like = Пекара, theme park = Лунариа, Shanghai-like
 * = Вердан, Zhuhai-like = Зорган), plus at least three unseen wordings of each in Cyrillic,
 * Latin letters and with typos.
 */
export const OWNER_SCENARIOS: Scenario[] = [];
const add = (...items: Scenario[]) => { OWNER_SCENARIOS.push(...items); };

// 1. A company sends 35 employees somewhere warm for the New Year
const op1 = scenario(["owner", "need", "corporate", "holiday", "nonmodel"], {
  id: "OP-1", title: "35 employees, New Year, a warm country", model: M.none,
  turns: [{ text: "Манай 35 ажилтныг шинэ жилээр дулаан орон руу явуулах гэсэн юм.", expect: X.business }],
});
add(op1,
  underModel(op1, "invents", M.invents("Тийм, 35 хүнтэй байгууллагад тусгай хямдралтай үнэ санал болгодог. Нарийн үнийг зөвлөхөөс лавлана уу."), [], [0]),
  underModel(op1, "down", M.down, ["outage"]),
  underModel(op1, "mislabel", M.mislabel),
  ...paraphrases(op1, [
    "Манай 25 ажилтныг цагаан сараар дулаан орон руу явуулах гэсэн юм",
    "35 ajiltnaa shine jileer dulaan orond yavuulmaar bna",
    "Компаниасаа 40 хүн шинэ жилээр гадаад аялуулна",
  ]));

// 2. Tsagaan Sar with children
const op2 = scenario(["owner", "date", "holiday", "multi", "answerable"], {
  id: "OP-2", title: "2027 Tsagaan Sar with children: what is there?", model: { intent: "catalog", topics: ["dates"], certainty: "none" },
  turns: [{ text: "2027 оны цагаан сараар хүүхдүүдтэйгээ аялахад юу байна?",
    expect: { mustAnswer: true, mustMatch: [/Цагаан сарын үеэр/], datesWithin: WINDOW.tsagaanSar, noClarification: true, noOutage: true } }],
});
add(op2, underModel(op2, "down", M.down, ["outage"]), ...paraphrases(op2, [
  "Цагаан сараар хүүхэдтэйгээ аялмаар байна",
  "tsagaan sarar huuhduudtei ayalah yu bn",
  "Цагаан сарын амралтаар гэр бүлээрээ явах аялал байна уу",
]));

// 3. A city, but not its theme park
const op3 = scenario(["owner", "trip", "multi", "answerable"], {
  id: "OP-3", title: "wants Пекара but not the theme park (the negation names no trip word of its own)", model: M.topics(["price"], { intent: "trip", certainty: "several", place: "Пекара" }),
  turns: [{ text: "Пекара үзмээр байна гэхдээ Лунариа хэрэггүй.",
    expect: { mustAnswer: true, mustMatch: [/ПЕКАРА/], mustNotMentionTripIds: ["pekara-park"], noOutage: true } }],
});
add(op3, ...paraphrases(op3, ["Пекара явъя, Лунариа парк хэрэггүй", "pekara yavmaar bna lunaria orohgui", "Пекара руу явмаар байна, парк биш"]));

// 4. Barter or an organisation contract
const op4 = scenario(["owner", "need", "policy", "corporate", "nonmodel"], {
  id: "OP-4", title: "can we pay by barter or an organisation contract", model: M.none,
  turns: [{ text: "Бартер эсвэл байгууллагын гэрээгээр төлж болох уу?", expect: X.business }],
});
add(op4,
  underModel(op4, "invents", M.invents("Тийм, бартер болон байгууллагын гэрээгээр төлбөр хийх боломжтой."), [], [0]),
  underModel(op4, "down", M.down, ["outage"]),
  underModel(op4, "mislabel", M.mislabel),
  ...paraphrases(op4, ["Бартер авдаг уу", "компанийн гэрээгээр төлбөр хийж болох уу", "нэхэмжлэхээр төлж болох уу", "barter hiij boloh uu"]));

// 5. A team of 60 wants a special route early in February
const op5 = scenario(["owner", "need", "corporate", "date", "nonmodel"], {
  id: "OP-5", title: "team of 60, early February, a special route", model: M.topics(["dates"], { month: 2 }),
  turns: [{ text: "Манай 60 хүний багт 2 сарын эхээр тусгай маршрут гаргах уу?", expect: { ...X.business, mustNotMatch: [/2 сард гарах аяллууд/, RE.tripList] } }],
});
add(op5, underModel(op5, "reads-other", M.none), underModel(op5, "down", M.down, ["outage"]),
  ...paraphrases(op5, [
    "Манай 45 ажилтанд 3 сарын эхээр өөрсдийн маршрут гаргаж өгөх үү",
    "60 hunii bagt 2 sariin ehnees tusgai marshrut hiij ugch boloh uu",
    "Багаараа 50 хүн, 2 сарын эхээр өөрсдийн хөтөлбөртэй явна",
  ]));

// 6. Praise and thanks after a trip
const op6 = scenario(["owner", "need", "social", "nonmodel"], {
  id: "OP-6", title: "'the trip was great, thank you'", model: M.friendly(),
  turns: [{ text: "Аялал маш сайхан боллоо. Баярлалаа.", expect: X.social }],
});
add(op6, underModel(op6, "down", M.down, ["outage"]), underModel(op6, "mislabel", M.friendly(M.mislabel)),
  ...paraphrases(op6, ["Аялал үнэхээр гоё байлаа, баярлалаа", "ayal ih saihan bolloo bayarlalaa", "Сайхан аялсан. Танд баярлалаа 🙏", "Манай гэр бүл их сэтгэл хангалуун байлаа, баярлалаа"]));

// 7. "Not the previous trip, the sea one"
const op7 = scenario(["owner", "trip", "context", "answerable"], {
  id: "OP-7", title: "not the previous trip, the other one, the one with the sea",
  turns: [
    { text: "Вэлмор далайн эргийн аялал", setup: true, model: M.trip("sea-a", ["price"]) },
    { text: "Норвел хотын аялал", setup: true, model: M.trip("norvel", ["price"]) },
    { text: "Өмнөх аяллынх биш, нөгөө далайтай аяллын үнэ.", model: M.trip("sea-a", ["price"]),
      expect: { mustAnswer: true, mustMentionTripIds: ["sea-a"], mustNotMentionTripIds: ["norvel"], mustMatch: [/1,391,000₮/] } },
  ],
});
add(op7, ...paraphrases(op7, ["Өмнөх аялал биш, далайн аяллын үнийг хэлээч", "Нөгөө далайн аялал нь хэд вэ", "Норвел ни биш, далайтай аяллын үнэ", "Эхний аяллынх чинь үнийг хэлээч"]));

// 8. Not the first city, directly the second
const op8 = scenario(["owner", "trip", "context", "multi"], {
  id: "OP-8", title: "not Вердан, directly Зорган (a 4-stop package is the only Зорган trip)",
  turns: [
    { text: "Вердан хотын 11-р сарын аялал", setup: true, model: M.trip("verdan-nov", ["price"]) },
    { text: "Бид Вердан биш Зорган руу шууд явмаар байна.", model: M.trip("zorgan-pkg", ["price"]),
      expect: { allowSilence: true, leadIfSilent: true, mustNotMentionTripIds: ["verdan-nov", "verdan-dec", "verdan-q1", "zorent-sold", "zorent-combo"],
        ifReplyMustMatch: [/ШЭНЗАР – ХОНГСАН – ЗОРГАН – МАКОР/] } },
  ],
});
add(op8, ...paraphrases(op8, ["Вердан хэрэггүй, Зорган руу шууд явна", "verdan bish zorgan ruu shuud yavmaar bn", "Зорган руу шууд нислэгтэй аялал байна уу, Вердан биш"]));

// 9. The weather of the PREVIOUS trip
const op9 = scenario(["owner", "trip", "context", "weather"], {
  id: "OP-9", title: "what is the weather of the previous trip", weather: "ok",
  turns: [
    { text: "Вэлмор далайн эргийн аялал", setup: true, model: M.trip("sea-a", ["price"]) },
    { text: "Норвел хотын аялал", setup: true, model: M.trip("norvel", ["price"]) },
    { text: "Өмнөх аяллынх чинь цаг агаар ямар байна?", model: M.trip("sea-a", ["weather"]),
      expect: { allowSilence: true, leadIfSilent: true, mustNotMatch: [/norvel/, RE.tripList], ifReplyMustMatch: [/sea-a/] } },
  ],
});
add(op9, ...paraphrases(op9, ["Өмнөх аяллын цаг агаар ямар вэ", "Анхны аяллын цаг агаар ямар байна", "omnoh ayliin tsag agaar yamar bn"]));

// 10. Leaves on 30 December, returns after the new year begins
const op10 = scenario(["owner", "date", "holiday", "multi", "answerable"], {
  id: "OP-10", title: "start on 30 December and come back after the new year",
  model: M.topics(["dates"], { intent: "trip", certainty: "none", date: "2026-12-30" }),
  turns: [{ text: "Аяллыг 12 сарын 30-нд эхлээд шинэ он гарсны дараа буцахаар байна уу?",
    expect: { mustAnswer: true, anyOf: [/12 сарын 30|12\/30/], datesWithin: WINDOW.newYear, noOutage: true } }],
});
add(op10, ...paraphrases(op10, [
  "12 сарын 30-нд гараад шинэ жилийн дараа ирэх аялал байна уу",
  "12/30-нд явж 1 сарын эхээр буцдаг аялал байна уу",
  "Шинэ оныг гадаадад угтаад буцах аялал 12 сарын 30-нд гарах уу",
]));
