import assert from "node:assert/strict";
import test from "node:test";
import { phoneticLatinText, phoneticTokenMatches } from "../src/lib/travelTextNorm";
import { resolveTripFromUserMessage } from "../src/lib/travelFastPathsSearch";
import { trip } from "./helpers/understandingRoutingFixtures";

/**
 * Same class as the alias rule (understanding-routing-alias.test.ts), on the trip TITLE: a short
 * place word of a title (four letters once spelled phonetically) sat at the start of an everyday word
 * ("санал", "санагдах" in the live data) and the message resolved to that one trip. A short title
 * word now matches a longer word only before a case ending or as a lengthened final vowel. Every
 * name below is invented; the trip has no aliases, so only its title can match.
 */
const catalog = [
  trip("t1", "ТАЛЬЯ АРЛЫН АЯЛАЛ", ["2098-02-12"], [2_400_000, 2_000_000, null], { extra: { transport_type: "direct_flight" } }),
  trip("c1", "ВЕРДАН ХОТЫН АЯЛАЛ", ["2098-02-14"], [3_000_000, 2_500_000, null], { extra: { transport_type: "direct_flight" } }),
];
const status = (text: string) => resolveTripFromUserMessage(text, catalog, { allowLooseFallback: false }).status;

test("a short title word inside an everyday word names no trip", () => {
  assert.equal(phoneticLatinText("Талья").trim().length, 4, "setup: the invented place is four phonetic letters");
  for (const text of ["Танай талархал хүргэе", "Талархаж байна", "talarhaj bn", "Маш их талархлаа", "talarhsan shuu"]) {
    assert.equal(status(text), "not_found", text);
  }
});

test("the short title word as a word, with a case ending or a lengthened vowel, still names its trip", () => {
  for (const text of ["Талья руу явмаар байна", "Тальяд явах уу", "Тальягийн аялал хэд вэ", "Тальяа аялал", "talya ayalal"]) {
    const result = resolveTripFromUserMessage(text, catalog, { allowLooseFallback: false });
    assert.equal(result.status === "verified" ? result.trip.id : result.status, "t1", text);
  }
  // Longer words keep the old prefix behaviour (a case ending the list does not hold still matches).
  assert.equal(phoneticTokenMatches(phoneticLatinText("Верданчууд").trim(), phoneticLatinText("Вердан").trim()), true);
});
