/**
 * Found while loading a new trip whose departures run from December into the
 * next February, priced per departure, with a solo-traveller column. Trip
 * names and prices here are invented; "today" is fixed so nothing drifts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TravelTrip } from "../src/lib/travelOps";
import {
  findPriceGroupByMonthDay,
  formatStructuredDayPrice,
  formatTripBasePricePremium,
} from "../src/lib/travelFastPaths";
import { filterFutureDepartureDates, resolveDepartureDatesAtWrite } from "../src/lib/travelDates";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { websiteExtraDetails } from "../src/lib/connectedTripMapping";
import { guardUnverifiedPrices } from "../src/lib/reply";

// Late September: December is later this year, January/February next year.
const NOW = new Date("2026-09-30T04:00:00Z");

const POSTER = {
  title: "Вэлмор – Кардан аялал",
  duration_days: 8,
  duration_nights: 7,
  departures: [{ date: "12 сарын 7" }, { date: "12 сарын 21" }, { date: "1 сарын 4" }, { date: "1 сарын 25" }],
  price_table: {
    columns: ["Том хүн", "Хүүхэд 6-12 нас", "Хүүхэд 2-6 нас", "Нярай 0-2 нас", "Ганцаараа явах"],
    rows: [
      { dates: "12 сарын 7", cells: ["1,100,000₮", "900,000₮", "800,000₮", "100,000₮", "1,500,000₮"] },
      { dates: "12 сарын 21, 1 сарын 4", cells: ["1,300,000₮", "1,000,000₮", "900,000₮", "100,000₮", "1,700,000₮"] },
      { dates: "1 сарын 25", cells: ["1,200,000₮", "900,000₮", "800,000₮", "100,000₮", "1,700,000₮"] },
    ],
  },
};

function tripFromPoster(): TravelTrip {
  const fields = mapPosterTripToFields(POSTER);
  return {
    id: "t", category: "Аялал", operator_name: "Test", route_name: fields.route_name!, duration_text: fields.duration_text!,
    adult_price: fields.adult_price ?? null, child_price: fields.child_price ?? null, infant_price: fields.infant_price ?? null,
    currency: "MNT", departure_dates: fields.departure_dates!, seats_total: null, seats_left: null, has_food: true,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], created_at: "", updated_at: "",
    extra: { ...fields.extra, departure_dates_resolved: resolveDepartureDatesAtWrite(fields.departure_dates!, NOW) },
  };
}

test("a solo-traveller column becomes each group's single_price, never a child tier", () => {
  const fields = mapPosterTripToFields(POSTER);
  const groups = fields.extra!.price_groups!;
  assert.deepEqual(groups.map((g) => g.single_price), [1_500_000, 1_700_000, 1_700_000]);
  assert.ok(groups.every((g) => g.passenger_prices.every((p) => !/ганцаар/i.test(p.label))));
  assert.equal(fields.adult_price, 1_100_000);
});

test("a next-January departure is not treated as already gone", () => {
  const trip = tripFromPoster();
  const resolved = trip.extra.departure_dates_resolved as ReturnType<typeof resolveDepartureDatesAtWrite>;
  // Spelled differently from the stored date ("1 сарын 4" vs "1 сарын 04").
  assert.deepEqual(filterFutureDepartureDates(["1 сарын 4", "1 сарын 25"], NOW, resolved), ["1 сарын 4", "1 сарын 25"]);
  const card = formatTripBasePricePremium(trip, NOW);
  assert.match(card, /1,300,000₮/);
  assert.match(card, /1,200,000₮/);
});

test("the price for one next-year date is that date's own fare, with every tier", () => {
  const trip = tripFromPoster();
  assert.ok(findPriceGroupByMonthDay(trip, 1, 25, NOW));
  const card = formatStructuredDayPrice(trip, 1, 25, "1 сарын 25", NOW) || "";
  assert.match(card, /Том хүн: 1,200,000₮/);
  assert.match(card, /Хүүхэд \/2-6 нас\/: 800,000₮/);
  assert.match(card, /Ганцаараа явбал: 1,700,000₮/);
  assert.doesNotMatch(card, /1,100,000₮/);
});

test("the website summary states each tier once and merges departures with the same prices", () => {
  const trip = tripFromPoster();
  const details = websiteExtraDetails(trip.extra, { adult: trip.adult_price, child: trip.child_price, infant: trip.infant_price, currency: "MNT" });
  assert.deepEqual(details.childPriceNotes, [
    "Том хүн - 1,100,000₮",
    "Хүүхэд (6-12 нас) - 900,000₮",
    "Нярай (0-2 нас) - 100,000₮",
    "Хүүхэд 2-6 нас - 800,000₮",
    "12 сарын 21, 1 сарын 4 - Том хүн 1,300,000₮ · Хүүхэд 6-12 нас 1,000,000₮ · Хүүхэд 2-6 нас 900,000₮",
    "1 сарын 25 - Том хүн 1,200,000₮",
  ]);
  assert.equal(details.roomPrices.length, 2);
  assert.match(details.roomPrices[0], /1,500,000₮/);
});

test("the price checker accepts a real solo price and both ends of a price range", () => {
  const trip = tripFromPoster();
  assert.equal(guardUnverifiedPrices("Ганцаараа явбал 1,700,000₮.", [trip]), "Ганцаараа явбал 1,700,000₮.");
  const ranged: TravelTrip = { ...trip, extra: { ...trip.extra, price_groups: [{ adult_price: 2_000_000, adult_price_range: { min: 2_000_000, max: 2_300_000 } }] } };
  assert.equal(guardUnverifiedPrices("Үнэ 2,000,000–2,300,000₮.", [ranged]), "Үнэ 2,000,000–2,300,000₮.");
  assert.equal(guardUnverifiedPrices("Ганцаараа явбал 9,900,000₮.", [trip]), "REFER");
});
