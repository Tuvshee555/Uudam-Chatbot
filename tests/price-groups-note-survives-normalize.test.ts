import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExtra, normalizeExtraPatch } from "../src/lib/tripExtraSchema";

// Regression: normalizePassengerPrices used to whitelist only label/age_range/
// price/currency, silently dropping a passenger_prices entry's "note" field —
// the exact field isDocumentedFreeFare reads to tell a real 0 (free) from a
// blank/missing price. A trip saved as infant-free would pass the completeness
// check once, then regress back to "missing data" on the very next save.
const GROUP_WITH_FREE_INFANT = {
  label: "Үнэ", dates: [], display_dates: [], date_keys: [],
  adult_price: 1190000, child_price: 890000, infant_price: 0,
  child_age: "", infant_age: "", note: "",
  passenger_prices: [
    { label: "Хүүхэд", age_range: "2-11 нас", price: 890000, currency: "MNT" },
    { label: "Нярай", age_range: "", price: 0, currency: "MNT", note: "Үнэгүй" },
  ],
};

test("normalizeExtra keeps a passenger_prices note through full normalization", () => {
  const { extra } = normalizeExtra({ price_groups: [GROUP_WITH_FREE_INFANT] });
  const groups = extra.price_groups as Array<Record<string, unknown>>;
  const infant = (groups[0].passenger_prices as Array<Record<string, unknown>>)
    .find((p) => p.label === "Нярай");
  assert.equal(infant?.note, "Үнэгүй");
});

test("normalizeExtraPatch (the save-time path) also keeps the note", () => {
  const patched = normalizeExtraPatch({ price_groups: [GROUP_WITH_FREE_INFANT] });
  const groups = patched.price_groups as Array<Record<string, unknown>>;
  const infant = (groups[0].passenger_prices as Array<Record<string, unknown>>)
    .find((p) => p.label === "Нярай");
  assert.equal(infant?.note, "Үнэгүй");
});

test("a passenger_prices entry with no note normalizes to an empty string, not undefined", () => {
  const { extra } = normalizeExtra({ price_groups: [GROUP_WITH_FREE_INFANT] });
  const groups = extra.price_groups as Array<Record<string, unknown>>;
  const child = (groups[0].passenger_prices as Array<Record<string, unknown>>)
    .find((p) => p.label === "Хүүхэд");
  assert.equal(child?.note, "");
});
