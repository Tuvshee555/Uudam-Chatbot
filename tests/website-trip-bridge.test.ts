import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";
import { itineraryMealsText } from "../src/lib/tripKnowledgeText";

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

test("website-created incomplete trips sync without a fake zero adult fare; a typed 0 child/infant fare is free", () => {
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
  // The website's adult 0 means "Үнэ лавлах"; a child/infant 0 is shown there as "Үнэгүй".
  assert.equal(result.fields.adult_price, null);
  assert.equal(result.fields.child_price, 0);
  assert.equal(result.fields.infant_price, 0);
  assert.deepEqual(result.fields.photo_urls, []);
  assert.deepEqual(result.fields.extra?.price_groups, [
    { dates: ["2026-12-01"], adult_price: null, child_price: 0, infant_price: 0, child_price_free: true, infant_price_free: true },
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

test("website hotel records sync as one canonical name, link, description and media unit", () => {
  const hotelProfiles = [{
    name: "Jomtien Palm Beach Hotel & Resort",
    url: "https://www.jomtien-palmbeach.com/",
    description: "Beach hotel",
    media: [{ url: "https://res.cloudinary.com/demo/image/upload/hotel.webp", caption: "Pool" }],
  }];
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-hotels",
    title: "Thailand",
    description: "Trip",
    price: 1_000_000,
    durationDays: 2,
    durationNights: 1,
    isPublished: true,
    sourceMetadata: {
      hotel_profiles: hotelProfiles,
      hotel_links: hotelProfiles.map(({ name, url }) => ({ name, url })),
    },
  });

  assert.deepEqual(result.fields.extra?.hotel_profiles, hotelProfiles);
  assert.deepEqual(result.fields.extra?.hotel_links, [{
    name: "Jomtien Palm Beach Hotel & Resort",
    url: "https://www.jomtien-palmbeach.com/",
  }]);
});

test("a website itinerary edit keeps a 'not stated' meal not stated and a removed meal not included", () => {
  const base = {
    sourceTripId: "trip-web-meals",
    title: "ТУРШИЛТЫН АЯЛАЛ",
    durationDays: 3,
    durationNights: 2,
    currency: "MNT",
    departures: [],
  };
  const withStates = websiteTripToCanonicalFields({
    ...base,
    sourceMetadata: {
      itineraryMeals: [
        { dayNumber: 1, breakfast: true, lunch: null, dinner: false },
        { dayNumber: 2, breakfast: true, lunch: true, dinner: null },
      ],
    },
    itinerary: [
      { dayNumber: 1, title: "Өдөр нэг", meals: ["Өглөө"] },
      { dayNumber: 2, title: "Өдөр хоёр", meals: ["Өглөө"] },
    ],
  });
  const days = withStates.fields.extra?.itinerary_days as Array<{ meals: Record<string, boolean | null> }>;
  assert.deepEqual(days[0].meals, { breakfast: true, lunch: null, dinner: false });
  assert.deepEqual(days[1].meals, { breakfast: true, lunch: false, dinner: null }, "lunch was taken off on the website");

  const legacy = websiteTripToCanonicalFields({ ...base, itinerary: [{ title: "Өдөр нэг", meals: ["Орой"] }] });
  const legacyDays = legacy.fields.extra?.itinerary_days as Array<{ meals: Record<string, boolean | null> }>;
  assert.deepEqual(legacyDays[0].meals, { breakfast: null, lunch: null, dinner: true }, "with no stored states an unnamed meal is not stated");

  const typed = websiteTripToCanonicalFields({ ...base, itinerary: [{ title: "Өдөр нэг", meals: ["Өглөө, Орой ороогүй"] }] });
  const typedDays = typed.fields.extra?.itinerary_days as Array<{ meals: Record<string, boolean | null> }>;
  assert.deepEqual(typedDays[0].meals, { breakfast: true, lunch: null, dinner: false }, "'Орой ороогүй' is dinner not included, never included");
});

test("a trip made on the website keeps the meals it never named not stated, and the bot says nothing about them", () => {
  const created = websiteTripToCanonicalFields({
    sourceTripId: "trip-web-created",
    title: "ТУРШИЛТЫН ШИНЭ АЯЛАЛ",
    durationDays: 2,
    durationNights: 1,
    currency: "MNT",
    departures: [],
    itinerary: [
      { dayNumber: 1, title: "Өдөр нэг", meals: ["Өглөө"] },
      { dayNumber: 2, title: "Өдөр хоёр", meals: [] },
    ],
  });
  const days = created.fields.extra?.itinerary_days as Array<{ meals: Record<string, boolean | null> }>;
  assert.deepEqual(days[0].meals, { breakfast: true, lunch: null, dinner: null });
  assert.deepEqual(days[1].meals, { breakfast: null, lunch: null, dinner: null });
  assert.equal(itineraryMealsText(days), "1-р өдөр — өглөөний хоол багтсан");
});

test("with no earlier website copy, only a meal the last sync drew as included and now gone becomes not included", () => {
  const result = websiteTripToCanonicalFields({
    sourceTripId: "trip-web-no-copy",
    title: "ТУРШИЛТЫН АЯЛАЛ",
    durationDays: 3,
    durationNights: 2,
    currency: "MNT",
    departures: [],
    sourceMetadata: { itineraryMeals: [{ dayNumber: 1, breakfast: true, lunch: true, dinner: false }] },
    itinerary: [
      { dayNumber: 1, title: "Өдөр нэг", meals: ["Өглөө"] },
      { dayNumber: 2, title: "Шинэ өдөр", meals: ["Орой"] },
    ],
  });
  const days = result.fields.extra?.itinerary_days as Array<{ meals: Record<string, boolean | null> }>;
  assert.deepEqual(days[0].meals, { breakfast: true, lunch: false, dinner: false }, "lunch was taken off; dinner was already not included");
  assert.deepEqual(days[1].meals, { breakfast: null, lunch: null, dinner: true }, "a day the chatbot never had states only what it names");
});
