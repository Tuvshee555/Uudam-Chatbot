import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Pool } from "pg";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";
import {
  tripToPoster, websiteBookingTerms, websiteBrochurePdfUrl, websiteDayMeals, websiteExtraDetails,
  websiteFilledFields, websiteItineraryMeals, websiteSingleSupplement, websiteTransportTags,
  WEBSITE_FILLED_CLEARED, WEBSITE_FILLED_QUIET,
} from "../src/lib/connectedTripMapping";
import { fillWebsiteFields } from "../src/lib/websiteTripDetails";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { projectedPatchTransport, websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { resolveDepartureDatesAtWrite } from "../src/lib/travelDates";

// Everything below is invented: places, hotels, terms and prices.
const date = "2098-05-06";
const now = new Date("2098-01-01T00:00:00.000Z");

function trip(extra: Record<string, unknown> = {}, overrides: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "norvel-trip", category: "", operator_name: "Invented", route_name: "Норвел аялал", duration_text: "4 өдөр 3 шөнө",
    adult_price: 1_111_111, child_price: null, infant_price: null, currency: "MNT", departure_dates: [date],
    seats_total: 12, seats_left: 5, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { poster_trip_id: "poster-norvel", ...extra }, created_at: "", updated_at: "", ...overrides,
  };
}

/* ------------------------------------------------------------ B1 booking terms */

test("booking terms become the website's two condition boxes, each only from its own term", () => {
  assert.deepEqual(websiteBookingTerms({ documents: "Норвел паспорт", cancellation: "Норвел цуцлалт" }), {
    requirements: "Норвел паспорт", cancellationPolicy: "Норвел цуцлалт",
  });
  assert.deepEqual(websiteBookingTerms({
    documents: "Норвел паспорт", visa: "Норвел виз", deposit: "111,111₮", payment: "Норвел төлбөр", cancellation: "Норвел цуцлалт",
  }), {
    requirements: "Бичиг баримт: Норвел паспорт\nВиз: Норвел виз",
    cancellationPolicy: "Урьдчилгаа: 111,111₮\nТөлбөр: Норвел төлбөр\nЦуцлалт: Норвел цуцлалт",
  });
  // The bot reads these boxes back as "documents" / "cancellation" when its own
  // term is empty: a deposit or visa alone must never become that answer.
  assert.deepEqual(websiteBookingTerms({ deposit: "111,111₮", visa: "Норвел виз", payment: "Норвел төлбөр" }), {
    requirements: null, cancellationPolicy: null,
  });
  assert.deepEqual(websiteBookingTerms({ documents: "  ", cancellation: "" }), { requirements: null, cancellationPolicy: null });
  assert.deepEqual(websiteBookingTerms(undefined), { requirements: null, cancellationPolicy: null });
});

/* ------------------------------------------------- three-way fill (B1, B6, B8) */

const fill = (current: Record<string, unknown> | null, baseline: Record<string, unknown>, incoming: Record<string, unknown>, hold?: string[], skip?: string[]) =>
  fillWebsiteFields(current, baseline, incoming, { hold: new Set(hold), skip: new Set(skip), quiet: WEBSITE_FILLED_QUIET, cleared: WEBSITE_FILLED_CLEARED });

test("an empty website field is filled from the chatbot", () => {
  const result = fill({ requirements: null, cancellationPolicy: "", transport: [], destinations: [], singleSupplement: null }, {},
    { requirements: "Норвел паспорт", cancellationPolicy: "Норвел цуцлалт", transport: ["Онгоц"], destinations: ["Норвел"], singleSupplement: 222_222 });
  assert.deepEqual(result.data, { requirements: "Норвел паспорт", cancellationPolicy: "Норвел цуцлалт", transport: ["Онгоц"], destinations: ["Норвел"], singleSupplement: 222_222 });
  assert.deepEqual(result.conflicts, []);
});

test("a website value still equal to the last projection follows the chatbot, and is cleared when the chatbot clears it", () => {
  const baseline = { requirements: "Хуучин паспорт", transport: ["Галт тэрэг"], singleSupplement: 222_222 };
  const changed = fill({ requirements: "Хуучин паспорт", transport: ["Галт тэрэг"], singleSupplement: 222_222 }, baseline,
    { requirements: "Шинэ паспорт", transport: ["Онгоц"], singleSupplement: 333_333 });
  assert.deepEqual(changed.data, { requirements: "Шинэ паспорт", transport: ["Онгоц"], singleSupplement: 333_333 });
  const cleared = fill({ requirements: "Хуучин паспорт", transport: ["Галт тэрэг"], singleSupplement: 222_222 }, baseline,
    { requirements: null, transport: [], singleSupplement: null });
  assert.deepEqual(cleared.data, { requirements: null, transport: [], singleSupplement: null });
  assert.deepEqual(cleared.conflicts, []);
});

test("a value staff typed on the website is never overwritten; a differing chatbot term is reported", () => {
  const result = fill(
    { requirements: "Вэбсайтын паспорт", cancellationPolicy: "Вэбсайтын цуцлалт", transport: ["Автобус"], destinations: ["Велмор"] },
    { requirements: "Норвел паспорт", transport: ["Онгоц"] },
    { requirements: "Норвел паспорт", cancellationPolicy: "Норвел цуцлалт", transport: ["Онгоц"], destinations: ["Норвел"] },
  );
  assert.deepEqual(result.data, {});
  assert.deepEqual(result.conflicts, [
    { field: "requirements", website: "Вэбсайтын паспорт", chatbot: "Норвел паспорт", base: "Норвел паспорт" },
    // No baseline yet (first sync after this change): the website value was typed there.
    { field: "cancellationPolicy", website: "Вэбсайтын цуцлалт", chatbot: "Норвел цуцлалт", base: null },
  ], "transport and destinations are display tags: kept quietly");
});

test("an empty chatbot term leaves a website-typed value alone without a conflict", () => {
  const result = fill({ requirements: "Вэбсайтын паспорт", cancellationPolicy: "Вэбсайтын цуцлалт" }, {},
    { requirements: null, cancellationPolicy: null });
  assert.deepEqual(result, { data: {}, conflicts: [] });
});

test("an edit still on its way from the website and a field the admin's website patch sets are left alone", () => {
  const result = fill({ requirements: "", transport: [] }, {}, { requirements: "Норвел паспорт", transport: ["Онгоц"] }, ["requirements"], ["transport"]);
  assert.deepEqual(result, { data: {}, conflicts: [] });
});

test("a box staff emptied on the website after the sync filled it stays empty, and every later sync leaves it empty", () => {
  const filledBefore = { requirements: "Норвел паспорт", cancellationPolicy: "Норвел цуцлалт", transport: ["Онгоц"], destinations: ["Норвел"], singleSupplement: 222_222 };
  const emptied = { requirements: "", cancellationPolicy: null, transport: [], destinations: [], singleSupplement: null };
  for (const incoming of [filledBefore, { ...filledBefore, requirements: "Шинэ паспорт", transport: ["Галт тэрэг", "Автобус"] }]) {
    const result = fill(emptied, filledBefore, incoming);
    assert.deepEqual(result.data, {}, "an empty cancellation box is how staff get the site's default wording");
    assert.deepEqual(result.conflicts, [
      { field: "requirements", website: "", chatbot: incoming.requirements, base: "Норвел паспорт" },
      { field: "cancellationPolicy", website: null, chatbot: "Норвел цуцлалт", base: "Норвел цуцлалт" },
      { field: "singleSupplement", website: null, chatbot: 222_222, base: 222_222 },
    ], "the bot still has a term the site no longer shows; tags are kept quietly");
  }
});

test("an empty box the projection never filled is filled, whether the baseline is missing or empty", () => {
  const result = fill({ requirements: "", transport: [] }, { requirements: null, transport: [] },
    { requirements: "Норвел паспорт", transport: ["Онгоц"] });
  assert.deepEqual(result, { data: { requirements: "Норвел паспорт", transport: ["Онгоц"] }, conflicts: [] });
});

test("a brand-new website trip only receives values the chatbot has", () => {
  const result = fill(null, {}, { requirements: "Норвел паспорт", cancellationPolicy: null, transport: [], destinations: ["Норвел"], singleSupplement: null });
  assert.deepEqual(result.data, { requirements: "Норвел паспорт", destinations: ["Норвел"] });
});

/* -------------------------------------------------------- B6 transport, destinations */

test("transport type and destinations become website tags", () => {
  assert.deepEqual(websiteTransportTags("direct_flight"), ["Онгоц"]);
  assert.deepEqual(websiteTransportTags("land"), ["Галт тэрэг", "Автобус"]);
  assert.deepEqual(websiteTransportTags("teleport"), []);
  assert.deepEqual(websiteTransportTags(undefined), []);
  const fields = websiteFilledFields(trip({ transport_type: "cruise", destinations: ["Норвел", " Велмор ", "Норвел", ""] }), []);
  assert.deepEqual(fields.transport, ["Галт тэрэг", "Усан онгоц"]);
  assert.deepEqual(fields.destinations, ["Норвел", "Велмор"]);
  assert.equal(fields.requirements, null);
});

test("transport tags the new-trip review put in the website patch are the projection's, a manual override is not", () => {
  // Written by the review for a direct flight; the trip is now sold as land.
  assert.deepEqual(projectedPatchTransport(["Онгоц"], ["land", "direct_flight"]), ["Онгоц"], "the type at the last sync");
  assert.deepEqual(projectedPatchTransport(["Галт тэрэг", "Автобус"], ["land", undefined]), ["Галт тэрэг", "Автобус"], "the type now");
  assert.deepEqual(projectedPatchTransport(["Онгоц"], ["land", "land"], ["Онгоц"]), ["Онгоц"], "recognised by an earlier sync");
  assert.equal(projectedPatchTransport(["Онгоц"], ["land", "land"]), null, "nothing ties it to the projection");
  assert.equal(projectedPatchTransport(["Автобус", "Морь"], ["land", "direct_flight"]), null, "typed by staff");
  assert.equal(projectedPatchTransport(["Автобус", "Галт тэрэг"], ["land"]), null, "not the tags as the review writes them");
  assert.equal(projectedPatchTransport([], ["land"]), null);
  assert.equal(projectedPatchTransport(undefined, ["land"], ["Онгоц"]), null);
});

/* ------------------------------------------------------- B8 solo supplement per hotel */

test("the trip-level solo supplement is set only when every fare row states the same one", () => {
  assert.equal(websiteSingleSupplement([{ single_price: 222_222 }, { single_price: 222_222 }]), 222_222);
  assert.equal(websiteSingleSupplement([{ hotel: "Норвел", single_price: 222_222 }, { hotel: "Велмор", single_price: 333_333 }]), null);
  assert.equal(websiteSingleSupplement([{ single_price: 222_222 }, { adult_price: 1_111_111 }]), null, "a row without it is not covered");
  assert.equal(websiteSingleSupplement([{ single_price: 1 }]), null, "a 1₮ placeholder is not a price");
  assert.equal(websiteSingleSupplement([{ single_price: 50, currency: "USD" }]), 50);
  assert.equal(websiteSingleSupplement([]), null);
  assert.equal(websiteFilledFields(trip({}, { currency: "USD" }), [{ single_price: 50, currency: "USD" }]).singleSupplement, null,
    "the website prints it in tugrik");
});

test("solo-room lines name the hotel whose price they are", () => {
  const details = (groups: Record<string, unknown>[]) => websiteExtraDetails({ price_groups: groups }, { adult: 1_111_111, child: null, infant: null, currency: "MNT" }).roomPrices;
  assert.deepEqual(details([
    { hotel: "Норвел буудал", dates: ["2098-05-06"], adult_price: 1_111_111, single_price: 222_222 },
    { hotel: "Велмор буудал", dates: ["2098-05-06"], adult_price: 1_444_444, single_price: 333_333 },
    { hotel: "Норвел буудал", dates: ["2098-05-13"], adult_price: 1_111_111, single_price: 222_222 },
    { hotel: "Велмор буудал", dates: ["2098-05-13"], adult_price: 1_444_444, single_price: 333_333 },
  ]), [
    "Ганцаараа явах (өрөөндөө ганцаараа) - Норвел буудал - 222,222₮",
    "Ганцаараа явах (өрөөндөө ганцаараа) - Велмор буудал - 333,333₮",
  ]);
  // Two hotels with the same supplement share a line; a date-dependent one lists its dates.
  assert.deepEqual(details([
    { hotel: "Норвел буудал", dates: ["2098-05-06"], single_price: 222_222 },
    { hotel: "Велмор буудал", dates: ["2098-05-06"], single_price: 222_222 },
    { hotel: "Тэлсар буудал", dates: ["2098-05-06"], single_price: 444_444 },
    { hotel: "Тэлсар буудал", dates: ["2098-05-13"], single_price: 555_555 },
  ]), [
    "Ганцаараа явах (өрөөндөө ганцаараа) - Норвел буудал, Велмор буудал - 222,222₮",
    "Ганцаараа явах (өрөөндөө ганцаараа) - Тэлсар буудал - 2098-05-06 - 444,444₮",
    "Ганцаараа явах (өрөөндөө ганцаараа) - Тэлсар буудал - 2098-05-13 - 555,555₮",
  ]);
});

/* ---------------------------------------------------------- B7 price row label, note */

test("a price row's own label and note survive to the website metadata; the date is only the fallback", () => {
  const source = trip({ price_groups: [
    { dates: [date], label: "Норвел эрт захиалга", note: "Норвел тэмдэглэл", adult_price: 1_111_111 },
  ] });
  const named = websiteTripPayload(source, websiteDepartureSchedule(source, now), now).priceGroups[0];
  assert.equal(named.label, "Норвел эрт захиалга");
  assert.equal((named as Record<string, unknown>).note, "Норвел тэмдэглэл");
  assert.deepEqual(named.dates, [date]);
  const unnamed = trip({ price_groups: [{ dates: [date], adult_price: 1_111_111 }] });
  assert.equal(websiteTripPayload(unnamed, websiteDepartureSchedule(unnamed, now), now).priceGroups[0].label, date);
});

const labelsOf = (source: TravelTrip) => websiteTripPayload(source, websiteDepartureSchedule(source, now), now).priceGroups
  .map((group) => [group.label, group.dates]);

test("a poster row's date cell is not a price-row name: each website row is labelled with its own date", () => {
  // The poster mapper labels every row with its date cell. Sent as a name, "5/6, 5/13"
  // showed as the option's title and split equal-priced dates into separate price blocks.
  for (const cell of ["5/6, 5/13", "5 сарын 6, 13", "2098-05-06, 2098-05-13"]) {
    const fields = mapPosterTripToFields({
      title: "Норвел аялал", duration_days: 4, duration_nights: 3,
      departures: [{ date: "2098-05-06" }, { date: "2098-05-13" }],
      price_table: { columns: ["Том хүн"], rows: [{ dates: cell, cells: ["1,111,111₮"] }] },
    } as Parameters<typeof mapPosterTripToFields>[0]);
    assert.equal(fields.extra?.price_groups?.[0].label, cell, "the poster row is labelled with its cell");
    const source = trip({ ...fields.extra, departure_dates_resolved: resolveDepartureDatesAtWrite(fields.departure_dates!, now) },
      { departure_dates: fields.departure_dates! });
    assert.deepEqual(labelsOf(source), [["2098-05-06", ["2098-05-06"]], ["2098-05-13", ["2098-05-13"]]], cell);
  }
});

test("a stale date cell left on a row whose dates were edited is still not a name; real names survive", () => {
  const row = (label: string) => trip({ price_groups: [{ label, dates: [date], display_dates: [date], date_keys: [date], adult_price: 1_111_111 }] });
  for (const stale of ["5/6, 5/13", "5-р сарын 6, 13", "Мягмар 5/6", "5/6-аас 5/13 хүртэл", "2098.05.06"]) {
    assert.deepEqual(labelsOf(row(stale)), [[date, [date]]], stale);
  }
  for (const name of ["Норвел эрт захиалга", "2 хүний өрөө", "Стандарт 5*", "1-р ангилал"]) {
    assert.deepEqual(labelsOf(row(name)), [[name, [date]]], name);
  }
});

/* ------------------------------------------------------------- B4, B5 meals */

test("only meals the program includes are listed for the website day", () => {
  assert.deepEqual(websiteDayMeals({ breakfast: true, lunch: null, dinner: false }), ["Өглөө"]);
  assert.deepEqual(websiteDayMeals({ breakfast: "true", lunch: 1, dinner: true }), ["Орой"], "only a real true is included");
  assert.deepEqual(websiteDayMeals(undefined), []);
});

test("each website day carries included, own-cost and not-stated meals and its meal note", () => {
  const meals = websiteItineraryMeals([
    { day: 1, route: "Норвел – Велмор", meals: { breakfast: true, lunch: null, dinner: false }, meal_note: "Норвел буфет" },
    { day: 2, summary: "Велмор", meals: {} },
    { day: 3, route: "", summary: "", photo: "https://res.cloudinary.com/invented/a.jpg" },
  ], [{ day: 1 }, { day: 2, meal_note: "Велмор ресторан" }]);
  assert.deepEqual(meals, [
    { dayNumber: 1, breakfast: true, lunch: null, dinner: false, note: "Норвел буфет" },
    // A poster saved before notes travelled: the chatbot day's own note is used.
    { dayNumber: 2, breakfast: null, lunch: null, dinner: null, note: "Велмор ресторан" },
  ], "a photo-only slot is not an itinerary day");
});

test("a day's meal note travels to the poster day and a removed note does not survive there", () => {
  const before = trip({ itinerary_days: [{ day: 1, title: "Норвел", description: "", meals: { breakfast: true, lunch: null, dinner: null }, meal_note: "Норвел буфет" }] });
  const poster = tripToPoster(before, { days: [] }, null);
  assert.equal((poster.days as Record<string, unknown>[])[0].meal_note, "Норвел буфет");
  assert.deepEqual((poster.days as Record<string, unknown>[])[0].meals, { breakfast: true, lunch: null, dinner: null });
  const removed = trip({ itinerary_days: [{ day: 1, title: "Норвел", description: "", meals: { breakfast: true } }] });
  const after = tripToPoster(removed, poster, before);
  assert.equal("meal_note" in (after.days as Record<string, unknown>[])[0], false);
});

/* ------------------------------------------------------------ B12 brochure */

const SITE_KEYS = ["NEXT_PUBLIC_SITE_URL", "SITE_URL", "VERCEL_PROJECT_PRODUCTION_URL", "VERCEL_URL"] as const;
function withSite<T>(site: string | undefined, run: () => T): T {
  const saved = SITE_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of SITE_KEYS) delete process.env[key];
  if (site) process.env.SITE_URL = site;
  try { return run(); } finally {
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test("the website brochure is the poster PDF, and an uploaded PDF only when there is no poster PDF", () => {
  const uploaded = "https://files.invalid/norvel.pdf";
  withSite("https://catalog.invalid", () => {
    assert.equal(websiteBrochurePdfUrl({ poster_trip_id: "poster-norvel", brochure_pdf_url: uploaded }), "https://catalog.invalid/api/poster-pdf?id=poster-norvel");
    assert.equal(websiteBrochurePdfUrl({ brochure_pdf_url: uploaded }), uploaded, "no poster behind the trip");
  });
  withSite(undefined, () => {
    assert.equal(websiteBrochurePdfUrl({ poster_trip_id: "poster-norvel", brochure_pdf_url: uploaded }), uploaded);
    // Cloudinary raw PDFs answer 401 to everyone; a plain link is not a brochure.
    assert.equal(websiteBrochurePdfUrl({ poster_trip_id: "poster-norvel", brochure_pdf_url: "https://res.cloudinary.com/invented/raw/upload/norvel.pdf" }), "");
    assert.equal(websiteBrochurePdfUrl({ poster_trip_id: "poster-norvel", brochure_pdf_url: "http://files.invalid/norvel.pdf" }), "");
    assert.equal(websiteBrochurePdfUrl({ poster_trip_id: "poster-norvel" }), "");
  });
});

/* ---------------------------------------------- the projection writes all of it */

type Captured = { trip: Record<string, unknown>; inserted: boolean; days: unknown[][]; contentConflict: unknown; conflicts: unknown[] };

async function project(context: TestContext, options: {
  source: TravelTrip; poster: Record<string, unknown>; prior?: Record<string, unknown> | null; site?: string;
}): Promise<Captured> {
  const database = "postgres://fixture:fixture@127.0.0.1:1/staff-fields-fixture";
  applyTestEnv({ NEON_DATABASE_URL: database, BOOKING_DATABASE_URL: database, SITE_URL: options.site, NEXT_PUBLIC_SITE_URL: undefined,
    VERCEL_PROJECT_PRODUCTION_URL: undefined, VERCEL_URL: undefined });
  const captured: Captured = { trip: {}, inserted: false, days: [], contentConflict: undefined, conflicts: [] };
  const errors: unknown[] = [];
  let synced = false;
  const query = async (sql: string, params: unknown[] = []) => {
    if (/SELECT trip_id FROM trip_website_sync/.test(sql)) return { rows: synced ? [] : [{ trip_id: options.source.id }] };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
    if (/SELECT \* FROM trip_website_sync/.test(sql)) return { rows: [{ trip_id: options.source.id, revision: "1" }] };
    if (/SELECT \* FROM travel_trip_entries/.test(sql)) return { rows: [options.source] };
    if (sql.includes("SELECT data FROM poster_trips")) return { rows: [{ data: options.poster }] };
    if (/SELECT \* FROM "Trip"/.test(sql)) return { rows: options.prior ? [options.prior] : [] };
    if (/^UPDATE "Trip" SET "(?!sourceMetadata"=jsonb_set)/.test(sql) && !sql.includes('"isPublished"=false')) {
      for (const [, key, index] of sql.matchAll(/"(\w+)"=\$(\d+)/g)) captured.trip[key] = params[Number(index) - 1];
    }
    if (sql.startsWith('INSERT INTO "Trip"')) {
      captured.inserted = true;
      const keys = [...(sql.match(/\(([^)]*)\)/)?.[1] || "").matchAll(/"(\w+)"/g)].map((match) => match[1]).filter((key) => key !== "lastSyncedAt");
      keys.forEach((key, index) => { captured.trip[key] = params[index]; });
    }
    if (sql.includes("jsonb_set(\"sourceMetadata\",'{contentConflicts}'")) captured.conflicts = JSON.parse(String(params[1]));
    if (sql.startsWith('INSERT INTO "ItineraryDay"')) captured.days.push(params);
    if (sql.includes("UPDATE trip_website_sync SET synced_revision")) { synced = true; captured.contentConflict = params[4]; }
    if (sql.includes("UPDATE trip_website_sync SET attempts")) errors.push(params[1]);
    return { rows: [] };
  };
  const pg = await import("pg");
  context.mock.method(pg.Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(pg.Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
  context.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  const sync = await import("../src/lib/websiteTripSync");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  try {
    assert.deepEqual(await sync.flushWebsiteSync(options.source.id, 1), { processed: 1 });
    assert.deepEqual(errors, []);
  } finally { await closeNeonPool(); await sync.closeBookingPool(); }
  return captured;
}

const posterDays = [
  { day: 1, route: "Норвел – Велмор", summary: "Норвел өдөр", hotel: "Норвел буудал", meals: { breakfast: true, lunch: null, dinner: false }, meal_note: "Норвел буфет" },
  { day: 2, route: "Велмор", summary: "Велмор өдөр", meals: { breakfast: null, lunch: null, dinner: null } },
];
const staffSource = () => trip({
  booking_terms: { documents: "Норвел паспорт", visa: "Норвел виз", deposit: "", payment: "", cancellation: "Норвел цуцлалт" },
  transport_type: "direct_flight", destinations: ["Норвел", "Велмор"],
  brochure_pdf_url: "https://files.invalid/norvel.pdf",
});

test("a new website trip receives the terms, tags, meal states and brochure staff entered", async (context) => {
  const captured = await project(context, { source: staffSource(), poster: { days: posterDays }, site: "https://catalog.invalid" });
  assert.equal(captured.inserted, true);
  assert.equal(captured.trip.requirements, "Бичиг баримт: Норвел паспорт\nВиз: Норвел виз");
  assert.equal(captured.trip.cancellationPolicy, "Норвел цуцлалт");
  assert.deepEqual(captured.trip.transport, ["Онгоц"]);
  assert.deepEqual(captured.trip.destinations, ["Норвел", "Велмор"]);
  assert.equal(captured.trip.brochurePdfUrl, "https://catalog.invalid/api/poster-pdf?id=poster-norvel");
  const metadata = JSON.parse(String(captured.trip.sourceMetadata));
  assert.deepEqual(metadata.itineraryMeals, [
    { dayNumber: 1, breakfast: true, lunch: null, dinner: false, note: "Норвел буфет" },
    { dayNumber: 2, breakfast: null, lunch: null, dinner: null },
  ]);
  assert.equal(metadata.contentSnapshot.requirements, captured.trip.requirements, "the next sync's baseline");
  // ItineraryDay rows: [id, tripId, dayNumber, title, description, accommodation, meals, image].
  assert.deepEqual(captured.days.map((row) => [row[2], row[6]]), [[1, ["Өглөө"]], [2, []]]);
  assert.equal(captured.contentConflict, false);
});

test("without a poster PDF the projection links the brochure staff uploaded", async (context) => {
  const captured = await project(context, { source: staffSource(), poster: { days: posterDays } });
  assert.equal(captured.trip.brochurePdfUrl, "https://files.invalid/norvel.pdf");
});

test("a resync fills what nobody edited on the website and keeps and reports what staff typed there", async (context) => {
  const source = staffSource();
  const prior = {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture",
    requirements: null, cancellationPolicy: "Вэбсайтын цуцлалт", transport: ["Галт тэрэг"], destinations: ["Тэлсар"], singleSupplement: null,
    sourceMetadata: {
      connectedSource: { ...source, extra: { ...source.extra, transport_type: "land" }, photos: [], poster: { days: [] } },
      contentSnapshot: { transport: ["Галт тэрэг"], destinations: [] },
    },
  };
  const captured = await project(context, { source, poster: { days: posterDays }, prior, site: "https://catalog.invalid" });
  assert.equal(captured.inserted, false);
  assert.equal(captured.trip.requirements, "Бичиг баримт: Норвел паспорт\nВиз: Норвел виз", "empty on the website: filled");
  assert.deepEqual(captured.trip.transport, ["Онгоц"], "unchanged since the last sync: follows the chatbot");
  assert.equal("cancellationPolicy" in captured.trip, false, "typed on the website: never overwritten");
  assert.equal("destinations" in captured.trip, false, "website tags staff changed are kept");
  assert.deepEqual(captured.conflicts.filter((entry) => (entry as { field: string }).field === "cancellationPolicy"), [
    { field: "cancellationPolicy", website: "Вэбсайтын цуцлалт", chatbot: "Норвел цуцлалт", base: null },
  ]);
  assert.equal(captured.conflicts.some((entry) => (entry as { field: string }).field === "destinations"), false);
  assert.equal(captured.contentConflict, true);
});

test("a website edit still being delivered to the chatbot is not overwritten by the fill", async (context) => {
  const source = staffSource();
  const prior = {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture",
    requirements: "Вэбсайтын шинэ паспорт", cancellationPolicy: null, transport: [], destinations: [], singleSupplement: null,
    sourceMetadata: {
      connectedSource: { ...source, photos: [], poster: { days: [] } },
      contentSnapshot: { requirements: "Хуучин паспорт" },
      websiteSyncPending: { id: "pending-norvel", edits: { requirements: "Хуучин паспорт" } },
    },
  };
  const captured = await project(context, { source, poster: { days: posterDays }, prior, site: "https://catalog.invalid" });
  assert.equal(captured.trip.requirements, undefined, "held: the website keeps its pending edit");
  assert.equal(captured.conflicts.some((entry) => (entry as { field: string }).field === "requirements"), false);
  assert.equal(captured.trip.cancellationPolicy, "Норвел цуцлалт");
});

const fieldsOf = (conflicts: unknown[]) => conflicts.map((entry) => (entry as { field: string }).field);

test("boxes staff emptied on the website after a sync filled them are not refilled by the next sync", async (context) => {
  const source = staffSource();
  const prior = {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture",
    requirements: "", cancellationPolicy: null, transport: [], destinations: ["Норвел", "Велмор"], singleSupplement: null,
    sourceMetadata: {
      connectedSource: { ...source, photos: [], poster: { days: [] } },
      // What the last sync proposed (and wrote) — staff then emptied three boxes.
      contentSnapshot: { requirements: "Бичиг баримт: Норвел паспорт\nВиз: Норвел виз", cancellationPolicy: "Норвел цуцлалт",
        transport: ["Онгоц"], destinations: ["Норвел", "Велмор"], singleSupplement: null },
    },
  };
  const captured = await project(context, { source, poster: { days: posterDays }, prior, site: "https://catalog.invalid" });
  for (const key of ["requirements", "cancellationPolicy", "transport"]) assert.equal(key in captured.trip, false, key);
  assert.deepEqual(fieldsOf(captured.conflicts).filter((field) => ["requirements", "cancellationPolicy", "transport"].includes(field)),
    ["requirements", "cancellationPolicy"], "the bot still quotes terms the site no longer shows");
});

test("transport tags the new-trip review pinned in the website patch follow a later change of transport type", async (context) => {
  // The review wrote ["Онгоц"] into website_details_patch for a direct flight; staff then made it a land trip.
  const source = trip({ transport_type: "land", website_details_patch: { base: {}, values: { transport: ["Онгоц"] } } });
  const first = await project(context, { source, poster: { days: posterDays }, site: "https://catalog.invalid", prior: {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture", transport: ["Онгоц"],
    sourceMetadata: {
      connectedSource: { ...source, extra: { ...source.extra, transport_type: "direct_flight" }, photos: [], poster: { days: [] } },
      contentSnapshot: {},
    },
  } });
  assert.deepEqual(first.trip.transport, ["Галт тэрэг", "Автобус"]);
  assert.equal(fieldsOf(first.conflicts).includes("website.transport"), false);
  const firstMetadata = JSON.parse(String(first.trip.sourceMetadata));
  assert.deepEqual(firstMetadata.projectedPatchTransport, ["Онгоц"]);
  assert.deepEqual(firstMetadata.contentSnapshot.transport, ["Галт тэрэг", "Автобус"]);
  // The stored patch still says ["Онгоц"] and the last sync already saw the land trip.
  const second = await project(context, { source, poster: { days: posterDays }, site: "https://catalog.invalid", prior: {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture", transport: ["Галт тэрэг", "Автобус"],
    sourceMetadata: { connectedSource: { ...source, photos: [], poster: { days: [] } }, contentSnapshot: firstMetadata.contentSnapshot,
      projectedPatchTransport: firstMetadata.projectedPatchTransport },
  } });
  assert.equal("transport" in second.trip, false);
  assert.equal(fieldsOf(second.conflicts).includes("website.transport"), false, "never a conflict with its own old tags");
  assert.deepEqual(JSON.parse(String(second.trip.sourceMetadata)).projectedPatchTransport, ["Онгоц"]);
});

test("transport staff set through the admin's website patch is theirs, also after the patch stops naming it", async (context) => {
  const patched = trip({ transport_type: "land", website_details_patch: { base: { transport: ["Галт тэрэг", "Автобус"] }, values: { transport: ["Автобус", "Морь"] } } });
  const applied = await project(context, { source: patched, poster: { days: posterDays }, site: "https://catalog.invalid", prior: {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture", transport: ["Галт тэрэг", "Автобус"],
    sourceMetadata: { connectedSource: { ...patched, photos: [], poster: { days: [] } }, contentSnapshot: { transport: ["Галт тэрэг", "Автобус"] } },
  } });
  assert.deepEqual(applied.trip.transport, ["Автобус", "Морь"]);
  const appliedMetadata = JSON.parse(String(applied.trip.sourceMetadata));
  assert.equal("projectedPatchTransport" in appliedMetadata, false);
  // Saving another website detail rebuilt the patch without transport.
  const later = trip({ transport_type: "land", website_details_patch: { base: { city: null }, values: { city: "Норвел" } } });
  const kept = await project(context, { source: later, poster: { days: posterDays }, site: "https://catalog.invalid", prior: {
    id: "web-norvel", slug: "trip-norvel", categoryId: "category-fixture", transport: ["Автобус", "Морь"], city: null,
    sourceMetadata: { connectedSource: { ...patched, photos: [], poster: { days: [] } }, contentSnapshot: appliedMetadata.contentSnapshot },
  } });
  assert.equal("transport" in kept.trip, false, "the override is a website value now: kept");
  assert.equal(kept.trip.city, "Норвел");
});
