import assert from "node:assert/strict";
import test from "node:test";
import { aliasOccursInText } from "../src/lib/aliasMatch";
import { resolveTripFromUserMessage } from "../src/lib/travelFastPathsSearch";
import { conversationGateHarness } from "./helpers/conversationGateHarness";
import { TRIP_LIST_MARKERS, day, textOf, trip } from "./helpers/understandingRoutingFixtures";

/**
 * Class: a WEAK alias inside a LONGER word names a trip. An alias must occupy a whole word, or a word
 * start followed by a closed list of Mongolian case endings; an alias under five letters never matches
 * inside a longer word. Real case 14: a long thank-you ("санал хүсэлт" = suggestion) got an itinerary
 * because a four-letter alias of three sibling trips sat inside "санал". All names below are invented.
 */
test("alias occurrence is token-aligned, with a closed list of case endings", () => {
  // Whole word and a word followed by a case ending.
  for (const text of ["Тарвелия аялал", "Тарвелияд явмаар байна", "тарвелиягийн үнэ", "Тарвелиягаас гарах", "тарвелиятай аялал", "Tarveliya yavmaar bn", "tarveliyad yavmaar bn", "tarveliyaas"]) {
    assert.equal(aliasOccursInText("Тарвелия", text) || aliasOccursInText("Tarveliya", text), true, text);
  }
  // A multi-word alias keeps its word order, and its last word may carry an ending.
  assert.equal(aliasOccursInText("Тэнгэр хаалга", "тэнгэр хаалганд очих"), true);
  assert.equal(aliasOccursInText("Тэнгэр хаалга", "хаалга тэнгэр"), false);
  // A short alias matches only as the whole word.
  assert.equal(aliasOccursInText("Сана", "Сана аялал хэд вэ"), true);
  for (const text of ["Санал болгосонд баярлалаа", "санамж өгсөнд баярлалаа", "санагдаад байна", "sanal bolgoson", "sanaa zovoltgui", "Сананд явъя"]) {
    assert.equal(aliasOccursInText("Сана", text), false, text);
  }
  // An alias spelled like the start of a very common word (phonetic collision across Cyrillic/Latin).
  for (const text of ["Танай талархал байна", "талархаж байна", "talarhaj bn"]) {
    assert.equal(aliasOccursInText("Талья", text), false, text);
    assert.equal(aliasOccursInText("Talya", text), false, text);
  }
  assert.equal(aliasOccursInText("Талья", "талья руу явмаар байна"), true);
  // A long alias inside an unrelated longer word is not an occurrence either.
  assert.equal(aliasOccursInText("Тарвелия", "тарвелиянарын хүн"), false);
});

const island = (id: string, name: string, dates: string[]) => trip(id, name, dates, [2_400_000, 2_000_000, null], {
  extra: { transport_type: "direct_flight", destinations: ["Орлова"], aliases: ["Сана", "Талья"], itinerary_days: [1, 2, 3].map((n) => day(n, `ӨДӨР ${n}`, "Хөтөлбөр (invented).")) } });
const catalog = [
  island("i1", "ОРЛОВА АРЛЫН АЯЛАЛ - ЛАГУНА", ["2098-02-12", "2098-02-26"]),
  island("i2", "ОРЛОВА АРЛЫН АЯЛАЛ - ШАЛОВ", ["2098-02-19"]),
  island("i3", "ОРЛОВА АРЛЫН АЯЛАЛ - ТОРНА", ["2098-03-05"]),
  trip("c1", "ВЕРДАН ХОТЫН АЯЛАЛ", ["2098-02-14"], [3_000_000, 2_500_000, null], { extra: { transport_type: "direct_flight", destinations: ["Вердан"], aliases: ["Verdan"] } }),
];

test("a weak alias inside a longer word resolves no trip; the alias as a word still does", () => {
  const none = (text: string) => assert.equal(resolveTripFromUserMessage(text, catalog, { allowLooseFallback: false }).status, "not_found", text);
  none("Санал болгосонд баярлалаа");
  none("Танай санал хүсэлт байвал хэлээрэй, баярлалаа");
  none("bayrlalaa, sanal hvseltee daraa ilgeene");
  none("Санамж өгсөнд баярлалаа");
  none("Танай ажилтнуудад талархаж байна");
  none("talarhal ilgeej bn");
  // Positive controls: the alias as a word names the sibling trips.
  for (const text of ["Сана аялал хэд вэ", "Талья руу явмаар байна", "talya ayal"]) {
    assert.notEqual(resolveTripFromUserMessage(text, catalog, { allowLooseFallback: false }).status, "not_found", text);
  }
});

test("a thank-you that carries an alias-like word gets no trip list (case 14 shape)", async (context) => {
  const harness = await conversationGateHarness(context);
  harness.catalog(catalog);
  try {
    const thanks = [
      "Санал болгосонд баярлалаа",
      "Танай компанид баярлалаа. Хөтөлбөрт нэмэх хасах санал хүсэлт болгоныг сайн сонсож хөтөч нартаа баярлалаа, дахин аялна аа",
      "bayrlalaa, sanal hvseltee daraa ilgeene",
      "Талархаж байна, маш сайн үйлчилсэн",
    ];
    for (const [index, text] of thanks.entries()) {
      const result = await harness.turn(`alias-thanks-${index}`, text, { intent: "smalltalk", topics: [], certainty: "none", place: null });
      const sent = textOf(result.sends);
      for (const name of catalog.map((value) => value.route_name)) assert.ok(!sent.includes(name), `a thank-you must not name a trip: ${text} -> ${sent}`);
      for (const marker of TRIP_LIST_MARKERS) assert.ok(!sent.includes(marker), `a thank-you must not list trips: ${text} -> ${sent}`);
      assert.equal(result.selection, null, `a thank-you must not select a trip: ${text}`);
    }
    // Positive control: the same alias used as a word is a trip question and is answered.
    const asked = await harness.turn("alias-control", "Сана аяллын үнэ хэд вэ", { intent: "trip", topics: ["price"], certainty: "several", place: "Сана" });
    assert.ok(textOf(asked.sends).includes("ОРЛОВА АРЛЫН АЯЛАЛ"), "an alias as a word still finds its trips");
  } finally {
    await harness.close();
  }
});
