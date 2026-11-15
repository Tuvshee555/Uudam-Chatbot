import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { HOLIDAY_CATALOG } from "./helpers/holidayFixture";
import type { TravelTrip } from "../src/lib/travelTypes";

applyTestEnv({});
const catalogue = HOLIDAY_CATALOG as unknown as TravelTrip[];

// Integration regression (2026-11-11): the unknown-place test read chat typing of ordinary words
// ("үеээр" for "үеэр", "ямр" for "ямар") as a place no trip goes to, so "цагаан сарын үеээр ямр
// аялалууд бга вэ" got silence instead of the holiday listing. Typed variants of function words
// (doubled letters, dropped vowels) are not places; a real unknown place still is.
test("typed variants of ordinary words are not places; an unknown place still is", async () => {
  const { unknownPlaceTokens } = await import("../src/lib/placeLikeTokens");
  const unknown = (text: string) => unknownPlaceTokens(text, catalogue);
  for (const text of ["цагаан сарын үеээр ямр аялалууд бга вэ", "Цагаан сарын үеээр аялалууд байнаа юу", "2 сардд явмаар бнаа",
    "шинэ жилийн үеэр ямр аялал бн", "хэдэнн хүүхэдтэй явбал нийт хэд вэ"]) {
    assert.deepEqual(unknown(text), [], text);
  }
  for (const text of ["Цагаан сарын үеээр Оролго явмаар байна", "Шинэ жилээр Оролго явах аялал бн уу"]) {
    assert.ok(unknown(text).length > 0, `an unknown place is still found: ${text}`);
  }
});
