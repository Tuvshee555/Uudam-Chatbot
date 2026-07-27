/**
 * Regressions from the 2026-07-27 full audit.
 *
 * Fixtures are SYNTHETIC on purpose: no real route name, price or departure
 * date appears here. Only the *shapes* the live catalog uses are reproduced
 * (age bands written in years / months / birth-years, weekday recurrences,
 * included/excluded item lists), because the shape is what the code branches
 * on. Prices are deliberately impossible-but-well-formed so a leak into any
 * reply is instantly recognisable as fake. See feedback_no_hardcoded_trips.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBudgetReply,
  buildCompareReply,
  buildStructuredTripReply,
  hasBudgetIntent,
  resolveFocusTripForDateQuestion,
} from "../src/lib/travelFastPaths";
import { buildDepartureDateAvailabilityReply } from "../src/lib/travelDates";
import { ageBandCoversAge } from "../src/lib/travelFastPathsPricing";
import type { TravelTrip } from "../src/lib/travelOps";

const NOW = new Date("2026-07-27T04:00:00.000Z");

const ADULT = 1111111;
const CHILD = 999999;
const OTHER_ADULT = 2222222;

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "t",
    category: "",
    operator_name: "Тест оператор",
    route_name: "Зэрэглээ хотын аялал",
    duration_text: "6 өдөр / 5 шөнө",
    adult_price: ADULT,
    child_price: CHILD,
    currency: "MNT",
    departure_dates: [],
    seats_total: null,
    seats_left: null,
    has_food: null,
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

// Shape under test: a free infant band sitting beside a paid child band.
const WEEKLY_TRIP = trip({
  id: "weekly",
  route_name: "Зэрэглээ хотын аялал",
  departure_dates: ["Баасан гариг болгон"],
  extra: {
    aliases: ["Зэрэглээ"],
    child_rules: [
      { label: "Хүүхэд", price: CHILD, currency: "MNT", age_range: "2-12 нас", note: "" },
      { label: "Нярай", price: 0, currency: "MNT", age_range: "0-2 нас", note: "Үнэгүй" },
    ],
  },
});

// Shape under test: explicit calendar departures rather than a recurrence.
const DATED_TRIP = trip({
  id: "dated",
  route_name: "Номин арлын аялал",
  adult_price: OTHER_ADULT,
  departure_dates: ["8 сарын 20"],
  extra: { aliases: ["Номин"] },
});

// ---- Age bands: the stated age picks the tier, in the tier's own unit ----

test("a 1-year-old gets the free infant band, not the paid child fare", () => {
  const reply = buildStructuredTripReply("Зэрэглээ 1 настай хүүхэд хэд вэ", [WEEKLY_TRIP], NOW) || "";
  assert.match(reply, /Үнэгүй/);
  assert.doesNotMatch(reply, new RegExp(CHILD.toLocaleString("en-US")));
});

test("an age stated in months resolves against the band's own unit", () => {
  const reply = buildStructuredTripReply("Зэрэглээ 6 сартай хүүхэд хэд вэ", [WEEKLY_TRIP], NOW) || "";
  assert.match(reply, /Үнэгүй/);
  assert.doesNotMatch(reply, new RegExp(CHILD.toLocaleString("en-US")));
});

test("an age above every child band is quoted the adult fare, never the child one", () => {
  const reply = buildStructuredTripReply("Зэрэглээ 15 настай хүүхэд хэд вэ", [WEEKLY_TRIP], NOW) || "";
  assert.match(reply, new RegExp(ADULT.toLocaleString("en-US")));
  assert.doesNotMatch(reply, new RegExp(CHILD.toLocaleString("en-US")));
});

test("an age inside the child band still gets the child fare", () => {
  const reply = buildStructuredTripReply("Зэрэглээ 5 настай хүүхэд хэд вэ", [WEEKLY_TRIP], NOW) || "";
  assert.match(reply, new RegExp(CHILD.toLocaleString("en-US")));
});

test("ageBandCoversAge reads months, years and birth-year bands in their own unit", () => {
  assert.equal(ageBandCoversAge("0-23 сар", 1, "year"), true); // 12 months
  assert.equal(ageBandCoversAge("0-23 сар", 5, "year"), false); // 60 months
  assert.equal(ageBandCoversAge("2-12 нас", 15, "year"), false);
  assert.equal(ageBandCoversAge("11 нас доош", 9, "year"), true);
  // Born 2015-2022 → aged 4..11 in 2026.
  assert.equal(ageBandCoversAge("2015-2022 он", 8, "year", NOW), true);
  assert.equal(ageBandCoversAge("2015-2022 он", 20, "year", NOW), false);
  assert.equal(ageBandCoversAge("", 5, "year"), null);
});

// ---- Departure dates: answer about the trip the customer named ----

test("a named trip that does not run on the asked date is not answered with a yes", () => {
  // 2026-08-20 is a Thursday; the named trip departs Fridays. The OTHER trip in
  // the catalog does depart that day — which is how the unscoped answer used to
  // reply "Тийм ээ" and then list the wrong tour.
  const reply = buildDepartureDateAvailabilityReply({
    userText: "Зэрэглээ 8 сарын 20-нд явах уу",
    trips: [WEEKLY_TRIP, DATED_TRIP],
    now: NOW,
    focusTrip: WEEKLY_TRIP,
  }) || "";
  assert.doesNotMatch(reply, /^Тийм ээ/);
  assert.doesNotMatch(reply, /Номин арлын аялал/);
  assert.match(reply, /Баасан гариг болгон/);
});

test("a named trip's weekly recurrence still counts as a departure", () => {
  // 2026-08-21 is a Friday.
  const reply = buildDepartureDateAvailabilityReply({
    userText: "Зэрэглээ 8 сарын 21-нд явах уу",
    trips: [WEEKLY_TRIP, DATED_TRIP],
    now: NOW,
    focusTrip: WEEKLY_TRIP,
  }) || "";
  assert.match(reply, /Тийм ээ/);
});

test("a date question naming no trip still answers catalog-wide", () => {
  const reply = buildDepartureDateAvailabilityReply({
    userText: "8 сарын 20-нд ямар аялал байна",
    trips: [WEEKLY_TRIP, DATED_TRIP],
    now: NOW,
    focusTrip: null,
  }) || "";
  assert.match(reply, /Номин арлын аялал/);
});

test("resolveFocusTripForDateQuestion picks a named trip and abstains otherwise", () => {
  assert.equal(
    resolveFocusTripForDateQuestion("Номин 8 сарын 20-нд явах уу", [WEEKLY_TRIP, DATED_TRIP])?.id,
    "dated",
  );
  assert.equal(
    resolveFocusTripForDateQuestion("8 сарын 20-нд ямар аялал байна", [WEEKLY_TRIP, DATED_TRIP]),
    null,
  );
});

// ---- Compare: only the trips the customer named ----

test("comparing two trips does not pull in a third via the connector 'болон'", () => {
  // "болон" ("and") occurs inside other trips' formatted date labels, so a
  // whole-haystack match let the word "and" nominate an unrelated tour.
  const bystander = trip({
    id: "bystander",
    route_name: "Сарнай хотын аялал",
    adult_price: 3333333,
    departure_dates: ["8 сарын 6, 13-ны болон 20-ны гаралт"],
  });
  const reply = buildCompareReply("Номин болон Зэрэглээ хоёрыг харьцуулаач", [
    DATED_TRIP,
    WEEKLY_TRIP,
    bystander,
  ]) || "";
  assert.match(reply, /Номин арлын аялал/);
  assert.match(reply, /Зэрэглээ хотын аялал/);
  assert.doesNotMatch(reply, /Сарнай хотын аялал/);
});

// ---- Superlatives ----

test("the priciest-tour question is answered, not dropped", () => {
  const cheap = trip({ id: "cheap", route_name: "Гэрэлт хотын аялал", adult_price: 555555, child_price: 444444 });
  assert.equal(hasBudgetIntent("хамгийн үнэтэй аялал аль вэ"), true);
  const reply = buildBudgetReply("хамгийн үнэтэй аялал аль вэ", [cheap, DATED_TRIP], NOW) || "";
  assert.match(reply, /Хамгийн үнэтэй/);
  assert.match(reply, /Номин арлын аялал/);
});

test("the cheapest question lists every trip tied at that fare", () => {
  const a = trip({ id: "a", route_name: "Цэнхэрлэг хотын аялал", adult_price: 555555, child_price: 444444 });
  const b = trip({ id: "b", route_name: "Ягаан хотын аялал", adult_price: 555555, child_price: 333333 });
  const reply = buildBudgetReply("хамгийн хямд аялал аль нь вэ", [a, b, DATED_TRIP], NOW) || "";
  assert.match(reply, /Цэнхэрлэг хотын аялал/);
  assert.match(reply, /Ягаан хотын аялал/);
});

// ---- Inclusion questions answer from the operator's own notes ----

test("a meals question is answered from the note that states it", () => {
  const meals = trip({
    id: "meals",
    route_name: "Сарнай нуурын аялал",
    has_food: true,
    notes: "Өглөөний цай, оройн хоол багтсан, өдрийн хоол багтаагүй.",
    extra: { aliases: ["Сарнай нуур"] },
  });
  const reply = buildStructuredTripReply("Сарнай нуур хоол багтсан уу", [meals], NOW) || "";
  assert.match(reply, /өдрийн хоол багтаагүй/);
});

test("meals included and excluded stay on opposite sides", () => {
  const listed = trip({
    id: "listed",
    route_name: "Номин уулын аялал",
    extra: {
      aliases: ["Номин уул"],
      included_items: ["Хөтөлбөрт багтсан хоол", "Аяллын даатгал"],
      excluded_items: ["Хөтөлбөрт багтаагүй хоол"],
    },
  });
  const reply = buildStructuredTripReply("Номин уул хоол багтсан уу", [listed], NOW) || "";
  assert.match(reply, /Багтсан: Хөтөлбөрт багтсан хоол/);
  assert.match(reply, /Багтаагүй: Хөтөлбөрт багтаагүй хоол/);
  // The insurance line is not a meal and must not be listed as one.
  assert.doesNotMatch(reply, /даатгал/);
});

test("an airfare question about a named trip is not derailed by a ship-named tour", () => {
  // "онгоцны тийз" ("plane ticket") shares a word with any tour whose name
  // contains "онгоц", which used to turn a named-trip question into "which trip
  // did you mean?".
  const shipNamed = trip({
    id: "ship",
    route_name: "Усан онгоцны Гэрэлт аялал",
    adult_price: null,
    child_price: null,
    duration_text: "11 өдөр / 10 шөнө",
  });
  const named = trip({
    id: "named",
    route_name: "Зэрэглээ нуурын аялал",
    departure_dates: ["Баасан гариг болгон"],
    extra: {
      aliases: ["Зэрэглээ нуур"],
      important_notes: ["Онгоцны тийзтэй болон тийзгүй үнэ тусдаа."],
    },
  });
  const reply = buildStructuredTripReply("Зэрэглээ нуур онгоцны тийз багтсан уу", [named, shipNamed], NOW) || "";
  assert.match(reply, /Зэрэглээ нуурын аялал/);
  assert.doesNotMatch(reply, /Усан онгоцны/);
});
