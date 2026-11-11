/**
 * Seat state per departure day in the new-trip review, as the admin sees it (server-rendered markup):
 * a full day keeps its chip and its price card with a red «Дүүрсэн», a few-seats day shows «4 суудал»
 * or «Цөөн суудал», an ordinary open day shows nothing. Routes, prices and dates are invented; the
 * dates are far ahead so they are never "past".
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewTripReview } from "../src/components/admin/tripReview/NewTripReview";
import { PriceSection } from "../src/components/admin/tripReview/PriceSection";
import { chosenState, dayStateBadge, seatsFromInput } from "../src/components/admin/tripReview/dayStateView";

type Row = Record<string, unknown>;
const noop = () => undefined;
const [D1, D2, D3] = ["2098-05-08", "2098-05-15", "2098-05-22"];
const plain = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/\s+/g, " ");

const trip = (states: Row): Row => ({
  route_name: "ВЭЛМОР НУУРЫН АЯЛАЛ", duration_text: "3 өдөр 2 шөнө", departure_dates: [D1, D2, D3], adult_price: 2190000, child_price: 1890000, infant_price: null,
  photo_urls: [], extra: { price_groups: [], itinerary_days: [], day_states: states },
});

test("the badge: full is «Дүүрсэн», few seats with and without a count, nothing for an ordinary open day", () => {
  assert.deepEqual(dayStateBadge({ state: "full", seats: null }), { text: "Дүүрсэн", tone: "full" });
  assert.deepEqual(dayStateBadge({ state: "low", seats: 4 }), { text: "4 суудал", tone: "low" });
  assert.deepEqual(dayStateBadge({ state: "low", seats: null }), { text: "Цөөн суудал", tone: "low" });
  assert.equal(dayStateBadge({ state: "open", seats: null }), null);
  assert.equal(dayStateBadge(undefined), null);
});

test("a typed seat count is a whole number of at least 1, else no count", () => {
  assert.equal(seatsFromInput("4"), 4);
  assert.equal(seatsFromInput(" 12 суудал"), 12);
  assert.equal(seatsFromInput("0"), null);
  assert.equal(seatsFromInput(""), null);
  assert.deepEqual(chosenState("low", { state: "low", seats: 3 }), { state: "low", seats: 3 }, "switching to few seats keeps a count");
  assert.deepEqual(chosenState("full", { state: "low", seats: 3 }), { state: "full", seats: null });
  assert.deepEqual(chosenState("open", { state: "low", seats: 3 }), { state: "open", seats: null }, "open clears the count");
});

test("the calendar's chips and days carry the state; a full day stays selected", () => {
  const fields = trip({ [D2]: { state: "low", seats: 4 }, [D3]: { state: "full", seats: null } });
  // The table's days say it without opening anything (2026-11-11: the calendar opens from «Огноо нэмэх, хасах»).
  const closed = plain(renderToStaticMarkup(createElement(NewTripReview, { fields, onChange: noop, warnings: [] })));
  assert.ok(closed.includes("4 суудал") && closed.includes("Дүүрсэн"), "the table's days carry the state");
  const html = renderToStaticMarkup(createElement(NewTripReview, { fields, onChange: noop, warnings: [], initialOpen: "calendar" }));
  const text = plain(html);
  assert.ok(text.includes("Сонгосон 3 өдөр"), "the full day is still one of the selected days");
  assert.ok(text.includes("4 суудал") && text.includes("Дүүрсэн"));
  assert.ok(/aria-label="[^"]*— сонгосон — дүүрсэн"/u.test(html), "the calendar day says it is full");
  assert.ok(/aria-label="[^"]*— сонгосон — 4 суудал"/u.test(html));
  assert.ok((html.match(/Суудлын төлөв солих/g) || []).length >= 3, "each selected day's chip opens its state");
});

test("the price card's day chips show the same state and the price stays", () => {
  const html = renderToStaticMarkup(createElement(PriceSection, { fields: trip({ [D3]: { state: "full", seats: null } }), onChange: noop }));
  const text = plain(html);
  assert.ok(text.includes("Дүүрсэн"));
  assert.ok(text.includes("2,190,000₮"), "the full day keeps its fare");
  assert.equal((text.match(/Цөөн суудал|суудал /g) || []).length, 0, "no badge on the open days");
});
