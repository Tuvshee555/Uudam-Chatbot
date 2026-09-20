import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

// Static imports are hoisted above applyTestEnv(), and env.ts validates on
// load — pull the module in only after the env is set, same pattern as
// tests/trip-categorization.test.ts.
let mapPosterTripToFields: typeof import("../src/lib/poster/tripMapper").mapPosterTripToFields;
let isFreePriceCell: typeof import("../src/lib/poster/tripMapper").isFreePriceCell;
before(async () => {
  ({ mapPosterTripToFields, isFreePriceCell } = await import("../src/lib/poster/tripMapper"));
});

test("isFreePriceCell recognises Үнэгүй and free, not a blank or numeric cell", () => {
  assert.equal(isFreePriceCell("Үнэгүй"), true);
  assert.equal(isFreePriceCell("free"), true);
  assert.equal(isFreePriceCell(""), false);
  assert.equal(isFreePriceCell(undefined), false);
  assert.equal(isFreePriceCell("300000₮"), false);
});

test("a cell written as Үнэгүй in the infant column maps to infant_price 0 with a documented-free note", () => {
  const fields = mapPosterTripToFields({
    title: "Test trip",
    price_table: {
      columns: ["Том хүн", "Хүүхэд", "Нярай"],
      rows: [{ dates: "7 сарын 6", cells: ["1500000₮", "1200000₮", "Үнэгүй"] }],
    },
  });

  assert.equal(fields.infant_price, 0);
  const infantRule = fields.extra?.child_rules?.find((r) => /нярай/i.test(r.label));
  assert.ok(infantRule, "expected a child_rules entry for the infant column");
  assert.equal(infantRule?.price, 0);
  assert.equal(infantRule?.note, "Үнэгүй");
});

test("Үнэгүй typed into the ADULT column is never parsed as a free adult fare", () => {
  const fields = mapPosterTripToFields({
    title: "Test trip",
    price_table: {
      columns: ["Том хүн", "Хүүхэд", "Нярай"],
      rows: [{ dates: "7 сарын 6", cells: ["Үнэгүй", "1200000₮", "300000₮"] }],
    },
  });

  // A stray "Үнэгүй" in the adult cell must not zero out the real adult price —
  // it simply fails to parse as a number, same as any other unparseable cell.
  assert.equal(fields.adult_price, undefined);
});

test("a blank infant cell stays genuinely missing, not free", () => {
  const fields = mapPosterTripToFields({
    title: "Test trip",
    price_table: {
      columns: ["Том хүн", "Хүүхэд", "Нярай"],
      rows: [{ dates: "7 сарын 6", cells: ["1500000₮", "1200000₮", ""] }],
    },
  });

  assert.equal(fields.infant_price, undefined);
  const infantRule = fields.extra?.child_rules?.find((r) => /нярай/i.test(r.label));
  assert.equal(infantRule, undefined);
});

test("a real 0-priced child cell without a free note never gets treated as free", () => {
  // Guards the isDocumentedFreeFare contract: price alone is never enough,
  // the note must say so — otherwise an unparsed/garbage cell could silently
  // read as "free" downstream.
  const fields = mapPosterTripToFields({
    title: "Test trip",
    price_table: {
      columns: ["Том хүн", "Хүүхэд", "Нярай"],
      rows: [{ dates: "7 сарын 6", cells: ["1500000₮", "1200000₮", "0"] }],
    },
  });

  // A bare "0" with no ₮ and no free wording doesn't parse as a positive
  // price, and isFreePriceCell rejects it too — so it's simply unrecognised,
  // same as blank.
  assert.equal(fields.infant_price, undefined);
});
