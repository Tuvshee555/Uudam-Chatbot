import assert from "node:assert/strict";
import test from "node:test";
import { buildTripRequest } from "../src/lib/tripRequest";
import { parseDepartureDateText, requestedDepartureScope } from "../src/lib/travelDates";

/**
 * The ways customers really type a date and a party, and the numbers that look like them but are not.
 * Production 2026-11-12/13: "11,19" (month, day) was not a date, so a dated ask lost its date; "12 3 хавьцаа"
 * (around Dec 3) was not read; a family's ages typed with spaces ("4 7 10 nastai") were dropped and the bot
 * asked for the adults again. Every row is a format, never a trip, place or price.
 */
const NOW = new Date("2026-11-12T01:00:00Z");

test("a month and day typed with a comma are a date; amounts, decimals and counts are not", () => {
  const dates: Array<[string, string]> = [["11,19 гарах", "2026-11-19"], ["гарах 11,19", "2026-11-19"], ["11,19-нд", "2026-11-19"], ["11,19nd garah", "2026-11-19"], ["12,05 гарна уу", "2026-12-05"]];
  for (const [text, ymd] of dates) assert.deepEqual(parseDepartureDateText(text, NOW), [ymd], text);
  for (const text of ["2,5 сая", "4,5 хоног", "1,290,000₮", "3,4 хүн", "5,6 настай", "2,50 сая", "10,15 хүн", "үнэ 2,99", "11, 19 хоёр огноо",
    "10,15 мин", "2,10 хүүхэд", "5,10 хувь", "хүүхэд 5,10"]) {
    assert.deepEqual(parseDepartureDateText(text, NOW), [], `${text} is not a date`);
  }
  // Days of a month already named ("the 3rd and the 10th of February") are not also another month's date.
  for (const [text, ymd] of [["2 сарын 3,10", "2027-02-03"], ["12 сарын 3,10-нд гарах уу", "2026-12-03"], ["1 сарын 10,17 гарах", "2027-01-10"]] as const) {
    assert.deepEqual(parseDepartureDateText(text, NOW), [ymd], `${text}: only the named month`);
  }
});

test("a month and day typed with a space are a date only beside an 'around' word", () => {
  for (const text of ["12 3 хавьцаа", "hi 12 3 havitsa lumis", "12 3-ны орчим", "12 3 orchim"]) {
    const scope = requestedDepartureScope(text, NOW);
    assert.equal(scope?.kind, "range", `${text} is an around-window`);
    if (scope?.kind === "range") assert.ok(scope.startYmd <= "2026-12-03" && scope.endYmd >= "2026-12-03", `${text} contains Dec 3`);
  }
  for (const text of ["2 3 хүн", "5 6 настай", "3 12", "12 3 хоног", "10 15 мянган төгрөг", "4 5 одтой", "1 2 хүүхэд", "2 хүүхэд 4 7 настай",
    "3 4 орчим хүн", "5 6 орчим хүн явна"]) {
    assert.equal(requestedDepartureScope(text, NOW), null, `${text} is not a date`);
  }
});

test("children's ages typed with spaces are read when their number matches the children counted", () => {
  const party = (text: string) => buildTripRequest(text, [], undefined, NOW).passengers.map((p) => `${p.kind}${p.age !== undefined ? `:${p.age}` : `x${p.count}`}`);
  assert.deepEqual(party("2 том 3 хүүхэд 4 7 10 настай"), ["adultx2", "child:4", "child:7", "child:10"]);
  assert.deepEqual(party("5 hvn 2 tom 3 huuhed 4 7 10 nastai"), ["adultx2", "child:4", "child:7", "child:10"]);
  assert.deepEqual(party("2 том 2 хүүхэд 6 8 настай"), ["adultx2", "child:6", "child:8"]);
  // Other separators were already read; they still are.
  assert.deepEqual(party("2 том 3 хүүхэд 4, 7, 10 настай"), ["adultx2", "child:4", "child:7", "child:10"]);
  assert.deepEqual(party("2 том 2 хүүхэд 6 болон 8 настай"), ["adultx2", "child:6", "child:8"]);
  // A phone number or a year right before the age word is not an age: only the last number is, as before.
  assert.deepEqual(party("2 том 2 хүүхэд утас 12345678 5 настай"), ["adultx2", "childx2"]);
  assert.deepEqual(party("1 том 2 хүүхэд 2026 5 настай"), ["adultx1", "childx2"]);
  // A count that does not match is never guessed into ages: only the last number is the age, as before.
  assert.deepEqual(party("2 том 1 хүүхэд 6 8 настай"), ["adultx2", "child:8"]);
  assert.deepEqual(party("2 том хүн 1 хүүхэд 7 настай"), ["adultx2", "child:7"]);
});
