import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

let parseAgeRange: typeof import("../src/components/admin/TripEditModal").parseAgeRange;
let formatAgeRange: typeof import("../src/components/admin/TripEditModal").formatAgeRange;
before(async () => {
  ({ parseAgeRange, formatAgeRange } = await import("../src/components/admin/TripEditModal"));
});

test("parseAgeRange reads a months range and keeps the сар unit", () => {
  assert.deepEqual(parseAgeRange("0-23 сар"), { min: "0", max: "23", unit: "сар" });
});

test("parseAgeRange reads a years range and keeps the нас unit", () => {
  assert.deepEqual(parseAgeRange("2-11 нас"), { min: "2", max: "11", unit: "нас" });
});

test("parseAgeRange reads a single-number band", () => {
  assert.deepEqual(parseAgeRange("12 сар"), { min: "12", max: "", unit: "сар" });
});

test("parseAgeRange on an empty string defaults to нас with no numbers", () => {
  assert.deepEqual(parseAgeRange(""), { min: "", max: "", unit: "нас" });
});

test("formatAgeRange round-trips a min/max/unit triple", () => {
  assert.equal(formatAgeRange("0", "23", "сар"), "0-23 сар");
  assert.equal(formatAgeRange("2", "11", "нас"), "2-11 нас");
});

test("formatAgeRange with only a min (no max) formats as a single number", () => {
  assert.equal(formatAgeRange("12", "", "сар"), "12 сар");
});

test("formatAgeRange with nothing entered yields an empty string", () => {
  assert.equal(formatAgeRange("", "", "нас"), "");
});

test("parse then format round-trips exactly for every real shape seen in the catalog", () => {
  for (const original of ["0-23 сар", "2-11 нас", "0-2 нас", "3-10 нас"]) {
    const { min, max, unit } = parseAgeRange(original);
    assert.equal(formatAgeRange(min, max, unit), original);
  }
});
