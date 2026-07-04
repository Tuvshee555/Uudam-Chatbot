import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDepartureDateAvailabilityReply,
  buildTemporalPromptContext,
  filterFutureDepartureDates,
  hasDepartureDateAvailabilityIntent,
  parseDepartureDateText,
  parseTripDepartureDateText,
  resolveDepartureDatesAtWrite,
  resolveRequestedDate,
} from "../src/lib/travelDates";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW_IN_MONGOLIA = new Date("2026-05-30T04:00:00.000Z");

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-1",
    category: "Outbound",
    operator_name: "Uudam Travel",
    route_name: "Бээжин аялал",
    duration_text: "4 өдөр",
    adult_price: 2500000,
    child_price: null,
    currency: "MNT",
    departure_dates: [],
    seats_total: 20,
    seats_left: 6,
    has_food: true,
    status: "active",
    notes: "",
    hotel: "",
    source_description: "",
    photo_urls: [],
    extra: {},
    created_at: "",
    updated_at: "",
    ...fields,
  };
}

test("resolves margaash/tomorrow against Mongolia time", () => {
  const requested = resolveRequestedDate(
    "margaash garah aylal baina uu",
    NOW_IN_MONGOLIA,
  );

  assert.equal(requested?.ymd, "2026-05-31");
  assert.equal(requested?.label, "маргааш");
});

test("parses common stored departure date formats", () => {
  assert.deepEqual(parseDepartureDateText("2026.05.31", NOW_IN_MONGOLIA), [
    "2026-05-31",
  ]);
  assert.deepEqual(parseDepartureDateText("5 сарын 31", NOW_IN_MONGOLIA), [
    "2026-05-31",
  ]);
});

test("answers direct tomorrow availability from active trip dates", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "маргааш гарах аялал байна уу",
    now: NOW_IN_MONGOLIA,
    trips: [
      trip({ departure_dates: ["2026-05-31"] }),
      trip({
        id: "cancelled",
        route_name: "Цуцлагдсан аялал",
        departure_dates: ["2026-05-31"],
        status: "cancelled",
      }),
    ],
  });

  assert.match(reply || "", /Тийм ээ/);
  assert.match(reply || "", /2026-05-31/);
  assert.match(reply || "", /Бээжин аялал/);
  assert.doesNotMatch(reply || "", /Цуцлагдсан/);
});

test("answers no for missing target date and suggests upcoming departures", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "tomorrow departure available?",
    now: NOW_IN_MONGOLIA,
    trips: [trip({ departure_dates: ["2026-06-02"] })],
  });

  assert.match(reply || "", /алга байна/);
  assert.match(reply || "", /2026-06-02/);
  assert.doesNotMatch(reply || "", /ямар огноо|тодруулах/i);
});

test("answers direct date availability even when there are no trips", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "margaash garah aylal baina uu",
    now: NOW_IN_MONGOLIA,
    trips: [],
  });

  assert.match(reply || "", /2026-05-31/);
  assert.match(reply || "", /алга байна/);
  assert.doesNotMatch(reply || "", /ямар огноо|тодруулах/i);
});

test("recognizes date availability even when the user also wants to book", () => {
  assert.equal(
    hasDepartureDateAvailabilityIntent(
      "margaash garah aylal baina uu zahialah gesen yum",
      NOW_IN_MONGOLIA,
    ),
    true,
  );
});

test("prompt context tells the model what tomorrow means", () => {
  const context = buildTemporalPromptContext("margaash?", NOW_IN_MONGOLIA);

  assert.match(context, /Current date .*2026-05-30/);
  assert.match(context, /tomorrow.*2026-05-31/);
  assert.match(context, /requested date resolves to 2026-05-31/);
});

test("trip-date parsing keeps bare month/day in the CURRENT year (no roll-forward)", () => {
  // 2026-05-30 in Mongolia: "3 сарын 8" on a stored trip is March 2026 (past),
  // never March 2027 — roll-forward here made stale trips look bookable.
  assert.deepEqual(parseTripDepartureDateText("3 сарын 8", NOW_IN_MONGOLIA), ["2026-03-08"]);
  assert.deepEqual(parseTripDepartureDateText("2026 он 7 сар 7", NOW_IN_MONGOLIA), ["2026-07-07"]);
});

test("filterFutureDepartureDates drops past dates, keeps future and recurring text", () => {
  const filtered = filterFutureDepartureDates(
    [
      "3 сарын 8", // past (March 2026 vs now = May 30, 2026)
      "6 сарын 10", // future
      "Пүрэв гараг бүр", // recurring — always kept
      "аяллын групп бүрдсэн огноогоор", // flexible — always kept
      "2026-05-30", // today — kept
      "2025-12-01", // explicit past year — dropped
    ],
    NOW_IN_MONGOLIA,
  );
  assert.deepEqual(filtered, [
    "6 сарын 10",
    "Пүрэв гараг бүр",
    "аяллын групп бүрдсэн огноогоор",
    "2026-05-30",
  ]);
});

test("resolveDepartureDatesAtWrite freezes bare dates with roll-forward from write time", () => {
  // In July 2026: "1 сарын 15" is next January (2027), "8 сарын 1" is this August.
  const resolved = resolveDepartureDatesAtWrite(
    ["1 сарын 15", "8 сарын 1", "Пүрэв гараг бүр"],
    new Date("2026-07-04T04:00:00.000Z"),
  );
  assert.deepEqual(resolved, [
    { text: "1 сарын 15", ymd: "2027-01-15" },
    { text: "8 сарын 1", ymd: "2026-08-01" },
    { text: "Пүрэв гараг бүр", ymd: null }, // recurring — no calendar date
  ]);
});

test("resolved map keeps a genuine next-season date that text parsing would hide", () => {
  const now = new Date("2026-07-04T04:00:00.000Z");
  // Without the map, "1 сарын 15" parses to 2026-01-15 (past) and is dropped.
  assert.deepEqual(filterFutureDepartureDates(["1 сарын 15"], now), []);
  // With the frozen write-time resolution (next January), it is kept.
  const resolved = [{ text: "1 сарын 15", ymd: "2027-01-15" }];
  assert.deepEqual(filterFutureDepartureDates(["1 сарын 15"], now, resolved), ["1 сарын 15"]);
});

test("resolved map still drops a frozen date that has since passed", () => {
  const now = new Date("2026-07-04T04:00:00.000Z");
  const resolved = [{ text: "3 сарын 8", ymd: "2026-03-08" }]; // frozen, now past
  assert.deepEqual(filterFutureDepartureDates(["3 сарын 8"], now, resolved), []);
});

test("date availability does not resurrect a past-season trip as next year", () => {
  // User asks for March 8 (rolls forward to 2027-03-08); the trip's stored
  // "3 сарын 8" means March 2026 — they must NOT match.
  const reply = buildDepartureDateAvailabilityReply({
    userText: "3 сарын 8-нд гарах аялал байна уу",
    now: NOW_IN_MONGOLIA,
    trips: [trip({ departure_dates: ["3 сарын 8"] })],
  });
  assert.match(reply || "", /алга байна/);
});

test("availability matches a next-season trip via its write-time resolved map", () => {
  const now = new Date("2026-07-04T04:00:00.000Z");
  const reply = buildDepartureDateAvailabilityReply({
    userText: "1 сарын 15-нд гарах аялал байна уу",
    now,
    trips: [
      trip({
        route_name: "Хайнан өвлийн аялал",
        departure_dates: ["1 сарын 15"],
        extra: { departure_dates_resolved: [{ text: "1 сарын 15", ymd: "2027-01-15" }] },
      }),
    ],
  });
  assert.match(reply || "", /Тийм ээ/);
  assert.match(reply || "", /Хайнан өвлийн аялал/);
});
