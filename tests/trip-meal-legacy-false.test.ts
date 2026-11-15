/**
 * Before 2026-11 every meal a source did not state was saved as false. A missing
 * meal key now stays "not stated", and a day whose three meals are all false with
 * no meal note reads as not stated wherever "not included" would be said: the
 * website's ✗ and the AI catalogue. Day names and notes here are invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { legacyUnstatedMeals, normalizeExtraPatch, statedDayMeals } from "../src/lib/tripExtraSchema";
import { websiteItineraryMeals } from "../src/lib/connectedTripMapping";
import { itineraryMealsText } from "../src/lib/tripKnowledgeText";

test("a missing meal key is saved as not stated; an explicit false stays not included", () => {
  const days = normalizeExtraPatch({ itinerary_days: [
    { title: "Зохиомол өдөр", meals: { breakfast: true } },
    { title: "Зохиомол өдөр 2", meals: { breakfast: false, lunch: null } },
    { title: "Зохиомол өдөр 3" },
  ] }).itinerary_days as Array<{ meals: unknown }>;
  assert.deepEqual(days.map((day) => day.meals), [
    { breakfast: true, lunch: null, dinner: null },
    { breakfast: false, lunch: null, dinner: null },
    { breakfast: null, lunch: null, dinner: null },
  ]);
});

test("one rule: all three false with no meal note is not stated; a note or a listed meal keeps the false", () => {
  const none = { breakfast: false, lunch: false, dinner: false };
  assert.equal(legacyUnstatedMeals(none), true);
  assert.equal(legacyUnstatedMeals(none, "  "), true);
  assert.deepEqual(statedDayMeals(none), { breakfast: null, lunch: null, dinner: null });
  assert.deepEqual(statedDayMeals(none, "Зохиомол тэмдэглэл"), none);
  assert.deepEqual(statedDayMeals({ breakfast: true, lunch: false, dinner: false }), { breakfast: true, lunch: false, dinner: false });
  assert.deepEqual(statedDayMeals({ breakfast: false, lunch: null }), { breakfast: false, lunch: null, dinner: null });
  assert.deepEqual(statedDayMeals(undefined), { breakfast: null, lunch: null, dinner: null });
});

test("the website is not told a legacy all-false day is 'not included'", () => {
  const meals = websiteItineraryMeals([
    { day: 1, route: "Зохиомол өдөр", meals: { breakfast: false, lunch: false, dinner: false } },
    { day: 2, route: "Зохиомол өдөр 2", meals: { breakfast: true, lunch: false, dinner: false } },
    { day: 3, route: "Зохиомол өдөр 3", meals: { breakfast: false, lunch: false, dinner: false }, meal_note: "Зохиомол тэмдэглэл" },
    { day: 4, route: "Зохиомол өдөр 4", meals: { breakfast: false, lunch: false, dinner: false } },
  ], [{ day: 4, meal_note: "Өөр тэмдэглэл" }]);
  assert.deepEqual(meals, [
    { dayNumber: 1, breakfast: null, lunch: null, dinner: null },
    { dayNumber: 2, breakfast: true, lunch: false, dinner: false },
    { dayNumber: 3, breakfast: false, lunch: false, dinner: false, note: "Зохиомол тэмдэглэл" },
    // The chatbot day's note counts as the day's note.
    { dayNumber: 4, breakfast: false, lunch: false, dinner: false, note: "Өөр тэмдэглэл" },
  ]);
});

test("the AI catalogue does not say 'хоол багтаагүй' for a legacy all-false day", () => {
  assert.equal(itineraryMealsText([
    { day: 1, meals: { breakfast: false, lunch: false, dinner: false } },
    { day: 2, meals: { breakfast: false, lunch: false, dinner: false } },
  ]), null);
  assert.equal(itineraryMealsText([
    { day: 1, meals: { breakfast: false, lunch: false, dinner: false } },
    { day: 2, meals: { breakfast: true, lunch: false, dinner: false } },
    { day: 3, meals: { breakfast: false, lunch: false, dinner: false }, meal_note: "Зохиомол тэмдэглэл" },
  ]), "2-р өдөр — өглөөний хоол багтсан, өдрийн, оройн хоол багтаагүй; 3-р өдөр — хоол багтаагүй (Зохиомол тэмдэглэл)");
});
