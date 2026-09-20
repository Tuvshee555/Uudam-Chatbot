import assert from "node:assert/strict";
import test from "node:test";
import { deriveChildRules, withDerivedSummaryFields } from "../src/lib/priceGroups";
import type { PriceGroup } from "../src/lib/adminTypes";

function group(fields: Partial<PriceGroup>): PriceGroup {
  return {
    label: "", dates: [], display_dates: [], date_keys: [],
    adult_price: null, child_price: null, infant_price: null,
    child_age: "", infant_age: "", passenger_prices: [], note: "",
    ...fields,
  };
}

test("child_rules is exactly the deduped union of every group's passenger_prices", () => {
  const groups = [
    group({ passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1200000, currency: "MNT" }] }),
    group({ passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1200000, currency: "MNT" }] }),
  ];
  const rules = deriveChildRules(groups);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].price, 1200000);
});

test("two different prices for the same label are kept as separate rules", () => {
  const groups = [
    group({ passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1200000, currency: "MNT" }] }),
    group({ passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 1290000, currency: "MNT" }] }),
  ];
  const rules = deriveChildRules(groups);
  assert.equal(rules.length, 2);
});

test("an unpriced passenger entry never becomes a child_rules row", () => {
  const groups = [group({ passenger_prices: [{ label: "Нярай", age_range: "0-2 нас", price: null, currency: "MNT" }] })];
  assert.deepEqual(deriveChildRules(groups), []);
});

test("a free-marked passenger price carries its Үнэгүй note into the derived rule", () => {
  const groups = [group({ passenger_prices: [{ label: "Нярай", age_range: "", price: 0, currency: "MNT", note: "Үнэгүй" }] })];
  const rules = deriveChildRules(groups);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].price, 0);
  assert.equal(rules[0].note, "Үнэгүй");
});

test("no groups at all derives no rules", () => {
  assert.deepEqual(deriveChildRules([]), []);
});

test("a trip with no price groups yet can still declare infant free from the base tab", () => {
  const rules = deriveChildRules([], { infant: true });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].label, "Нярай");
  assert.equal(rules[0].price, 0);
  assert.equal(rules[0].note, "Үнэгүй");
});

test("the base-tab free flag also works for child, independently of infant", () => {
  const rules = deriveChildRules([], { child: true });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].label, "Хүүхэд");
});

test("a real infant band in a price group wins over the base-tab free flag", () => {
  // If the trip HAS priced its infant tier per date group, that real number
  // must never be silently overridden by a leftover base-tab checkbox.
  const g = group({ passenger_prices: [{ label: "Нярай", age_range: "0-23 сар", price: 350000, currency: "MNT" }] });
  const rules = deriveChildRules([g], { infant: true });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].price, 350000);
});

test("base-tab free flags are false by default and add nothing", () => {
  assert.deepEqual(deriveChildRules([], {}), []);
});

test("withDerivedSummaryFields backfills the legacy flat child/infant fields from passenger_prices", () => {
  const g = group({
    passenger_prices: [
      { label: "Хүүхэд", age_range: "2-11 нас", price: 1200000, currency: "MNT" },
      { label: "Нярай", age_range: "0-23 сар", price: 300000, currency: "MNT" },
    ],
  });
  const result = withDerivedSummaryFields(g);
  assert.equal(result.child_price, 1200000);
  assert.equal(result.child_age, "2-11 нас");
  assert.equal(result.infant_price, 300000);
  assert.equal(result.infant_age, "0-23 сар");
});

test("withDerivedSummaryFields classifies by age shape, not label spelling", () => {
  // Real catalog data: an infant tier mislabeled "Хүүхэд" but shaped like an
  // infant band (age in months) must still land in infant_price, not child_price.
  const g = group({
    passenger_prices: [{ label: "Хүүхэд", age_range: "0-23 сар", price: 350000, currency: "MNT" }],
  });
  const result = withDerivedSummaryFields(g);
  assert.equal(result.infant_price, 350000);
  assert.equal(result.child_price, null);
});

test("withDerivedSummaryFields leaves child/infant null when no band exists", () => {
  const result = withDerivedSummaryFields(group({ passenger_prices: [] }));
  assert.equal(result.child_price, null);
  assert.equal(result.infant_price, null);
});

test("withDerivedSummaryFields ignores an unpriced band", () => {
  const g = group({ passenger_prices: [{ label: "Нярай", age_range: "0-2 нас", price: null, currency: "MNT" }] });
  const result = withDerivedSummaryFields(g);
  assert.equal(result.infant_price, null);
});
