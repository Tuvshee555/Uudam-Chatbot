/**
 * Website itinerary saves and meal states (2026-11-06). The website lists only
 * included meals and renumbers its days 1..n on every save, so a day's "not
 * included" / "not stated" must follow the day itself (its ItineraryDay id), not
 * its new number. Trip, day and place names here are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripPatchReport, websiteTripToCanonicalFields, type WebsiteTripPatchReport } from "../src/lib/websiteTripBridge";

type Meals = { breakfast: boolean | null; lunch: boolean | null; dinner: boolean | null };
const ID = "trip-meal-identity";

/** The chatbot's days at the last sync. */
const chatbotDays = [
  { day: 1, title: "Нэгдүгээр зогсоол", description: "", meals: { breakfast: true, lunch: null, dinner: false } },
  { day: 2, title: "Хоёрдугаар зогсоол", description: "", meals: { breakfast: true, lunch: false, dinner: null } },
  { day: 3, title: "Гуравдугаар зогсоол", description: "", meals: { breakfast: null, lunch: true, dinner: false } },
];
/** The website's days as that sync wrote them: only included meals are listed. */
const websiteDays = [
  { id: "day-a", dayNumber: 1, title: "Нэгдүгээр зогсоол", description: null, accommodation: null, meals: ["Өглөө"], image: null },
  { id: "day-b", dayNumber: 2, title: "Хоёрдугаар зогсоол", description: null, accommodation: null, meals: ["Өглөө"], image: null },
  { id: "day-c", dayNumber: 3, title: "Гуравдугаар зогсоол", description: null, accommodation: null, meals: ["Өдөр"], image: null },
];
const sourceMetadata = { connectedSource: { id: ID, extra: { itinerary_days: chatbotDays } } };
const previous = { sourceTripId: ID, itinerary: websiteDays, sourceMetadata };
const canonical = (days: unknown[] = chatbotDays) => ({
  id: ID, route_name: "Зохиомол аялал", duration_text: "3 өдөр 2 шөнө", currency: "MNT", extra: { itinerary_days: days },
});
const save = (itinerary: unknown[], current = canonical()) =>
  websiteTripPatchReport({ sourceTripId: ID, itinerary, sourceMetadata }, previous, current, ["itinerary"]);
const savedDays = (report: WebsiteTripPatchReport) =>
  (report.fields.extra?.itinerary_days as Array<{ title: string; meals: Meals }>).map(({ title, meals }) => ({ title, meals }));

test("deleting a middle day on the website keeps each remaining day's own meal states", () => {
  const [first, , third] = websiteDays;
  const report = save([first, { ...third, dayNumber: 2 }]);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(savedDays(report), [
    { title: "Нэгдүгээр зогсоол", meals: { breakfast: true, lunch: null, dinner: false } },
    // Now day 2, still the third day: its breakfast was not stated and its dinner not included.
    { title: "Гуравдугаар зогсоол", meals: { breakfast: null, lunch: true, dinner: false } },
  ]);
});

test("inserting a day keeps its neighbours' meal states; the new day states only what it lists", () => {
  const [first, second, third] = websiteDays;
  const added = { id: "day-new", dayNumber: 2, title: "Шинэ зогсоол", description: null, accommodation: null, meals: ["Орой"], image: null };
  const report = save([first, added, { ...second, dayNumber: 3 }, { ...third, dayNumber: 4, meals: [] }]);
  assert.deepEqual(report.conflicts, []);
  assert.deepEqual(savedDays(report), [
    { title: "Нэгдүгээр зогсоол", meals: { breakfast: true, lunch: null, dinner: false } },
    { title: "Шинэ зогсоол", meals: { breakfast: null, lunch: null, dinner: true } },
    { title: "Хоёрдугаар зогсоол", meals: { breakfast: true, lunch: false, dinner: null } },
    // The lunch it listed was taken off (not included); the meals it never listed keep their states.
    { title: "Гуравдугаар зогсоол", meals: { breakfast: null, lunch: false, dinner: false } },
  ]);
});

test("a chatbot 'not stated' -> 'not included' meal edit is never reverted by a later website itinerary save", () => {
  const [first, second, third] = websiteDays;
  const retitled = [{ ...first, title: "Нэгдүгээр зогсоол шинэ" }, second, third];
  // Control: the chatbot did not touch the day, so the website's title edit is taken.
  const untouched = save(retitled);
  assert.deepEqual(untouched.conflicts, []);
  assert.deepEqual(savedDays(untouched)[0], { title: "Нэгдүгээр зогсоол шинэ", meals: { breakfast: true, lunch: null, dinner: false } });
  // Since that sync the chatbot set day 1's lunch to "not included".
  const edited = chatbotDays.map((day) => day.day === 1 ? { ...day, meals: { ...day.meals, lunch: false } } : day);
  const report = save(retitled, canonical(edited));
  assert.equal(report.fields.extra?.itinerary_days, undefined, "the chatbot's lunch is not put back to 'not stated'");
  assert.deepEqual(report.conflicts.map((conflict) => conflict.field), ["extra.itinerary_days"]);
});

/** One website day's meals read with no earlier website copy, against a chatbot day that states nothing. */
function read(meals: string[]): Meals {
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-meal-words", durationDays: 1, durationNights: 0,
    sourceMetadata: { connectedSource: { extra: { itinerary_days: [{ day: 1, meals: { breakfast: null, lunch: null, dinner: null } }] } } },
    itinerary: [{ dayNumber: 1, title: "Зохиомол зогсоол", meals }],
  });
  return (result.fields.extra?.itinerary_days as Array<{ meals: Meals }>)[0].meals;
}

test("website meal phrases read exactly as the website's dayMealSlots reads them", () => {
  assert.deepEqual(read(["Өглөө, Өдрийн хоол, Орой үгүй"]), { breakfast: true, lunch: true, dinner: false });
  assert.deepEqual(read(["Оройн хоол өөрийн зардлаар"]), { breakfast: null, lunch: null, dinner: false });
  assert.deepEqual(read(["Үдийн хоол"]), { breakfast: null, lunch: true, dinner: null });
  // The projection's own word for lunch.
  assert.deepEqual(read(["Өдөр"]), { breakfast: null, lunch: true, dinner: null });
  for (const all of ["3 хоол", "Бүх хоол", "Full board"]) {
    assert.deepEqual(read([all]), { breakfast: true, lunch: true, dinner: true }, all);
  }
  // A meal named both ways is unknown, never included.
  assert.deepEqual(read(["Өглөө", "Өглөө үгүй"]), { breakfast: null, lunch: null, dinner: null });
});
