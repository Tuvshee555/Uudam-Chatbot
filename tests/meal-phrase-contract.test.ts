import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

// The meal-phrase contract. The SAME table lives in uudam-booking-web/tests/meal-phrase-contract.test.mjs:
// the website draws these phrases, the bridge turns them into the chatbot's facts, and the two
// readers are copies (websiteTripBridge.ts MEAL_PATTERNS ↔ booking-web src/lib/itineraryMeals.ts).
// Change a row here only together with the website's table, or the two sides drift apart again.
// "in" = included, "out" = not included, null = not stated.
type State = "in" | "out" | null;
const MEAL_PHRASE_CONTRACT: Array<{ meals: string[]; breakfast: State; lunch: State; dinner: State }> = [
  { meals: ["Өглөө"], breakfast: "in", lunch: null, dinner: null },
  { meals: ["Өглөө", "Өдөр", "Орой"], breakfast: "in", lunch: "in", dinner: "in" },
  { meals: ["Өглөө, Өдрийн хоол, Орой үгүй"], breakfast: "in", lunch: "in", dinner: "out" },
  { meals: ["Оройн хоол өөрийн зардлаар"], breakfast: null, lunch: null, dinner: "out" },
  { meals: ["Үдийн хоол"], breakfast: null, lunch: "in", dinner: null },
  { meals: ["Өдрийн хоол өөрөө"], breakfast: null, lunch: "out", dinner: null },
  { meals: ["3 хоол"], breakfast: "in", lunch: "in", dinner: "in" },
  { meals: ["Бүх хоол"], breakfast: "in", lunch: "in", dinner: "in" },
  { meals: ["Full board"], breakfast: "in", lunch: "in", dinner: "in" },
  { meals: ["Breakfast; Lunch"], breakfast: "in", lunch: "in", dinner: null },
  { meals: ["Dinner not included"], breakfast: null, lunch: null, dinner: "out" },
  { meals: ["Орой", "Орой ороогүй", "Өглөө"], breakfast: "in", lunch: null, dinner: null },
  { meals: [], breakfast: null, lunch: null, dinner: null },
];

const asState = (value: unknown): State => (value === true ? "in" : value === false ? "out" : null);

test("the bridge reads every contract phrase exactly as the website draws it", () => {
  for (const row of MEAL_PHRASE_CONTRACT) {
    // A trip created on the website: no earlier copy, so an unnamed meal stays "not stated".
    const { fields } = websiteTripToCanonicalFields({
      sourceTripId: "meal-contract", title: "Гэрээний аялал", durationDays: 2, durationNights: 1, currency: "MNT", departures: [],
      itinerary: [{ title: "Өдөр нэг", description: "Тайлбар", meals: row.meals }],
    });
    const day = ((fields.extra?.itinerary_days ?? []) as Array<{ meals?: Record<string, unknown> }>)[0];
    const meals = day?.meals ?? {};
    assert.deepEqual(
      { breakfast: asState(meals.breakfast), lunch: asState(meals.lunch), dinner: asState(meals.dinner) },
      { breakfast: row.breakfast, lunch: row.lunch, dinner: row.dinner },
      JSON.stringify(row.meals),
    );
  }
});
