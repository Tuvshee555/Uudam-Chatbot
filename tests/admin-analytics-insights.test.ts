import assert from "node:assert/strict";
import test from "node:test";
import { classifySilence, missingFactTopic, questionTopic, tripCoverage } from "../src/lib/adminAnalyticsInsights";

const FAST_PATH = "Бот мэдээлэлгүй fast-path хариуг зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй: ";

test("every hand-off context the bot stores maps to the reason it stayed silent", () => {
  const cases: Array<[string, string, string]> = [
    ["AI түр саатсан тул зөвлөхөд шилжүүлэв.", "Вэлмор аялал", "ai_outage"],
    ["Бот мэдээлэлгүй асуулт тул зөвлөхөд шилжүүлэв.", "Вэлмор аялал", "no_data"],
    ["AI мэдээлэлгүй өгүүлбэр бичсэн тул зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй.", "Вэлмор аялал", "no_data"],
    ["AI өөр аяллын (ОРЛАН АЯЛАЛ) хариу өгөх гэсэн тул хэрэглэгчид илгээлгүй зөвлөхөд шилжүүлэв.", "Вэлмор аялал", "unclear_trip"],
    [`${FAST_PATH}answer_plan [price.child]`, "Хүүхдийн үнэ?", "no_data"],
    [`${FAST_PATH}answer_plan (харилцаанд дурдагдаагүй аялал: ОРЛАН АЯЛАЛ)`, "Үнэ?", "unclear_trip"],
    [`${FAST_PATH}bare_number_without_context`, "1", "unclear_trip"],
    [`${FAST_PATH}not_in_catalog`, "Өөр орон", "not_found"],
    [`${FAST_PATH}structured_trip_not_found`, "Өөр орон", "not_found"],
    [`${FAST_PATH}sold_out_named`, "Суудал бий юу", "sold_out"],
    [`${FAST_PATH}punctuation_only`, "???", "asked_person"],
    ["Хэрэглэгч төлбөрийн дансны мэдээлэл асуусан — зөвлөх албан ёсоор илгээнэ үү.", "Данс?", "payment"],
    ["Төлбөр шилжүүлсэн гэж мэдэгдсэн — зөвлөх шалгаж баталгаажуулна уу.", "Шилжүүлсэн", "payment"],
    ["Хэрэглэгч дуут мессеж илгээсэн — бот сонсож чадахгүй тул зөвлөх сонсоод хариулна уу.", "[Дуут мессеж]", "media"],
    ["Хэрэглэгч аяллын зураг илгээсэн, аль аялал болохыг бот тогтоож чадсангүй — «Ирсэн зургууд»-аас үзээд хариулна уу.", "[Аяллын зураг]", "media"],
    // The explicit "холбогдох" hand-off stores no context: the customer asked for a person.
    ["", "Зөвлөхтэй холбогдох", "asked_person"],
    ["", "", "other"],
    ["Дотоод каталог/status тэмдэглэл шиг харагдсан тул бот автоматаар хариулаагүй.", "тэмдэглэл", "other"],
  ];
  for (const [context, message, reason] of cases) assert.equal(classifySilence(context, message), reason, context || message);
});

test("the fact the bot recorded as missing decides the question's topic", () => {
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [booking_terms.visa]`), "documents");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [booking_terms.documents]`), "documents");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [booking_terms.deposit, booking_terms.cancellation]`), "terms");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [price.child]`), "price");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [dates.window]`), "dates");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [hotel.room]`), "hotel");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [includes.Хоол]`), "includes");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [weather.report, price.adult]`), "price", "the first fact with a topic counts");
  assert.equal(missingFactTopic(`${FAST_PATH}answer_plan [weather.report]`), null, "a recorded fact outside the topics is not guessed");
  assert.equal(missingFactTopic(`${FAST_PATH}not_in_catalog`), undefined, "no record: the question's words decide");
});

test("a question's words name its topic in Cyrillic and Latin spelling", () => {
  assert.equal(questionTopic("Виз хэрэгтэй юу"), "documents");
  assert.equal(questionTopic("viz heregtei yu"), "documents");
  assert.equal(questionTopic("Урьдчилгаа хэд вэ"), "terms", "a deposit question is about terms, not the fare");
  assert.equal(questionTopic("Хоол багтсан уу"), "includes");
  assert.equal(questionTopic("Ямар буудалд буух вэ"), "hotel");
  assert.equal(questionTopic("hotolbor ywuulaach"), "program");
  assert.equal(questionTopic("zurag bnu"), "photos");
  assert.equal(questionTopic("une hed ve"), "price");
  assert.equal(questionTopic("Хэзээ гарах вэ"), "dates");
  assert.equal(questionTopic("Баярлалаа"), null);
});

test("trip coverage reads the same fields the bot answers from", () => {
  const empty = tripCoverage({ adult_price: 0, hotel: "", departure_dates: [], photo_urls: [], extra: {} });
  assert.deepEqual([...empty], []);
  const blankText = tripCoverage({ extra: { booking_terms: { visa: "  ", deposit: "" }, included_items: [""], itinerary_days: [{ title: " " }] } });
  assert.deepEqual([...blankText], [], "blank fields answer nothing");
  const full = tripCoverage({
    adult_price: "0", hotel: "", departure_dates: [], photo_urls: [],
    extra: {
      price_groups: [{ adult_price: 900, hotel: "Вэлмор буудал" }], departure_rule: "Сар бүр",
      itinerary_days: [{ summary: "Хотын аялал" }], included_items: ["Хоол"], poster_photo_count: 3,
      booking_terms: { payment: "Бэлнээр" }, website_details: { requirements: "Гадаад паспорт" },
    },
  });
  assert.deepEqual([...full].sort(), ["dates", "documents", "hotel", "includes", "photos", "price", "program", "terms"]);
  const websiteTerms = tripCoverage({ extra: { website_details: { cancellationPolicy: "Цуцлалтын нөхцөл" } } });
  assert.deepEqual([...websiteTerms], ["terms"]);
});
