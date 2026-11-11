import test from "node:test";
import assert from "node:assert/strict";
import { posterDifferences } from "../src/lib/parityAudit";
import { posterTableFromTrip } from "../src/lib/poster/priceTableFromTrip";
import { followedPosterPriceTable, rebuiltPosterTable } from "../src/lib/poster/posterTableFollow";
import { posterFareColumns } from "../src/lib/poster/tripMapper";
import { splitPackagedHotel } from "../src/lib/poster/packageRows";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";

applyTestEnv();

// Invented trips, hotels, packages and prices only.
const NOW = new Date("2099-01-05T04:00:00Z");
const PRICE_CODES = ["poster_price", "poster_row_extra", "poster_row_unreadable", "poster_row_missing", "poster_choice_name", "poster_fare_wording"];

function trip(extra: Record<string, unknown> = {}, more: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "trip-invented-poster", route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", operator_name: "Uudam", category: "Аялал",
    duration_text: "3 өдөр 2 шөнө", adult_price: 1_000_000, child_price: 800_000, infant_price: null, currency: "MNT",
    departure_dates: ["2099-02-10", "2099-02-17", "2099-02-24"], seats_total: null, seats_left: null, has_food: true,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: {
      poster_trip_id: "poster-invented-poster", age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-2 нас" },
      price_groups: [
        { dates: ["2098-12-01"], adult_price: 900_000, child_price: 700_000 },
        { dates: ["2099-02-10"], adult_price: 1_000_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 800_000 }, { label: "Нярай", age_range: "0-2 нас", price: 0, note: "Үнэгүй" }] },
        { dates: ["2099-02-17"], adult_price: 1_000_000, passenger_prices: [{ label: "Хүүхэд 2-11 нас", age_range: "2-11 нас", price: 800_000 }, { label: "Нярай", age_range: "0-2 нас", price: 0, note: "Үнэгүй" }] },
        { dates: ["2099-02-24"], adult_price: 1_200_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 900_000 }, { label: "Нярай", age_range: "0-2 нас", price: 0, note: "Үнэгүй" }] },
      ],
      itinerary_days: [{ day: 1, title: "А", description: "а" }, { day: 2, title: "Б", description: "б" }, { day: 3, title: "В", description: "в" }],
      ...extra,
    },
    created_at: "", updated_at: "", ...more,
  };
}

const priceProblems = (subject: TravelTrip, table: Record<string, unknown>) =>
  posterDifferences(subject, { price_table: table, days: [{ day: 1, route: "А" }, { day: 2, route: "Б" }, { day: 3, route: "В" }] }, NOW)
    .filter((diff) => PRICE_CODES.includes(diff.code));

test("one row per price, same prices share a row, past dates dropped, and it reads back as the chatbot's prices", () => {
  const built = posterTableFromTrip(trip(), NOW);
  assert.ok(built.table);
  assert.deepEqual(built.table.columns, ["Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-2 нас"]);
  assert.deepEqual(built.table.rows, [
    { dates: "2099 оны 2 сарын 10, 17", cells: ["1,000,000₮", "800,000₮", "Үнэгүй"] },
    { dates: "2099 оны 2 сарын 24", cells: ["1,200,000₮", "900,000₮", "Үнэгүй"] },
  ]);
  assert.deepEqual(priceProblems(trip(), built.table), []);
});

test("a trip sold by package only gets a package column that reads back as the package, not a hotel", () => {
  const packaged = trip({
    package_options: [{ id: "pkg-a", label: "Хөтөлбөртэй" }, { id: "pkg-b", label: "Чөлөөт" }],
    price_groups: [
      { dates: ["2099-02-10"], package_id: "pkg-a", adult_price: 1_000_000, child_price: 800_000 },
      { dates: ["2099-02-17"], package_id: "pkg-b", adult_price: 1_100_000, child_price: 800_000 },
    ],
  });
  const built = posterTableFromTrip(packaged, NOW);
  assert.ok(built.table);
  assert.equal((built.table.columns as string[])[0], "Буудал");
  assert.deepEqual(splitPackagedHotel("Чөлөөт", [{ id: "pkg-b", label: "Чөлөөт" }]), { hotel: "", packageId: "pkg-b" });
  assert.deepEqual(priceProblems(packaged, built.table), []);
});

test("a child fare that mentions the hotel is a child column, never the hotel column", () => {
  const fare = posterFareColumns(["Том хүн", "2-11 нас хүүхэд /буудалд оргүй", "0-2 нас хүүхэд/эйрпорт такс"]);
  assert.equal(fare.accommodation, -1);
  assert.equal(fare.passengers.length, 2);
  assert.equal(posterFareColumns(["Буудал", "Том хүн"]).accommodation, 0);
});

test("a trip with only base fares gets one row with its age bands", () => {
  const base = trip({ price_groups: [] }, { infant_price: null });
  const built = posterTableFromTrip(base, NOW);
  assert.ok(built.table);
  assert.deepEqual(built.table, { columns: ["Том хүн", "Хүүхэд 2-11 нас"], rows: [{ dates: "2099 оны 2 сарын 10, 17, 24", cells: ["1,000,000₮", "800,000₮"] }] });
  assert.equal(posterTableFromTrip(trip({ price_groups: [] }, { adult_price: null }), NOW).table, null);
  assert.equal(posterTableFromTrip(trip({ price_groups: [{ dates: ["2099-02-10"], adult_price: 10, currency: "CNY" }] }), NOW).table, null);
});

test("a save that changed a price rewrites the poster table and keeps its note; an unchanged save leaves it", async () => {
  const before = trip();
  const after = trip({ price_groups: [{ dates: ["2099-02-10", "2099-02-17", "2099-02-24"], adult_price: 1_300_000, child_price: 1_000_000 }] });
  const poster = { price_table: { note: "Нислэг ороогүй.", columns: ["Том хүн"], rows: [{ dates: "2 сарын 10", cells: ["1,000,000₮"] }] }, days: [] };
  const followed = await followedPosterPriceTable(after, poster, before, NOW);
  assert.ok(followed);
  assert.equal(followed.note, "Нислэг ороогүй.");
  assert.deepEqual(followed.rows, [{ dates: "2099 оны 2 сарын 10, 17, 24", cells: ["1,300,000₮", "1,000,000₮"] }]);
  assert.equal(await followedPosterPriceTable(before, poster, before, NOW), null);
  assert.deepEqual(rebuiltPosterTable(after, poster, NOW)?.note, "Нислэг ороогүй.");
});

test("a full date keeps its prices on the poster, and an infant fare kept on the row is a column", () => {
  const priced = trip({ price_groups: [
    { dates: ["2099-02-10"], status: "sold_out", adult_price: 1_000_000, infant_price: 700_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 800_000 }] },
    { dates: ["2099-02-17"], adult_price: 1_100_000, infant_price: 700_000, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: 800_000 }] },
  ] });
  const built = posterTableFromTrip(priced, NOW);
  assert.ok(built.table);
  assert.deepEqual(built.table.columns, ["Том хүн", "Хүүхэд 2-11 нас", "Нярай 0-2 нас"]);
  assert.deepEqual((built.table.rows as Array<{ dates: string }>).map((row) => row.dates), ["2099 оны 2 сарын 10", "2099 оны 2 сарын 17"]);
});
