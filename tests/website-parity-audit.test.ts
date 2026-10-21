import assert from "node:assert/strict";
import test from "node:test";
import { types } from "pg";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { auditWebsiteParityPairs, type WebsiteParityInput } from "../scripts/lib/websiteParityPairs";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

const now = new Date("2098-01-01T00:00:00.000Z");

function fixture(id = "velmor"): WebsiteParityInput {
  const website = {
    id: `web-${id}`, sourceTripId: id, slug: `trip-${id}`, title: "Вэлмор аялал", description: "Invented description",
    summary: "Invented summary", price: 1_234_567, childPrice: null, infantPrice: null, currency: "MNT",
    durationDays: 3, durationNights: 2, isPublished: true, included: [], excluded: [], importantNotes: [],
    image: "", extraImages: [], itinerary: [],
    departures: [{ startDate: "2098-03-04T00:00:00.000Z", status: "OPEN", seatsLeft: 5, price: 1_234_567, childPrice: null, infantPrice: null }],
  };
  return { website, source: { id, category: "", operator_name: "Invented", route_name: "Вэлмор аялал", duration_text: "3 өдөр 2 шөнө",
    adult_price: null, child_price: null, infant_price: null, currency: "MNT", departure_dates: [], seats_total: 12, seats_left: 5,
    has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "",
    ...websiteTripToCanonicalFields(website).fields } };
}

test("SQL JSONB timestamps and API-serialized Date values produce the same successful audit", () => {
  const sql = fixture();
  const raw = { ...sql.website, departures: [{ ...(sql.website.departures as Record<string, unknown>[])[0], startDate: "2098-03-04T00:00:00.123" }] };
  sql.website = types.getTypeParser(3802)(JSON.stringify(raw));
  const api = fixture();
  api.website = JSON.parse(JSON.stringify({ ...api.website, departures: [{ ...(api.website.departures as Record<string, unknown>[])[0], startDate: new Date("2098-03-04T00:00:00.123Z") }] }));
  const sqlResult = auditWebsiteParityPairs([sql], now);
  const apiResult = auditWebsiteParityPairs([api], now);
  assert.deepEqual(sqlResult, apiResult);
  assert.equal(sqlResult.invalidPairs.length, 0);
  assert.equal(sqlResult.pairs.length, 1);
  assert.deepEqual(sqlResult.pairs[0].differences, []);
  assert.deepEqual(sqlResult.pairs[0].projectionFareDifferences, []);
  assert.equal(sqlResult.pairs[0].generatedDepartureCount, 1);
});

test("one malformed trip is an explicit finding and does not hide valid comparisons", () => {
  const invalid = fixture("nerith");
  invalid.website.departures = [{ startDate: "2098-02-30T00:00:00", status: "OPEN" }];
  const valid = fixture();
  const before = structuredClone([invalid, valid]);
  const result = auditWebsiteParityPairs([invalid, valid], now);
  assert.deepEqual(result.invalidPairs, [{ websiteId: "web-nerith", sourceTripId: "nerith", slug: "trip-nerith", error: "Invalid website trip field: departures.startDate" }]);
  assert.equal(result.pairs.length, 1);
  assert.equal(result.pairs[0].sourceTripId, "velmor");
  assert.equal(result.pairs.some(pair => pair.sourceTripId === "nerith"), false);
  assert.deepEqual([invalid, valid], before, "audit never mutates either source");
});

test("historical duplicate rows use the bridge's current departure for projection", () => {
  const input = fixture();
  const current = (input.website.departures as Record<string, unknown>[])[0];
  input.website.departures = [{ ...current, status: "CANCELLED", seatsLeft: 0, price: 7_654_321 }, current];
  const result = auditWebsiteParityPairs([input], now);
  assert.deepEqual(result.invalidPairs, []);
  assert.equal(result.pairs[0].storedDepartureCount, 2, "retained rows remain inventoried");
  assert.equal(result.pairs[0].generatedDepartureCount, 1);
  assert.deepEqual(result.pairs[0].projectionFareDifferences, []);
});

test("programming failures are never reported as a successful or merely invalid trip", () => {
  const input = fixture();
  Object.defineProperty(input.website, "departures", { get() { throw new Error("Fixture programmer failure"); } });
  assert.throws(() => auditWebsiteParityPairs([input], now), /Fixture programmer failure/);
});

test("the read-only CLI writes mixed results before returning a failing exit code", () => {
  const valid = fixture();
  const invalid = fixture("nerith");
  invalid.website.departures = [{ startDate: "invalid", status: "OPEN" }];
  const base = resolve("tmp");
  mkdirSync(base, { recursive: true });
  const scratch = mkdtempSync(join(base, "parity-cli-fixture-"));
  const output = join(scratch, "report.json");
  const env = join(scratch, "fixture.env");
  const preload = join(scratch, "fixture.mjs");
  writeFileSync(env, "DATABASE_URL=postgres://fixture:fixture@127.0.0.1:1/parity-fixture\n");
  writeFileSync(preload, `import { Pool } from 'pg';
const website = ${JSON.stringify([invalid.website, valid.website])};
const canonical = ${JSON.stringify([invalid.source, valid.source])};
globalThis.fetch = async () => { throw new Error('Unexpected network request'); };
const query = async (sql) => {
  if (/^BEGIN TRANSACTION.*READ ONLY$|^COMMIT$|^ROLLBACK$/.test(sql)) return { rows: [] };
  if (!/^SELECT\\b/.test(sql)) throw new Error('Audit attempted a database mutation');
  if (sql.includes('FROM "Trip" t ORDER BY t.id')) {
    if (!/"dayNumber">0/.test(sql)) throw new Error('Archived itinerary rows must stay excluded');
    return { rows: website };
  }
  if (sql.includes('SELECT * FROM travel_trip_entries ORDER BY id')) return { rows: canonical };
  return { rows: [] };
};
Pool.prototype.connect = async () => ({ query, release() {} });
Pool.prototype.end = async () => {};
`);
  try {
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", pathToFileURL(preload).href,
      "scripts/audit-website-parity.ts", output, env], { cwd: process.cwd(), encoding: "utf8", timeout: 20_000 });
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.readOnly, true);
    assert.equal(report.summary.linkedPairs, 2);
    assert.equal(report.summary.auditedPairs, 1);
    assert.equal(report.summary.invalidPairs, 1);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.invalidPairs[0].sourceTripId, "nerith");
    assert.equal(report.pairs[0].sourceTripId, "velmor");
    assert.equal(JSON.parse(result.stdout).invalidPairs, 1, "CLI summary makes incomplete coverage explicit");
  } finally {
    assert.ok(resolve(scratch).startsWith(base + sep));
    rmSync(scratch, { recursive: true, force: true });
  }
});
