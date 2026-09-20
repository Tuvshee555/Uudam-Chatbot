import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

let pauseRowStillActive: typeof import("../src/lib/travelSessionDb").pauseRowStillActive;
before(async () => {
  ({ pauseRowStillActive } = await import("../src/lib/travelSessionDb"));
});

const NOW = new Date("2026-09-11T05:00:00.000Z");

test("a paused row with NO expiry is never treated as still paused", () => {
  // Regression: the old rule was `expires_at && expired`, so a null expiry
  // skipped the auto-clear and returned "paused" forever. Two real senders
  // sat silenced from 2026-06-28 until this was found on 2026-09-11 — the
  // bot read their messages and dropped them without replying.
  assert.equal(
    pauseRowStillActive({ paused: true, expires_at: null }, NOW),
    false,
  );
});

test("a paused row whose expiry has passed is no longer paused", () => {
  assert.equal(
    pauseRowStillActive({ paused: true, expires_at: "2026-09-10T00:00:00.000Z" }, NOW),
    false,
  );
});

test("a paused row with a future expiry is still paused", () => {
  assert.equal(
    pauseRowStillActive({ paused: true, expires_at: "2026-09-20T00:00:00.000Z" }, NOW),
    true,
  );
});

test("an unpaused row is never paused, whatever the expiry says", () => {
  assert.equal(
    pauseRowStillActive({ paused: false, expires_at: "2026-09-20T00:00:00.000Z" }, NOW),
    false,
  );
  assert.equal(pauseRowStillActive({ paused: false, expires_at: null }, NOW), false);
});

test("a sender with no row at all is never paused", () => {
  assert.equal(pauseRowStillActive(undefined, NOW), false);
});
