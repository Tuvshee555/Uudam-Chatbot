import test from "node:test";
import assert from "node:assert/strict";
import { dayStates, liftDayStates, lowerDayStates, rowDayState, setDayState, withPricedDaysOnCalendar } from "../src/lib/tripDayStates";
import { reviewedFields } from "../src/lib/tripReview";
import { priceModel } from "../src/lib/tripReviewPrices";

// Invented schedule: four departures, two prices, each row with its own seat state (as a partner table says it).
const NOW = new Date("2099-01-05T04:00:00Z");
type Row = Record<string, unknown>;
const row = (date: string, adult: number, more: Row = {}): Row => ({ dates: [date], adult_price: adult, child_price: adult, passenger_prices: [{ label: "Хүүхэд", age_range: "2-11 нас", price: adult }], ...more });
const fields = (): Row => ({
  route_name: "НОРВЕЛ ХОТЫН АЯЛАЛ", adult_price: 1_000_000, child_price: 1_000_000, infant_price: 0,
  departure_dates: ["2099-02-03", "2099-02-10"],
  extra: { price_groups: [
    row("2099-02-03", 1_000_000),
    row("2099-02-10", 1_200_000, { status: "sold_out" }),
    row("2099-02-17", 1_200_000, { status: "almost_full", seats_left: 4 }),
    row("2099-02-24", 1_000_000, { status: "sold_out" }),
  ] },
});

test("a row's words become a state: full, few seats with the count, open with a count, plain open", () => {
  assert.deepEqual(rowDayState({ status: "sold_out" }), { state: "full", seats: null });
  assert.deepEqual(rowDayState({ status: "almost_full", seats_left: 4 }), { state: "low", seats: 4 });
  assert.deepEqual(rowDayState({ seats_left: 0 }), { state: "full", seats: null });
  assert.deepEqual(rowDayState({ seats_left: 12 }), { state: "open", seats: 12 });
  assert.deepEqual(rowDayState({ status: "almost_full", seats_left: 12 }), { state: "open", seats: 12 }, "12 left is not few");
  assert.equal(rowDayState({}), null);
});

test("every priced day goes on the calendar, past ones excepted", () => {
  const withPast = fields();
  (withPast.extra as Row).price_groups = [...((withPast.extra as Row).price_groups as Row[]), row("2098-12-01", 900_000)];
  assert.deepEqual(withPricedDaysOnCalendar(withPast, NOW).departure_dates, ["2099-02-03", "2099-02-10", "2099-02-17", "2099-02-24"]);
});

test("states move off the rows, so same-price days are one card, and the review knows each day's state", () => {
  const lifted = liftDayStates(withPricedDaysOnCalendar(fields(), NOW), NOW);
  assert.deepEqual(dayStates(lifted), {
    "2099-02-10": { state: "full", seats: null },
    "2099-02-17": { state: "low", seats: 4 },
    "2099-02-24": { state: "full", seats: null },
  });
  for (const group of (lifted.extra as Row).price_groups as Row[]) assert.ok(!("status" in group) && !("seats_left" in group));
  const cards = priceModel(lifted, NOW).cards.filter((card) => card.kind === "own");
  assert.deepEqual(cards.map((card) => card.days), [["2099-02-03", "2099-02-24"], ["2099-02-10", "2099-02-17"]]);
});

test("on save each day keeps its own state: a card with mixed states is written as one row per state", () => {
  const lifted = liftDayStates(withPricedDaysOnCalendar(fields(), NOW), NOW);
  const saved = reviewedFields(lifted, "publish", NOW);
  const extra = saved.extra as Row;
  assert.equal(extra.day_states, undefined);
  const rows = (extra.price_groups as Row[]).map((group) => [(group.dates as string[]).join(","), group.adult_price, group.status ?? "", group.seats_left ?? ""]);
  assert.deepEqual(rows.sort(), [
    ["2099-02-03", 1_000_000, "", ""],
    ["2099-02-10", 1_200_000, "sold_out", ""],
    ["2099-02-17", 1_200_000, "almost_full", 4],
    ["2099-02-24", 1_000_000, "sold_out", ""],
  ]);
  assert.deepEqual(saved.departure_dates, ["2099-02-03", "2099-02-10", "2099-02-17", "2099-02-24"]);
  assert.equal(saved.status, "active", "full departures never make the trip sold out");
});

test("the admin changes a day's state; open clears it; a day priced by the trip's own fares gets a row for its state", () => {
  let next = setDayState(liftDayStates(fields(), NOW), "2099-02-24", null);
  next = setDayState(next, "2099-02-03", { state: "low", seats: 2 });
  assert.deepEqual(Object.keys(dayStates(next)).sort(), ["2099-02-03", "2099-02-10", "2099-02-17"]);
  const own = { route_name: "А", adult_price: 800_000, child_price: 700_000, infant_price: null, departure_dates: ["2099-03-01", "2099-03-08"], extra: {} };
  const lowered = lowerDayStates(setDayState(own, "2099-03-08", { state: "full", seats: 5 }), NOW);
  assert.deepEqual((lowered.extra as Row).price_groups, [{ dates: ["2099-03-08"], date_keys: ["2099-03-08"], display_dates: ["2099-03-08"], adult_price: 800_000,
    child_price: 700_000, infant_price: null, passenger_prices: [{ label: "Хүүхэд", age_range: "", price: 700_000, currency: "MNT" }], status: "sold_out" }]);
});

test("a day priced by an every-date row (no trip fare) keeps its state: a dated copy of each option carries it", () => {
  const options = { route_name: "А", adult_price: null, departure_dates: ["2099-03-01", "2099-03-08"], extra: { price_groups: [
    { dates: [], hotel: "Буудал А", package_id: "pkg-a", adult_price: 900_000 },
    { dates: [], hotel: "Буудал А", package_id: "pkg-b", adult_price: 800_000 },
  ] } };
  const rows = ((lowerDayStates(setDayState(options, "2099-03-08", { state: "low", seats: 2 }), NOW).extra as Row).price_groups as Row[]);
  assert.deepEqual(rows.map((group) => [group.package_id, (group.dates as string[]).join(","), group.status ?? "", group.seats_left ?? ""]), [
    ["pkg-a", "", "", ""], ["pkg-b", "", "", ""], ["pkg-a", "2099-03-08", "almost_full", 2], ["pkg-b", "2099-03-08", "almost_full", 2],
  ]);
});

test("rows the reader dated in a wrong season move by the gap the calendar shows; a truly past row stays", async () => {
  const { withRowYearsOfCalendar } = await import("../src/lib/tripDayStates");
  // Calendar lists only the first month; the rows carry an older season for every month.
  const read = { route_name: "А", departure_dates: ["2099-02-03", "2099-02-10"], extra: { price_groups: [
    { dates: ["2097-02-03"], adult_price: 1_000_000 },
    { dates: ["2097-03-03"], adult_price: 1_100_000 },
    { dates: ["2098-12-01"], adult_price: 900_000 },
  ] } };
  const moved = (withRowYearsOfCalendar(read, NOW).extra as Row).price_groups as Row[];
  assert.deepEqual(moved.map((row) => (row.dates as string[])[0]), ["2099-02-03", "2099-03-03", "2100-12-01"]);
  // Two different gaps: nothing is guessed.
  const mixed = { ...read, departure_dates: ["2099-02-03", "2099-03-03"], extra: { price_groups: [{ dates: ["2097-02-03"], adult_price: 1 }, { dates: ["2098-03-03"], adult_price: 1 }] } };
  assert.equal(withRowYearsOfCalendar(mixed, NOW), mixed);
});
