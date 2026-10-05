import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { readFileSync } from "node:fs";
import { sameDatabase, websiteProjectionTransaction } from "../src/lib/websiteSyncTransaction";

test("automatic website projection does not delete retained trips, departures or days", () => {
  const source = readFileSync(new URL("../src/lib/websiteTripSync.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /DELETE\s+FROM\s+"(?:Trip|Departure|ItineraryDay)"/i);
});

function clientFixture() {
  const queries: string[] = [];
  const client = { query: async (query: string) => { queries.push(query); return { rows: [] }; } } as unknown as PoolClient;
  return { client, queries };
}

test("shared database detection handles pooled URLs and ignores credentials", () => {
  assert.equal(sameDatabase("postgres://one:a@ep-example-pooler.neon.tech/db", "postgresql://two:b@ep-example.neon.tech:5432/db"), true);
  assert.equal(sameDatabase("postgres://one:a@ep-example.neon.tech/db", "postgres://one:a@ep-example.neon.tech/other"), false);
  assert.equal(sameDatabase(null, "postgres://one:a@ep-example.neon.tech/db"), false);
  assert.equal(sameDatabase("https://example.com/db", "https://example.com/db"), false);
});

test("a shared projection never commits before the caller records sync status", async () => {
  const { client, queries } = clientFixture();
  const result = await websiteProjectionTransaction(client, true, async db => {
    assert.equal(db, client);
    await db.query("projection update");
    return "saved";
  });
  assert.equal(result, "saved");
  assert.deepEqual(queries, ["projection update"]);
});

test("shared projection errors reach the caller without ending its transaction", async () => {
  const { client, queries } = clientFixture();
  await assert.rejects(websiteProjectionTransaction(client, true, async () => { throw new Error("conflict"); }), /conflict/);
  assert.deepEqual(queries, []);
});

test("a separate database projection owns its successful transaction", async () => {
  const { client, queries } = clientFixture();
  await websiteProjectionTransaction(client, false, async db => { await db.query("projection update"); });
  assert.deepEqual(queries, ["BEGIN", "projection update", "COMMIT"]);
});

test("a separate database projection rolls back on failure", async () => {
  const { client, queries } = clientFixture();
  await assert.rejects(websiteProjectionTransaction(client, false, async () => { throw new Error("conflict"); }), /conflict/);
  assert.deepEqual(queries, ["BEGIN", "ROLLBACK"]);
});
