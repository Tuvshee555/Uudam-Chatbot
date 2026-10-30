import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import { departureMatchesScope, requestedDepartureScope } from "../src/lib/travelDates";
import { resolveTripFromUserMessage } from "../src/lib/travelFastPathsSearch";
import { applyTestEnv } from "./helpers/env";
import { conversationGateHarness } from "./helpers/conversationGateHarness";

const now = new Date("2098-02-01T04:00:00.000Z");
let routing: typeof import("../src/lib/fastPathRouting");
let clarification: typeof import("../src/lib/clarificationState");
let selection: typeof import("../src/lib/tripSelectionState");

before(async () => {
  applyTestEnv({ NEON_DATABASE_URL: undefined, BOOKING_DATABASE_URL: undefined, TRIP_UNDERSTANDING: "off" });
  routing = await import("../src/lib/fastPathRouting");
  clarification = await import("../src/lib/clarificationState");
  selection = await import("../src/lib/tripSelectionState");
});

function trip(id: string, name: string, dates: string[]): TravelTrip {
  return { id, route_name: name, category: "Шууд нислэгтэй аялал", operator_name: "Invented", duration_text: "5 өдөр",
    adult_price: 731_000, child_price: null, infant_price: null, currency: "MNT", departure_dates: dates,
    seats_total: null, seats_left: null, has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
    extra: { transport_type: "direct_flight" }, created_at: "", updated_at: "" };
}

const north = trip("velmor-north", "ВЭЛМОР ХОЙД АЯЛАЛ", ["2098-02-05", "2098-03-05", "2098-03-30"]);
const south = trip("velmor-south", "ВЭЛМОР ӨМНӨД АЯЛАЛ", ["2098-02-12", "2098-03-12", "2098-03-28"]);
const middle = trip("velmor-middle", "ВЭЛМОР ТӨВ АЯЛАЛ", ["2098-02-19", "2098-03-29"]);
const unrelated = trip("nerith", "НЕРИТ НУУРЫН АЯЛАЛ", ["2098-03-28", "2098-03-30"]);
const trips = [north, south, middle, unrelated];

async function cleanup(senderId: string) {
  await clarification.clearClarificationState(senderId);
  await selection.setTripSelection(senderId, null);
}

test("a sibling departure cannot replace the customer's fully named trip", () => {
  const result = resolveTripFromUserMessage("ВЭЛМОР ХОЙД АЯЛАЛ 3 сарын 12 үнэ хэд вэ", trips);
  assert.equal(result.status, "verified");
  if (result.status === "verified") assert.equal(result.trip.id, north.id);
});

test("calendar scope keeps a shared-month day list distinct from a continuous range", () => {
  const scope = requestedDepartureScope("3.28,30-nd Вэлмор shuud nisleg bga yu?", now);
  assert.deepEqual(scope, { kind: "dates", dates: ["2098-03-28", "2098-03-30"] });
  assert.equal(departureMatchesScope("2098-03-29", scope), false);
  assert.deepEqual(requestedDepartureScope("Вэлмор шууд нислэгтэй, 3сарынх", now), { kind: "month", year: 2098, month: 3 });
  assert.deepEqual(requestedDepartureScope("Вэлмор оны сүүлээр гарах уу", now), { kind: "unsupported" });
  assert.deepEqual(requestedDepartureScope("Нэг сард байгаа юу", now), { kind: "month", year: 2099, month: 1 });
});

test("a dated destination list retains the requested days before model interpretation", async () => {
  const senderId = "review-calendar-days";
  const text = "3.28,30-nd Вэлмор shuud nisleg bga yu?";
  try {
    const route = await routing.routeFastPathText({ senderId, text, contextualUserText: text, trips, now,
      understand: async () => { assert.fail("a known calendar scope must not be replaced by a model guess"); } });
    assert.equal(route.unavailableDateWithinScope, false);
    assert.deepEqual(route.scopedClarify?.map(trip => trip.id).sort(), [north.id, south.id].sort());
  } finally { await cleanup(senderId); }
});

test("a month follow-up stays within the destination menu and keeps its year", async () => {
  const senderId = "review-calendar-month";
  await clarification.setClarificationState(senderId, [north.id, south.id]);
  const history = [{ role: "user" as const, text: "Вэлмор аялал" },
    { role: "assistant" as const, text: `${north.route_name}\n${south.route_name}\nАль аяллыг нь сонирхож байна вэ?` }];
  try {
    const route = await routing.routeFastPathText({ senderId, text: "3сарынх", contextualUserText: "Вэлмор аялал 3сарынх", trips, history, now });
    assert.equal(route.unavailableDateWithinScope, false);
    assert.deepEqual(route.scopedClarify?.map(trip => trip.id).sort(), [north.id, south.id].sort());
    const miss = await routing.routeFastPathText({ senderId, text: "4сарынх", contextualUserText: "Вэлмор аялал 4сарынх", trips, history, now });
    assert.equal(miss.unavailableDateWithinScope, true);
    assert.deepEqual(miss.scopedClarify?.map(trip => trip.id).sort(), [north.id, south.id].sort());
  } finally { await cleanup(senderId); }
});

test("a new unknown destination with a month cannot inherit a selected trip or pending menu", async () => {
  for (const pending of [false, true]) {
    const senderId = `review-calendar-new-unknown-${pending}`;
    await selection.setTripSelection(senderId, { tripId: north.id, date: "2098-03-05", hotel: null, package: null, passengers: [] });
    if (pending) await clarification.setClarificationState(senderId, [north.id, south.id]);
    const text = "Зорвин аялал 3 сарын үнэ хэд вэ";
    try {
      const route = await routing.routeFastPathText({ senderId, text, contextualUserText: `${north.route_name}\n${text}`, trips, now,
        understand: async () => { assert.fail("a new unresolved destination must not inherit the old trip"); } });
      assert.equal(route.chosenTripId, undefined);
      assert.equal(route.scopedClarify, null);
      assert.equal(route.unsupportedRequest, true);
      assert.doesNotMatch(route.matchText, /ВЭЛМОР/);
    } finally { await cleanup(senderId); }
  }
});

test("an unspecified year-end window hands off instead of listing upcoming departures", async () => {
  const senderId = "review-calendar-year-end";
  const text = "Вэлмор оны сүүлээр гарах уу";
  try {
    const route = await routing.routeFastPathText({ senderId, text, contextualUserText: text, trips, now,
      understand: async () => { assert.fail("unsupported calendar bounds must stay unsupported"); } });
    assert.equal(route.unavailableDateWithinScope, true);
    assert.equal(route.chosenTripId, undefined);
  } finally { await cleanup(senderId); }
});

test("an itinerary origin question never becomes a destination match", async () => {
  for (const text of ["Вэлморгоос эхлэх аялал", "Вэлмор хотоос хөдлөх аялал байна уу", "velmoroos ehleh aylal", "trips departing from Velmor"]) {
    const senderId = `review-origin-${text}`;
    try {
      const route = await routing.routeFastPathText({ senderId, text, contextualUserText: text, trips, now,
        understand: async () => { assert.fail("destination membership cannot establish an origin"); } });
      assert.equal(route.unsupportedRequest, true);
      assert.equal(route.chosenTripId, undefined);
      assert.equal(route.scopedClarify, null);
    } finally { await cleanup(senderId); }
  }
  assert.equal(routing.hasUnsupportedOriginRequest("3 сарын 10-аас эхлэх аялал"), false, "a numeric date range is not an origin");
  assert.equal(routing.hasUnsupportedOriginRequest("starting from 731000"), false, "a starting price is not an origin");
});

test("demo date menus stay in scope and missing origins or months hand off silently", async context => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog(trips);
    const month = await harness.demoTurn("calendar-demo-month", "Вэлмор шууд нислэгтэй, 3сарынх");
    assert.equal(month.status, 200);
    assert.match(String(month.body.reply), /📅 3\/\d/);
    assert.doesNotMatch(String(month.body.reply), /\b2\/\d|2 сарын|НЕРИТ/);
    const dates = await harness.demoTurn("calendar-demo-days", "3.28,30-nd Вэлмор shuud nisleg bga yu?");
    assert.equal(dates.status, 200);
    assert.match(String(dates.body.reply), /3 сарын (?:28|30)|\b3\/(?:28|30)\b/);
    assert.doesNotMatch(String(dates.body.reply), /\b2\/\d|2 сарын|3 сарын 29|\b3\/29\b|ВЭЛМОР ТӨВ|НЕРИТ/);
    for (const [index, text] of ["Вэлмор шууд нислэгтэй, 4сарынх", "Вэлмор хотоос эхлэх аялал", "Вэлмор оны сүүлээр гарах уу"].entries()) {
      const result = await harness.demoTurn(`calendar-demo-missing-${index}`, text);
      assert.equal(result.status, 200);
      assert.equal(result.body.handoff, true);
      assert.doesNotMatch(String(result.body.reply), /REFER|ВЭЛМОР|2 сарын|3 сарын|📅/);
      assert.equal(result.history.some(row => row.role === "assistant" && row.text === "REFER"), false);
    }
    const original = await harness.demoTurn("calendar-demo-new-destination", `${north.route_name} үнэ хэд вэ`);
    assert.equal(original.status, 200);
    const changed = await harness.demoTurn("calendar-demo-new-destination", "Зорвин аялал 3 сарын үнэ хэд вэ", { tripId: north.id, topics: ["price"], finalReply: `${north.route_name} 731,000₮` });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.handoff, true);
    assert.doesNotMatch(String(changed.body.reply), /ВЭЛМОР|731,000/);
  } finally { await harness.close(); }
});
