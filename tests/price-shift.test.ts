import assert from "node:assert/strict";
import test from "node:test";
import { shiftAmountsInText, shiftLabelledFares, shiftPosterFares, shiftTripFares } from "../src/lib/priceShift";

// Invented trip and fares only.
test("an amount keeps its own number style; ages, days and free cells stay", () => {
  assert.equal(shiftAmountsInText("1,390,000₮", 100_000), "1,490,000₮");
  assert.equal(shiftAmountsInText("3.190.000₮", 100_000), "3.290.000₮");
  assert.equal(shiftAmountsInText("3490000₮", 100_000), "3590000₮");
  assert.equal(shiftAmountsInText("990,000", 100_000), "1,090,000");
  assert.equal(shiftAmountsInText("2,290,000 - 2,490,000₮", 100_000), "2,390,000 - 2,590,000₮");
  for (const cell of ["Үнэгүй", "-", "Үнэ лавлах", "", "8 өдөр 7 шөнө", "2-11 нас"]) assert.equal(shiftAmountsInText(cell, 100_000), cell);
  assert.equal(shiftAmountsInText("1,490,000₮", -100_000), "1,390,000₮", "the opposite amount undoes it");
});

test("free text moves only the fares after their labels, never a single-room fee", () => {
  assert.equal(shiftLabelledFares("Том хүн: 5890000₮; Хүүхэд: 4690000₮", 100_000), "Том хүн: 5990000₮; Хүүхэд: 4790000₮");
  assert.equal(shiftLabelledFares("Том хүний үнэ 3,880,000₮. Хүүхдийн үнэ 580,000₮–3,580,000₮; нас тодруулна.", 100_000),
    "Том хүний үнэ 3,980,000₮. Хүүхдийн үнэ 680,000₮–3,680,000₮; нас тодруулна.");
  const single = "Өрөөнд ганцаараа орсон тохиолдолд нэмж төлөх зөрүү төлбөр - 490,000₮";
  assert.equal(shiftLabelledFares(single, 100_000), single);
});

test("trip fares move, a free infant stays free, supplements and fees stay", () => {
  const trip = {
    adult_price: 1_390_000, child_price: 1_090_000, infant_price: 0,
    extra: {
      price_groups: [{ dates: ["2098-03-08"], hotel: "Lumen Lodge", adult_price: 1_390_000, child_price: 1_090_000, infant_price: null,
        single_price: 650_000, passenger_prices: [{ label: "Хүүхэд 2-5 нас", price: 990_000 }, { label: "Нярай", price: 0 }] }],
      child_rules: [{ label: "Хүүхэд", price: 1_090_000 }, { label: "Нярай", price: 0 }],
      extra_fees: [{ label: "Виз", amount: 150_000 }],
    },
  };
  const shifted = shiftTripFares(trip, 100_000);
  assert.equal(shifted.adult_price, 1_490_000);
  assert.equal(shifted.child_price, 1_190_000);
  assert.equal(shifted.infant_price, 0);
  const extra = shifted.extra as Record<string, Array<Record<string, unknown>>>;
  assert.deepEqual(extra.price_groups[0], { dates: ["2098-03-08"], hotel: "Lumen Lodge", adult_price: 1_490_000, child_price: 1_190_000,
    infant_price: null, single_price: 650_000, passenger_prices: [{ label: "Хүүхэд 2-5 нас", price: 1_090_000 }, { label: "Нярай", price: 0 }] });
  assert.deepEqual(extra.child_rules.map((rule) => rule.price), [1_190_000, 0]);
  assert.equal("extra_fees" in extra, false, "fees are not passenger fares and are not rewritten");
});

test("the poster keeps its columns, bands, dates and 'Үнэгүй'; only fare cells move", () => {
  const poster = {
    title: "ВЭЛМОР НУУРЫН АЯЛАЛ",
    price_table: { note: "", columns: ["Том хүн 12+ нас", "Хүүхэд 2-11 нас", "Нярай 0-23 сар", "Ганцаараа явах"],
      rows: [{ dates: "2098 оны 3 сарын 8, 15", cells: ["1,390,000₮", "1,090,000₮", "Үнэгүй", "650,000₮"] }] },
    price_note: "Том хүн: 1390000₮; Хүүхэд: 1090000₮",
    excludes: ["Өрөөнд ганцаараа байрлах нэмэлт төлбөр 650,000₮"],
  };
  const shifted = shiftPosterFares(poster, 100_000);
  assert.deepEqual(shifted.price_table, { note: "", columns: poster.price_table.columns,
    rows: [{ dates: "2098 оны 3 сарын 8, 15", cells: ["1,490,000₮", "1,190,000₮", "Үнэгүй", "650,000₮"] }] });
  assert.equal(shifted.price_note, "Том хүн: 1490000₮; Хүүхэд: 1190000₮");
  assert.deepEqual(shifted.excludes, poster.excludes);
  assert.equal(shifted.title, poster.title);
});
