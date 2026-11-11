import test from "node:test";
import assert from "node:assert/strict";
import { forwardAgeRange, saysInfantsFree, settleRowInfantFares } from "../src/lib/tripRowFares";

// Invented rows: a child column "without a bed" that the reader also copied into infant_price.
type Row = Record<string, unknown>;
const fields = (notes: string[]): Row => ({
  route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", infant_price: null,
  extra: {
    important_notes: notes, age_rules: { infant: "2-оос доош нас" },
    price_groups: [{ dates: ["2099-02-03"], adult_price: 1_000_000, child_price: 1_000_000, infant_price: 700_000,
      passenger_prices: [{ label: "Хүүхэд ортой", age_range: "", price: 1_000_000 }, { label: "Хүүхэд ор эзлэхгүй", age_range: "11 – 2 нас", price: 700_000 }] }],
  },
});
const firstRow = (value: Row) => ((value.extra as Row).price_groups as Row[])[0];

test("an age band written backwards reads forwards", () => {
  assert.equal(forwardAgeRange("12 – 2 нас"), "2-12 нас");
  assert.equal(forwardAgeRange("2-12 нас"), "2-12 нас");
  assert.equal(forwardAgeRange("0-23 сар"), "0-23 сар");
});

test("a child band's amount copied into infant_price is dropped; the band keeps its forward age", () => {
  const settled = firstRow(settleRowInfantFares(fields([])));
  assert.equal(settled.infant_price, null);
  assert.deepEqual((settled.passenger_prices as Row[]).map((band) => band.age_range), ["", "2-11 нас"]);
});

test("'Нярай үнэгүй' gives every row and the trip a free infant with the trip's infant band", () => {
  assert.equal(saysInfantsFree(fields(["Нярай үнэгүй. Зөвхөн нислэгийн такс төлнө."])), true);
  assert.equal(saysInfantsFree(fields(["Нярай 300,000₮"])), false);
  const settled = settleRowInfantFares(fields(["Нярай үнэгүй. Зөвхөн нислэгийн такс төлнө."]));
  assert.equal(settled.infant_price, 0);
  const row = firstRow(settled);
  assert.equal(row.infant_price, 0);
  assert.deepEqual((row.passenger_prices as Row[]).at(-1), { label: "Нярай", age_range: "2-оос доош нас", price: 0, currency: "MNT", note: "Үнэгүй" });
});

test("a real infant band is left alone", () => {
  const own = fields(["Нярай үнэгүй"]);
  const row = firstRow(own);
  row.passenger_prices = [{ label: "Хүүхэд", age_range: "2-11 нас", price: 800_000 }, { label: "Нярай", age_range: "0-2 нас", price: 300_000 }];
  row.infant_price = 300_000;
  const settled = firstRow(settleRowInfantFares(own));
  assert.equal(settled.infant_price, 300_000);
  assert.equal((settled.passenger_prices as Row[]).length, 2);
});
