import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

let isBookingIntent: typeof import("../src/lib/webhookMedia").isBookingIntent;
before(async () => {
  ({ isBookingIntent } = await import("../src/lib/webhookMedia"));
});

test("Latin-typed Mongolian booking intent is recognised", () => {
  // Regression, live conversation 2026-09-11: the customer typed
  // "zahialga hiie" — an unambiguous buy signal — and the bot re-sent the
  // price block it had just sent instead of starting the booking flow,
  // because only the Cyrillic spellings were matched.
  assert.equal(isBookingIntent("zahialga hiie"), true);
  assert.equal(isBookingIntent("zahialah"), true);
  assert.equal(isBookingIntent("burtguuleh"), true);
  assert.equal(isBookingIntent("suudal avya"), true);
  assert.equal(isBookingIntent("tiiz avya"), true);
});

test("Cyrillic booking intent still works", () => {
  assert.equal(isBookingIntent("захиалга хийе"), true);
  assert.equal(isBookingIntent("бүртгүүлье"), true);
  assert.equal(isBookingIntent("суудал авъя"), true);
  assert.equal(isBookingIntent("book хийе"), true);
});

test("ordinary questions are not mistaken for booking intent", () => {
  assert.equal(isBookingIntent("үнэ хэд вэ"), false);
  assert.equal(isBookingIntent("une hed ve"), false);
  assert.equal(isBookingIntent("hi"), false);
  assert.equal(isBookingIntent("shanhai aylal medeelel"), false);
  assert.equal(isBookingIntent(""), false);
});
