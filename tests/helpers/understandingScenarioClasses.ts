import { WINDOW, paraphrases } from "./understandingScenarioKit";
import { M, RE, X, scenario, type Expect, type Model, type Scenario } from "./understandingScenarioTypes";

/**
 * Need classes beyond the 17 conversations: positive controls (ordinary questions that MUST be
 * answered, so over-caution is measured too), staff takeover for every class, the provider
 * being down, unsupported business policies, services the agency does not sell, an existing
 * booking, missing external data, context carried across turns, and several constraints at once.
 */
export const CLASS_SCENARIOS: Scenario[] = [];
const add = (...items: Scenario[]) => { CLASS_SCENARIOS.push(...items); };

// ======================================================================= positive controls
const answer = (...mustMatch: RegExp[]): Expect => ({ mustAnswer: true, mustMatch, noClarification: true, noOutage: true });
const pos = (id: string, title: string, text: string, model: Model, expect: Expect, extra: Partial<Scenario> = {}, tags: string[] = []): Scenario =>
  scenario(["positive", "answerable", ...tags], { id, title, model, turns: [{ text, expect }], ...extra });

add(
  pos("POS-01", "price of a named trip", "Норвел хотын аялал үнэ хэд вэ", M.trip("norvel", ["price"]), answer(/1,791,000₮/), {}, ["trip"]),
  pos("POS-02", "child fare of a named trip", "Норвел хүүхдийн үнэ", M.trip("norvel", ["price"]), answer(/1,591,000₮/), {}, ["trip"]),
  pos("POS-03", "infant fare of a named trip", "Норвел нярайн үнэ", M.trip("norvel", ["price"]), answer(/381,000₮/), {}, ["trip"]),
  pos("POS-04", "departure dates of a named trip", "Норвел хэзээ гарах вэ", M.trip("norvel", ["dates"]), { ...answer(), anyOf: [/11 сарын 22|11\/22/] }, {}, ["trip", "date"]),
  pos("POS-05", "programme of a named trip", "Норвел аяллын хөтөлбөр", M.trip("norvel", ["program"]), { ...answer(), anyOf: [/Өдөр \d|\d-р өдөр/i, /Улаанбаатар – Норвел/] }, {}, ["trip"]),
  pos("POS-06", "hotel of a named trip", "Норвел зочид буудал ямар вэ", M.trip("norvel", ["hotel"]), answer(/Норвел Плаза Хотел/), {}, ["trip"]),
  pos("POS-07", "duration of a named trip", "Норвел хэдэн өдөр вэ", M.trip("norvel", ["duration"]), answer(/6 өдөр 5 шөнө/), {}, ["trip"]),
  pos("POS-08", "what a named trip includes", "Норвел аялалд юу багтсан бэ", M.trip("norvel", ["includes"]), answer(/Нислэгийн тийз/), {}, ["trip"]),
  pos("POS-09", "weather of the selected trip", "Норвел цаг агаар ямар байна", M.trip("norvel", ["weather"]), answer(/Очих хотуудад одоогоор/, /norvel/), { weather: "ok" }, ["trip", "weather"]),
  pos("POS-10", "booking interest in a named trip", "Норвел аялалд захиалга өгье", M.trip("norvel", ["booking_terms"]), answer(/Утасны дугаар/), {}, ["trip"]),
  pos("POS-11", "sea trips", "Далайн аялал байна уу", M.catalog, { mustAnswer: true, mustMentionTripIds: ["sea-a"], noOutage: true }, {}, ["need"]),
  pos("POS-12", "land trips", "Газрын аялал байна уу", M.catalog, { mustAnswer: true, anyOf: [/ЭРДЭН|ЖОРВИН|ПЕКАРА - ЖИРОН/], noOutage: true }, {}, ["need"]),
  pos("POS-13", "direct-flight trips", "Шууд нислэгтэй аялал байна уу", M.catalog, { mustAnswer: true, anyOf: [/ТАРВИЯ|НОРВЕЛ|ПЕКАРА|САНВИЯ/], noOutage: true }, {}, ["need"]),
  pos("POS-14", "trips in a named month", "11 сард ямар аялал байна", M.topics(["dates"], { intent: "catalog", month: 11 }), { mustAnswer: true, datesWithin: ["2026-11-06", "2026-11-30"], noOutage: true }, {}, ["date"]),
  pos("POS-15", "trips on an exact date", "12 сарын 30-нд гарах аялал байна уу", M.topics(["dates"], { date: "2026-12-30" }), { mustAnswer: true, anyOf: [/ПЕКАРА - ЛУНАРИА|САНВИЯ|ДОРМАН/], noOutage: true }, {}, ["date"]),
  pos("POS-16", "total for a stated party", "Норвел 2 том 1 хүүхэд хэд вэ", M.trip("norvel", ["price"], { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }), answer(/5,173,000₮/), {}, ["trip", "multi"]),
  pos("POS-17", "a landmark trip by its landmark", "Лунариа парк орох аялал", M.trip("pekara-park", ["price"]), answer(/ПЕКАРА - ЛУНАРИА/), {}, ["trip"]),
  pos("POS-18", "a named trip with a number in its title", "Жирон 4 хотын аялал үнэ", M.trip("pekara-4", ["price"]), answer(/1,690,000₮/), {}, ["trip"]),
  pos("POS-19", "the New Year trip by name", "Санвия шинэ жилийн аялал үнэ", M.trip("sanvia-ny", ["price"]), answer(/4,290,000₮/), {}, ["trip", "holiday"]),
  pos("POS-20", "price in Latin letters", "norvel hotiin ayal une hed ve", M.trip("norvel", ["price"]), answer(/1,791,000₮/), {}, ["trip", "paraphrase"]),
  pos("POS-21", "dates in Latin letters", "norvel hezee garah ve", M.trip("norvel", ["dates"]), { ...answer(), anyOf: [/11 сарын 22|11\/22/] }, {}, ["trip", "date", "paraphrase"]),
  pos("POS-22", "child fare of one of three sibling packages", "Тарвия лумар велна аялал хүүхдийн үнэ", M.trip("tarvia-a", ["price"]), answer(/4,790,000₮/), {}, ["trip"]),
  pos("POS-23", "a greeting", "Сайн байна уу", M.smalltalk, { mustAnswer: true, mustMatch: [/Ямар аялал сонирхож байна/], noModelCalls: true }, {}, ["need"]),
  pos("POS-24", "seats on a named date", "Норвел 11 сарын 22-нд суудал байна уу", M.trip("norvel", ["availability"], { date: "2026-11-22" }), { ...answer(), anyOf: [/суудал|нээлттэй/i] }, {}, ["trip", "date"]),
  pos("POS-25", "the family of a country", "Тарвия аялал", M.trip("tarvia-a", ["price"], { certainty: "several" }), { mustAnswer: true, mustMatch: [/ТАРВИЯ/], noOutage: true }, {}, ["trip"]),
  pos("POS-26", "programme of a sea trip", "Вэлмор далайн аяллын хөтөлбөр", M.trip("sea-a", ["program"]), { ...answer(), anyOf: [/Өдөр \d|\d-р өдөр/i, /Улаанбаатар – Вэлмор/] }, {}, ["trip"]),
  pos("POS-27", "the holiday with a place that has a departure then", "Цагаан сараар Тарвия явмаар байна", M.topics(["dates"], { place: "Тарвия", certainty: "several" }),
    { mustAnswer: true, mustMatch: [/ТАРВИЯ/], datesWithin: WINDOW.tsagaanSar, noOutage: true }, {}, ["date", "holiday", "trip"]),
  pos("POS-28", "the New Year with a place that has a departure then", "Шинэ жилээр Санвия явмаар байна", M.topics(["dates"], { place: "Санвия", certainty: "several" }),
    { mustAnswer: true, mustMatch: [/САНВИЯ/], noOutage: true }, {}, ["date", "holiday", "trip"]),
  pos("POS-29", "weather when no trip is named", "цаг агаар ямар байна", M.topics(["weather"]), { mustAnswer: true, mustMatch: [/Аль аяллын цаг агаар/], noOutage: true }, {}, ["need", "weather"]),
  scenario(["positive", "answerable", "context", "trip"], {
    id: "POS-30", title: "a numbered pick from a list of trips gives that trip's card",
    turns: [
      { text: "Лумор Саривана аялал сонирхож байна", setup: true, model: { intent: "trip", certainty: "several", topics: [] } },
      { text: "1", model: M.none, expect: { mustAnswer: true, mustMatch: [RE.fareLine], noOutage: true } },
    ],
  }),
);

// ======================================================================= staff takeover, every class
const takeoverClasses: Array<{ key: string; text: string; model: Model; weather?: "ok" }> = [
  { key: "holiday-place", text: "Цагаан сараар Пекара явмаар байна", model: M.topics(["dates"], { place: "Пекара" }) },
  { key: "corporate", text: "Манай 35 ажилтныг шинэ жилээр дулаан орон руу явуулах гэсэн юм.", model: M.none },
  { key: "policy", text: "Бартер авдаг уу", model: M.none },
  { key: "weather", text: "Норвел цаг агаар ямар байна", model: M.trip("norvel", ["weather"]), weather: "ok" },
  { key: "thanks", text: "Аялал маш сайхан боллоо. Баярлалаа.", model: M.smalltalk },
  { key: "price", text: "Норвел хотын аялал үнэ хэд вэ", model: M.trip("norvel", ["price"]) },
  { key: "dates", text: "Норвел хэзээ гарах вэ", model: M.trip("norvel", ["dates"]) },
  { key: "programme", text: "Норвел аяллын хөтөлбөр", model: M.trip("norvel", ["program"]) },
  { key: "hotel", text: "Норвел зочид буудал ямар вэ", model: M.trip("norvel", ["hotel"]) },
  { key: "booking", text: "Норвел аялалд захиалга өгье", model: M.trip("norvel", ["booking_terms"]) },
  { key: "service", text: "Хорвата Нелмараас Улаанбаатар орох хүн авах боломж байдаг уу", model: M.none },
  { key: "sold-out", text: "вердан зорентын хаалга аялал үнэ болон хөтөлбөр авья", model: M.trip("zorent-sold", ["price", "program"]) },
  { key: "correction", text: "Өмнөх аяллынх биш, нөгөө далайтай аяллын үнэ.", model: M.trip("sea-a", ["price"]) },
  { key: "latin", text: "norvel hotiin ayal une hed ve", model: M.trip("norvel", ["price"]) },
  { key: "bare-price", text: "860000 geed bga yum", model: M.topics(["price"]) },
  { key: "greeting", text: "Сайн байна уу", model: M.smalltalk },
  { key: "provider-down", text: "Норвел хотын аялал үнэ хэд вэ", model: M.down },
  { key: "custom-quote", text: "4 хүн нислэг, зочид буудал, унаа л авъя. хөтөлбөр хэрэггүй, үнийн санал өгөөч", model: M.topics(["price"]) },
];
for (const entry of takeoverClasses) {
  add(
    scenario(["takeover", "need"], { id: `OWN-${entry.key}.paused`, title: `staff paused the chat, then: ${entry.key}`, weather: entry.weather, before: { pause: true }, model: entry.model, turns: [{ text: entry.text }] }),
    scenario(["takeover", "need"], { id: `OWN-${entry.key}.consultant`, title: `a consultant wrote 2 minutes ago, then: ${entry.key}`, weather: entry.weather, before: { consultantAgoMs: 120_000 }, model: entry.model, turns: [{ text: entry.text }] }),
  );
}
add(
  scenario(["takeover", "context", "need"], {
    id: "OWN-mid-conversation", title: "the bot answers, a consultant steps in, three more messages stay with staff, staff hand back, the bot answers again",
    model: M.trip("norvel", ["price"]),
    turns: [
      { text: "Норвел хотын аялал үнэ хэд вэ", expect: { mustAnswer: true, mustMatch: [/1,791,000₮/] } },
      { text: "Хүүхдийн үнэ хэд вэ", before: { consultantAgoMs: 90_000 } },
      { text: "Баярлалаа", model: M.smalltalk },
      { text: "Бартер авдаг уу", model: M.none },
      { text: "Норвел нярайн үнэ", before: { resume: true }, expect: { mustAnswer: true, mustMatch: [/381,000₮/] } },
    ],
  }),
  scenario(["takeover", "context", "need"], {
    id: "OWN-consultant-after-bot-reply", title: "the bot answered once, then a consultant is in the thread when the next message arrives",
    model: M.trip("norvel", ["price"]),
    turns: [
      { text: "Норвел хотын аялал үнэ хэд вэ", expect: { mustAnswer: true } },
      { text: "Тарвия лумар велна аялал хүүхдийн үнэ", before: { consultantAgoMs: 60_000 }, model: M.trip("tarvia-a", ["price"]) },
    ],
  }),
);

// ======================================================================= the provider is down
const down = (id: string, title: string, text: string, expect: Expect, tags: string[], extra: Partial<Scenario> = {}): Scenario =>
  scenario(["outage", ...tags], { id, title, model: M.down, turns: [{ text, expect }], ...extra });
add(
  down("OUT-01", "price of a named trip is answered from the catalogue", "Норвел хотын аялал үнэ хэд вэ", answer(/1,791,000₮/), ["positive", "answerable", "trip"]),
  down("OUT-02", "dates of a named trip", "Норвел хэзээ гарах вэ", { ...answer(), anyOf: [/11 сарын 22|11\/22/] }, ["positive", "answerable", "trip", "date"]),
  down("OUT-03", "programme of a named trip", "Норвел аяллын хөтөлбөр", { ...answer(), anyOf: [/Өдөр \d|\d-р өдөр/i, /Улаанбаатар – Норвел/] }, ["positive", "answerable", "trip"]),
  down("OUT-04", "weather of a named trip", "Норвел цаг агаар ямар байна", answer(/Очих хотуудад одоогоор/), ["positive", "answerable", "trip", "weather"], { weather: "ok" }),
  down("OUT-05", "sea trips", "Далайн аялал байна уу", { mustAnswer: true, mustMentionTripIds: ["sea-a"], noOutage: true }, ["positive", "answerable", "need"]),
  down("OUT-06", "the holiday with a place", "Цагаан сараар Тарвия явмаар байна", { mustAnswer: true, mustMatch: [/ТАРВИЯ/], noOutage: true }, ["positive", "answerable", "date", "holiday"]),
  down("OUT-07", "a greeting", "Сайн байна уу", { mustAnswer: true, noOutage: true }, ["positive", "answerable", "need"]),
  down("OUT-08", "a bare thank-you", "Баярлалаа", X.social, ["need", "social", "nonmodel"]),
  down("OUT-09", "instalments", "Хэсэгчлэн төлж болох уу", X.business, ["need", "policy", "nonmodel"]),
  down("OUT-10", "a bare advertised price", "860000 geed bga yum", { mustAnswer: true, mustMentionTripIds: ["jorvin"], noOutage: true }, ["positive", "answerable", "trip"]),
  down("OUT-11", "a ticket-only wish", "Тарвия руу онгоцны тийз л авъя аялал биш", X.service, ["need", "service", "nonmodel"]),
  down("OUT-12", "a complaint", "Норвел аялалд явсан чинь хоол муу байсан гомдолтой байна", { allowSilence: true, leadIfSilent: true, noTripContent: true, noOutage: true }, ["need", "service", "nonmodel"]),
  down("OUT-13", "an existing booking", "Захиалга маань юу болсон бэ?", { allowSilence: true, leadIfSilent: true, mustNotMatch: [/Утасны дугаараа/], noOutage: true }, ["need", "existing", "nonmodel"]),
  down("OUT-14", "a farewell", "Баяртай, сайхан амраарай", X.social, ["need", "social", "nonmodel"]),
);

// ======================================================================= unsupported business policies
const policy = scenario(["need", "policy", "corporate", "nonmodel"], {
  id: "POL-01", title: "instalments", model: M.none, turns: [{ text: "Хэсэгчлэн төлж болох уу", expect: X.business }],
});
add(
  policy,
  ...[
    "Картаар төлж болох уу",
    "Манай бүтээгдэхүүнээр солилцож аялж болох уу",
    "Манай компани гэрээ байгуулж аялуулах боломжтой юу",
    "Нэхэмжлэх гаргаж өгөх үү",
    "Гэр бүл, хамт олны аяллын үнэ сонирхоё",
    "hymdral bga yu",
    "uramshuulal bga uu",
  ].map((text, index) => ({ ...policy, id: `POL-0${index + 2}`, title: `policy question: ${text}`, turns: [{ text, expect: X.business }] })),
  { ...policy, id: "POL-09", title: "cancellation refund is not a booking request", turns: [{ text: "Захиалгаа цуцлах бол мөнгө буцаан авч болох уу", expect: { ...X.business, mustNotMatch: [/Утасны дугаараа/] } }] },
  { ...policy, id: "POL-10", title: "a model that invents instalments with a percentage", model: M.invents("Тийм, хэсэгчлэн төлөх боломжтой. Урьдчилгаа 30% төлнө."), turns: [{ text: "Хэсэгчлэн төлж болох уу", expect: X.business }] },
  { ...policy, id: "POL-11", title: "a model that invents a seasonal discount", model: M.invents("Тийм, өвлийн улиралд 15% хөнгөлөлт байдаг."), turns: [{ text: "Хөнгөлөлт байдаг уу", expect: X.business }] },
  { ...policy, id: "POL-12", title: "a model that invents a loyalty bonus", model: M.invents("Тийм, байнгын үйлчлүүлэгчдэд тусгай урамшуулал олгодог."), turns: [{ text: "Байнгын үйлчлүүлэгчийн урамшуулал байдаг уу", expect: X.business }] },
);

// ======================================================================= services the agency does not sell
const service = (id: string, text: string, expect: Expect = X.service, model: Model = M.none): Scenario =>
  scenario(["need", "service", "nonmodel"], { id, title: `not a trip question: ${text}`, model, turns: [{ text, expect }] });
add(
  service("SVC-01", "Тарвия руу онгоцны тийз л авъя аялал биш", X.service, M.topics(["price"], { certainty: "one", tripId: "tarvia-a" })),
  service("SVC-02", "Тарвия лумарт зөвхөн зочид буудал захиалах уу"),
  service("SVC-03", "Норвел аялалд явсан чинь хоол муу байсан гомдолтой байна", { allowSilence: true, leadIfSilent: true, noTripContent: true, noOutage: true }, M.trip("norvel", ["price"])),
  service("SVC-04", "Тарвия виз хэрэгтэй юу"),
  service("SVC-05", "Нисэх буудлаас буудал хүртэл унаа захиалах уу"),
  service("SVC-06", "Хорвата хилээс Улаанбаатар хүртэл автобусаар хүргэж өгөх үү"),
  service("SVC-07", "Тарвия руу тийз тусад нь авч болох уу", X.service, M.topics(["price"], { certainty: "one", tripId: "tarvia-a" })),
);

// ======================================================================= an existing booking
const existing = (id: string, text: string, expect: Expect): Scenario => scenario(["need", "existing", "nonmodel"], { id, title: `existing booking: ${text}`, model: M.none, turns: [{ text, expect }] });
const noPhoneAsk: Expect = { allowSilence: true, leadIfSilent: true, mustNotMatch: [/Утасны дугаараа бичнэ үү/], noTripContent: true, noOutage: true };
add(
  existing("EXB-01", "Захиалга маань юу болсон бэ?", noPhoneAsk),
  existing("EXB-02", "Би захиалга өгсөн, төлбөр төлсөн, баталгаажсан уу", noPhoneAsk),
  existing("EXB-03", "Төлбөрөө төллөө шалгаад өгөөч", { ...noPhoneAsk, lead: {} }),
  existing("EXB-04", "Миний захиалсан аялал хэзээ гарах вэ", noPhoneAsk),
  existing("EXB-05", "zahialgaa tsutslah uu", noPhoneAsk),
);

// ======================================================================= missing external data
add(
  scenario(["need", "external", "weather", "trip"], { id: "EXT-01", title: "weather service down for the selected trip: no invented weather", weather: "down", model: M.trip("norvel", ["weather"]),
    turns: [{ text: "Норвел цаг агаар ямар байна", expect: { ...X.service, mustNotMatch: [/\d+\s*°|хэм/, RE.tripList] } }] }),
  scenario(["need", "external", "weather"], { id: "EXT-02", title: "weather of a place no trip visits", weather: "ok", model: M.topics(["weather"], { place: "Нельмара" }),
    turns: [{ text: "Нельмара хотод цаг агаар ямар байна", expect: { allowSilence: true, leadIfSilent: true, mustNotMatch: [/Очих хотуудад одоогоор/, RE.tripList] } }] }),
  scenario(["need", "external", "weather", "trip"], { id: "EXT-03", title: "weather service down, asked in Latin letters", weather: "down", model: M.trip("norvel", ["weather"]),
    turns: [{ text: "norvel tsag agaar yamar bn", expect: { ...X.service, mustNotMatch: [/\d+\s*°|хэм/, RE.tripList] } }] }),
  scenario(["need", "external", "weather", "trip"], { id: "EXT-04", title: "weather service down while the provider is down too", weather: "down", model: M.down,
    turns: [{ text: "Норвел цаг агаар ямар байна", expect: { ...X.service, mustNotMatch: [/\d+\s*°|хэм/, RE.tripList] } }] }),
  scenario(["need", "external", "weather", "trip", "positive", "answerable"], { id: "EXT-05", title: "weather service up: asked as clothing advice", weather: "ok", model: M.trip("norvel", ["weather"]),
    turns: [{ text: "Норвел аялалд ямар хувцас авах вэ", expect: answer(/Очих хотуудад одоогоор/) }] }),
);

// ======================================================================= context carried across turns
add(
  scenario(["context", "positive", "answerable", "multi"], { id: "CTX-01", title: "price, then a party: the total for that trip",
    turns: [
      { text: "Норвел хотын аялал үнэ", model: M.trip("norvel", ["price"]), expect: answer(/1,791,000₮/) },
      { text: "2 том 1 хүүхэд", model: M.trip("norvel", ["price"], { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }), expect: answer(/5,173,000₮/) },
    ] }),
  scenario(["context", "positive", "answerable", "multi", "date"], { id: "CTX-02", title: "trip, dates, a date, then a party: everything accumulates",
    turns: [
      { text: "Норвел", setup: true, model: M.trip("norvel", ["price"]) },
      { text: "хэзээ гарах вэ", model: M.trip("norvel", ["dates"]), expect: { ...answer(), anyOf: [/11 сарын 22|11\/22/] } },
      { text: "11 сарын 22", model: M.trip("norvel", ["availability"], { date: "2026-11-22" }), expect: { ...answer(), anyOf: [/суудал|нээлттэй/i] } },
      { text: "2 хүн", model: M.trip("norvel", ["price"], { passengers: [{ kind: "adult", count: 2 }] }), expect: answer(/1,791,000₮|3,582,000₮/) },
    ] }),
  scenario(["context", "trip"], { id: "CTX-03", title: "correction of the trip: 'no, the other country'",
    turns: [
      { text: "Норвел хотын аялал үнэ", setup: true, model: M.trip("norvel", ["price"]) },
      { text: "үгүй Тарвиягийн Лумар Велна аяллын үнэ", model: M.trip("tarvia-a", ["price"]), expect: { mustAnswer: true, mustMentionTripIds: ["tarvia-a"], mustNotMentionTripIds: ["norvel"], selectionAfter: "tarvia-a" } },
    ] }),
  scenario(["context", "date"], { id: "CTX-04", title: "correction of the date",
    turns: [
      { text: "Тарвия Лумар Велна 2 сарын 6", model: M.trip("tarvia-a", ["availability"], { date: "2027-02-06" }), expect: { mustAnswer: true, mustMatch: [/2 сарын 6|2\/6/] } },
      { text: "үгүй 2 сарын 13", model: M.trip("tarvia-a", ["availability"], { date: "2027-02-13" }), expect: { mustAnswer: true, mustMatch: [/2 сарын 13|2\/13/], mustNotMatch: [/2 сарын 6\b/] } },
    ] }),
  scenario(["context", "multi", "answerable"], { id: "CTX-05", title: "a party told before any trip is named is still applied when the trip comes",
    turns: [
      { text: "2 том 2 хүүхэдтэй явна", setup: true, model: M.topics(["price"], { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 2 }] }) },
      { text: "Норвел", model: M.trip("norvel", ["price"], { passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 2 }] }), expect: answer(/6,764,000₮/) },
    ] }),
  scenario(["context", "positive", "answerable"], { id: "CTX-06", title: "the trip on screen stays the subject of a bare fare question",
    turns: [
      { text: "Норвел", setup: true, model: M.trip("norvel", ["price"]) },
      { text: "хүүхдийн үнэ", model: M.trip("norvel", ["price"]), expect: answer(/1,591,000₮/) },
    ] }),
);

// ======================================================================= several constraints at once
const multi = scenario(["multi", "date", "holiday", "trip"], {
  id: "MC-01", title: "destination + holiday + party", model: M.topics(["dates", "price"], { place: "Тарвия", certainty: "several", passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 2 }] }),
  turns: [{ text: "Цагаан сараар Тарвия 2 том 2 хүүхэдтэй явмаар байна",
    expect: { mustAnswer: true, mustMatch: [/ТАРВИЯ/, /Цагаан сарын үеэр/], datesWithin: WINDOW.tsagaanSar, anyOf: [/Нийт|19,760,000₮|4,790,000₮/], noOutage: true } }],
});
add(multi, ...paraphrases(multi, [
  "tsagaan sarar tarvia 2 om 2 huuhedtei yavmaar bna",
  "Цагаан сарын амралтаар Тарвия руу 2 хүн, 2 хүүхэдтэй явья",
  "Тарвиягийн цагаан сарын аялал, том хүн 2, хүүхэд 2",
]));
add(
  scenario(["multi", "date", "holiday", "trip"], { id: "MC-06", title: "New Year + destination that has a departure then: the list is about New Year, not about early December", model: M.topics(["dates"], { place: "Санвия", certainty: "several" }),
    turns: [{ text: "Шинэ жилээр Санвия явмаар байна", expect: { mustAnswer: true, mustMatch: [/САНВИЯ/], datesWithin: WINDOW.newYear, noOutage: true } }] }),
  scenario(["multi", "date", "trip"], { id: "MC-02", title: "destination + month + party", model: M.topics(["dates"], { place: "Тарвия", certainty: "several", month: 2, passengers: [{ kind: "adult", count: 4 }] }),
    turns: [{ text: "2 сард Тарвия 4 хүн явна", expect: { mustAnswer: true, mustMatch: [/ТАРВИЯ/], datesWithin: ["2027-02-01", "2027-02-28"], noOutage: true } }] }),
  scenario(["multi", "date", "trip"], { id: "MC-03", title: "destination + exact date + party", model: M.topics(["price"], { place: "Пекара", certainty: "several", date: "2026-12-30", passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }),
    turns: [{ text: "12 сарын 30-нд Пекара 2 том 1 хүүхэд", expect: { mustAnswer: true, anyOf: [/12 сарын 30|12\/30/], mustMatch: [/ПЕКАРА/], noOutage: true } }] }),
  scenario(["multi", "date", "holiday", "trip"], { id: "MC-04", title: "holiday + destination that has no departure then + party", model: M.topics(["dates", "price"], { place: "Пекара", certainty: "several", passengers: [{ kind: "adult", count: 2 }, { kind: "child", count: 1 }] }),
    turns: [{ text: "Цагаан сараар Пекара 2 том 1 хүүхэдтэй явмаар байна", expect: { mustAnswer: true, mustMatch: [/Цагаан сар/], datesWithin: WINDOW.february, noOutage: true } }] }),
  scenario(["multi", "trip"], { id: "MC-05", title: "kind of trip + month + budget words", model: M.topics(["dates", "budget"], { intent: "catalog", month: 12, transport: "land" }),
    turns: [{ text: "12 сард газраар явах хямд аялал байна уу", expect: { mustAnswer: true, anyOf: [/ЖОРВИН|ЭРДЭН|ПЕКАРА - ЖИРОН/], noOutage: true } }] }),
);

// ======================================================================= more social wording
const social = (id: string, text: string, model: Model = M.friendly()): Scenario => scenario(["need", "social", "nonmodel"], { id, title: `social: ${text}`, model, turns: [{ text, expect: X.social }] });
add(
  social("SOC-01", "Баяртай"),
  social("SOC-02", "Сайхан амраарай"),
  social("SOC-03", "Ойлголоо баярлалаа"),
  social("SOC-04", "За ойлголоо бодоод үзье"),
  social("SOC-05", "Mednee bayarlalaa", M.friendly(M.mislabel)),
  scenario(["need", "social", "nonmodel", "context"], { id: "SOC-06", title: "thanks right after a price card",
    turns: [
      { text: "Норвел хотын аялал үнэ хэд вэ", setup: true, model: M.trip("norvel", ["price"]) },
      { text: "За баярлалаа", model: M.friendly(), expect: X.social },
    ] }),
  scenario(["need", "social", "nonmodel", "context"], { id: "SOC-07", title: "an acknowledgement after a price card",
    turns: [
      { text: "Норвел хотын аялал үнэ хэд вэ", setup: true, model: M.trip("norvel", ["price"]) },
      { text: "ок", model: M.friendly(), expect: X.social },
    ] }),
);
