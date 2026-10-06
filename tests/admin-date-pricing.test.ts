import assert from "node:assert/strict";
import test from "node:test";
import { pricingDates, pricingDateRows, patchPricingDate, reconcilePricingDates, renamePricingDate, passengerPricingRows, passengerName } from "../src/lib/adminDatePricing";

test("age is displayed separately without rewriting stored names or custom categories", () => {
  const row = { label: "Хүүхэд 4-12 нас", age_range: "4-12 нас" };
  assert.equal(passengerName(row), "Хүүхэд");
  assert.equal(row.label, "Хүүхэд 4-12 нас");
  assert.equal(passengerName({ label: "Хүүхэд тусдаа ортой", age_range: "4-12 нас" }), "Хүүхэд тусдаа ортой");
  assert.equal(passengerName({ label: "Нярай", age_range: "0-23 сар" }), "Нярай");
});

const bands = [
  { label: "Child", age_range: "6-11", price: 4590000, currency: "MNT", note: "Own bed" },
  { label: "Child", age_range: "2-5", price: 4190000, currency: "MNT" },
  { label: "Infant", age_range: "0-23 months", price: 0, currency: "MNT", note: "Free" },
];
const original = { id: "shared", dates: ["2026-12-06", "2026-12-13"], date_keys: ["2026-12-06", "12/06", "2026-12-13"], display_dates: ["2026-12-06", "2026-12-13"], adult_price: 5890000, passenger_prices: bands, hotel: "Hotel A", package_id: "Guided", availability: { status: "paused" }, custom: { keep: true } };

test("date list deduplicates aliases and retains every hotel/package option", () => {
  assert.deepEqual(pricingDates(original), ["2026-12-06", "2026-12-13"]);
  assert.equal(pricingDateRows([original, { ...original, hotel: "Hotel B" }]).length, 4);
});
test("editing an adult price splits only the selected date and preserves every age tier", () => {
  const result = patchPricingDate([original], { groupIndex: 0, date: "2026-12-13" }, { adult_price: 6990000 });
  assert.equal(result.length, 2);
  assert.deepEqual(pricingDates(result[0]), ["2026-12-06"]);
  assert.equal(result[0].adult_price, 5890000);
  assert.deepEqual(pricingDates(result[1]), ["2026-12-13"]);
  assert.equal(result[1].adult_price, 6990000);
  assert.deepEqual(result[1].passenger_prices, bands);
  assert.equal(result[1].hotel, "Hotel A");
  assert.deepEqual(result[1].availability, { status: "paused" });
  assert.deepEqual(result[1].custom, { keep: true });
  assert.equal(result[1].id, undefined);
  assert.equal(original.adult_price, 5890000);
});
test("child/infant edits do not overwrite another date or competing package", () => {
  const alternative = { ...original, hotel: "Hotel B", package_id: "Free", adult_price: 7000000 };
  const result = patchPricingDate([original, alternative], { groupIndex: 0, date: "2026-12-06" }, { passenger_prices: bands.map((band, index) => index === 0 ? { ...band, price: 4800000 } : band) });
  assert.equal(result[0].passenger_prices[0].price, 4590000);
  assert.equal(result[1].passenger_prices[0].price, 4800000);
  assert.deepEqual(result[2], alternative);
});
test("single-date edits preserve the original ID and metadata", () => {
  const group = { ...original, dates: ["2026-12-06"], date_keys: ["2026-12-06"], display_dates: [] };
  const result = patchPricingDate([group], { groupIndex: 0, date: "2026-12-06" }, { adult_price: 0 });
  assert.equal(result[0].id, "shared");
  assert.equal(result[0].adult_price, 0);
  assert.deepEqual(result[0].custom, original.custom);
});
test("changing a date keeps the rest of the shared dates intact", () => {
  const result = patchPricingDate([original], { groupIndex: 0, date: "2026-12-06" }, { dates: ["2026-12-20"], date_keys: ["2026-12-20"], display_dates: ["2026-12-20"] });
  assert.deepEqual(pricingDates(result[0]), ["2026-12-13"]);
  assert.deepEqual(pricingDates(result[1]), ["2026-12-20"]);
});
test("undated and natural-language fares remain editable", () => {
  assert.deepEqual(pricingDateRows([{ dates: [] }, { dates: ["Every Friday"] }]), [{ groupIndex: 0, date: "" }, { groupIndex: 1, date: "Every Friday" }]);
});
test("legacy child and infant fares stay visible without creating fake zero fares", () => {
  assert.deepEqual(passengerPricingRows({ child_price: 400, child_age: "2-12", infant_price: 0, infant_age: "0-23 months", currency: "USD" }), [
    { label: "Хүүхэд", age_range: "2-12", price: 400, currency: "USD" },
    { label: "Нярай", age_range: "0-23 months", price: 0, currency: "USD" },
  ]);
  assert.deepEqual(passengerPricingRows({ child_price: null, infant_price: null }), []);
  assert.deepEqual(passengerPricingRows(original), bands);
});
test("date removal and addition keep the shared departure list in sync without losing recurring rules", () => {
  const before = [{ dates: ["2026-12-06", "2026-12-13"] }];
  const after = [{ dates: ["2026-12-13", "2026-12-20"] }];
  assert.deepEqual(reconcilePricingDates(["2026-12-06", "2026-12-13", "Every Friday"], before, after), ["2026-12-13", "Every Friday", "2026-12-20"]);
});
test("renaming a departure moves every hotel option without touching other dates", () => {
  const result = renamePricingDate([original, { ...original, hotel: "Hotel B" }], "2026-12-06", "2026-12-20");
  assert.deepEqual(result.map(pricingDates), [["2026-12-13"], ["2026-12-20"], ["2026-12-13"], ["2026-12-20"]]);
  assert.equal(result[3].hotel, "Hotel B");
});
