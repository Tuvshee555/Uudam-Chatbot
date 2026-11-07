import assert from "node:assert/strict";
import test from "node:test";
import { decideRefresh, REFRESH_AFTER_DAYS } from "../src/lib/catalogue/autoRefresh";
import type { FreshnessVerdict } from "../src/lib/catalogue/freshness";

const NOW = "2026-11-20T10:00:00.000Z";
const fresh: FreshnessVerdict = { state: "fresh", stale: false, ageDays: 1, reasons: [], code: "ok" };
const staleDrift: FreshnessVerdict = { state: "stale", stale: true, ageDays: 1, reasons: ["price changed"], code: "drift" };
const base = { edition: "complete" as const, published: { generatedAt: "2026-11-19T10:00:00.000Z" }, freshness: fresh, configUpdatedAt: null, publishedTripIds: ["a", "b"], liveTripIds: ["a", "b"], nowIso: NOW };

test("nothing changed: no render", () => {
  assert.deepEqual(decideRefresh(base), { refresh: false, reasons: [] });
});
test("nothing published: refresh", () => {
  assert.deepEqual(decideRefresh({ ...base, published: null }), { refresh: true, reasons: ["none_published"] });
});
test("a price/date/status change (drift) refreshes", () => {
  assert.deepEqual(decideRefresh({ ...base, freshness: staleDrift }).reasons, ["stale:drift"]);
});
test("a NEW trip refreshes the Complete edition, a removed one too; Quick ignores new trips", () => {
  assert.deepEqual(decideRefresh({ ...base, liveTripIds: ["a", "b", "c"] }).reasons, ["new_trips"]);
  assert.deepEqual(decideRefresh({ ...base, liveTripIds: ["a"] }).reasons, ["trips_removed"]);
  assert.equal(decideRefresh({ ...base, edition: "quick", liveTripIds: ["a", "b", "c"] }).refresh, false);
});
test("staff saving the catalogue config (photo, title, cover, notes) after generation refreshes", () => {
  assert.deepEqual(decideRefresh({ ...base, configUpdatedAt: "2026-11-19T12:00:00.000Z" }).reasons, ["config_changed"]);
  assert.equal(decideRefresh({ ...base, configUpdatedAt: "2026-11-19T09:00:00.000Z" }).refresh, false);
});
test(`a file older than ${REFRESH_AFTER_DAYS} days is renewed before the 21-day cutoff`, () => {
  assert.deepEqual(decideRefresh({ ...base, published: { generatedAt: "2026-11-01T10:00:00.000Z" } }).reasons, ["age"]);
});
