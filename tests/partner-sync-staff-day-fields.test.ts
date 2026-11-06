/**
 * A meal note and a day photo staff add to a partner trip's day survive the
 * 30-minute partner sync, and a run with nothing new from the partner writes
 * nothing. The tour fixture is invented.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";
import { partnerTripFields } from "../src/lib/partnerSync/tripPayload";
import { normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { tour } from "./fixtures/partner-tour";

type Row = Record<string, unknown>;
const PHOTO = "https://res.cloudinary.com/demo/image/upload/sample-day-one.jpg";

/** run.ts's "unchanged" test for the trip's extra: every key it would write already holds that value. */
const extraUnchanged = (desired: Row, stored: Row) =>
  Object.entries(normalizeExtraPatch(desired)).every(([key, value]) => isDeepStrictEqual(stored[key], value));

test("a staff meal note and day photo survive a partner sync with no partner change, and the next run is a no-op", () => {
  const first = normalizeExtraPatch(partnerTripFields(tour(), {}, {}).extra ?? {});
  const days = (first.itinerary_days as Row[]).map((day) => day.day === 1
    ? { ...day, meal_note: "Зохиомол ресторанд оройн хоол", photo: PHOTO } : day);
  const stored: Row = { ...first, itinerary_days: days };

  const desired = partnerTripFields(tour(), {}, stored).extra ?? {};
  const synced = normalizeExtraPatch(desired).itinerary_days as Row[];
  assert.equal(synced[0].meal_note, "Зохиомол ресторанд оройн хоол");
  assert.equal(synced[0].photo, PHOTO);
  assert.equal("meal_note" in synced[1], false);
  assert.ok(extraUnchanged(desired, stored), "nothing to write: the stored day already says this");
});

test("the partner still owns the day's own facts: a changed partner day is taken, the staff note stays", () => {
  const first = normalizeExtraPatch(partnerTripFields(tour(), {}, {}).extra ?? {});
  const stored: Row = { ...first, itinerary_days: (first.itinerary_days as Row[]).map((day) => ({ ...day, meal_note: `Тэмдэглэл ${day.day}` })) };
  const changed = tour();
  changed.days = changed.days.map((day) => day.day === 2 ? { ...day, title: "Return by sea", meals: { breakfast: true, lunch: true, dinner: false } } : day);
  const synced = normalizeExtraPatch(partnerTripFields(changed, {}, stored).extra ?? {}).itinerary_days as Row[];
  assert.equal(synced[1].title, "Return by sea");
  assert.deepEqual(synced[1].meals, { breakfast: true, lunch: true, dinner: false });
  assert.deepEqual(synced.map((day) => day.meal_note), ["Тэмдэглэл 1", "Тэмдэглэл 2"]);
});
