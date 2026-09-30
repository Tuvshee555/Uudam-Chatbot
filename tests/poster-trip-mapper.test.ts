import assert from "node:assert/strict";
import test from "node:test";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";

test("poster price table preserves date-specific adult and child age fares", () => {
  const fields = mapPosterTripToFields({
    title: "Торвал Нордэнын аялал",
    duration_days: 5,
    duration_nights: 4,
    price_table: {
      columns: ["Огноо", "Том хүн", "2-8 насны хүүхэд", "0-2 насны хүүхэд"],
      rows: [
        {
          dates: "7 сарын 06, 13,20,27\n8 сарын 03,10,17нд",
          cells: ["1.001.000₮", "901.000₮", "401.000₮"],
        },
        {
          dates: "8 сарын 24,31нд",
          cells: ["1,201,000₮", "1,001,000₮", "401,000₮"],
        },
      ],
    },
  });

  assert.equal(fields.adult_price, 1001000);
  assert.equal(fields.child_price, 901000);
  assert.deepEqual(fields.departure_dates, [
    "7 сарын 06",
    "7 сарын 13",
    "7 сарын 20",
    "7 сарын 27",
    "8 сарын 03",
    "8 сарын 10",
    "8 сарын 17",
    "8 сарын 24",
    "8 сарын 31",
  ]);

  const groups = fields.extra?.price_groups || [];
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].dates, [
    "7 сарын 06",
    "7 сарын 13",
    "7 сарын 20",
    "7 сарын 27",
    "8 сарын 03",
    "8 сарын 10",
    "8 сарын 17",
  ]);
  assert.equal(groups[0].adult_price, 1001000);
  assert.equal(groups[0].child_price, 901000);
  assert.equal(groups[0].child_age, "2-8 нас");
  assert.equal(groups[0].infant_price, 401000);
  assert.equal(groups[0].infant_age, "0-2 нас");
  assert.deepEqual(groups[0].passenger_prices, [
    { label: "2-8 насны хүүхэд", age_range: "2-8 нас", price: 901000, currency: "MNT" },
    { label: "0-2 насны хүүхэд", age_range: "0-2 нас", price: 401000, currency: "MNT" },
  ]);
});

test("poster price table supports a custom child age bracket", () => {
  const fields = mapPosterTripToFields({
    title: "Лумиа аялал",
    price_table: {
      columns: ["Огноо", "Том хүн", "Хүүхэд 2-11 нас"],
      rows: [
        { dates: "9 сарын 10, 17, 10 сарын 15", cells: ["3.401.000₮", "2.701.000₮"] },
        { dates: "10 сарын 8", cells: ["3.501.000₮", "2.801.000₮"] },
      ],
    },
  });

  assert.equal(fields.child_price, 2701000);
  assert.deepEqual(fields.departure_dates, [
    "9 сарын 10",
    "9 сарын 17",
    "10 сарын 15",
    "10 сарын 08",
  ]);
  assert.equal(fields.extra?.price_groups?.[0].child_age, "2-11 нас");
  assert.equal(fields.extra?.price_groups?.[1].adult_price, 3501000);
});

test("poster adult price ranges keep the low fare for lookup and the full range for replies", () => {
  const fields = mapPosterTripToFields({
    title: "Хайнань – Саньяа аялал",
    price_table: {
      columns: ["Огноо", "Том хүн", "Хүүхэд"],
      rows: [{ dates: "10 сарын 1, 8, 15, 22", cells: ["2,000,000 - 2,300,000₮", "1,700,000₮"] }],
    },
  });

  assert.equal(fields.adult_price, 2000000);
  assert.deepEqual(fields.extra?.price_groups?.[0].adult_price_range, { min: 2000000, max: 2300000 });
});

test("poster hotel rows keep separate passenger tiers on the same date", () => {
  const fields = mapPosterTripToFields({
    title: "Хайнань – Саньяа аялал",
    price_table: {
      columns: ["Буудал", "Том хүн", "Хүүхэд 6-11 нас", "Хүүхэд 2-5 нас", "Нярай"],
      rows: [
        { dates: "10 сарын 1", cells: ["Phoenix", "3,290,000₮", "3,090,000₮", "2,390,000₮", "450,000₮"] },
        { dates: "10 сарын 1", cells: ["Paxton", "2,790,000₮", "2,590,000₮", "2,390,000₮", "450,000₮"] },
      ],
    },
  });
  assert.equal(fields.adult_price, 2790000);
  assert.deepEqual(fields.extra?.price_groups?.map((group) => group.hotel), ["Phoenix", "Paxton"]);
  assert.equal(fields.extra?.price_groups?.[0].passenger_prices[1].price, 2390000);
  assert.deepEqual(fields.extra?.child_rules, undefined);
});
