/**
 * The new-trip review as a PREVIEW of the trip page (2026-11-11): empty optional fields are not shown
 * but folded into «+ …» chips, a chip opens its field, a field with a value always shows, and ONE
 * problems list at the top says what blocks (red) and what to look at (amber), each with the place
 * that fixes it. Routes, hotels, prices and dates are invented; the dates are far ahead.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewTripReview } from "../src/components/admin/tripReview/NewTripReview";
import { PriceSection } from "../src/components/admin/tripReview/PriceSection";
import { cardFields, priceColumns, splitOptional } from "../src/components/admin/tripReview/reviewView";
import { reviewIssues } from "../src/lib/tripReview";
import { priceModel } from "../src/lib/tripReviewPrices";
import { INVERTED_BAND_TEXT, invertedBands, reviewProblems } from "../src/lib/tripReviewProblems";

type Row = Record<string, unknown>;
const noop = () => undefined;
const NOW = new Date("2098-03-01T04:00:00Z");
const [D1, D2, D3] = ["2098-05-08", "2098-05-15", "2098-05-22"];
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const row = (dates: string[], adult: number | null, child: number | null, more: Row = {}): Row => ({
  label: "", dates, adult_price: adult, child_price: child, infant_price: null, note: "",
  passenger_prices: child === null ? [] : [{ label: "Хүүхэд", age_range: "", price: child, currency: "MNT" }],
  ...more,
});
const UB_DAYS = [
  { day: 1, title: "УЛААНБААТАР – ВЭЛМОР", description: "Улаанбаатараас нисэж Вэлморт буух.", meals: { breakfast: null, lunch: null, dinner: true } },
  { day: 2, title: "ВЭЛМОР НУУР", description: "Нуурын эргээр аялна.", meals: { breakfast: true, lunch: true, dinner: true } },
  { day: 3, title: "ВЭЛМОР – УЛААНБААТАР", description: "Улаанбаатарт буцаж ирнэ.", meals: { breakfast: true, lunch: null, dinner: null } },
];
const trip = (dates: string[], groups: Row[], base: Row = {}, extra: Row = {}): Row => ({
  route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", duration_text: "3 өдөр 2 шөнө", departure_dates: dates, adult_price: null, child_price: null, infant_price: null,
  photo_urls: [], ...base,
  extra: { price_groups: groups, itinerary_days: UB_DAYS, transport_type: "direct_flight", included_items: ["Нислэгийн тийз"], ...extra },
});
const review = (fields: Row, props: Row = {}) => renderToStaticMarkup(createElement(NewTripReview, { fields, onChange: noop, warnings: [], ...props }));
const chipsOf = (html: string) => Array.from(html.matchAll(/<div[^>]*data-review-chips[^>]*>([\s\S]*?)<\/div>/g)).map((m) => plain(m[1]).trim()).join(" | ");

/* ------------------------------------------------------------------ hidden-empty fields */

test("empty optional fields are not shown: no box for the booking terms, the summary, the page notes; they are «+ …» chips", () => {
  const html = review(trip([D1], [], { adult_price: 3290000, child_price: 2590000 }));
  const chips = chipsOf(html);
  for (const label of ["Виз", "Урьдчилгаа", "Цуцлалт", "Төлбөр", "Бичиг баримт", "Товч танилцуулга", "Хуудасны тайлбар", "Насны ангилал", "Үнэд багтаагүй", "Анхаарах зүйл"]) {
    assert.ok(chips.includes(label), `«+ ${label}» is a chip`);
  }
  assert.equal(/aria-label="Виз"/.test(html), false, "no visa box while it is empty");
  assert.equal(/aria-label="Урьдчилгаа"/.test(html), false);
  assert.equal(/aria-label="Товч танилцуулга/.test(html), false, "no summary box");
  assert.equal(/aria-label="Хуудсанд гарах тайлбар"/.test(html), false, "no page-notes box");
  assert.equal(html.includes("заавал биш"), false, "no «заавал биш» boxes at all");
  // A list with a value shows; only the empty one is a chip.
  assert.ok(/<textarea[^>]*aria-label="Үнэд багтсан 1"/.test(html));
  assert.equal(chips.split(" | ").some((part) => / Үнэд багтсан( |$)/.test(` ${part}`)), false, "the filled list has no chip");
});

test("a field with a value always shows, without its chip", () => {
  const html = review(trip([D1], [], { adult_price: 3290000, child_price: 2590000, notes: "Гэр бүлээрээ амрах аялал." }, {
    booking_terms: { deposit: "", payment: "", documents: "", visa: "Визгүй", cancellation: "" },
    website_summary: "Нуурын эрэг, ой.", age_rules: { adult: "12+ нас", child: "", infant: "" },
  }));
  assert.ok(/aria-label="Виз"[^>]*value="Визгүй"|value="Визгүй"[^>]*aria-label="Виз"/.test(html), "the visa term is shown with its value");
  assert.ok(html.includes("Нуурын эрэг, ой.") && html.includes("Гэр бүлээрээ амрах аялал."), "summary and page notes shown");
  assert.ok(html.includes('value="12+ нас"'), "the age bands line is shown");
  const chips = chipsOf(html);
  for (const label of ["Виз", "Товч танилцуулга", "Хуудасны тайлбар", "Насны ангилал"]) assert.equal(chips.includes(label), false, `no chip for «${label}»`);
  assert.ok(chips.includes("Урьдчилгаа"), "the empty terms are still chips");
});

test("a chip opens its field: the field shows (empty, ready to type) and the other chips stay", () => {
  const fields = trip([D1], [], { adult_price: 3290000, child_price: 2590000 });
  const html = review(fields, { initialOpen: "terms:visa" });
  assert.ok(/<input[^>]*aria-label="Виз"/.test(html), "the visa box is open");
  assert.ok(/data-review-target="terms:visa"/.test(html), "a link or the chip can scroll to it");
  assert.equal(/<input[^>]*aria-label="Урьдчилгаа"/.test(html), false);
  assert.ok(chipsOf(html).includes("Урьдчилгаа"));
  assert.equal(chipsOf(html).includes("Виз"), false);
  // The same rule, pure: opened from a chip → shown; «Бүх талбар» → everything shown.
  const opened = splitOptional(fields, ["terms:visa", "terms:deposit"], { revealed: new Set(["terms:visa"]) });
  assert.deepEqual(opened.shown, ["terms:visa"]);
  assert.deepEqual(opened.chips.map((chip) => chip.label), ["Урьдчилгаа"]);
  assert.deepEqual(splitOptional(fields, ["terms:visa", "terms:deposit"], { all: true }).chips, []);
});

test("the price table shows only the columns somebody has a value in; the rest are chips under it", () => {
  const plainTrip = trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 2090000)]);
  const columns = priceColumns(priceModel(plainTrip, NOW).cards);
  assert.deepEqual(columns.shown, []);
  assert.deepEqual(columns.chips.map((chip) => chip.label), ["Өөр насны ангилал", "Нярай", "Ганц өрөө", "Буудал, багц"]);
  const html = renderToStaticMarkup(createElement(PriceSection, { fields: plainTrip, onChange: noop }));
  assert.equal(/<span[^>]*>Нярай<\/span>/.test(html.split("<ul")[0]), false, "no infant column header");
  assert.ok(chipsOf(html).includes("Нярай") && chipsOf(html).includes("Ганц өрөө"));
  const rich = trip([D1], [row([D1], 2190000, 1890000, { hotel: "Норвел 4*", single_price: 450000, infant_price: 0, passenger_prices: [
    { label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" }, { label: "Нярай", age_range: "0-23 сар", price: 0, currency: "MNT", note: "Үнэгүй" },
  ] })]);
  assert.deepEqual(priceColumns(priceModel(rich, NOW).cards).shown, ["infant", "single", "hotel"]);
  const text = plain(renderToStaticMarkup(createElement(PriceSection, { fields: rich, onChange: noop })));
  assert.ok(text.includes("Норвел 4*") && text.includes("450,000₮") && text.includes("Үнэгүй"), "each value in its column");
  // The trip's own fares (no price rows) have no hotel, single or band: only the infant chip is offered.
  const own = priceColumns(priceModel(trip([D1], [], { adult_price: 3290000, child_price: 2590000 }), NOW).cards);
  assert.deepEqual(own.chips.map((chip) => chip.key), ["infant"]);
});

test("a price row's editor shows the adult and child fare; empty hotel, package, single, name, note are chips", () => {
  const fields = trip([D1], [row([D1], 2190000, 1890000, { hotel: "Норвел 4*" })]);
  const card = priceModel(fields, NOW).cards[0];
  const view = cardFields(card, []);
  assert.deepEqual(view.shown, ["hotel"], "only the box with a value");
  assert.deepEqual(view.chips.map((chip) => chip.label), ["Нярай", "Багц", "Ганц өрөө", "Үнийн нэр", "Тэмдэглэл"]);
  const all = cardFields(priceModel(trip([D1], [], { adult_price: 1 }), NOW).cards[0], []);
  assert.deepEqual(all.chips.map((chip) => chip.key), ["infant"], "the trip's own fares: an infant fare at most");
  const html = renderToStaticMarkup(createElement(PriceSection, { fields, onChange: noop, openCard: card.key, onOpenCard: noop }));
  assert.ok(html.includes('value="2,190,000"') && html.includes('value="1,890,000"'), "the fares are boxes once the row is open");
  assert.ok(html.includes('value="Норвел 4*"'));
  assert.equal(/aria-label="Ганц өрөөний нэмэлт төлбөр"/.test(html), false, "no single-room box while empty");
  assert.ok(plain(html).includes("Өөр насны ангилал"), "an extra band is one chip away");
});

/* ------------------------------------------------------------------ the problems list */

test("problems: nothing to fix is said calmly; the list is empty and the bar reads «Нийтлэхэд бэлэн»", () => {
  const fields = trip([D1], [], { adult_price: 3290000, child_price: 2590000 });
  assert.deepEqual(reviewProblems(fields, [], NOW), { blocking: [], warnings: [] });
  const html = review(fields);
  assert.ok(plain(html).includes("Нийтлэхэд бэлэн"));
  assert.equal(html.includes("data-problem="), false);
});

test("problems: each red one names its place — the name, the calendar, the price row and its missing fare", () => {
  const noName = reviewProblems({ ...trip([D1], [], { adult_price: 3290000, child_price: 2590000 }), route_name: "" }, [], NOW);
  assert.deepEqual(noName.blocking.map((p) => [p.target, p.blocks]), [["name", "save"]]);

  const noDates = reviewProblems(trip([], [], { adult_price: 3290000, child_price: 2590000 }), [], NOW);
  assert.deepEqual(noDates.blocking.map((p) => p.target), ["calendar"]);

  const fields = trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, null)]);
  const { blocking } = reviewProblems(fields, [], NOW);
  assert.equal(blocking.length, 1, "one row lacks a fare: one problem, not one count");
  const [missing] = blocking;
  const card = priceModel(fields, NOW).cards.find((entry) => entry.days.includes(D2));
  assert.equal(missing.target, `card:${card?.key}`, "the link opens that row");
  assert.equal(missing.field, "child", "and puts the cursor in its child fare");
  assert.equal(missing.blocks, "publish");
  assert.match(missing.text, /^5\/15 .+: хүүхдийн үнэ оруулаагүй\.$/u, "said with the row's day");

  const empty = reviewProblems(trip([D1], []), [], NOW).blocking[0];
  assert.equal(empty.target, "card:all");
  assert.equal(empty.field, "adult");
  assert.ok(empty.text.endsWith("том хүн, хүүхдийн үнэ оруулаагүй."));
});

test("problems: the red list is the save gate's own — red exactly when reviewIssues blocks, the same publish/save split", () => {
  const cases = [
    trip([D1], [], { adult_price: 3290000, child_price: 2590000 }),
    trip([D1], []),
    trip([], [], { adult_price: 1 }),
    { ...trip([D1], [], { adult_price: 1, child_price: 1 }), route_name: "" },
    trip([D1, D2, D3], [row([D2], 3590000, 3090000)], { adult_price: 3290000 }),
    trip([D1, D2], [row([D1, D2], 3490000, 3060000, { passenger_prices: [
      { label: "Хүүхэд", age_range: "", price: 3060000, currency: "MNT" }, { label: "Хүүхэд", age_range: "", price: 2700000, currency: "MNT" },
    ] })]),
  ];
  for (const fields of cases) {
    const gate = reviewIssues(fields, NOW).filter((issue) => issue.blocks);
    const { blocking } = reviewProblems(fields, [], NOW);
    assert.equal(blocking.length > 0, gate.length > 0);
    assert.equal(blocking.some((p) => p.blocks === "save"), gate.some((issue) => issue.blocks === "save"));
  }
  const tiers = reviewProblems(cases[5], [], NOW).blocking.find((p) => p.blocks === "save");
  assert.ok(tiers?.text.includes("Нэг үнийн картанд ижил ангилалд хоёр өөр үнэ байна") && tiers.text.includes("Засаагүй бол ноорог ч хадгалагдахгүй."));
  assert.ok(tiers?.target?.startsWith("card:") && tiers.field === "bands", "the link opens the row with the two tiers");
});

test("a band whose age runs backwards («12 – 2 нас») is red on its row, and the problem opens that row on its bands", () => {
  const bands = [{ label: "Хүүхэд", age_range: "", price: 1890000, currency: "MNT" }, { label: "Хүүхэд ор эзлэхгүй", age_range: "12 – 2 нас", price: 1500000, currency: "MNT" }];
  const fields = trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, 1890000, { passenger_prices: bands })]);
  const card = priceModel(fields, NOW).cards.find((entry) => entry.days.includes(D2));
  assert.ok(card);
  assert.deepEqual(invertedBands(card), [1]);
  const refused = reviewProblems(fields, [], NOW).blocking.find((problem) => problem.blocks === "save");
  assert.ok(refused?.text.includes("доод хязгаар"), "the save's own words");
  assert.equal(refused?.target, `card:${card.key}`, "the link opens the row with that band");
  assert.equal(refused?.field, "bands");
  const html = renderToStaticMarkup(createElement(PriceSection, { fields, onChange: noop, openCard: card.key, onOpenCard: noop }));
  assert.ok(plain(html).includes(INVERTED_BAND_TEXT), "the band row says what is wrong");
  assert.ok(/border-danger[^"]*"[^>]*aria-label="Насны доод хязгаар"/.test(html), "and its age boxes are red");
});

test("problems: amber ones — the file's length against the program, a priced day off the calendar, a child fare above the adult's, the assistant's notes", () => {
  const fields = trip([D1], [row([D1], 2190000, 2490000), row([D3], 2190000, 1890000)], {}, { program_duration_text: "4 өдөр 3 шөнө" });
  const { blocking, warnings } = reviewProblems(fields, ["Хүүхдийн насны хязгаар файлд хоёр янз бичигдсэн."], NOW);
  assert.deepEqual(blocking, []);
  const byId = Object.fromEntries(warnings.map((p) => [p.id.split(":")[0], p]));
  assert.equal(byId.duration?.target, "duration");
  assert.ok(byId.duration?.text.includes("«4 өдөр 3 шөнө»") && byId.duration.text.includes("3 өдөр"));
  assert.equal(byId.strays?.target, "prices");
  assert.ok(byId.strays?.text.includes("5/22"));
  assert.equal(byId.child_above?.field, "child");
  assert.ok(byId.child_above?.target?.startsWith("card:"));
  assert.equal(byId.note?.target, null, "a note has no place to open");
  assert.ok(warnings.every((p) => p.blocks === null));
});

test("the problems bar: red items are links that say «Засах», amber ones «Харах», a note is plain text", () => {
  const html = review(trip([D1, D2], [row([D1], 2190000, 1890000), row([D2], 2390000, null)], {}, { program_duration_text: "4 өдөр 3 шөнө" }),
    { warnings: ["Файлын хоёр хүснэгт өөр үнэтэй."] });
  const text = plain(html);
  assert.ok(text.includes("Нийтлэхийн өмнө 1 зүйл засна"));
  assert.ok(text.includes("Ноорог болгон хадгалж болно."), "a publish block still lets a draft be saved");
  assert.ok(/data-problem="price:[^"]+"[^>]*>[\s\S]*?Засах/.test(html), "the missing fare is a link");
  assert.ok(/data-problem="duration"[^>]*>[\s\S]*?Харах/.test(html));
  assert.ok(text.includes("Файлын хоёр хүснэгт өөр үнэтэй."));
  assert.equal(/data-problem="note:/.test(html), false, "the note is not a link");
  // The red cell in the table says it too, without opening anything.
  assert.ok(text.includes("Оруулаагүй"));
});
