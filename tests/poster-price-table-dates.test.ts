import assert from "node:assert/strict";
import test from "node:test";
import { normalizePosterPriceTable, normalizePriceTable } from "../src/lib/poster/priceTableNormalize";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";

/** A source table that prints the date as its own columns, as one uploaded document did (invented values). */
const SPLIT = {
  columns: ["Гарах сар", "Өдөр", "Том хүн", "3-11настай хүүхэд оргүй"],
  rows: [
    { dates: "2026 он 10 сар 26", cells: ["2026 он 10 сар", "26", "2460юань", "2060юань"] },
    { dates: "2026 он 11 сар 11,25", cells: ["2026 он 11 сар", "11,25", "1600000₮", "1400000₮"] },
    { dates: "", cells: ["2026 он 12 сар", "9", "1700000₮", "1500000₮"] },
  ],
  note: "",
};

test("date columns are folded into the row date and never shown as fares", () => {
  const fixed = normalizePriceTable(SPLIT)!;
  assert.deepEqual(fixed.columns, ["Том хүн", "3-11настай хүүхэд оргүй"]);
  // Rows 1-2 are one price in юань over ₮ (merged down in the source); the юань is never a fare.
  assert.deepEqual(fixed.rows!.map((row) => row.cells), [["1600000₮", "1400000₮"], ["1600000₮", "1400000₮"], ["1700000₮", "1500000₮"]]);
  assert.equal(fixed.rows![2].dates, "2026 он 12 сар 9"); // built from the pieces when the row had no date
  // A normal table is returned untouched.
  const normal = { columns: ["Том хүн", "Хүүхэд"], rows: [{ dates: "11 сарын 5", cells: ["1,000,000₮", "800,000₮"] }] };
  assert.equal(normalizePriceTable(normal), normal);
  // A hotel or age column is never mistaken for a date.
  const hotels = { columns: ["Буудал", "Том хүн"], rows: [{ dates: "11 сарын 5", cells: ["Лотус 4*", "1,000,000₮"] }] };
  assert.equal(normalizePriceTable(hotels), hotels);
});

test("every day of 'M сар D1,D2' becomes a departure and the base fare comes from the tugrik rows", () => {
  const fields = mapPosterTripToFields(normalizePosterPriceTable({ title: "ВЭЛМОР-ЛОТУС", duration_days: 9, price_table: SPLIT }) as never) as {
    departure_dates: string[]; adult_price: number; currency?: string;
  };
  assert.ok(fields.departure_dates.includes("2026 оны 11 сарын 11"));
  assert.ok(fields.departure_dates.includes("2026 оны 11 сарын 25"));
  assert.equal(fields.adult_price, 1_600_000);
  assert.notEqual(fields.currency, "CNY");
});

test("a price merged down two date rows as юань over ₮ is one price for both dates", () => {
  const table = { columns: ["Гарах сар", "Өдөр", "Том хүн", "Хүүхэд"], rows: [
    { dates: "2026 он 10 сар 26", cells: ["2026 он 10 сар", "26", "3780юань", "3280юань"] },
    { dates: "2026 он 11 сар 11,25", cells: ["2026 он 11 сар", "11,25", "2337000₮", "2077000₮"] },
  ], note: "" };
  const fixed = normalizePriceTable(table)!;
  assert.deepEqual(fixed.rows!.map((row) => row.cells), [["2337000₮", "2077000₮"], ["2337000₮", "2077000₮"]]);
  const fields = mapPosterTripToFields(normalizePosterPriceTable({ title: "ВЭЛМОР", duration_days: 10, price_table: table }) as never) as {
    adult_price: number; extra: { price_groups: Array<{ adult_price: number; currency?: string }> };
  };
  assert.ok(fields.extra.price_groups.every((group) => group.adult_price === 2_337_000));
  // Rows that are really different prices (no yuan rate between them) stay apart: the yuan-only row has no price.
  const separate = { columns: ["Том хүн"], rows: [{ dates: "10 сарын 1", cells: ["3780юань"] }, { dates: "11 сарын 1", cells: ["9,990,000₮"] }] };
  assert.deepEqual(normalizePriceTable(separate)!.rows!.map((row) => row.cells), [[""], ["9,990,000₮"]]);
});

test("юань is never a price: yuan-only tables leave the trip without a fare", () => {
  const yuanOnly = { columns: ["Том хүн", "Хүүхэд"], rows: [{ dates: "2026 оны 11 сарын 13", cells: ["9800юань", "7600 юань"] }], note: "" };
  const fixed = normalizePriceTable(yuanOnly)!;
  assert.deepEqual(fixed.rows!.map((row) => row.cells), [["", ""]]);
  assert.equal(fixed.rows![0].dates, "2026 оны 11 сарын 13");
  const fields = mapPosterTripToFields(normalizePosterPriceTable({ title: "ВЭЛМОР", duration_days: 8, price_table: yuanOnly }) as never) as {
    adult_price?: number | null; child_price?: number | null; currency?: string;
  };
  assert.ok(fields.adult_price == null);
  assert.ok(fields.child_price == null);
  assert.notEqual(fields.currency, "CNY");
  // A yuan-only column beside ₮ fares is removed; the ₮ fares stay.
  const mixed = { columns: ["Лант үнэ (юань)", "Том хүн"], rows: [{ dates: "11 сарын 5", cells: ["2460юань", "1,600,000₮"] }] };
  const cleaned = normalizePriceTable(mixed)!;
  assert.deepEqual(cleaned.columns, ["Том хүн"]);
  assert.deepEqual(cleaned.rows![0].cells, ["1,600,000₮"]);
  // A ₮ table is untouched.
  const tugrik = { columns: ["Том хүн"], rows: [{ dates: "11 сарын 5", cells: ["1,600,000₮"] }] };
  assert.equal(normalizePriceTable(tugrik), tugrik);
});
