import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

test("human takeover pauses default to 30 days", async () => {
  applyTestEnv();
  const { AUTO_PAUSE_RESET_DAYS } = await import("../src/lib/travelSessionDb");

  assert.equal(AUTO_PAUSE_RESET_DAYS, 30);
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
