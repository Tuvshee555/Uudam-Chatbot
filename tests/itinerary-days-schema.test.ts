import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";

test("normalizeExtra keeps itinerary_days with title/description/hotel/meals, renumbered by position", () => {
  const { extra, warnings } = normalizeExtra({
    itinerary_days: [
      { day: 9, title: "УБ – Хархорин", description: "Замд гарна", hotel: "Kharkhorin Hotel", meals: { breakfast: false, lunch: true, dinner: true } },
      { title: "Хархорин – УБ", description: "Буцна", meals: { breakfast: true } },
    ],
  });
  assert.deepEqual(extra.itinerary_days, [
    { day: 1, title: "УБ – Хархорин", description: "Замд гарна", hotel: "Kharkhorin Hotel", meals: { breakfast: false, lunch: true, dinner: true } },
    { day: 2, title: "Хархорин – УБ", description: "Буцна", meals: { breakfast: true, lunch: false, dinner: false } },
  ]);
  // itinerary_days is a known key now — must not trigger the "unknown field" warning.
  assert.ok(!warnings.some((w) => w.includes("itinerary_days")));
});

test("normalizeExtra keeps blank itinerary rows instead of silently dropping them", () => {
  const { extra } = normalizeExtra({ itinerary_days: [{ title: "", description: "", meals: {} }] });
  assert.deepEqual(extra.itinerary_days, [{ day: 1, title: "", description: "", meals: { breakfast: false, lunch: false, dinner: false } }]);
});

test("normalizeExtra defaults itinerary_days to an empty array when absent or malformed", () => {
  assert.deepEqual(normalizeExtra({}).extra.itinerary_days, []);
  assert.deepEqual(normalizeExtra({ itinerary_days: "not an array" }).extra.itinerary_days, []);
});

test("normalizeExtraPatch only returns itinerary_days when it was actually part of the patch", () => {
  const withIt = normalizeExtraPatch({ itinerary_days: [{ title: "A", description: "" }] });
  assert.ok("itinerary_days" in withIt);

  const without = normalizeExtraPatch({ customer_visible: false });
  assert.ok(!("itinerary_days" in without));
});
