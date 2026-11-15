import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import { isFrustratedHandoffRequest } from "../src/lib/handoffDetection";
import { buildContactReply, isAddressRequest, isPhoneRequest } from "../src/lib/contactReplies";
import { isGenericRouteToken, normText } from "../src/lib/travelTextNorm";
import { hasIncludedInPriceIntent } from "../src/lib/travelFastPathsPricing";
import { replyPreferences } from "../src/lib/chatbotReplyPolicy";
import { requestedFactsFromText } from "../src/lib/requestedFacts";
import { buildTripRequest, requestedPassengersFromText } from "../src/lib/tripRequest";
import { stripTripNamesForIntent } from "../src/lib/customerTurn";
import { isGenericTripRequest } from "../src/lib/travelFastPathsSearch";
import { evalCatalogue } from "./eval/catalogue";

// Unit checks for the 2026-11-02 accuracy work. Every phrase is an invented customer message;
// every trip, hotel, price and date comes from the invented evaluation catalogue.
const now = new Date("2098-02-01T04:00:00Z");

// These modules load env (redis state) at import time.
let isAttributePickOnly: typeof import("../src/lib/fastPathRouting").isAttributePickOnly;
let recurringScheduleTexts: typeof import("../src/lib/tripAnswerPlan").recurringScheduleTexts;
let buildCatalogListingReply: typeof import("../src/lib/catalogListing").buildCatalogListingReply;
before(async () => {
  applyTestEnv();
  ({ isAttributePickOnly } = await import("../src/lib/fastPathRouting"));
  ({ recurringScheduleTexts } = await import("../src/lib/tripAnswerPlan"));
  ({ buildCatalogListingReply } = await import("../src/lib/catalogListing"));
});

test("asking for a person is read in Latin letters, short forms and 'not a bot' wording", () => {
  for (const text of ["hun bnu", "Хүн байна уу", "ажилтан байна уу", "Хүнтэй ярьмаар байна", "huntei yarimaar bn", "chatbot bish hun heregtei", "бот биш хүн", "хүн хэрэгтэй"]) {
    assert.ok(isFrustratedHandoffRequest(text), text);
  }
  // A head count or a seats question is not a request for a person.
  for (const text of ["2 хүн байна уу", "3 хүн хэрэгтэй", "Калдор 2 хүн явна", "хүүхэдтэй ярих уу"]) {
    assert.equal(isFrustratedHandoffRequest(text), false, text);
  }
});

test("typed phone and address questions in both scripts get the saved contact details; a customer's own number never does", () => {
  const contact = { phones: "7700 1234 / 9900 5678", address: "Энхтайваны өргөн чөлөө 1" };
  for (const text of ["utasnii dugaar ugch uu", "tanai utas hed ve", "утасны дугаар хэд вэ", "Холбоо барих дугаар 😊", "Танай утасны дугаараа өгөөч"]) {
    assert.ok(isPhoneRequest(text), text);
    assert.match(buildContactReply(text, contact)!, /7700 1234/);
  }
  for (const text of ["ta nar haana bairladag ve", "Оффис хаана байдаг вэ", "Та нарын хаяг хаана вэ", "хаяг хаана вэ", "Манай хаяг 😊", "office address"]) {
    assert.ok(isAddressRequest(text), text);
    assert.match(buildContactReply(text, contact)!, /Энхтайваны/);
  }
  for (const text of ["99119911", "миний утас 99119911", "утасны дугаараа үлдээнэ үү", "Калдор буудлын хаяг", "Вэлмор хаана байдаг вэ"]) {
    assert.equal(isPhoneRequest(text) || isAddressRequest(text), false, text);
  }
});

test("Latin spellings of question words bridge to the Cyrillic the intent patterns read", () => {
  assert.equal(normText("ymar aylal bga we"), "ямар аялал bga we");
  assert.equal(normText("gazraar yavdag aylal"), "газраар yavdag аялал");
  assert.equal(normText("kaldor viz heregtei yu"), "kaldor виз хэрэгтэй yu");
  assert.equal(normText("uridchilgaa hedn huvi"), "урьдчилгаа hedn huvi");
  assert.equal(normText("huuhded hungulult bga yu"), "хүүхдэд хөнгөлөлт bga yu");
  assert.equal(normText("hamgiin hyamd"), "хамгийн хямд");
});

test("a pick by quality under a list is a choice, a question with a quality word is not", () => {
  for (const text of ["шууд нислэгтэй нь", "shuud nislegtei ni", "газрын", "5 өдөр нь", "хосолсон аялал нь"]) assert.ok(isAttributePickOnly(text), text);
  for (const text of ["шууд нислэгтэй нь хэд вэ", "газрын аялал хэзээ гарах вэ", "шууд нислэгтэй 2 том хүн"]) assert.equal(isAttributePickOnly(text), false, text);
  assert.ok(isGenericRouteToken("нислэгтэй") && isGenericRouteToken("shuud"));
});

test("every way of asking what the fare covers is an inclusions question", () => {
  for (const text of ["юу багтдаг вэ", "ticket une tusdaa yu", "hool orson uu", "тийз багтсан уу", "хоол орсон юу", "bagtsan uu"]) assert.ok(hasIncludedInPriceIntent(text), text);
  const food = replyPreferences("хоол багтсан уу").includes.find((target) => target.label === "Хоол")!;
  assert.ok(food.pattern.test("Өглөөний цай"), "breakfast counts as food");
  assert.deepEqual(replyPreferences("kaldor viz heregtei yu").termKeys, ["visa"]);
  assert.deepEqual(replyPreferences("huuhded hungulult bga yu").fareKinds, ["child"]);
});

test("hotel distance and flight hours are facts the catalogue does not hold", () => {
  assert.deepEqual(requestedFactsFromText("Калдор буудал далайгаас хэр хол вэ").map((fact) => fact.field), ["hotel.location"]);
  assert.deepEqual(requestedFactsFromText("Калдор руу хэдэн цаг нисэх вэ").map((fact) => fact.field), ["other.unsupported"]);
  assert.deepEqual(requestedFactsFromText("Калдор буудал ямар буудал вэ"), []);
});

test("'2 хүн' are two adults; ten or more people stay a group for staff", () => {
  assert.deepEqual(requestedPassengersFromText("2 hun yavna"), [{ kind: "adult", count: 2 }]);
  assert.deepEqual(requestedPassengersFromText("3 хүн 1 хүүхэд"), [{ kind: "adult", count: 3 }, { kind: "child", count: 1 }]);
  assert.deepEqual(requestedPassengersFromText("12 хүн явна"), []);
  assert.deepEqual(requestedPassengersFromText("2 хүний үнэ"), [], "a possessive is not a head count");
});

test("a hotel named without its star rating is the catalogue's hotel; the model's reading maps to it too", () => {
  const norvel = evalCatalogue.filter((trip) => trip.id === "norvel");
  assert.equal(buildTripRequest("Norvel Grand", norvel, undefined, now).hotel, "Norvel Grand 5*");
  assert.equal(buildTripRequest("norvel inn авъя", norvel, undefined, now).hotel, "Norvel Inn 3*");
  assert.equal(buildTripRequest("Norvel Grand", norvel, { hotel: "Norvel Grand" }, now).hotel, "Norvel Grand 5*");
  assert.equal(buildTripRequest("Норвел", norvel, { hotel: "Norvel Grand" }, now).hotel, null, "the customer did not write it");
});

test("a bargain asks the real fare and the discount data, not how one travels", () => {
  const request = buildTripRequest("Вэлмор шууд нислэгтэй 1 сая төгрөгөөр болох уу", evalCatalogue, undefined, now);
  assert.ok(request.topics.includes("price") && request.topics.includes("discount"), request.topics.join(","));
  assert.equal(request.topics.includes("transport"), false);
  assert.equal(stripTripNamesForIntent("Вэлмор шууд нислэгтэй 1 сая төгрөгөөр болох уу", evalCatalogue).trim(), "1 сая төгрөгөөр болох уу");
});

test("Latin booking-term words are read as booking terms", () => {
  assert.ok(buildTripRequest("kaldor viz heregtei yu", evalCatalogue, undefined, now).topics.includes("booking_terms"));
  const deposit = buildTripRequest("velmor shuud nislegtei uridchilgaa hedn huvi", evalCatalogue, undefined, now);
  assert.ok(deposit.topics.includes("booking_terms") && !deposit.topics.includes("price"), deposit.topics.join(","));
});

test("a weekly schedule is recognised as text; calendar dates are not", () => {
  assert.deepEqual(recurringScheduleTexts(evalCatalogue.find((trip) => trip.id === "solmar-spring")!), ["Баасан гараг бүр"]);
  assert.deepEqual(recurringScheduleTexts(evalCatalogue.find((trip) => trip.id === "vel-direct")!), []);
});

test("catalogue questions in Latin letters, by price and for families list from the catalogue", () => {
  const all = buildCatalogListingReply("ymar aylal bga we", evalCatalogue, now)!;
  assert.match(all.reply, /ВЭЛМОР/);
  const cheap = buildCatalogListingReply("Хямдхан аялал байна уу", evalCatalogue, now)!;
  assert.match(cheap.reply.split("\n").find((line) => line.startsWith("1. "))!, /СОЛМАР/);
  assert.equal(cheap.authoritative, true);
  assert.equal(buildCatalogListingReply("2 саяд багтах аялал байна уу", evalCatalogue, now), null, "a ceiling is the budget reply's job");
  const family = buildCatalogListingReply("Хүүхэдтэй явахад тохиромжтой аялал", evalCatalogue, now)!;
  assert.match(family.reply, /ЛУНАРИА/);
  const land = buildCatalogListingReply("gazraar yavdag aylal", evalCatalogue, now)!;
  assert.match(land.reply, /ВЭЛМОР ГАЗРЫН|ОРВЕЛИЯ|СОЛМАР/);
  assert.ok(isGenericTripRequest("Gadaad aylal sonirhoj baina"));
  assert.ok(isGenericTripRequest("ene aylal dotor hool orson uu"));
});

test("model names come from the environment only when they are known chat models", async () => {
  const { replyModel, understandingModelName, isKnownChatModel } = await import("../src/lib/modelConfig");
  const saved = { reply: process.env.OPENAI_REPLY_MODEL, understanding: process.env.TRIP_UNDERSTANDING_MODEL };
  try {
    delete process.env.OPENAI_REPLY_MODEL; delete process.env.TRIP_UNDERSTANDING_MODEL;
    assert.equal(replyModel(), "gpt-4.1");
    assert.equal(understandingModelName(), "gpt-4.1-mini");
    process.env.OPENAI_REPLY_MODEL = "gpt-4.1-mini"; process.env.TRIP_UNDERSTANDING_MODEL = "gpt-4o-2024-08-06";
    assert.equal(replyModel(), "gpt-4.1-mini");
    assert.equal(understandingModelName(), "gpt-4o-2024-08-06");
    process.env.OPENAI_REPLY_MODEL = "gpt4o"; process.env.TRIP_UNDERSTANDING_MODEL = "made-up-model";
    assert.equal(replyModel(), "gpt-4.1", "a typo falls back instead of failing every reply");
    assert.equal(understandingModelName(), "gpt-4.1-mini");
    assert.equal(isKnownChatModel("gpt-4.1-nano"), true);
  } finally {
    if (saved.reply === undefined) delete process.env.OPENAI_REPLY_MODEL; else process.env.OPENAI_REPLY_MODEL = saved.reply;
    if (saved.understanding === undefined) delete process.env.TRIP_UNDERSTANDING_MODEL; else process.env.TRIP_UNDERSTANDING_MODEL = saved.understanding;
  }
});

test("cached input tokens are charged at the provider's discounted share", async () => {
  const { estimateCostUsd } = await import("../src/lib/aiUsage");
  const full = estimateCostUsd("gpt-4o", { prompt_tokens: 10_000, completion_tokens: 0 })!;
  const half = estimateCostUsd("gpt-4o", { prompt_tokens: 10_000, completion_tokens: 0, cached_tokens: 10_000 })!;
  assert.ok(Math.abs(full - 0.025) < 1e-9 && Math.abs(half - 0.0125) < 1e-9, `${full} ${half}`);
  const mini = estimateCostUsd("gpt-4.1-mini", { prompt_tokens: 1_000_000, completion_tokens: 0, cached_tokens: 1_000_000 })!;
  assert.ok(Math.abs(mini - 0.1) < 1e-9, String(mini));
  assert.equal(estimateCostUsd("unknown-model", { prompt_tokens: 1, completion_tokens: 1 }), null);
});
