import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { publishPriceGap, reviewIssues, reviewedFields, weekdayOf } from "../src/lib/tripReview";
import {
  ALL_CARD, BAND_PROBLEM_TEXT, bandProblems, cardShort, normalizePriceRows, priceModel, priceProblems, reviewPriceGroups,
  setBaseFare, setCardFare, splitDays, withCalendarDays, dropCard, moveDays,
} from "../src/lib/tripReviewPrices";

applyTestEnv();

// Second round on the review's price cards (2026-11-07): a split that repeats the default price is
// not a second card; what is saved matches the cards; the publish gate and the saved "from" price
// agree with the red marks; two child tiers with the same name are caught before the save.
// Every route, hotel and price is invented; "now" is fixed far ahead.
const NOW = new Date("2098-03-01T04:00:00Z");
type Row = Record<string, unknown>;
const [D1, D2, D3, D4] = ["2098-05-08", "2098-05-15", "2098-05-22", "2098-06-05"];
const wd = (ymd: string) => weekdayOf(ymd).slice(0, 2);

const row = (dates: string[], adult: number | null, child: number | null, more: Row = {}): Row => ({
  label: "", dates, adult_price: adult, child_price: child, infant_price: null, note: "",
  passenger_prices: child === null ? [] : [{ label: "Хүүхэд", age_range: "", price: child, currency: "MNT" }],
  ...more,
});
const trip = (dates: string[], groups: Row[], base: Row = {}): Row => ({
  route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", duration_text: "3 өдөр 2 шөнө", departure_dates: dates, adult_price: null, child_price: null, infant_price: null,
  extra: { price_groups: groups, itinerary_days: [] }, ...base,
});
const cardsOf = (fields: Row) => priceModel(fields, NOW).cards.map((card) => [card.kind, card.days]);
const keyOfDay = (fields: Row, day: string) => priceModel(fields, NOW).cards.find((card) => card.days.includes(day))!.key;
const rowsOf = (fields: Row) => reviewPriceGroups(fields);

/* -------------------------------------------- 1. publish needs the default card's fares too */

test("one date split off with both fares does not publish the other dates without a child fare", () => {
  let fields = trip([D1, D2, D3], [], { adult_price: 3290000 });
  fields = splitDays(fields, ALL_CARD, [D2], NOW);
  const key = keyOfDay(fields, D2);
  fields = setCardFare(setCardFare(fields, key, "adult", 3590000, NOW), key, "child", 3090000, NOW);
  const all = priceModel(fields, NOW).cards.find((card) => card.kind === "all")!;
  assert.deepEqual(all.missing, { adult: false, child: true }, "the card is red");
  assert.deepEqual(publishPriceGap(fields, NOW), { adult: false, child: true, rows: [] }, "and so is the publish check");
  assert.ok(reviewIssues(fields, NOW).some((issue) => issue.key === "price" && issue.blocks === "publish"), "the footer stops «Нийтлэх»");
  const done = setBaseFare(fields, "child", 2590000, NOW);
  assert.deepEqual(publishPriceGap(done, NOW), { adult: false, child: false, rows: [] });
  assert.equal(reviewIssues(done, NOW).some((issue) => issue.key === "price"), false);
});

/* -------------------------------------------- 2. an unpriced date is never sold at another date's fare */

test("a date left without a card is not given the cheapest card's fare when saved; the publish is stopped", () => {
  const fields = trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)], { adult_price: 2190000, child_price: 1890000 });
  // The cheapest card is taken away: its date is unpriced, and the trip's "from" fare goes with it.
  const dropped = dropCard(fields, keyOfDay(fields, D1), NOW);
  assert.equal(dropped.adult_price, null);
  assert.deepEqual(priceModel(dropped, NOW).cards.find((card) => card.kind === "all")!.days, [D1]);
  assert.equal(publishPriceGap(dropped, NOW).adult, true);
  const saved = reviewedFields(dropped, "publish", NOW);
  assert.equal(saved.adult_price, null, "D1 is not published at D2's fare");
  assert.deepEqual(rowsOf(saved).map((entry) => entry.dates), [[D2]]);
  // A date removed from the calendar and added back is unpriced the same way.
  const back = withCalendarDays(withCalendarDays(fields, [D2], NOW), [D1, D2], NOW);
  assert.equal(publishPriceGap(back, NOW).adult, true);
  assert.equal(reviewedFields(back, "publish", NOW).adult_price, null);
  // With every date on a card the "from" price is still the cheapest card's.
  assert.equal(reviewedFields({ ...fields, adult_price: null, child_price: null }, "publish", NOW).adult_price, 2190000);
});

/* -------------------------------------------- 3. the same price is one card, default included */

test("a split card typed to the default price folds back into the default card", () => {
  let fields = trip([D1, D2, D3], [], { adult_price: 3290000, child_price: 2590000 });
  fields = splitDays(fields, ALL_CARD, [D2], NOW);
  const key = keyOfDay(fields, D2);
  fields = setCardFare(fields, key, "adult", 3290000, NOW);
  assert.equal(priceModel(fields, NOW).cards.length, 2, "the child fare still differs: two cards");
  fields = setCardFare(fields, key, "child", 2590000, NOW);
  const model = priceModel(fields, NOW);
  assert.equal(model.cards.length, 1, "now it is the same price");
  assert.deepEqual(model.cards[0].days, [D1, D2, D3], "all three dates in the one default card");
  assert.deepEqual(rowsOf(fields), [], "and no price row is left behind");
  assert.equal(fields.adult_price, 3290000);
});

test("the default price changed to a split card's price folds that card into it", () => {
  let fields = trip([D1, D2, D3], [row([D2], 2790000, 2390000)], { adult_price: 3290000, child_price: 2590000 });
  assert.equal(priceModel(fields, NOW).cards.length, 2);
  fields = setBaseFare(setBaseFare(fields, "adult", 2790000, NOW), "child", 2390000, NOW);
  const model = priceModel(fields, NOW);
  assert.deepEqual(model.cards.map((card) => [card.kind, card.days]), [["all", [D1, D2, D3]]]);
  assert.deepEqual(rowsOf(fields), []);
});

test("a card with its own hotel, package, name, note or extra band is never folded into the default, even at the same fares", () => {
  const base = { adult_price: 3290000, child_price: 2590000 };
  for (const more of [{ hotel: "Норвел 4*" }, { package_id: "Хөтөлбөртэй" }, { single_price: 400000 }, { label: "Стандарт" }, { note: "Хоолгүй" }]) {
    const fields = trip([D1, D2], [row([D2], 3290000, 2590000, more)], base);
    assert.equal(priceModel(fields, NOW).cards.length, 2, JSON.stringify(more));
    assert.equal(rowsOf(normalizePriceRows(fields, NOW)).length, 1, JSON.stringify(more));
  }
  const banded = trip([D1, D2], [row([D2], 3290000, 2590000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 2590000, currency: "MNT" },
    { label: "Хүүхэд ор эзлэхгүй", age_range: "", price: 1500000, currency: "MNT" },
  ] })], base);
  assert.equal(priceModel(banded, NOW).cards.length, 2);
});

test("when every date has its own card the trip's fares are just the cheapest one: nothing is folded", () => {
  const fields = trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)], { adult_price: 2190000, child_price: 1890000 });
  assert.equal(priceModel(fields, NOW).cards.length, 2);
  assert.equal(rowsOf(normalizePriceRows(fields, NOW)).length, 2);
});

test("a date moved out of the cheapest card back to the default price leaves an empty default card, not a copy", () => {
  const fields = trip([D1, D2, D3], [row([D1, D2], 2190000, 1890000), row([D3], 2390000, 2090000)], { adult_price: 2190000, child_price: 1890000 });
  const moved = moveDays(fields, keyOfDay(fields, D1), [D1, D2], ALL_CARD, NOW);
  assert.deepEqual(cardsOf(moved), [["all", [D1, D2]], ["own", [D3]]]);
  assert.equal(priceModel(moved, NOW).cards[0].adult, null);
});

/* -------------------------------------------- 4. what is saved matches the cards on screen */

test("saving writes the cards as shown: rows with the same price are one row listing their dates", () => {
  const fields = trip([D1, D2, D3], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000), row([D3], 2190000, 1890000)], { adult_price: 2190000, child_price: 1890000 });
  assert.equal(priceModel(fields, NOW).cards.length, 2, "two cards on screen");
  const saved = reviewedFields(fields, "publish", NOW);
  const rows = rowsOf(saved);
  assert.deepEqual(rows.map((entry) => entry.dates), [[D1, D3], [D2]], "and two rows saved");
  assert.ok(rows.every((entry) => Array.isArray(entry.passenger_prices) && !("date_keys" in entry) && !("display_dates" in entry)), "the shape the bot reads is unchanged");
  assert.equal(saved.adult_price, 2190000);
  // A row that only repeats the default fares is left to the default; nothing else changes.
  const repeated = trip([D1, D2, D3], [row([D2], 3290000, 2590000)], { adult_price: 3290000, child_price: 2590000 });
  assert.deepEqual(rowsOf(reviewedFields(repeated, "draft", NOW)), []);
  assert.equal(reviewedFields(repeated, "draft", NOW).adult_price, 3290000);
  // A trip without price rows is untouched.
  const flat = trip([D1], [], { adult_price: 3290000, child_price: 2590000 });
  assert.deepEqual((reviewedFields(flat, "draft", NOW).extra as Row).price_groups, []);
});

/* -------------------------------------------- 5. the drop-down is short enough for a phone */

test("a card in the «move to…» list is days and the adult fare only", () => {
  const fields = trip([D1, D2, D3, D4], [row([D1, D2, D3, D4], 3490000, 3060000, { hotel: "Норвел 4*" })]);
  const [card] = priceModel(fields, NOW).cards;
  assert.equal(cardShort(card), `Норвел 4* · 5/8 ${wd(D1)}, 5/15 ${wd(D2)} +2 · 3,490,000₮`);
  assert.ok(cardShort(card).length < 48, "short enough for the width of a phone");
});

/* -------------------------------------------- 6. two child tiers with the same name */

const twoChildTiers = (dates: string[]) => row(dates, 3490000, 3060000, { passenger_prices: [
  { label: "Хүүхэд", age_range: "", price: 3060000, currency: "MNT" },
  { label: "Хүүхэд", age_range: "", price: 2700000, currency: "MNT" },
] });

test("a second tier with the same name and no age or height is flagged on its card and refused before the save", () => {
  const fields = trip([D1, D2], [twoChildTiers([D1, D2])]);
  const [card] = priceModel(fields, NOW).cards;
  assert.deepEqual(bandProblems(card), [{ index: 1, kind: "same_name" }]);
  assert.ok(BAND_PROBLEM_TEXT.same_name.includes("насны хүрээ"));
  const problems = priceProblems(fields, NOW);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes("хоёр өөр үнэ"), problems[0]);
  const issue = reviewIssues(fields, NOW).find((entry) => entry.key === "fares");
  assert.ok(issue && issue.blocks === "save", "the footer says it, for the draft too");
  // Told apart by an age range, or by a name, it is fine.
  const aged = trip([D1], [row([D1], 3490000, 3060000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "6-11 нас", price: 3060000, currency: "MNT" },
    { label: "Хүүхэд", age_range: "2-5 нас", price: 2700000, currency: "MNT" },
  ] })]);
  assert.deepEqual(bandProblems(priceModel(aged, NOW).cards[0]), []);
  assert.deepEqual(priceProblems(aged, NOW), []);
  const named = trip([D1], [row([D1], 3490000, 3060000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 3060000, currency: "MNT" },
    { label: "Хүүхэд ор эзлэхгүй", age_range: "", price: 2700000, currency: "MNT" },
  ] })]);
  assert.deepEqual(bandProblems(priceModel(named, NOW).cards[0]), []);
  assert.deepEqual(priceProblems(named, NOW), []);
  assert.equal(reviewIssues(named, NOW).some((entry) => entry.key === "fares"), false);
});

test("an extra tier with a price but no name and no age is flagged; an empty new row is not", () => {
  const blank = trip([D1], [row([D1], 3490000, 3060000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 3060000, currency: "MNT" },
    { label: "", age_range: "", price: 1500000, currency: "MNT" },
  ] })]);
  assert.deepEqual(bandProblems(priceModel(blank, NOW).cards[0]), [{ index: 1, kind: "no_name" }]);
  const fresh = trip([D1], [row([D1], 3490000, 3060000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 3060000, currency: "MNT" },
    { label: "", age_range: "", price: null, currency: "MNT" },
  ] })]);
  assert.deepEqual(bandProblems(priceModel(fresh, NOW).cards[0]), []);
});

test("the review catches the same fare conflict the server refuses", async () => {
  const { newTripSaveProblems } = await import("../src/lib/travelAIApply");
  const { validateAIChangeProposal } = await import("../src/lib/travelAIValidation");
  const { reviewedProposal } = await import("../src/lib/adminProposalApply");
  const program = [
    { day: 1, title: "УЛААНБААТАР – ВЭЛМОР", description: "Чингис Хаан олон улсын нисэх буудлаас хөөрнө.", meals: {} },
    { day: 2, title: "ВЭЛМОР – УЛААНБААТАР", description: "Улаанбаатар хотод газардсанаар аялал өндөрлөнө.", meals: {} },
  ];
  const make = (groups: Row[]): Row => ({ ...trip([D1, D2], groups), operator_name: "Fixture Travel", currency: "MNT", extra: { price_groups: groups, itinerary_days: program } });
  const server = (fields: Row, mode: "draft" | "publish") => {
    const proposal = { summary: "", needs_confirmation: false, important_reason: "", conflicts: [], conflict_items: [], actions: [{ action: "upsert", fields }] };
    return newTripSaveProblems(validateAIChangeProposal(reviewedProposal(proposal as never, { 0: fields }, mode, NOW) as never, [], { now: NOW }).proposal);
  };
  const bad = make([twoChildTiers([D1, D2])]);
  assert.ok(server(bad, "draft").length > 0, "the server refuses even a draft");
  assert.ok(reviewIssues(bad, NOW).some((entry) => entry.key === "fares" && entry.blocks === "save"));
  const good = make([row([D1, D2], 3490000, 3060000)]);
  assert.deepEqual(server(good, "publish"), []);
  assert.equal(reviewIssues(good, NOW).some((entry) => entry.key === "fares"), false);
});
