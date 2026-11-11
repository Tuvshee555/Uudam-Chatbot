/**
 * The price part of the new-trip review, second round (2026-11-07), as the admin sees it (server-rendered
 * markup): two child tiers with one name are red on their row and said once in the problems list; a split
 * that repeats the default price is not a second row. Routes, hotels, prices and dates are invented.
 * Since 2026-11-11 a row's boxes show once it is opened (`openCard`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PriceSection } from "../src/components/admin/tripReview/PriceSection";
import { reviewProblems } from "../src/lib/tripReviewProblems";

type Row = Record<string, unknown>;
const noop = () => undefined;
const [D1, D2, D3] = ["2098-05-08", "2098-05-15", "2098-05-22"];

const row = (dates: string[], adult: number | null, child: number | null, bands?: Row[]): Row => ({
  label: "", dates, adult_price: adult, child_price: child, infant_price: null, note: "",
  passenger_prices: bands ?? (child === null ? [] : [{ label: "Хүүхэд", age_range: "", price: child, currency: "MNT" }]),
});
const trip = (dates: string[], groups: Row[], base: Row = {}): Row => ({
  route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", departure_dates: dates, adult_price: null, child_price: null, infant_price: null,
  extra: { price_groups: groups, itinerary_days: [] }, ...base,
});
const section = (fields: Row, openCard?: string) => renderToStaticMarkup(createElement(PriceSection, { fields, onChange: noop, ...(openCard ? { openCard, onOpenCard: noop } : {}) }));
const rows = (html: string) => (html.match(/data-price-row="/g) || []).length;
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("two child tiers with the same name and no age are red on their row, and the problems list says the save would stop", () => {
  const tiers = [{ label: "Хүүхэд", age_range: "", price: 3060000, currency: "MNT" }, { label: "Хүүхэд", age_range: "", price: 2700000, currency: "MNT" }];
  const fields = trip([D1, D2], [row([D1, D2], 3490000, 3060000, tiers)]);
  const html = section(fields, "g0");
  const text = plain(html);
  assert.ok(text.includes("Энэ нь хүүхдийн үнэтэй ижил нэртэй, насны хүрээгүй байна."), "the extra tier says what is wrong");
  const refused = reviewProblems(fields).blocking.map((problem) => problem.text).join(" ");
  assert.ok(refused.includes("Нэг үнийн картанд ижил ангилалд хоёр өөр үнэ байна"), "and the problems list says what the save refuses");
  assert.ok(refused.includes("Засаагүй бол ноорог ч хадгалагдахгүй."));
  assert.ok(/border-danger[^"]*"[^>]*aria-label="Насны доод хязгаар"|aria-label="Насны доод хязгаар"[^>]*border-danger/.test(html), "the age range box is red");
  // Told apart by an age range: nothing red, nothing said.
  const aged = [{ label: "Хүүхэд", age_range: "6-11 нас", price: 3060000, currency: "MNT" }, { label: "Хүүхэд", age_range: "2-5 нас", price: 2700000, currency: "MNT" }];
  const agedFields = trip([D1, D2], [row([D1, D2], 3490000, 3060000, aged)]);
  const fine = plain(section(agedFields, "g0"));
  assert.equal(fine.includes("насны хүрээгүй"), false);
  assert.equal(reviewProblems(agedFields).blocking.some((problem) => problem.text.includes("хоёр өөр үнэ")), false);
});

test("a split that repeats the default price is one row listing every day, not two identical rows", () => {
  const html = section(trip([D1, D2, D3], [row([D2], 3290000, 2590000)], { adult_price: 3290000, child_price: 2590000 }));
  assert.equal(rows(html), 1, "one row");
  assert.equal((html.match(/Суудлын төлөв солих/g) || []).length / 2, 3, "with the three days (each day: its label and its title)");
  // A different price stays a row of its own.
  assert.equal(rows(section(trip([D1, D2, D3], [row([D2], 3590000, 3090000)], { adult_price: 3290000, child_price: 2590000 }))), 2);
});

test("with a second price on one date the other dates' row is red until its child fare is there too", () => {
  const fields = trip([D1, D2, D3], [row([D2], 3590000, 3090000)], { adult_price: 3290000 });
  assert.equal((section(fields, "all").match(/aria-invalid="true"/g) || []).length, 1, "only the default row's child box");
  assert.equal((plain(section(fields)).match(/Оруулаагүй/g) || []).length, 1, "the closed table says it in that one cell");
  assert.deepEqual(reviewProblems(fields).blocking.map((problem) => [problem.target, problem.field]), [["card:all", "child"]]);
});
