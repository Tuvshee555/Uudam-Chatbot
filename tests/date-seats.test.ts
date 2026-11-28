import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MAX_DATE_SEATS, departureSeatsAfterTripEdit, parseDateSeats } from "../src/lib/departureSeats";
import { dateSeatNote, lowSeatDates, openDateWording } from "../src/lib/departureAvailability";
import { resolveTripOffer } from "../src/lib/tripOffers";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { websiteTripToCanonicalFields } from "../src/lib/websiteTripBridge";
import { checkSelfConsistency } from "../src/lib/selfConsistency";
import { buildStructuredTripReply } from "../src/lib/travelFastPaths";
import { DateSeatsEditor } from "../src/components/admin/DateSeatsEditor";
import { ToastProvider } from "../src/components/ui";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { TravelTrip as AdminTrip } from "../src/lib/adminTypes";

// Invented trip only. One future date is flagged "few seats", its neighbours are not.
const NOW = new Date("2099-01-05T04:00:00Z");
const row = (date: string, status: string, seatsLeft: number | null = null) => ({ date, status, seatsLeft });
const trip = (rows: ReturnType<typeof row>[], more: Partial<TravelTrip> = {}): TravelTrip => ({
  id: "fixture-seats", route_name: "ЗАНДАН ДАЛАЙН АЯЛАЛ", operator_name: "Uudam", category: "",
  duration_text: "6 өдөр 5 шөнө", adult_price: 2_000_000, child_price: 1_500_000, infant_price: null, currency: "MNT",
  departure_dates: ["2099-02-10", "2099-02-17", "2099-02-24"], seats_total: null, seats_left: null,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: { age_rules: { adult: "12+ нас", child: "2-11 нас" }, website_departure_availability: rows },
  created_at: "", updated_at: "", ...more,
});
const flagged = trip([row("2099-02-10", "OPEN"), row("2099-02-17", "ALMOST_FULL"), row("2099-02-24", "OPEN")]);

test("a trip-wide seat edit can only close every date; it never marks dates as few seats", () => {
  const edit = (tripSeatsLeft: number | null, rowSeatsLeft: number | null, previousTripSeatsLeft: number | null = 5) =>
    departureSeatsAfterTripEdit({ tripChanged: true, previousTripSeatsLeft, tripSeatsLeft, rowSeatsLeft });
  assert.equal(edit(0, 8), 0, "0 closes every date");
  assert.equal(edit(3, null), null, "typing 3 does not stamp 3 on every date");
  assert.equal(edit(3, 5), null, "a count copied from the old trip-wide number is cleared");
  assert.equal(edit(3, 0), null, "reopening a full trip reopens its dates");
  assert.equal(edit(3, 2), 2, "a date's own count stays");
  assert.equal(departureSeatsAfterTripEdit({ tripChanged: false, previousTripSeatsLeft: 5, tripSeatsLeft: 5, rowSeatsLeft: 4 }), 4);
});

test("every typed count is shown beside its date, and «Цөөн суудал» is the state staff pick, shown next to it (owner, 2026-11-28)", () => {
  assert.deepEqual([...lowSeatDates(flagged, "2099-01-05")], ["2099-02-17"]);
  const counted = trip([row("2099-02-10", "OPEN", 2), row("2099-02-17", "ALMOST_FULL", 19), row("2099-02-24", "OPEN", 40), row("2099-03-03", "OPEN")]);
  assert.deepEqual([...lowSeatDates(counted, "2099-01-05")], ["2099-02-17"], "a count never sets «Цөөн суудал» by itself");
  assert.equal(dateSeatNote(counted, "2099-02-10"), "2 суудал үлдсэн");
  assert.equal(dateSeatNote(counted, "2099-02-17"), "цөөн суудал, 19 суудал үлдсэн", "state and count side by side");
  assert.equal(dateSeatNote(counted, "2099-02-24"), "40 суудал үлдсэн", "any count is shown");
  assert.equal(dateSeatNote(counted, "2099-03-03"), "", "no count, no state: nothing");
  assert.equal(dateSeatNote(flagged, "2099-02-17"), "цөөн суудал", "the state picked with no number");
  const result = resolveTripOffer(flagged, { date: "2099-02-17" }, NOW);
  assert.equal(result.status, "ready");
  if (result.status === "ready") assert.equal(result.offer.availability.low, true);
  const plain = resolveTripOffer(flagged, { date: "2099-02-10" }, NOW);
  if (plain.status === "ready") assert.equal(plain.offer.availability.low, undefined);
});

test("the flag reaches the website as ALMOST_FULL on that date only", () => {
  const payload = websiteTripPayload(flagged, [
    { start: "2099-02-10T00:00:00.000Z", end: "2099-02-15T00:00:00.000Z", label: "2/10" },
    { start: "2099-02-17T00:00:00.000Z", end: "2099-02-22T00:00:00.000Z", label: "2/17" },
  ], NOW);
  assert.deepEqual(payload.departures.map((d) => d.status), ["OPEN", "ALMOST_FULL"]);
});

test("a website admin edit of one date keeps the flag when it comes back to the chatbot", () => {
  const { fields } = websiteTripToCanonicalFields({
    sourceTripId: "fixture-seats", title: "ЗАНДАН ДАЛАЙН АЯЛАЛ", durationDays: 6, durationNights: 5, currency: "MNT",
    departures: [{ startDate: "2099-02-10T00:00:00.000Z", status: "OPEN" }, { startDate: "2099-02-17T00:00:00.000Z", status: "ALMOST_FULL" }],
  });
  const rows = (fields.extra as { website_departure_availability: Array<{ date: string; status: string }> }).website_departure_availability;
  assert.deepEqual(rows.map((r) => r.status), ["OPEN", "ALMOST_FULL"]);
});

test("the requested full trip card marks only the flagged date and still passes its own checker", () => {
  const card = buildStructuredTripReply("ЗАНДАН ДАЛАЙН АЯЛАЛ дэлгэрэнгүй", [flagged], NOW)!;
  assert.match(card, /2\/17 \(цөөн суудал\)/);
  assert.doesNotMatch(card, /2\/10 \(цөөн/);
  assert.doesNotMatch(card, /2\/24 \(цөөн/);
  assert.match(card, /Цөөн суудалтай гэж тэмдэглэсэн өдрөөр/);
  assert.deepEqual(checkSelfConsistency([flagged], NOW).failures, []);
  assert.equal(openDateWording({ seatsLeft: null, low: true }), "захиалга нээлттэй, цөөн суудал үлдсэн");
  assert.equal(openDateWording({ seatsLeft: null }), "захиалга нээлттэй");
});

test("the card shows each date's own count and state; a date with no count shows none (owner, 2026-11-28)", () => {
  const counted = trip([row("2099-02-10", "OPEN", 4), row("2099-02-17", "ALMOST_FULL", 19), row("2099-02-24", "OPEN", 30)]);
  const card = buildStructuredTripReply("ЗАНДАН ДАЛАЙН АЯЛАЛ дэлгэрэнгүй", [counted], NOW)!;
  assert.match(card, /2\/10 \(4 суудал үлдсэн\)/);
  assert.match(card, /2\/17 \(цөөн суудал, 19 суудал үлдсэн\)/);
  assert.match(card, /2\/24 \(30 суудал үлдсэн\)/);
  assert.deepEqual(checkSelfConsistency([counted], NOW).failures, []);
  const plain = buildStructuredTripReply("ЗАНДАН ДАЛАЙН АЯЛАЛ дэлгэрэнгүй", [flagged], NOW)!;
  assert.doesNotMatch(plain, /\d+ суудал үлдсэн/, "no count typed: no number");
  assert.equal(openDateWording({ seatsLeft: 4 }), "захиалга нээлттэй, 4 суудал үлдсэн");
  assert.equal(openDateWording({ seatsLeft: 19, low: true }), "захиалга нээлттэй, цөөн суудал үлдсэн, 19 суудал үлдсэн");
  assert.equal(openDateWording({ seatsLeft: 30 }), "захиалга нээлттэй, 30 суудал үлдсэн");
  assert.equal(openDateWording({ seatsLeft: null, low: true }), "захиалга нээлттэй, цөөн суудал үлдсэн");
});

test("a trip with no flagged date says nothing about few seats", () => {
  const plain = trip([row("2099-02-10", "OPEN"), row("2099-02-17", "OPEN")], { seats_left: 3 });
  const card = buildStructuredTripReply("ЗАНДАН ДАЛАЙН АЯЛАЛ", [plain], NOW)!;
  assert.doesNotMatch(card, /цөөн суудал|Суудал цөөн/i);
});

test("the admin control lists each upcoming date with its own state", () => {
  const admin = trip([
    row("2099-02-10", "OPEN"), row("2099-02-17", "ALMOST_FULL"), row("2099-02-24", "SOLD_OUT"),
    row("2099-02-26", "PAUSED"), row("2099-03-03", "CANCELLED"), row("2001-01-01", "OPEN"),
  ]) as unknown as AdminTrip;
  const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(DateSeatsEditor, { trip: admin, apiFetch: async () => new Response("{}") })));
  const checked = (html.match(/aria-checked="true"[^>]*>[^<]+/g) || []).map((m) => m.replace(/.*>/, ""));
  assert.deepEqual(checked, ["Нээлттэй", "Цөөн суудал", "Дүүрсэн"]);
  assert.match(html, /Түр хаасан/);
  assert.doesNotMatch(html, /3-р сарын 3/, "a cancelled date is not offered");
  assert.doesNotMatch(html, /1-р сарын 1 /, "a past date is not offered");
  assert.match(html, /1 өдөр «Цөөн суудал» гэж харагдаж байна/);
});

test("a typed seat count is a whole number 0..200, empty clears it, anything else is not a count (2026-11-27)", () => {
  assert.equal(parseDateSeats(5), 5);
  assert.equal(parseDateSeats("12"), 12);
  assert.equal(parseDateSeats(" 7 "), 7);
  assert.equal(parseDateSeats(0), 0);
  assert.equal(parseDateSeats(MAX_DATE_SEATS), MAX_DATE_SEATS);
  assert.equal(parseDateSeats(null), null);
  assert.equal(parseDateSeats(""), null);
  for (const bad of [-1, 2.5, MAX_DATE_SEATS + 1, "abc", "1e3", "12 хүн", {}, [], true, NaN, undefined]) assert.equal(parseDateSeats(bad), undefined, String(bad));
});

test("the admin control has a seat-count box on every date, filled from the website's own count (2026-11-27)", () => {
  const admin = trip([
    { date: "2099-02-10", status: "OPEN", seatsLeft: 12 }, { date: "2099-02-17", status: "ALMOST_FULL", seatsLeft: null },
    { date: "2099-02-24", status: "SOLD_OUT", seatsLeft: 0 },
  ].map((entry) => ({ ...entry }))) as unknown as AdminTrip;
  const html = renderToStaticMarkup(createElement(ToastProvider, null, createElement(DateSeatsEditor, { trip: admin, apiFetch: async () => new Response("{}") })));
  const boxes = [...html.matchAll(/aria-label="([^"]*үлдсэн суудлын тоо)"[^>]*value="([^"]*)"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(boxes, [
    ["2-р сарын 10 · Мягмар үлдсэн суудлын тоо", "12"],
    ["2-р сарын 17 · Мягмар үлдсэн суудлын тоо", ""],
    ["2-р сарын 24 · Мягмар үлдсэн суудлын тоо", "0"],
  ]);
});
