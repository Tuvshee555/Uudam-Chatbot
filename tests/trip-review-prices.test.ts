import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { reviewedFields, weekdayOf } from "../src/lib/tripReview";
import {
  ALL_CARD, addExtraBand, addOption, addStraysToCalendar, cardSummary, dayLabel, dropCard, dropStrays, moveDays, patchCard, priceModel,
  reviewPriceGroups, setBaseFare, setCardFare, splitDays, withCalendarDays,
} from "../src/lib/tripReviewPrices";

applyTestEnv();

// The price cards of a new-trip review (2026-11-06). Every route, hotel and price is invented;
// "now" is fixed far ahead so nothing depends on today.
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
  route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", departure_dates: dates, adult_price: null, child_price: null, infant_price: null,
  extra: { price_groups: groups, itinerary_days: [] }, ...base,
});
const groupsOf = (fields: Row) => reviewPriceGroups(fields);
const keyOfDay = (fields: Row, day: string) => priceModel(fields, NOW).cards.find((card) => card.days.includes(day))!.key;

test("days with the same price are written once, as one card listing them", () => {
  const fields = trip([D1, D2, D3], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000), row([D3], 2190000, 1890000)], { adult_price: 2190000, child_price: 1890000 });
  const model = priceModel(fields, NOW);
  assert.equal(model.cards.length, 2, "three rows, two prices");
  assert.deepEqual(model.cards.map((card) => card.days), [[D1, D3], [D2]]);
  assert.equal(model.showsAll, false, "every day has its own price: no «all days» card");
  assert.equal(cardSummary(model.cards[0]), `5/8 ${wd(D1)}, 5/22 ${wd(D3)} — Том хүн 2,190,000₮ · Хүүхэд 1,890,000₮`);
  assert.equal(model.headline, 2190000, "the website's «from» price is the lowest adult fare");
  assert.equal(model.cards[0].key, "g0", "the card is named by its first row");
});

test("a date is in one card: a row's other date keys and its spelling do not make a second card", () => {
  const stale = row([D1], 2190000, 1890000, { date_keys: [D1], display_dates: ["5 сарын 8"] });
  const same = row([D2], 2190000, 1890000, { id: "row-b" });
  const model = priceModel(trip([D1, D2], [stale, same]), NOW);
  assert.equal(model.cards.length, 1, "rows that differ only by date and id are one price");
  assert.deepEqual(model.cards[0].days, [D1, D2]);
  // The same price written with the child as a flat field and as a band is still the same price.
  const flat = { ...row([D3], 2190000, null), child_price: 1890000 };
  assert.equal(priceModel(trip([D1, D3], [row([D1], 2190000, 1890000), flat]), NOW).cards.length, 1);
});

test("no price rows: one card for all the days with the trip's own fares; adult and child are required", () => {
  const model = priceModel(trip([D1, D2, D3], [], { adult_price: 3290000 }), NOW);
  assert.equal(model.cards.length, 1);
  const [card] = model.cards;
  assert.equal(card.kind, "all");
  assert.deepEqual(card.days, [D1, D2, D3]);
  assert.deepEqual(card.missing, { adult: false, child: true }, "the child fare is the red one");
  assert.equal(model.missingCards, 1);
  const filled = priceModel(setBaseFare(trip([D1], [], { adult_price: 3290000 }), "child", 2590000, NOW), NOW);
  assert.equal(filled.cards[0].missing.child, false);
  assert.equal(filled.missingCards, 0, "the infant fare is never asked for");
});

test("no dates at all: the flat prices still work, with nothing to list", () => {
  const model = priceModel(trip([], []), NOW);
  assert.equal(model.cards.length, 1);
  assert.deepEqual(model.cards[0].days, []);
  assert.deepEqual(model.cards[0].missing, { adult: true, child: true });
  assert.equal(setBaseFare(trip([], []), "adult", 100, NOW).adult_price, 100);
});

test("one date with its own price: it leaves the «all days» card and starts empty, not as a copy", () => {
  const fields = trip([D1, D2, D3], [], { adult_price: 3290000, child_price: 2590000 });
  const next = splitDays(fields, ALL_CARD, [D2], NOW);
  const model = priceModel(next, NOW);
  assert.equal(model.cards.length, 2);
  assert.deepEqual(model.cards[0].days, [D1, D3], "the other days keep the trip's price");
  assert.equal(model.cards[0].adult, 3290000);
  assert.deepEqual(model.cards[1].days, [D2]);
  assert.equal(model.cards[1].adult, null, "a copy would be the same price; the admin types the new one");
  assert.deepEqual(model.cards[1].missing, { adult: true, child: true });
  assert.equal(next.adult_price, 3290000, "the trip's own fares are untouched while a day still needs them");
  const priced = setCardFare(setCardFare(next, model.cards[1].key, "adult", 3590000, NOW), model.cards[1].key, "child", 3090000, NOW);
  const own = priceModel(priced, NOW).cards[1];
  assert.deepEqual([own.adult, own.child], [3590000, 3090000]);
  assert.deepEqual(own.missing, { adult: false, child: false });
  const saved = groupsOf(priced)[0];
  assert.deepEqual(saved.dates, [D2]);
  assert.equal(saved.child_price, 3090000, "the flat child fare the bot reads is kept in step with the band");
  assert.deepEqual((saved.passenger_prices as Row[]).map((band) => band.price), [3090000]);
});

test("two days given the same price become one card", () => {
  let fields = trip([D1, D2, D3], [], { adult_price: 3290000, child_price: 2590000 });
  fields = splitDays(fields, ALL_CARD, [D2], NOW);
  fields = setCardFare(setCardFare(fields, keyOfDay(fields, D2), "adult", 3590000, NOW), keyOfDay(fields, D2), "child", 3090000, NOW);
  fields = splitDays(fields, ALL_CARD, [D3], NOW);
  assert.equal(priceModel(fields, NOW).cards.length, 3, "the new card is empty, so it is not yet the same price as the other");
  fields = setCardFare(setCardFare(fields, keyOfDay(fields, D3), "adult", 3590000, NOW), keyOfDay(fields, D3), "child", 3090000, NOW);
  const model = priceModel(fields, NOW);
  assert.equal(model.cards.length, 2, "the «all days» card and one card for the two days");
  assert.deepEqual(model.cards[1].days, [D2, D3]);
  assert.equal(groupsOf(fields).length, 1, "and one saved row");
});

test("a date moves from one card to another or back to the trip's price; never two cards", () => {
  const fields = trip([D1, D2, D3], [row([D1, D2], 2190000, 1890000), row([D3], 2390000, 2090000)], { adult_price: 2190000, child_price: 1890000 });
  const moved = moveDays(fields, keyOfDay(fields, D2), [D2], keyOfDay(fields, D3), NOW);
  const model = priceModel(moved, NOW);
  assert.deepEqual(model.cards.map((card) => card.days), [[D1], [D2, D3]]);
  assert.equal(model.cards.flatMap((card) => card.days).length, 3, "each day once");
  // Out of its card entirely: the day is left without a price row.
  const freed = moveDays(moved, keyOfDay(moved, D1), [D1], ALL_CARD, NOW);
  assert.deepEqual(priceModel(freed, NOW).cards.map((card) => [card.kind, card.days]), [["all", [D1]], ["own", [D2, D3]]]);
  // A card taken away gives its days back the same way.
  const dropped = dropCard(moved, keyOfDay(moved, D3), NOW);
  assert.deepEqual(priceModel(dropped, NOW).cards.map((card) => [card.kind, card.days]), [["all", [D2, D3]], ["own", [D1]]]);
});

test("a day taken off the calendar leaves its card; a card without days goes", () => {
  const fields = trip([D1, D2, D3], [row([D1, D3], 2190000, 1890000), row([D2], 2390000, 2090000)], { adult_price: 2190000, child_price: 1890000 });
  const less = withCalendarDays(fields, [D1, D3], NOW);
  const model = priceModel(less, NOW);
  assert.deepEqual(model.cards.map((card) => card.days), [[D1, D3]]);
  assert.equal(groupsOf(less).length, 1);
  assert.deepEqual(less.departure_dates, [D1, D3]);
  assert.equal(priceModel(withCalendarDays(fields, [D1], NOW), NOW).cards[0].days.length, 1);
});

test("a calendar day added later is not priced yet: it shows in the «all days» card, empty and required", () => {
  const fields = trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)], { adult_price: 2190000, child_price: 1890000 });
  assert.equal(priceModel(fields, NOW).showsAll, false);
  const more = withCalendarDays(fields, [D1, D2, D4], NOW);
  const model = priceModel(more, NOW);
  const all = model.cards.find((card) => card.kind === "all")!;
  assert.deepEqual(all.days, [D4]);
  assert.equal(all.adult, null, "the old «from» price is not silently the new day's price");
  assert.equal(all.child, null);
  assert.deepEqual(all.missing, { adult: true, child: true });
  assert.equal(model.cards.length, 3);
  // Priced, it is one more day on the trip's own fares.
  const priced = setBaseFare(setBaseFare(more, "adult", 2990000, NOW), "child", 2590000, NOW);
  assert.deepEqual(priceModel(priced, NOW).cards.find((card) => card.kind === "all")!.missing, { adult: false, child: false });
  // Taking the new day off again returns to the cheapest-card «from» price.
  const back = withCalendarDays(priced, [D1, D2], NOW);
  assert.equal(back.adult_price, 2190000);
  assert.equal(back.child_price, 1890000);
});

test("with every day on its own card the trip's fares are the cheapest card's, as the file reader writes them", () => {
  const fields = trip([D1, D2], [row([D1], 2390000, 2090000), row([D2], 2190000, 1890000)], { adult_price: 2190000, child_price: 1890000 });
  const key = keyOfDay(fields, D2);
  const cheaper = setCardFare(fields, key, "adult", 2090000, NOW);
  assert.equal(cheaper.adult_price, 2090000, "the lowest adult fare");
  assert.equal(cheaper.child_price, 1890000, "that card's child fare");
  const dearer = setCardFare(setCardFare(cheaper, key, "adult", 2990000, NOW), keyOfDay(cheaper, D1), "adult", 2390000, NOW);
  assert.equal(dearer.adult_price, 2390000, "the cheapest follows the edit");
  assert.equal(dearer.child_price, 2090000);
  // The saved shape the bot and website read: base fares + extra.price_groups with dates and bands.
  const saved = reviewedFields(dearer, "publish", NOW);
  assert.equal(saved.adult_price, 2390000);
  const rows = (saved.extra as Row).price_groups as Row[];
  assert.deepEqual(rows.map((entry) => entry.dates), [[D1], [D2]]);
  assert.ok(rows.every((entry) => Array.isArray(entry.passenger_prices)));
});

test("the adult and child fare are required on every upcoming card; a past one and the infant fare are not", () => {
  const fields = trip([D1, "2098-02-01", D2], [row([D1], 2190000, null), row(["2098-02-01"], 1990000, null), row([D2], null, 1890000)]);
  const model = priceModel(fields, NOW);
  const byDay = (day: string) => model.cards.find((card) => card.days.includes(day))!;
  assert.deepEqual(byDay(D1).missing, { adult: false, child: true });
  assert.deepEqual(byDay("2098-02-01").missing, { adult: false, child: false }, "a departure that has already gone is not asked for");
  assert.deepEqual(byDay("2098-02-01").past, ["2098-02-01"]);
  assert.deepEqual(byDay(D2).missing, { adult: true, child: false });
  assert.equal(model.missingCards, 2);
});

test("a free infant is a fare of 0 marked «Үнэгүй»; clearing it removes the band", () => {
  const fields = trip([D1], [row([D1], 2190000, 1890000)]);
  const key = priceModel(fields, NOW).cards[0].key;
  const free = setCardFare(fields, key, "infant", 0, NOW);
  const card = priceModel(free, NOW).cards[0];
  assert.equal(card.infant, 0);
  const band = (groupsOf(free)[0].passenger_prices as Row[]).find((entry) => entry.label === "Нярай")!;
  assert.deepEqual([band.price, band.note], [0, "Үнэгүй"]);
  assert.equal(groupsOf(free)[0].infant_price, 0);
  assert.equal(cardSummary(card).includes("Нярай үнэгүй"), true);
  const cleared = setCardFare(free, key, "infant", null, NOW);
  assert.equal(priceModel(cleared, NOW).cards[0].infant, null);
  assert.equal((groupsOf(cleared)[0].passenger_prices as Row[]).some((entry) => entry.label === "Нярай"), false);
  // The trip's own infant fare is free the same way.
  assert.equal(setBaseFare(trip([D1], []), "infant", 0, NOW).infant_price, 0);
});

test("a card with a second child tier keeps it as an extra row; adding one never takes the child fare's place", () => {
  const fields = trip([D1], [row([D1], 2190000, 1890000, { passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" },
    { label: "Хүүхэд ор эзлэхгүй", age_range: "", price: 1500000, currency: "MNT" },
  ] })]);
  const card = priceModel(fields, NOW).cards[0];
  assert.deepEqual(card.bands.map((band) => band.role), ["child", "other"]);
  assert.equal(card.child, 1890000);
  // A card with no child fare yet: the extra band is added AFTER an empty child band.
  const bare = trip([D1], [row([D1], 2190000, null)]);
  const added = addExtraBand(bare, priceModel(bare, NOW).cards[0].key, NOW);
  const bands = priceModel(added, NOW).cards[0].bands;
  assert.deepEqual(bands.map((band) => band.role), ["child", "other"]);
  assert.equal(priceModel(added, NOW).cards[0].missing.child, true, "the empty child band is not a child fare");
});

test("another hotel for the same days is a second card; the same hotel twice is flagged", () => {
  const fields = trip([D1, D2], [row([D1, D2], 2190000, 1890000, { hotel: "Норвел 4*" })]);
  const key = priceModel(fields, NOW).cards[0].key;
  const option = addOption(fields, key, NOW);
  let model = priceModel(option, NOW);
  assert.equal(model.cards.length, 2);
  assert.deepEqual(model.cards.map((card) => card.days), [[D1, D2], [D1, D2]], "two hotels may offer the same days");
  assert.deepEqual(model.cards[0].clash, [], "different hotels do not clash");
  // The new card has no hotel yet; the first one has: still no clash. Give both the same hotel and they do.
  const second = model.cards[1].key;
  const same = patchCard(option, second, { hotel: "Норвел 4*" }, NOW);
  model = priceModel(same, NOW);
  assert.deepEqual(model.cards.map((card) => card.clash), [[D1, D2], [D1, D2]]);
});

test("a price for a day that is not on the calendar is shown and can be added to it or dropped", () => {
  const fields = trip([D1], [row([D1], 2190000, 1890000), row([D3], 2390000, 2090000)]);
  const model = priceModel(fields, NOW);
  assert.deepEqual(model.cards.flatMap((card) => card.strays), [D3]);
  assert.deepEqual(addStraysToCalendar(fields, NOW).departure_dates, [D1, D3]);
  const dropped = dropStrays(fields, NOW);
  assert.deepEqual(priceModel(dropped, NOW).cards.flatMap((card) => card.days), [D1]);
  assert.deepEqual(dropped.departure_dates, [D1], "the calendar is not touched by dropping a price");
});

test("a row without any date is the price of every departure; no «all days» card is needed beside it", () => {
  const fields = trip([D1, D2], [row([], 2190000, 1890000, { hotel: "Норвел 4*" }), row([], 2590000, 2290000, { hotel: "Лумиа 5*" })]);
  const model = priceModel(fields, NOW);
  assert.equal(model.showsAll, false);
  assert.deepEqual(model.cards.map((card) => card.everyDate), [true, true]);
  assert.equal(setCardFare(fields, model.cards[1].key, "adult", 2490000, NOW).adult_price, 2190000, "the cheapest row is the «from» price");
});

test("the day label: month/day and weekday, with the year only when the trip crosses years", () => {
  assert.equal(dayLabel("2098-05-08"), `5/8 ${wd("2098-05-08")}`);
  assert.equal(dayLabel("2099-01-03", true), `2099/1/3 ${wd("2099-01-03")}`);
  assert.equal(priceModel(trip([D1, "2099-01-03"], []), NOW).spansYears, true);
  assert.equal(priceModel(trip([D1, D2], []), NOW).spansYears, false);
});
