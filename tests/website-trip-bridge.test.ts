import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";

test("website trip updates retain shared facts for chatbot and poster", () => {
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-web-1",
    title: "ХАЙНАН АЯЛАЛ",
    summary: "Далайн эргийн амралт",
    description: "Дэлгэрэнгүй тайлбар",
    durationDays: 9,
    durationNights: 8,
    price: 2_690_000,
    childPrice: 2_390_000,
    infantPrice: 490_000,
    currency: "MNT",
    image: "https://example.com/cover.jpg",
    extraImages: ["https://example.com/day.jpg"],
    included: ["Нислэг"],
    excluded: ["Хувийн зардал"],
    importantNotes: ["Паспорт"],
    hotel: "Lotus",
    foodIncluded: true,
    departureRule: "Пүрэв гараг бүр",
    isPublished: true,
    departures: [
      { startDate: "2026-10-01T00:00:00.000Z", price: 2_690_000, childPrice: 2_390_000, infantPrice: 490_000, seatsLeft: 8, status: "OPEN" },
      { startDate: "2026-10-29T00:00:00.000Z", price: 3_090_000, childPrice: 2_790_000, infantPrice: 490_000, seatsLeft: 0, status: "SOLD_OUT" },
    ],
    itinerary: [{ title: "УБ - Зандан", description: "Нислэг", accommodation: "Lotus", meals: ["Өглөө"], image: "https://example.com/day.jpg" }],
  });

  assert.equal(result.sourceTripId, "trip-web-1");
  assert.equal(result.fields.route_name, "ХАЙНАН АЯЛАЛ");
  assert.equal(result.fields.notes, "Дэлгэрэнгүй тайлбар");
  assert.equal(result.fields.adult_price, 2_690_000);
  assert.deepEqual(result.fields.departure_dates, ["2026-10-01", "2026-10-29"]);
  assert.deepEqual(result.fields.photo_urls, ["https://example.com/cover.jpg", "https://example.com/day.jpg"]);
  assert.deepEqual(result.fields.extra?.website_departure_availability, [
    { date: "2026-10-01", status: "OPEN", seatsLeft: 8 },
    { date: "2026-10-29", status: "SOLD_OUT", seatsLeft: 0 },
  ]);
  assert.equal(result.fields.extra?.website_summary, "Далайн эргийн амралт");
});

test("an empty website summary is an explicit removal", () => {
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-web-2", title: "Аялал", description: "Тайлбар", price: 1_000_000,
    durationDays: 2, durationNights: 1, summary: "", isPublished: true,
  });
  assert.equal(result.fields.extra?.website_summary, "");
  assert.equal(result.fields.source_description, undefined);
  assert.equal(result.fields.seats_total, undefined);
  assert.equal(result.fields.seats_left, undefined);
});

test("website-created incomplete trips sync without fake zero fares", () => {
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-web-draft",
    title: "Шинэ аялал",
    description: "",
    price: 0,
    childPrice: 0,
    infantPrice: 0,
    durationDays: 1,
    durationNights: 0,
    image: "",
    extraImages: [],
    isPublished: false,
    departures: [{ startDate: "2026-12-01T00:00:00.000Z", price: 0, childPrice: 0, infantPrice: 0, status: "OPEN" }],
  });

  assert.equal(result.fields.status, "draft");
  assert.equal(result.fields.adult_price, null);
  assert.equal(result.fields.child_price, null);
  assert.equal(result.fields.infant_price, null);
  assert.deepEqual(result.fields.photo_urls, []);
  assert.deepEqual(result.fields.extra?.price_groups, [
    { dates: ["2026-12-01"], adult_price: null, child_price: null, infant_price: null },
  ]);
});

test("website-authored passenger price groups sync to canonical extra", () => {
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-web-3",
    title: "Бангкок аялал",
    description: "Тайлбар",
    price: 2_340_000,
    durationDays: 7,
    durationNights: 6,
    isPublished: true,
    sourceMetadata: {
      age_rules: { adult: "12+ нас", child: "2-11 нас", infant: "0-2 нас" },
      price_groups: [{
        label: "Үндсэн үнэ",
        dates: [],
        date_keys: [],
        adult_price: 2_340_000,
        passenger_prices: [
          { label: "Хүүхэд", age_range: "2-4 нас", price: 1_350_000, currency: "MNT" },
          { label: "Нярай", age_range: "0-2 нас", price: 0, currency: "MNT", note: "Үнэгүй" },
        ],
      }],
    },
  });

  const groups = result.fields.extra?.price_groups as Array<Record<string, unknown>>;
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].passenger_prices, [
    { label: "Хүүхэд", age_range: "2-4 нас", price: 1_350_000, currency: "MNT" },
    { label: "Нярай", age_range: "0-2 нас", price: 0, currency: "MNT", note: "Үнэгүй" },
  ]);
  assert.deepEqual(result.fields.extra?.age_rules, { adult: "12+ нас", child: "2-11 нас", infant: "0-2 нас" });
});
