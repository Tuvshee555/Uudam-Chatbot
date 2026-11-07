import assert from "node:assert/strict";
import test from "node:test";
import { GENERIC_OPENERS, isKnownGreetingPhrase, isThanksOnly } from "../src/lib/greetingPhrases";
import { buildGroupSizeReply, hasDiscountIntent } from "../src/lib/travelFastPaths";
import { guardInventedCommercialClaims, GROUP_INQUIRY_REPLY } from "../src/lib/reply";
import { commercialFactsText } from "../src/lib/commercialFacts";
import type { NeedDispatchInput } from "../src/lib/needDispatch";
import { applyTestEnv } from "./helpers/env";
import { classifyMessageNeed, commercialSignalCovered } from "../src/lib/messageNeed";
import { joinContextAndTurn } from "../src/lib/customerTurn";
import type { TravelTrip } from "../src/lib/travelTypes";

/**
 * The precision fixes around the need gate, one function at a time (invented trips only):
 * booking intent refuses questions ABOUT a booking, acknowledgements are not greetings, a commercial claim
 * the data does not hold is never stated, a group head count never implies a discount, and the dispatcher
 * promises "passed to the consultant" only when the lead was really saved.
 */
// needDispatch reaches the database layer, which reads the server environment when it is first imported. The
// full suite (scripts/run-tests.mjs) sets none, so the environment is applied first and the module loaded lazily.
const withEnv = () => applyTestEnv({});
const needDispatchModule = async () => { withEnv(); return import("../src/lib/needDispatch"); };
const webhookMediaModule = async () => { withEnv(); return import("../src/lib/webhookMedia"); };
const conversationModule = async () => { withEnv(); return import("../src/lib/conversation"); };
const dispatchNeed = async (input: NeedDispatchInput) => (await needDispatchModule()).dispatchNeed(input);
const catalogPlaceWordsIn = async (text: string, trips: TravelTrip[]) => (await needDispatchModule()).catalogPlaceWordsIn(text, trips);

const aTrip = (fields: Record<string, unknown> = {}) => ({
  id: "t1", route_name: "ДОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Fixture agency", category: "Аялал", adult_price: 1_791_000, child_price: 1_591_000,
  infant_price: 381_000, currency: "MNT", status: "active", duration_text: "6 өдөр 5 шөнө", departure_dates: ["2098-03-15"], seats_total: 20, seats_left: 10,
  has_food: null, hotel: "", photo_urls: [], notes: "", source_description: "", extra: { customer_visible: true, aliases: ["Дорвел"] }, ...fields,
} as unknown as TravelTrip);

test("a booking word inside a question ABOUT a booking is not a booking request", async () => {
  const { isBookingIntent, isQuestionAboutBooking } = await webhookMediaModule();
  for (const text of [
    "захиалгаа цуцлах боломжтой юу", "Захиалгаа цуцалбал мөнгө буцаан авч болох уу", "миний захиалга баталгаажсан уу",
    "төлбөрөө хийсэн захиалга баталгаажсан уу", "захиалгаа өөрчилж болох уу", "захиалбал урьдчилгаа хэд вэ", "урьдчилгаа яаж захиалга өгдөг вэ",
    "zahialgaa cuclah bolomjtoi yu", "minii zahialga batalgaajsan uu", "zahialahad uridchilgaa ymar ve",
  ]) {
    assert.equal(isBookingIntent(text), false, text);
    assert.ok(isQuestionAboutBooking(text), text);
  }
  // Positive controls: a real request to book still starts the collector.
  for (const text of ["Захиалъя", "Норвел аяллыг захиалъя", "захиалга өгье", "захиалмаар байна", "burtguulye", "book", "бүртгүүлье"]) {
    assert.equal(isBookingIntent(text), true, text);
  }
});

test("an acknowledgement is not a greeting; real greetings and Latin thanks keep their paths", () => {
  for (const word of ["ok", "ок", "хэрхэн", "та нар"]) assert.ok(!GENERIC_OPENERS.includes(word), `${word} left GENERIC_OPENERS`);
  for (const text of ["ok", "ок", "Ok", "okay"]) assert.equal(isKnownGreetingPhrase(text), false, text);
  for (const text of ["сайн уу", "Сайн байна уу", "hi", "hello", "мэнд"]) assert.equal(isKnownGreetingPhrase(text), true, text);
  for (const text of ["bayarlalaa", "Bayarlalaa", "bayarlaa", "bayarla", "baiarlalaa", "thanks", "Баярлалаа", "bayrlalaa"]) assert.equal(isThanksOnly(text), true, text);
  // A thanks word with a real question is not "thanks only".
  for (const text of ["bayarlalaa une hed ve", "Баярлалаа, хөтөлбөр илгээнэ үү"]) assert.equal(isThanksOnly(text), false, text);
});

test("discount intent reads Latin spellings and no longer treats a bespoke route as a discount question", () => {
  for (const text of ["хямдрал байна уу", "hymdral baina uu", "hyamdral bdag uu", "hongololt baigaa yu", "uramshuulal", "discount", "хөнгөлөлт байгаа юу"]) {
    assert.equal(hasDiscountIntent(text), true, text);
  }
  for (const text of ["Манай 60 хүний багт 2 сарын эхээр тусгай маршрут гаргах уу?", "tusgai marshrut gargaj ugch bolh uu", "тусгай санал байна уу", "special tour for us", "Норвел үнэ хэд вэ"]) {
    assert.equal(hasDiscountIntent(text), false, text);
  }
});

test("a head count under a trip card quotes the fare and leaves the total to an advisor without hinting at a discount", () => {
  const trip = aTrip();
  const reply = buildGroupSizeReply(joinContextAndTurn("Дорвел хотын аялал", "50 хүн"), [trip]);
  assert.ok(reply, "the group-size path still answers");
  assert.match(reply!, /1,791,000₮/);
  assert.match(reply!, /50 хүний группийн нийт үнийг манай аяллын зөвлөх тооцоод хэлж өгнө/);
  assert.doesNotMatch(reply!, /хөнгөлөлт|хямдрал|discount/i);
});

test("a commercial claim the data does not hold becomes REFER; one the data holds is kept", () => {
  const nothing = commercialFactsText([aTrip()], {});
  for (const claim of [
    "Тийм. 40-45 хүнтэй группт тусгай хямдрал санал болгодог.", "Бид бартераар аялуулдаг.", "Байгууллагын гэрээгээр төлж болно.",
    "Групп үнэ 10% хямд.", "Корпорат хөнгөлөлт байдаг", "Yes, we offer a group discount for organisations.", "Нэхэмжлэх гаргаж өгнө.",
  ]) assert.equal(guardInventedCommercialClaims(claim, nothing), "REFER", claim);
  // Ordinary replies are untouched.
  for (const reply of ["Норвел хотын аялал 3 сарын 15-нд гарна.", "Том хүн: 1,791,000₮, хүүхэд: 1,591,000₮.", "Манай аяллын зөвлөх тантай холбогдоно."]) {
    assert.equal(guardInventedCommercialClaims(reply, nothing), reply, reply);
  }
  // The trip's own note, an owner-entered offer, a discount policy or an FAQ makes the claim true.
  const noted = commercialFactsText([aTrip({ notes: "10+ хүнтэй групп хямдралтай" })], {});
  assert.equal(guardInventedCommercialClaims("Тийм, 10+ хүнтэй групп хямдралтай.", noted), "Тийм, 10+ хүнтэй групп хямдралтай.");
  const offer = commercialFactsText([aTrip()], { special_offers: [{ title: "Шинэ жилийн хямдрал", description: "5% хөнгөлөлт" }] as never });
  assert.equal(guardInventedCommercialClaims("Шинэ жилийн хямдрал байна.", offer), "Шинэ жилийн хямдрал байна.");
  const policy = commercialFactsText([aTrip()], { discount_policies: [{ name: "Групп", rule: "15+ хүнд групп үнэ" }] as never });
  assert.equal(guardInventedCommercialClaims("15+ хүнд групп үнэ байна.", policy), "15+ хүнд групп үнэ байна.");
  const faq = commercialFactsText([aTrip()], { faq: [{ question: "Бартер авах уу?", answer: "Бартер авна" }] as never });
  assert.equal(guardInventedCommercialClaims("Бартер авна.", faq), "Бартер авна.");
  // An EMPTY settings list is no policy, and the heading of an empty section is no fact.
  assert.equal(guardInventedCommercialClaims("Групп хямдрал байна.", commercialFactsText([aTrip()], { discount_policies: [], special_offers: [], faq: [] })), "REFER");
  // A structured discount row on the trip is a fact even though it names no discount word of its own.
  const structured = commercialFactsText([aTrip({ extra: { customer_visible: true, discount_groups: [{ label: "A", amount: 100000 }] } })], {});
  assert.equal(guardInventedCommercialClaims("Хямдрал байна.", structured), "Хямдрал байна.");
});

test("the reply model is told to REFER when no discount text is in Context, not to answer 'Тийм'", async () => {
  const { buildPromptParts } = await conversationModule();
  const system = buildPromptParts({ systemPrompt: "Fixture assistant", business: {}, history: [], userText: "хямдрал байна уу" }).system;
  assert.match(system, /NO DISCOUNT TEXT IN CONTEXT → REFER/);
  assert.match(system, /ONLY when a discount IS written in Context/);
  assert.doesNotMatch(system, /- Discount answer format — keep it SHORT/, "the unconditional 'Тийм' format line is gone");
});

test("the group-inquiry wording says only what the company's custom-trip page says", () => {
  assert.match(GROUP_INQUIRY_REPLY, /гэр бүл, найз нөхөд, хамт олны хүссэн өдрөөр тусгай аялал зохион байгуулах/);
  assert.match(GROUP_INQUIRY_REPLY, /чиглэл, ойролцоо огноо, аялагчдын тоо/);
  assert.match(GROUP_INQUIRY_REPLY, /Захиалга нь нөхцөл тохирсны дараа баталгаажна/);
  assert.doesNotMatch(GROUP_INQUIRY_REPLY, /хямдр|хөнгөлөлт|үнэгүй|бартер|баталгаатай үнэ|\d\s*₮|урамшуул|гэрээ/i);
});

// ── the dispatcher with stubbed transports: what the customer is told depends on what was really saved ─────────────

type Delivered = { reply: string; failTag: string };
const groupHit = () => classifyMessageNeed("50-60хүнтэй байгууллага байгаа юм")!;
const stub = (overrides: Partial<NeedDispatchInput> = {}) => {
  const delivered: Delivered[] = [];
  const leads: Array<{ kind: string; context?: string }> = [];
  const input: NeedDispatchInput = {
    hit: groupHit(), source: "rule", text: "50-60хүнтэй байгууллага байгаа юм", senderId: "stub-sender", platform: "facebook", lastBotReply: null,
    trips: async () => [aTrip()],
    deliver: async (value) => { delivered.push({ reply: value.reply, failTag: value.failTag }); return true; },
    captureLead: async (value) => { leads.push(value); return { created: true, lead: null }; },
    handoff: async () => {},
    ...overrides,
  };
  return { input, delivered, leads };
};

test("dispatch: the 'passed to the consultant' sentence is sent only after the lead was saved", async () => {
  const saved = stub();
  assert.equal(await dispatchNeed(saved.input), true);
  assert.equal(saved.delivered.length, 1);
  assert.match(saved.delivered[0].reply, /дамжууллаа/);
  assert.match(saved.delivered[0].reply, /Аль чиглэлд явахыг хүсэж байна вэ\?$/);
  assert.ok(saved.leads[0].context!.startsWith("[need:business_group]"));

  // The lead could not be persisted: no promise, no hand-off sentence; only the one question remains.
  const failed = stub({ captureLead: async () => { throw new Error("db down"); } });
  assert.equal(await dispatchNeed(failed.input), true);
  assert.deepEqual(failed.delivered.map((entry) => entry.reply), ["Аль чиглэлд явахыг хүсэж байна вэ?"]);
  assert.doesNotMatch(failed.delivered[0].reply, /дамжууллаа|бэлтгэнэ|зөвлөх/);
});

test("dispatch: commercial policy and a ticket-only wish are silence plus a lead; a lost lead is not swallowed", async () => {
  for (const text of ["barter awdag u", "Калдор руу онгоцны тийз л авъя аялал биш"]) {
    const hit = classifyMessageNeed(text)!;
    const run = stub({ hit, text });
    assert.equal(await dispatchNeed(run.input), true, text);
    assert.deepEqual(run.delivered, [], `${text}: nothing is sent`);
    assert.equal(run.leads.length, 1, text);
    assert.ok(run.leads[0].context!.startsWith(`[need:${hit.need}]`), text);
    // The customer must not be left with nothing AND no lead: a failed save propagates so Meta redelivers.
    const lost = stub({ hit, text, captureLead: async () => { throw new Error("db down"); } });
    await assert.rejects(() => dispatchNeed(lost.input), /db down/, text);
  }
});

test("dispatch: a payment claim or a bank-account ask is left to its own branch", async () => {
  for (const text of ["төлбөрөө хийсэн захиалга баталгаажсан уу", "дансаа явуулаач"]) {
    const run = stub({ hit: { need: "existing_booking", signals: ["x"], constraints: {} }, text });
    assert.equal(await dispatchNeed(run.input), false, text);
    assert.deepEqual(run.delivered, []);
    assert.deepEqual(run.leads, []);
  }
});

test("dispatch: a complaint goes through the hand-off branch when hand-off is on, and is a typed lead plus silence when it is off", async () => {
  const text = "Хөтөч муу байсан, гомдолтой байна";
  const handoffs: string[] = [];
  const on = stub({ hit: classifyMessageNeed(text)!, text, handoff: async (context) => { handoffs.push(context); } });
  assert.equal(await dispatchNeed(on.input), true);
  assert.equal(handoffs.length, 1);
  assert.ok(handoffs[0].startsWith("[need:complaint]"));
  assert.deepEqual(on.leads, [], "the hand-off branch writes the lead itself");
  const off = stub({ hit: classifyMessageNeed(text)!, text, handoff: undefined });
  assert.equal(await dispatchNeed(off.input), true);
  assert.deepEqual(off.delivered, []);
  assert.ok(off.leads[0].context!.startsWith("[need:complaint]"));
});

test("dispatch: social closes answer thanks and praise, and stay silent for an acknowledgement or a farewell", async () => {
  const cases: Array<[string, boolean]> = [["Баярлалаа", true], ["Аялал маш сайхан боллоо", true], ["ok", false], ["Баяртай", false]];
  for (const [text, replies] of cases) {
    const run = stub({ hit: classifyMessageNeed(text)!, text });
    assert.equal(await dispatchNeed(run.input), true, text);
    assert.equal(run.delivered.length, replies ? 1 : 0, text);
    assert.deepEqual(run.leads, [], `${text}: no lead for a social message`);
  }
});

test("destination words are recognised from the catalogue as typed, in either script", async () => {
  const trips = [aTrip(), aTrip({ id: "t2", route_name: "КАЛДОР ПАРК", extra: { customer_visible: true, aliases: ["Калдор", "Kaldor"] } })];
  assert.deepEqual(await catalogPlaceWordsIn("Dorvel hotruu 30 hun", trips), ["dorvel"]);
  assert.deepEqual(await catalogPlaceWordsIn("Калдор руу явна", trips), ["калдор"]);
  assert.deepEqual(await catalogPlaceWordsIn("30 хүн явна", trips), []);
});

test("an entered discount policy or offer is a fact whatever words its fields use; commercial terms in the owner's text step the gate aside", () => {
  const policyOnly = commercialFactsText([aTrip()], { discount_policies: [{ name: "Групп", discount: "5%", applies_to: "15+", eligibility: "", description: "", verification: "" }] });
  assert.equal(guardInventedCommercialClaims("Тийм, 15+ хүнд хямдрал бий.", policyOnly), "Тийм, 15+ хүнд хямдрал бий.");
  const offerOnly = commercialFactsText([aTrip()], { special_offers: [{ name: "Өвлийн", description: "Эрт захиалгын тусгай санал" }] as never });
  assert.equal(guardInventedCommercialClaims("Одоогоор урамшуулал байна.", offerOnly), "Одоогоор урамшуулал байна.");
  // A blank row is no policy.
  const blank = commercialFactsText([aTrip()], { discount_policies: [{ name: "", discount: " ", applies_to: "", eligibility: "", description: "", verification: "" }] });
  assert.equal(guardInventedCommercialClaims("Хямдрал байна.", blank), "REFER");
  // The gate steps aside only for the term the owner's text holds.
  const faq = commercialFactsText([], { faq: [{ question: "Бартераар аялж болох уу?", answer: "Болно." }] });
  assert.ok(commercialSignalCovered(["barter"], faq));
  assert.ok(commercialSignalCovered(["contract", "barter"], faq), "one covered term is enough: the model and the guard take it from there");
  assert.ok(!commercialSignalCovered(["invoice"], faq));
  assert.ok(!commercialSignalCovered(["instalment"], faq));
  assert.ok(!commercialSignalCovered(["barter"], ""));
  assert.ok(commercialSignalCovered(["group_discount"], policyOnly));
});

test("dispatch: with owner text covering the asked term the commercial gate does nothing; without it, silence plus a lead", async () => {
  const text = "barter awdag u";
  const hit = classifyMessageNeed(text)!;
  const covered = stub({ hit, text, configuredFacts: "Бартераар аялж болох уу? Болно." });
  assert.equal(await dispatchNeed(covered.input), false);
  assert.deepEqual(covered.delivered, []);
  assert.deepEqual(covered.leads, [], "left entirely to the ordinary path");
  const uncovered = stub({ hit, text, configuredFacts: "Нэхэмжлэх гаргана." });
  assert.equal(await dispatchNeed(uncovered.input), true);
  assert.equal(uncovered.leads.length, 1);
});
