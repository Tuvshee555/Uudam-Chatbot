import assert from "node:assert/strict";
import test from "node:test";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";
import { websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import { websiteAvailabilityForResync, websiteTripPayload } from "../src/lib/websiteTripPayload";
import type { TravelTrip } from "../src/lib/travelTypes";

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
    hotel: "Phoenix",
    foodIncluded: true,
    departureRule: "Пүрэв гараг бүр",
    isPublished: true,
    departures: [
      { startDate: "2026-10-01T00:00:00.000Z", price: 2_690_000, childPrice: 2_390_000, infantPrice: 490_000, seatsLeft: 8, status: "OPEN" },
      { startDate: "2026-10-29T00:00:00.000Z", price: 3_090_000, childPrice: 2_790_000, infantPrice: 490_000, seatsLeft: 0, status: "SOLD_OUT" },
    ],
    itinerary: [{ title: "УБ - Саньяа", description: "Нислэг", accommodation: "Phoenix", meals: ["Өглөө"], image: "https://example.com/day.jpg" }],
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
  assert.equal(result.fields.source_description, "");
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
  assert.deepEqual(result.fields.extra?.price_groups, []);
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

// ---- Saving a trip on the website must never close its dates -----------------

const NOW = new Date("2026-10-04T00:00:00Z");
const DATES = ["2026-12-06", "2026-12-13", "2026-12-20"];
function chatbotTrip(extra: Record<string, unknown> = {}): TravelTrip {
  return {
    id: "t", category: "", operator_name: "U", route_name: "Phuket", duration_text: "6 өдөр 5 шөнө",
    adult_price: 5_890_000, child_price: 4_000_000, infant_price: null, currency: "MNT", departure_dates: DATES,
    seats_total: 20, seats_left: 20, has_food: null, status: "active", notes: "", hotel: "H", source_description: "",
    photo_urls: [], extra, created_at: "", updated_at: "",
  };
}

/** Chatbot -> website -> staff edits and saves -> bridge -> chatbot -> website, without the databases. */
type WebsiteDeparture = { startDate: string; price: number | null; childPrice: number | null; infantPrice: number | null; status: string; seatsLeft: number | null };
type WebsiteTrip = Record<string, unknown> & { price: number | null; departures: WebsiteDeparture[] };
function saveOnWebsite(trip: TravelTrip, edit: (website: WebsiteTrip) => void = () => {}) {
  const first = websiteTripPayload(trip, websiteDepartureSchedule(trip, NOW), NOW);
  const website: WebsiteTrip = {
    sourceTripId: "t", title: "Phuket", description: "d", price: first.price, childPrice: first.childPrice,
    infantPrice: first.infantPrice, currency: "MNT", durationDays: 6, durationNights: 5, isPublished: true, hotel: "H",
    // The website form posts back whatever sourceMetadata it was given.
    sourceMetadata: { price_groups: first.priceGroups, canonicalOffers: first.canonicalOffers, connectedSource: { extra: trip.extra } },
    departures: first.departures.map((d) => ({ startDate: d.start, price: d.price, childPrice: d.childPrice,
      infantPrice: d.infantPrice, status: d.status, seatsLeft: d.seatsLeft })),
  };
  edit(website);
  const { fields } = websiteTripToCanonicalFields(website, trip.status);
  const merged: TravelTrip = { ...trip, ...fields, status: (fields.status ?? trip.status) as TravelTrip["status"],
    extra: { ...trip.extra, ...fields.extra } } as TravelTrip;
  const seatsChanged = trip.seats_total !== merged.seats_total || trip.seats_left !== merged.seats_left;
  const live: TravelTrip = { ...merged, extra: { ...merged.extra, website_departure_availability: website.departures.map((d) => {
    const a = websiteAvailabilityForResync({ date: d.startDate.slice(0, 10), status: d.status, seatsLeft: d.seatsLeft }, first.canonicalOffers);
    return { ...a, seatsLeft: seatsChanged ? merged.seats_left : a.seatsLeft };
  }) } };
  return { fields, merged, after: websiteTripPayload(live, websiteDepartureSchedule(merged, NOW), NOW) };
}
const statuses = (result: ReturnType<typeof saveOnWebsite>) => result.after.departures.map((d) => d.status);

test("a website save does not touch chatbot seat counts or sold-out state", () => {
  const sent = saveOnWebsite(chatbotTrip());
  assert.equal("seats_total" in sent.fields, false);
  assert.equal("seats_left" in sent.fields, false);
  assert.equal(sent.merged.seats_left, 20);

  for (const status of ["sold_out", "paused", "cancelled"] as const) {
    const closed = saveOnWebsite({ ...chatbotTrip(), status });
    assert.equal(closed.merged.status, status);
    assert.equal("status" in closed.fields, false);
  }
});

test("only the website's publish switch changes trip status", () => {
  const base = { sourceTripId: "t", title: "A", description: "d", price: 1_000_000, durationDays: 2, durationNights: 1 };
  assert.equal(websiteTripToCanonicalFields({ ...base, isPublished: false }, "active").fields.status, "draft");
  assert.equal(websiteTripToCanonicalFields({ ...base, isPublished: true }, "draft").fields.status, "active");
  assert.equal(websiteTripToCanonicalFields({ ...base, isPublished: true }).fields.status, "active");
  assert.equal("status" in websiteTripToCanonicalFields({ ...base, isPublished: true }, "sold_out").fields, false);
});

test("editing the trip price after a sync keeps every departure open", () => {
  const result = saveOnWebsite(chatbotTrip(), (website) => { website.price = 6_100_000; });
  assert.deepEqual(statuses(result), ["OPEN", "OPEN", "OPEN"]);
  assert.equal(result.merged.adult_price, 6_100_000);
  assert.equal(result.after.price, 6_100_000);
  assert.deepEqual(result.fields.extra?.price_groups, []);
});

test("a trip already poisoned with echoed base fares heals on the next save", () => {
  const first = websiteTripPayload(chatbotTrip(), websiteDepartureSchedule(chatbotTrip(), NOW), NOW);
  // What earlier buggy saves left in the chatbot: the projection frozen as price_groups.
  const poisoned = chatbotTrip({ price_groups: first.priceGroups });
  const result = saveOnWebsite(poisoned, (website) => { website.price = 6_100_000; });
  assert.deepEqual(result.fields.extra?.price_groups, []);
  assert.deepEqual(statuses(result), ["OPEN", "OPEN", "OPEN"]);
  assert.equal(result.after.price, 6_100_000);
});

test("a per-date price staff really typed survives, base-fare copies do not", () => {
  const result = saveOnWebsite(chatbotTrip(), (website) => { website.departures[1].price = 6_500_000; });
  assert.deepEqual(result.fields.extra?.price_groups, [
    { dates: ["2026-12-13"], adult_price: 6_500_000, child_price: 4_000_000, infant_price: null },
  ]);
  assert.deepEqual(statuses(result), ["OPEN", "OPEN", "OPEN"]);
  assert.equal(result.after.departures[1].price, 6_500_000);
  assert.equal(result.after.departures[0].price, 5_890_000);
});

test("hotel/package price groups authored on the chatbot are preserved through a website save", () => {
  const trip = chatbotTrip({ price_groups: [
    { id: "t:price_group:0", hotel: "Phoenix", dates: ["2026-12-06"], adult_price: 6_000_000 },
    { id: "t:price_group:1", hotel: "Paxton", dates: ["2026-12-06"], adult_price: 5_500_000 },
  ] });
  const result = saveOnWebsite(trip);
  const groups = result.fields.extra?.price_groups as Array<Record<string, unknown>>;
  assert.deepEqual(groups.map((g) => g.hotel).sort(), ["Paxton", "Phoenix"]);
});
