/**
 * A day picked in the trip editor's calendar is kept (2026-11-14: on a price row that held
 * "2026-12-20" the picked «11 сарын 30» was dropped by the row reader, so the date never appeared).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { isoDay } from "../src/components/admin/tripEditor/PricingEditor";
import { pricingDateRows, pricingDates } from "../src/lib/adminDatePricing";

test("a picked day is written with its year, from the local calendar day", () => {
  assert.equal(isoDay(new Date(2098, 10, 30)), "2098-11-30");
  assert.equal(isoDay(new Date(2098, 0, 5, 23, 59)), "2098-01-05");
});

test("a dated price row keeps a second picked day, and the editor lists both", () => {
  const group = { dates: ["2098-12-20", isoDay(new Date(2098, 10, 30))], date_keys: ["2098-12-20", "2098-11-30"], display_dates: ["2098-12-20", "2098-11-30"] };
  assert.deepEqual(pricingDates(group), ["2098-12-20", "2098-11-30"]);
  assert.deepEqual(pricingDateRows([group]).map((row) => row.date), ["2098-12-20", "2098-11-30"]);
  // The old picker's yearless text next to a dated day was dropped: why the fix writes ISO.
  assert.deepEqual(pricingDates({ dates: ["2098-12-20", "11 сарын 30"], date_keys: ["2098-12-20", "11 сарын 30"], display_dates: [] }), ["2098-12-20"]);
});
