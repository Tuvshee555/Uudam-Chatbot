import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { ContentSnapshot } from "../src/lib/websiteTripSync";

applyTestEnv();

// Static imports are hoisted above applyTestEnv(), and env.ts validates on
// load — pull the module in only after the env is set, same pattern as
// tests/trip-categorization.test.ts.
let contentSnapshotHash: typeof import("../src/lib/websiteTripSync").contentSnapshotHash;
let staffEditHoldsContent: typeof import("../src/lib/websiteTripSync").staffEditHoldsContent;
before(async () => {
  ({ contentSnapshotHash, staffEditHoldsContent } = await import("../src/lib/websiteTripSync"));
});

const SNAPSHOT: ContentSnapshot = {
  title: "ЖИНИН – ХӨХ ХОТ - ОРДОС", description: "Тайлбар", hotel: "4 od zochid buudal",
  included: ["Тийз"], excluded: ["Оройн хоол"], importantNotes: [],
};

test("a brand-new trip (no prior row) is never held back", () => {
  const held = staffEditHoldsContent({
    hasPriorTrip: false, freshHash: contentSnapshotHash(SNAPSHOT), priorHash: null,
    priorUpdatedAt: null, priorLastSyncedAt: null,
  });
  assert.equal(held, false);
});

test("a routine resync with unchanged chatbot content and no website edit is not held back", () => {
  const hash = contentSnapshotHash(SNAPSHOT);
  const held = staffEditHoldsContent({
    hasPriorTrip: true, freshHash: hash, priorHash: hash,
    priorUpdatedAt: "2026-09-01T00:00:00Z", priorLastSyncedAt: "2026-09-02T00:00:00Z",
  });
  assert.equal(held, false);
});

test("staff editing the trip on the website after the last sync holds the content fields back", () => {
  const hash = contentSnapshotHash(SNAPSHOT);
  const held = staffEditHoldsContent({
    hasPriorTrip: true, freshHash: hash, priorHash: hash,
    priorUpdatedAt: "2026-09-05T00:00:00Z", // edited on the website...
    priorLastSyncedAt: "2026-09-02T00:00:00Z", // ...after the last sync wrote it
  });
  assert.equal(held, true);
});

test("a genuine new chatbot-side content edit always clears an existing hold", () => {
  const changed: ContentSnapshot = { ...SNAPSHOT, description: "Шинэчилсэн тайлбар" };
  const held = staffEditHoldsContent({
    hasPriorTrip: true, freshHash: contentSnapshotHash(changed), priorHash: contentSnapshotHash(SNAPSHOT),
    // Even though the website was edited after the last sync, the chatbot
    // itself has since changed too — that new edit must win, not stay locked.
    priorUpdatedAt: "2026-09-05T00:00:00Z", priorLastSyncedAt: "2026-09-02T00:00:00Z",
  });
  assert.equal(held, false);
});

test("no lastSyncedAt yet (pre-existing trip from before this feature) is never held back", () => {
  const hash = contentSnapshotHash(SNAPSHOT);
  const held = staffEditHoldsContent({
    hasPriorTrip: true, freshHash: hash, priorHash: hash,
    priorUpdatedAt: "2026-09-05T00:00:00Z", priorLastSyncedAt: null,
  });
  assert.equal(held, false);
});

test("contentSnapshotHash is stable for identical snapshots and differs when a field changes", () => {
  assert.equal(contentSnapshotHash(SNAPSHOT), contentSnapshotHash({ ...SNAPSHOT }));
  assert.notEqual(contentSnapshotHash(SNAPSHOT), contentSnapshotHash({ ...SNAPSHOT, hotel: "Өөр буудал" }));
});
