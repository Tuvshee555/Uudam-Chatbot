import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("timed pauses are capped at 30 days; a person's take-over with no duration lasts until released", async () => {
  applyTestEnv();
  const { AUTO_PAUSE_RESET_DAYS, UNTIL_RELEASED_AT } = await import("../src/lib/travelSessionDb");

  assert.equal(AUTO_PAUSE_RESET_DAYS, 30);
  assert.ok(Date.parse(UNTIL_RELEASED_AT) - Date.now() > 100 * 365 * 86_400_000, "only «Ботод буцаах» ends it");
});

test("admin quick pause options include the 30-day takeover window", async () => {
  const [{ DURATIONS: adminDurations }, { DURATIONS: pageDurations }] = await Promise.all([
    import("../src/lib/adminUtils"),
    import("../src/lib/adminPageUtils"),
  ]);

  const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
  assert.equal(adminDurations.some((option) => option.ms === thirtyDaysMs), true);
  assert.equal(pageDurations.some((option) => option.ms === thirtyDaysMs), true);
});
