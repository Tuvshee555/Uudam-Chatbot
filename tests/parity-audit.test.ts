import test from "node:test";
import assert from "node:assert/strict";
import {
  botDifferences, cardAmountProblems, isCheckedTrip, partnerDifferences, posterDifferences, quoteMatrix, renderParityReport,
  summaryLine, topDifferences, tripAfterPosterSave, unsoldWebsitePages, websiteDifferences, withWebsiteOverlay,
  type TripParityResult, type WebsiteRows,
} from "../src/lib/parityAudit";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { websiteDayMeals, websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import { normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import type { TravelTrip } from "../src/lib/travelTypes";

// Invented trips, hotels and prices only.
const NOW = new Date("2099-01-05T04:00:00Z");
const DATES = ["2099-02-10", "2099-02-17", "2099-02-24"];
const AGES = { adult: "12+ нас", child: "2-11 нас" };

function trip(extra: Record<string, unknown> = {}, more: Partial<TravelTrip> = {}): TravelTrip {
  return {
    id: "trip-invented-1", route_name: "ТЭНГЭР НУУРЫН АЯЛАЛ", operator_name: "Uudam", category: "Аялал",
    duration_text: "3 өдөр 2 шөнө", adult_price: 1_000_000, child_price: 800_000, infant_price: null, currency: "MNT",
    departure_dates: DATES, seats_total: null, seats_left: null, has_food: true, status: "active", notes: "",
    hotel: "Цэнхэр буудал", source_description: "", photo_urls: [],
    extra: {
      poster_trip_id: "poster-invented-1", age_rules: AGES,
      price_groups: [
        { dates: ["2099-02-10", "2099-02-17"], adult_price: 1_000_000, child_price: 800_000 },
        { dates: ["2099-02-24"], adult_price: 1_200_000, child_price: 900_000 },
      ],
      itinerary_days: [
        { day: 1, title: "Хот — нуур", description: "Замд гарна" },
        { day: 2, title: "Нуур", description: "Амарна" },
        { day: 3, title: "Нуур — хот", description: "Буцна" },
      ],
      ...extra,
    },
    created_at: "", updated_at: "", ...more,
  };
}

/** The poster as a save from the chatbot leaves it: the same days, a price table matching price_groups. */
function poster(rows = [
  { dates: "2 сарын 10, 17", cells: ["1,000,000₮", "800,000₮"] },
  { dates: "2 сарын 24", cells: ["1,200,000₮", "900,000₮"] },
]): Record<string, unknown> {
  return {
    title: "ТЭНГЭР НУУРЫН АЯЛАЛ", duration_days: 3, duration_nights: 2,
    days: [
      { day: 1, route: "Хот — нуур", summary: "Замд гарна", meals: { breakfast: false, lunch: true, dinner: true } },
      { day: 2, route: "Нуур", summary: "Амарна", meals: { breakfast: true, lunch: true, dinner: true } },
      { day: 3, route: "Нуур — хот", summary: "Буцна", meals: { breakfast: true, lunch: null, dinner: null } },
      { day: 4, photo: "https://res.cloudinary.com/invented/photo-only.jpg" },
    ],
    price_table: { columns: ["Огноо", "Том хүн", "Хүүхэд 2-11 нас"], rows },
  };
}

/** Website rows exactly as the chatbot → website projection would write them now. */
function websiteRowsFor(source: TravelTrip, posterData: Record<string, unknown>): WebsiteRows {
  const payload = websiteTripPayload(source, websiteDepartureSchedule(source, NOW), NOW);
  return {
    trip: {
      slug: "trip-invented", title: source.route_name, hotel: source.hotel, durationDays: 3, durationNights: 2,
      isPublished: true, price: payload.price ?? 0, childPrice: payload.childPrice, infantPrice: payload.infantPrice,
      currency: "MNT", sourceTripId: source.id,
      sourceMetadata: {
        canonicalOffers: payload.canonicalOffers, price_groups: payload.priceGroups, contentConflicts: [],
        websiteSyncPending: null, connectedSource: { status: source.status, seats_total: source.seats_total, seats_left: source.seats_left },
      },
    },
    departures: payload.departures.map((dep) => ({
      sourceTripId: source.id, startDate: `${dep.start.slice(0, 10)} 00:00:00`, status: dep.status, seatsLeft: dep.seatsLeft,
      price: dep.price, childPrice: dep.childPrice, infantPrice: dep.infantPrice,
    })),
    days: (posterData.days as Array<Record<string, unknown>>).filter((day) => day.route)
      .map((day) => ({ sourceTripId: source.id, dayNumber: day.day, title: day.route, meals: websiteDayMeals(day.meals) })),
  };
}

const codes = (diffs: Array<{ code: string }>) => diffs.map((diff) => diff.code).sort();

test("a trip whose website rows are what the projection writes has no website difference", () => {
  const source = trip();
  const posterData = poster();
  assert.deepEqual(websiteDifferences(source, posterData, websiteRowsFor(source, posterData), NOW), []);
});

test("website: a stale date price, a hidden page, an extra open date and a missing date are each reported", () => {
  const source = trip();
  const posterData = poster();
  const rows = websiteRowsFor(source, posterData);
  rows.trip!.isPublished = false;
  rows.departures[1] = { ...rows.departures[1], price: 950_000 };
  rows.departures.push({ sourceTripId: source.id, startDate: "2099-03-03 00:00:00", status: "OPEN", seatsLeft: null, price: 1_000_000, childPrice: null, infantPrice: null });
  rows.departures.splice(2, 1);
  const diffs = websiteDifferences(source, posterData, rows, NOW);
  assert.deepEqual(codes(diffs), ["web_departure_extra", "web_departure_missing", "web_departure_price", "web_published"]);
  const price = diffs.find((diff) => diff.code === "web_departure_price")!;
  assert.equal(price.severity, 3);
  assert.deepEqual(price.items, ["2/17 · adult: website 950,000₮ · chatbot 1,000,000₮"]);
  assert.deepEqual(diffs.find((diff) => diff.code === "web_departure_extra")!.items, ["3/3"]);
  assert.deepEqual(diffs.find((diff) => diff.code === "web_departure_missing")!.items, ["2/24"]);
});

test("website: title, duration, hotel, day count, meals, status and open conflicts", () => {
  const source = trip();
  const posterData = poster();
  const rows = websiteRowsFor(source, posterData);
  Object.assign(rows.trip!, { title: "ХУУЧИН НЭР", durationDays: 4, hotel: "Өөр буудал" });
  rows.trip!.sourceMetadata = { ...(rows.trip!.sourceMetadata as object), contentConflicts: [{ field: "title" }] };
  rows.departures[0] = { ...rows.departures[0], status: "SOLD_OUT", seatsLeft: 0 };
  rows.days = rows.days.slice(0, 2).map((day) => (day.dayNumber === 1 ? { ...day, meals: ["Өглөө"] } : day));
  const diffs = websiteDifferences(source, posterData, rows, NOW);
  assert.deepEqual(codes(diffs), ["web_day_meals", "web_days_count", "web_duration", "web_hotel", "web_open_conflicts", "web_title"].sort());
  assert.deepEqual(diffs.find((diff) => diff.code === "web_day_meals")!.items, ["day 1: website Өглөө · chatbot Өдөр+Орой"]);
  // A website status edit is read back as the bot's own availability (the overlay), so it is not a difference.
  assert.equal(diffs.some((diff) => diff.code === "web_departure_status"), false);
});

test("website: a weekly trip's newest date, not on the website yet, is the normal sync lag", () => {
  const weekly = trip({ price_groups: [] }, { departure_dates: ["Ням гараг бүр"] });
  const posterData = poster();
  const rows = websiteRowsFor(weekly, posterData);
  rows.departures.pop();
  const diffs = websiteDifferences(weekly, posterData, rows, NOW);
  assert.deepEqual(diffs.map((diff) => [diff.code, diff.severity]), [["web_weekly_dates_behind", 1]]);
  rows.departures.splice(-3);
  assert.equal(websiteDifferences(weekly, posterData, rows, NOW).find((diff) => diff.code === "web_weekly_dates_behind")!.severity, 2);
});

test("website: a trip the website has no row for is one red difference", () => {
  const diffs = websiteDifferences(trip(), poster(), { trip: null, departures: [], days: [] }, NOW);
  assert.deepEqual(diffs.map((diff) => [diff.code, diff.severity]), [["web_missing", 3]]);
});

test("the overlay gives the bot the website's per-date status, as listTrips does", () => {
  const source = trip();
  const rows = websiteRowsFor(source, poster());
  rows.departures[0] = { ...rows.departures[0], status: "SOLD_OUT", seatsLeft: 0 };
  const served = withWebsiteOverlay(source, rows);
  assert.deepEqual((served.extra.website_departure_availability as Array<Record<string, unknown>>)[0], { date: "2099-02-10", status: "SOLD_OUT", seatsLeft: 0 });
  assert.equal(served.extra.website_slug, "trip-invented");
  assert.equal(served.extra.website_published, true);
});

test("poster: a table that matches price_groups is no difference", () => {
  assert.deepEqual(posterDifferences(trip(), poster(), NOW), []);
});

test("poster: a per-date price edited in the chatbot but not on the poster is the Poster-tab save trap", () => {
  // Staff raised 2/17 only; the poster table still says 1,000,000₮ for 2/10 and 2/17.
  const edited = trip({ price_groups: [
    { dates: ["2099-02-10"], adult_price: 1_000_000, child_price: 800_000 },
    { dates: ["2099-02-17"], adult_price: 1_100_000, child_price: 800_000 },
    { dates: ["2099-02-24"], adult_price: 1_200_000, child_price: 900_000 },
  ] });
  const diffs = posterDifferences(edited, poster(), NOW);
  assert.deepEqual(codes(diffs), ["poster_price"]);
  assert.equal(diffs[0].severity, 3);
  assert.deepEqual(diffs[0].items, ["2/17 · all: chatbot Том хүн 1,100,000₮ · poster Том хүн 1,000,000₮"]);
  // What the save would write back: the poster's 1,000,000₮ on 2/17.
  const after = tripAfterPosterSave(edited, poster())!;
  const rows = after.extra.price_groups as Array<Record<string, unknown>>;
  assert.ok(rows.some((row) => (row.dates as string[]).includes("2 сарын 17") && row.adult_price === 1_000_000));
});

test("poster: a date only the poster prices, a date only the chatbot prices, and a day count", () => {
  const posterData = poster([
    { dates: "2 сарын 10, 17", cells: ["1,000,000₮", "800,000₮"] },
    { dates: "3 сарын 3", cells: ["1,300,000₮", "900,000₮"] },
  ]);
  (posterData.days as unknown[]).splice(2, 1);
  // No trip-wide fare, so a date without a price row has no price at all.
  const diffs = posterDifferences(trip({}, { adult_price: null, child_price: null }), posterData, NOW);
  assert.deepEqual(codes(diffs), ["poster_days", "poster_row_extra", "poster_row_missing"]);
  assert.match(diffs.find((diff) => diff.code === "poster_row_extra")!.items[0], /^3\/3 · all: poster Том хүн 1,300,000₮/);
  assert.match(diffs.find((diff) => diff.code === "poster_row_missing")!.items[0], /^2\/24 · all: chatbot Том хүн 1,200,000₮/);
  assert.deepEqual(diffs.find((diff) => diff.code === "poster_days")!.items, ["poster 2 · chatbot 3"]);
});

test("poster: a date with no poster row is the trip-wide fallback after a save, never a price the poster prints", () => {
  const posterData = poster([{ dates: "2 сарын 10, 17", cells: ["1,000,000₮", "800,000₮"] }]);
  const diffs = posterDifferences(trip(), posterData, NOW);
  // The 1,000,000₮ / 800,000₮ are the trip-wide fare, not a poster cell for 2/24: no red "the PDF shows it".
  assert.deepEqual(diffs.map((diff) => [diff.code, diff.severity]), [["poster_row_unreadable", 2]]);
  assert.deepEqual(diffs[0].items, ["2/24 · all: chatbot Том хүн 1,200,000₮; Хүүхэд 900,000₮ · after a Poster-tab save the trip-wide Том хүн 1,000,000₮; Хүүхэд 800,000₮ (the date reader places no poster row on this day)"]);
  // When the trip-wide fare is the chatbot's own fare for that date, the save changes nothing anyone sees.
  assert.deepEqual(posterDifferences(trip({ price_groups: [{ dates: DATES, adult_price: 1_000_000, child_price: 800_000 }] }), posterData, NOW), []);
});

test("poster: range-labelled rows printing the chatbot's own per-package prices are unreadable rows, not missing or different prices", () => {
  const packaged = trip({ price_groups: [
    { dates: ["2099-02-10"], package_id: "Хөтөлбөртэй", adult_price: 1_500_000, child_price: 900_000 },
    { dates: ["2099-02-17"], package_id: "Чөлөөт", adult_price: 1_700_000, child_price: 900_000 },
    { dates: ["2099-02-24"], package_id: "Чөлөөт", adult_price: 1_800_000, child_price: 900_000 },
  ] }, { adult_price: 1_500_000, child_price: 900_000 });
  const posterData = { ...poster(), price_note: "Том хүн: 1500000₮; Хүүхэд: 900000₮", price_table: {
    columns: ["Хугацаа", "Хөтөлбөртэй - том хүний үнэ", "Хөтөлбөртэй - хүүхдийн үнэ", "Чөлөөт - том хүний үнэ", "Чөлөөт - хүүхдийн үнэ"],
    rows: [
      { dates: "2099: 02/10 - 02/17", cells: ["1,500,000₮", "900,000₮", "-", "-"] },
      { dates: "2099: 02/17 - 02/24", cells: ["-", "-", "1,700,000₮", "900,000₮"] },
      { dates: "2099: 02/24 - 03/03", cells: ["-", "-", "1,800,000₮", "900,000₮"] },
    ],
  } };
  const diffs = posterDifferences(packaged, posterData, NOW).filter((diff) => diff.code !== "poster_days");
  assert.deepEqual(diffs.map((diff) => [diff.code, diff.severity]), [["poster_row_unreadable", 2]]);
  assert.equal(diffs[0].items.length, 3);
  assert.match(diffs[0].items[0], /^2\/10 · Хөтөлбөртэй: chatbot Том хүн 1,500,000₮; Хүүхэд 900,000₮ · after a Poster-tab save no price .*a poster row is dated this day, but its prices cannot be read/);
  // Whatever the report says the poster holds is a cell the poster prints.
  for (const item of diffs[0].items) assert.deepEqual([...(item.split(" · after ")[1] || "").matchAll(/\d{1,3}(?:,\d{3})+/g)], []);
});

test("poster: a fare the poster table leaves out is inherited after a save; a printed one stays a poster price", () => {
  const adultOnly = (cells24: string) => ({ ...poster(), price_table: { columns: ["Огноо", "Том хүн"], rows: [
    { dates: "2 сарын 10, 17", cells: ["1,000,000₮"] }, { dates: "2 сарын 24", cells: [cells24] },
  ] } });
  // Same adult fares: only the child fare differs, and after the save it is the trip-wide 800,000₮.
  const inherited = posterDifferences(trip(), adultOnly("1,200,000₮"), NOW);
  assert.deepEqual(inherited.map((diff) => [diff.code, diff.items]), [["poster_row_unreadable",
    ["2/24 · all: chatbot Хүүхэд 900,000₮ · after a Poster-tab save the trip-wide Хүүхэд 800,000₮ (the poster row has no readable price for it)"]]]);
  // A different adult fare is printed on the poster; the child fare beside it is marked as not the poster's.
  const printed = posterDifferences(trip(), adultOnly("1,100,000₮"), NOW);
  assert.deepEqual(printed.map((diff) => [diff.code, diff.severity, diff.items]), [["poster_price", 3,
    ["2/24 · all: chatbot Том хүн 1,200,000₮; Хүүхэд 900,000₮ · poster Том хүн 1,100,000₮; Хүүхэд 800,000₮ (trip-wide, not on the poster)"]]]);
});

test("quoteMatrix: each price knows whether a price row produced it", () => {
  const bot = quoteMatrix(trip({ price_groups: [{ dates: ["2099-02-10"], adult_price: 1_100_000 }] }), NOW);
  assert.deepEqual(bot.get("2099-02-10||"), { prices: ["Том хүн 1,100,000₮", "Хүүхэд 800,000₮"], labelled: ["Том хүн 1,100,000₮", "Хүүхэд 2-11 нас 800,000₮"],
    inherited: ["Хүүхэд 800,000₮"], conflict: false });
  assert.deepEqual(bot.get("2099-02-17||")!.inherited, ["Том хүн 1,000,000₮", "Хүүхэд 800,000₮"]);
});

test("poster: a table with no hotel column, for a trip sold per hotel, is a choice-name difference, not two rows", () => {
  const perHotel = trip({ price_groups: [
    { dates: ["2099-02-10", "2099-02-17"], hotel: "Нарны буудал", adult_price: 1_000_000, child_price: 800_000 },
    { dates: ["2099-02-24"], hotel: "Нарны буудал", adult_price: 1_250_000, child_price: 900_000 },
  ] });
  const diffs = posterDifferences(perHotel, poster(), NOW);
  assert.deepEqual(codes(diffs), ["poster_choice_name", "poster_price"]);
  assert.deepEqual(diffs.find((diff) => diff.code === "poster_choice_name")!.items, ["2/10, 2/17 · chatbot «Нарны буудал» · poster «all»"]);
  assert.deepEqual(diffs.find((diff) => diff.code === "poster_price")!.items, ["2/24 · chatbot «Нарны буудал» · poster «all»: chatbot Том хүн 1,250,000₮ · poster Том хүн 1,200,000₮"]);
});

test("poster: a missing poster is reported", () => {
  assert.deepEqual(codes(posterDifferences(trip(), null, NOW)), ["poster_missing"]);
});

test("bot: the shared card of a priced trip is accepted and holds only stored amounts", () => {
  assert.deepEqual(botDifferences(trip(), NOW), []);
});

test("bot: amounts on a card that no price row holds, or not in tugrik, are reported", () => {
  const lines = ["💰 Үнэ:", "• Том хүн: 1,000,000₮", "• Хүүхэд /2-11 нас/: 777,000₮", "• Ганцаараа явах (өрөөндөө ганцаараа): 300 USD"];
  const problems = cardAmountProblems(lines, trip());
  assert.deepEqual(problems.unknown, ["Хүүхэд /2-11 нас/: 777,000₮ (777,000 is not on any price row)", "Ганцаараа явах (өрөөндөө ганцаараа): 300 USD (300 is not on any price row)"]);
  assert.deepEqual(problems.foreign, ["Ганцаараа явах (өрөөндөө ганцаараа): 300 USD"]);
});

test("bot: answers the bot's own checker refused are carried into the report", () => {
  const diffs = botDifferences(trip(), NOW, ["date 2/10"]);
  assert.deepEqual(diffs.map((diff) => [diff.code, diff.items]), [["bot_answer_refused", ["date 2/10"]]]);
});

test("bot: a trip whose every near date is sold out says so, which is not a difference", () => {
  const full = trip({ website_departure_availability: DATES.map((date) => ({ date, status: "SOLD_OUT", seatsLeft: 0 })) });
  assert.deepEqual(botDifferences(full, NOW), []);
});

test("bot: prices the admin holds but the card cannot quote (two fares for one date) are a difference", () => {
  const clash = trip({ price_groups: [
    { dates: ["2099-02-10"], adult_price: 1_000_000 },
    { dates: ["2099-02-10"], adult_price: 1_100_000 },
  ] }, { departure_dates: ["2099-02-10"], adult_price: null, child_price: null });
  const diffs = botDifferences(clash, NOW);
  assert.deepEqual(diffs.map((diff) => [diff.code, diff.severity]), [["bot_no_fare", 2]]);
});

test("partner: stored facts equal to the partner's are no difference; a changed fare is", () => {
  const stored = trip({ partner_sync: { source_url: "https://partner.invalid/tours/x" } });
  const expected = {
    fields: { adult_price: stored.adult_price, child_price: stored.child_price, infant_price: stored.infant_price, hotel: stored.hotel,
      notes: stored.notes, departure_dates: stored.departure_dates, duration_text: stored.duration_text },
    extra: normalizeExtraPatch({ price_groups: stored.extra.price_groups, itinerary_days: stored.extra.itinerary_days }),
    contentHash: "hash-1",
  };
  const posterData = { partner_snapshot: { contentHash: "hash-1" }, partner_sync: { status: "complete" } };
  const clean = { ...stored, extra: { ...stored.extra, ...expected.extra } };
  assert.deepEqual(partnerDifferences(clean, posterData, expected), []);

  const raised = { ...expected, fields: { ...expected.fields, adult_price: 1_100_000 },
    extra: normalizeExtraPatch({ ...expected.extra, price_groups: [{ dates: ["2099-02-10"], adult_price: 1_100_000 }] }), contentHash: "hash-2" };
  const diffs = partnerDifferences(clean, posterData, raised);
  assert.deepEqual(codes(diffs), ["partner_fares", "partner_prices_dates", "partner_snapshot"]);
  assert.deepEqual(diffs.find((diff) => diff.code === "partner_prices_dates")!.items, ["adult_price: stored 1000000 · partner 1100000"]);
});

test("published-state sweep: archived, hidden, unknown and unlinked pages are flagged; sold out is not", () => {
  const trips = new Map<string, TravelTrip>([
    ["t-archived", trip({}, { id: "t-archived", status: "archived" })],
    ["t-hidden", trip({ customer_visible: false }, { id: "t-hidden" })],
    ["t-soldout", trip({}, { id: "t-soldout", status: "sold_out" })],
    ["t-live", trip({}, { id: "t-live" })],
  ]);
  const page = (sourceTripId: string | null, slug: string, isPublished = true) => ({ sourceTripId, slug, title: slug, isPublished });
  const pages = [page("t-archived", "a"), page("t-hidden", "b"), page("t-soldout", "c"), page("t-live", "d"), page("t-gone", "e"),
    page(null, "f"), page("t-archived", "g", false)];
  const found = unsoldWebsitePages(pages, trips);
  assert.deepEqual(found.map((result) => result.name), ["a", "b", "e", "f"]);
  assert.ok(found.every((result) => result.websitePageOnly && result.differences[0].code === "web_published_unsold"));
});

test("only active, customer-visible trips are checked", () => {
  assert.equal(isCheckedTrip(trip()), true);
  assert.equal(isCheckedTrip(trip({ customer_visible: false })), false);
  assert.equal(isCheckedTrip(trip({}, { status: "paused" })), false);
});

test("the report opens with the summary and lists only trips with differences, most serious first", () => {
  const results: TripParityResult[] = [
    { tripId: "t1", name: "ЦЭВЭРХЭН АЯЛАЛ", differences: [] },
    { tripId: "t2", name: "ЗӨРҮҮТЭЙ АЯЛАЛ", differences: [
      { area: "poster", severity: 1, code: "poster_days", mn: "Өдөр өөр", en: "days differ", items: ["poster 2 · chatbot 3"] },
      { area: "website", severity: 3, code: "web_departure_price", mn: "Үнэ өөр", en: "price differs", items: ["2/17 · adult"] },
    ] },
    { tripId: "website:x", name: "ХУУЧИН ХУУДАС", websitePageOnly: true, differences: [
      { area: "website", severity: 3, code: "web_published_unsold", mn: "Нийтлэгдсэн", en: "published", items: ["/mn/trips/x"] },
    ] },
  ];
  assert.equal(summaryLine(results), "2 trips checked, 1 with differences; 1 website page published for trips the chatbot does not sell");
  const report = renderParityReport(results, { generatedAt: "2099-01-05 12:00 (UB)", notChecked: ["«ЗӨРҮҮТЭЙ АЯЛАЛ» partner: timeout"] });
  const lines = report.split("\n");
  assert.equal(lines[0], "# Uudam parity check — 2099-01-05 12:00 (UB)");
  assert.match(lines[2], /^\*\*2 trips checked, 1 with differences/);
  assert.doesNotMatch(report, /## «ЦЭВЭРХЭН АЯЛАЛ»/);
  assert.match(report, /## «ЗӨРҮҮТЭЙ АЯЛАЛ»/);
  assert.match(report, /partner: timeout/);
  // Inside a trip, the customer-visible website price comes before the poster's day count.
  const section = report.slice(report.indexOf("## «ЗӨРҮҮТЭЙ АЯЛАЛ»"));
  assert.ok(section.indexOf("price differs") < section.indexOf("days differ"));
  assert.deepEqual(topDifferences(results, 2).map(({ diff }) => diff.code), ["web_departure_price", "web_published_unsold"]);
});

test("a report with no difference says everything agrees", () => {
  const report = renderParityReport([{ tripId: "t1", name: "ЦЭВЭРХЭН АЯЛАЛ", differences: [] }], { generatedAt: "2099-01-05 12:00 (UB)" });
  assert.match(report, /^# Uudam parity check/);
  assert.match(report, /1 trips checked, 0 with differences/);
  assert.match(report, /Everything agrees/);
});
