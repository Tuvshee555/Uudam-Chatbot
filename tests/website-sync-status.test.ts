import assert from "node:assert/strict";
import test from "node:test";
import { hasWebsiteSyncConflict, parseWebsiteSyncStatus, summarizeWebsiteSync, type WebsiteSyncRow } from "../src/lib/websiteSyncStatus";

const row: WebsiteSyncRow = { trip_id: "velmor", trip_name: "Вэлмор аялал", synced: true, last_error: null, website_slug: "velmor" };

test("a delivered row with content conflicts still requires review", () => {
  const rows = [row, { ...row, trip_id: "nerith", content_conflict: true }, { ...row, trip_id: "tarmiz", shared_conflict_count: 2 }];
  assert.deepEqual(summarizeWebsiteSync(rows), { total: 3, synced: 3, pending: 0, failed: 0, conflicts: 2, lastSyncedAt: null });
  assert.equal(hasWebsiteSyncConflict(rows[2]), true);
});

test("pending failures, historical errors and successful delivery times are counted independently", () => {
  const rows = [
    { ...row, synced: false, last_error: "Fixture unavailable", synced_at: "2098-02-01T00:00:00Z" },
    { ...row, trip_id: "nerith", last_error: "Prior late error", synced_at: "2098-02-03T00:00:00Z" },
    { ...row, trip_id: "tarmiz", synced_at: "not-a-date" },
  ];
  assert.deepEqual(summarizeWebsiteSync(rows), { total: 3, synced: 2, pending: 1, failed: 2, conflicts: 0, lastSyncedAt: "2098-02-03T00:00:00Z" });
});

test("missing or malformed status data cannot be mistaken for a cleared queue", () => {
  for (const value of [null, {}, { configured: true }, { configured: true, trips: null },
    { configured: "true", trips: [] }, { configured: true, trips: [{ ...row, synced: "true" }] },
    { configured: true, trips: [{ ...row, trip_id: "" }] }, { configured: true, trips: [{ ...row, content_conflict: "false" }] },
    { configured: true, trips: [{ ...row, shared_conflict_count: -1 }] }]) assert.equal(parseWebsiteSyncStatus(value), null);
  assert.deepEqual(parseWebsiteSyncStatus({ configured: true, trips: [row] }), { configured: true, trips: [row] });
  assert.deepEqual(parseWebsiteSyncStatus({ configured: false, trips: [] }), { configured: false, trips: [] });
});

test("database timestamp values survive summary generation before JSON serialization", async () => {
  const { types } = await import("pg");
  const timestamp = types.getTypeParser(1184)("2098-02-03 04:05:06+00") as Date;
  assert.ok(timestamp instanceof Date);
  assert.equal(summarizeWebsiteSync([{ ...row, synced_at: timestamp }]).lastSyncedAt, "2098-02-03T04:05:06.000Z");
});
