/**
 * A 0₮ the reader wrote for a fare the file does not give is "not set" (2026-11-14: the assistant read
 * a Chongqing file's adult 0₮ rows as free and would not put the admin's adult price on them).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { unsetZeroFares } from "../src/lib/tripRowFares";
import { priceRowsOf } from "../src/lib/assistantAgent/readTools";
import type { TravelTrip } from "../src/lib/travelTypes";

const row = (adult: number | null, bands: Array<{ label: string; price: number | null; note?: string }>) => ({ dates: ["2098-12-09"], adult_price: adult, child_price: 0, passenger_prices: bands });

test("a new trip's 0₮ adult and child-band fares become not set; free and infant fares stay", () => {
  const fields = unsetZeroFares({ adult_price: 0, extra: { price_groups: [
    row(0, [{ label: "Хүүхэд ортой", price: 0 }, { label: "Хүүхэд үнэгүй", price: 0, note: "Үнэгүй" }, { label: "Нярай", price: 0 }]),
    row(2_190_000, [{ label: "Хүүхэд ортой", price: 1_690_000 }]),
  ] } });
  const groups = (fields.extra as { price_groups: Array<{ adult_price: unknown; passenger_prices: Array<{ price: unknown }> }> }).price_groups;
  assert.equal(fields.adult_price, null);
  assert.equal(groups[0].adult_price, null);
  assert.deepEqual(groups[0].passenger_prices.map((band) => band.price), [null, 0, 0]);
  assert.equal(groups[1].adult_price, 2_190_000);
  assert.deepEqual(groups[1].passenger_prices.map((band) => band.price), [1_690_000]);
  const untouched = { adult_price: 1_000_000, extra: { price_groups: [row(1_000_000, [])] } };
  assert.equal(unsetZeroFares(untouched), untouched);
});

test("the assistant sees a stored 0₮ adult or child tier as not set, so it prices it when told", () => {
  const trip = { id: "t", route_name: "Норвел", status: "draft", extra: { price_groups: [row(0, [{ label: "Хүүхэд ортой", price: 0 }, { label: "Хүүхэд", price: 0, note: "Үнэгүй" }])] } } as unknown as TravelTrip;
  const [view] = priceRowsOf(trip, new Date("2098-01-01T00:00:00Z"));
  assert.equal(view.adult, null);
  assert.deepEqual(view.passengers?.map((tier) => tier.price), [null, 0]);
});
