import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

let mapPosterTripToFields: typeof import("../src/lib/poster/tripMapper").mapPosterTripToFields;
before(async () => {
  ({ mapPosterTripToFields } = await import("../src/lib/poster/tripMapper"));
});

function ageRangeFor(columnLabel: string): string {
  const fields = mapPosterTripToFields({
    title: "Test trip",
    price_table: {
      columns: ["Том хүн", columnLabel],
      rows: [{ dates: "7 сарын 6", cells: ["1500000₮", "300000₮"] }],
    },
  });
  const rule = fields.extra?.child_rules?.[0];
  return rule?.age_range || "";
}

test("a column labelled in months keeps the сар unit, not нас", () => {
  // Regression: this used to come out as "0-23 нас" (23 YEARS), silently
  // relabelling a real infant band as a much older child band — every
  // downstream reader tells infant from child by checking for "сар".
  assert.equal(ageRangeFor("Нярай 0-23 сар"), "0-23 сар");
});

test("a column labelled in years keeps the нас unit", () => {
  assert.equal(ageRangeFor("Хүүхэд 2-11 нас"), "2-11 нас");
});

test("a column with no unit word at all defaults to нас", () => {
  assert.equal(ageRangeFor("Хүүхэд 2-11"), "2-11 нас");
});

test("a single-number months column keeps сар", () => {
  assert.equal(ageRangeFor("Нярай 12 сар хүртэл"), "12 сар");
});
