import assert from "node:assert/strict";
import test, { before } from "node:test";
import type { TravelTrip } from "../src/lib/travelTypes";
import { applyTestEnv } from "./helpers/env";
import { buildTripAnswerPlan } from "../src/lib/tripAnswerPlan";
import { ungroundedTripInReply } from "../src/lib/tripGrounding";
import { conversationGateHarness } from "./helpers/conversationGateHarness";
import { tripFromRecentMenu, tripMenuQuestionIndex } from "../src/lib/tripMenuChoice";

let routeFastPathText: typeof import("../src/lib/fastPathRouting").routeFastPathText;
let setClarificationState: typeof import("../src/lib/clarificationState").setClarificationState;
let clearClarificationState: typeof import("../src/lib/clarificationState").clearClarificationState;
let setTripSelection: typeof import("../src/lib/tripSelectionState").setTripSelection;
before(async () => {
  applyTestEnv();
  ({ routeFastPathText } = await import("../src/lib/fastPathRouting"));
  ({ setClarificationState, clearClarificationState } = await import("../src/lib/clarificationState"));
  ({ setTripSelection } = await import("../src/lib/tripSelectionState"));
});
const now = new Date("2098-02-01T04:00:00Z");
const trips: TravelTrip[] = ["ЛУМИР", "СЭЛВЭН", "ТЭЛУН"].map((name, i) => ({
  id: `menu-${i}`, route_name: `ВЭЛМОР ${name} АЯЛАЛ`, category: "Аялал", operator_name: "Invented",
  duration_text: "5 өдөр", adult_price: 731_000 + i * 100_000, child_price: 531_000, infant_price: null,
  currency: "MNT", departure_dates: ["2098-02-17", "2098-03-17"], seats_total: 20, seats_left: 10,
  has_food: null, status: "active", notes: "", hotel: "", source_description: "", photo_urls: [],
  extra: { brochure_pdf_url: `https://fixture.invalid/program-${i}.pdf` }, created_at: "", updated_at: "",
}));
const menu = `${trips.map(trip => `• ${trip.route_name}`).join("\n")}\nАль аяллыг нь сонирхож байна вэ?`;

test("named menu buttons retain the requested month just like bare numeric choices", async () => {
  for (const text of ["2", `2. ${trips[1].route_name}`]) {
    const senderId = `menu-month-${text}`;
    const history = [{ role: "user" as const, text: "Вэлмор 3 сарын үнэ хэд вэ" }, { role: "assistant" as const, text: menu }];
    await setClarificationState(senderId, trips.map(trip => trip.id));
    try {
      const route = await routeFastPathText({ senderId, text, contextualUserText: text, history, trips, now });
      assert.equal(route.chosenTripId, trips[1].id);
      assert.equal(route.selection?.dateScope?.month, 3);
      const plan = buildTripAnswerPlan({ text, route, trips, now });
      assert.equal(plan?.request.month, 3);
      assert.match(plan!.reply, /3 сарын/);
      assert.doesNotMatch(plan!.reply, /2 сарын/);
    } finally { await clearClarificationState(senderId); await setTripSelection(senderId, null); }
  }
});

test("a named button from outside the current menu does not inherit its calendar request", async () => {
  const senderId = "menu-other-button";
  await setClarificationState(senderId, [trips[0].id]);
  try {
    const history = [{ role: "user" as const, text: "Вэлмор 3 сарын үнэ" },
      { role: "assistant" as const, text: `${trips[0].route_name}\nАль аяллыг нь сонирхож байна вэ?` }];
    const text = `2. ${trips[1].route_name}`;
    const route = await routeFastPathText({ senderId, text, contextualUserText: text, history, trips, now });
    assert.equal(route.chosenTripId, trips[1].id);
    assert.equal(route.selection?.dateScope, undefined);
  } finally { await clearClarificationState(senderId); await setTripSelection(senderId, null); }
});

test("an explicit ordinal program request can switch back to an alternative from the displayed menu", async () => {
  const senderId = "menu-return-to-third";
  const history = [{ role: "user" as const, text: "Вэлмор аялал" }, { role: "assistant" as const, text: menu },
    { role: "user" as const, text: `2. ${trips[1].route_name}` }, { role: "assistant" as const, text: trips[1].route_name },
    { role: "user" as const, text: "Хөтөлбөр үзэх" }, { role: "assistant" as const, text: `${trips[1].route_name}\nhttps://fixture.invalid/program-1.pdf` }];
  await setTripSelection(senderId, { tripId: trips[1].id, date: null, hotel: null, package: null, passengers: [] });
  const text = "3 iin hotolboriig hary";
  try {
    const route = await routeFastPathText({ senderId, text, contextualUserText: `${trips[1].route_name}\n${text}`, history, trips, now,
      understand: async () => { assert.fail("an explicit menu reference is deterministic"); } });
    assert.equal(route.chosenTripId, trips[2].id);
    assert.equal(ungroundedTripInReply(trips[2].route_name, { customerText: text, history, trips, selectionTripId: trips[1].id }), null);
    assert.equal(ungroundedTripInReply(trips[1].route_name, { customerText: text, history, trips, selectionTripId: trips[1].id })?.id, trips[1].id);
  } finally { await clearClarificationState(senderId); await setTripSelection(senderId, null); }
});

test("an ordinal without an available menu or beyond its length cannot borrow the selected trip", async () => {
  for (const history of [[], [{ role: "assistant" as const, text: menu }]]) {
    const senderId = `menu-unknown-${history.length}`;
    await setTripSelection(senderId, { tripId: trips[1].id, date: null, hotel: null, package: null, passengers: [] });
    const text = history.length ? "4 iin hotolboriig hary" : "3 iin hotolboriig hary";
    try {
      const route = await routeFastPathText({ senderId, text, contextualUserText: text, history, trips, now });
      assert.equal(route.chosenTripId, undefined);
      assert.equal(route.unsupportedRequest, true);
      assert.equal(ungroundedTripInReply(trips[1].route_name, { customerText: text, history, trips, selectionTripId: trips[1].id })?.id, trips[1].id);
    } finally { await clearClarificationState(senderId); await setTripSelection(senderId, null); }
  }
});

test("itinerary days and calendar months are never read as menu ordinals", () => {
  for (const text of ["3-р өдрийн хөтөлбөр", "3-р сарын үнэ", "3 iin udriin hutulbur", "3 in month price"]) {
    assert.equal(tripMenuQuestionIndex(text), null);
  }
  assert.equal(tripMenuQuestionIndex("125 iin hotolboriig hary"), 124);
});

test("a current explicit trip name wins over a conflicting ordinal", async () => {
  const senderId = "menu-explicit-name";
  const history = [{ role: "assistant" as const, text: menu }];
  const text = `3 iin хөтөлбөр ${trips[0].route_name}`;
  try {
    const route = await routeFastPathText({ senderId, text, contextualUserText: text, history, trips, now });
    assert.equal(route.chosenTripId, trips[0].id);
    assert.equal(ungroundedTripInReply(trips[2].route_name, { customerText: text, history, trips })?.id, trips[2].id);
  } finally { await clearClarificationState(senderId); await setTripSelection(senderId, null); }
});

test("a destination answer keeps the preceding calendar-only request and a new date overrides it", async () => {
  const history = [{ role: "user" as const, text: "3 сарын 17-нд явах аялал байна уу" },
    { role: "assistant" as const, text: "Ямар чиглэл сонирхож байна вэ?" }];
  for (const [text, expected] of [[trips[0].route_name, "2098-03-17"], [`${trips[0].route_name} 2 сарын 17`, "2098-02-17"]]) {
    const senderId = `menu-calendar-completion-${expected}`;
    try {
      const route = await routeFastPathText({ senderId, text, contextualUserText: text, history, trips, now });
      assert.equal(route.chosenTripId, trips[0].id);
      assert.equal(route.selection?.date, expected);
    } finally { await clearClarificationState(senderId); await setTripSelection(senderId, null); }
  }
});

test("signed webhook retains calendar scope after named choices and switches ordinal programs through grounding", async context => {
  const harness = await conversationGateHarness(context);
  try {
    harness.catalog(trips);
    const month = await harness.turn("menu-live-month", "Вэлмор 3 сарын үнэ хэд вэ");
    assert.ok(month.sends[0]?.text.includes(trips[1].route_name));
    const chosen = await harness.turn("menu-live-month", `2. ${trips[1].route_name}`);
    assert.equal(chosen.selection?.dateScope?.month, 3);
    assert.ok(chosen.sends[0]?.text.includes("3 сарын"));
    assert.ok(!chosen.sends[0]?.text.includes("2 сарын"));
    const switched = await harness.turn("menu-live-month", "3 iin hotolboriig hary");
    assert.equal(switched.selection?.tripId, trips[2].id);
    assert.ok(switched.sends[0]?.text.includes("program-2.pdf"));
    assert.ok(!switched.sends[0]?.text.includes("program-1.pdf"), "the chosen program remains correct when its title is omitted");
    assert.equal(switched.leads.length, 0);
    const calendar = await harness.turn("menu-date-before-name", "3 сарын 17-нд явах аялал байна уу");
    assert.ok(calendar.sends.length > 0);
    const destination = await harness.turn("menu-date-before-name", trips[0].route_name);
    assert.equal(destination.selection?.date, "2098-03-17");
    assert.ok(destination.sends[0]?.text.includes("3 сарын 17"));
    assert.ok(!destination.sends[0]?.text.includes("2 сарын 17"));
  } finally { await harness.close(); }
});

test("recent menu ordinals preserve missing, duplicate and explicitly numbered slots", () => {
  const history = [{ role: "assistant" as const, text: menu }];
  const current = [trips[0], trips[2]];
  assert.equal(tripFromRecentMenu("2 iin program", history, current), null);
  assert.equal(tripFromRecentMenu("3 iin program", history, current)?.id, trips[2].id);
  assert.equal(ungroundedTripInReply(trips[2].route_name, { customerText: "2 iin program", history, trips: current })?.id, trips[2].id);
  const repeated = [{ role: "assistant" as const, text: `• ${trips[0].route_name}\n• ${trips[0].route_name}\n• ${trips[2].route_name}\nАль аяллыг сонгох вэ?` }];
  assert.equal(tripFromRecentMenu("2 iin program", repeated, trips)?.id, trips[0].id);
  assert.equal(tripFromRecentMenu("3 iin program", repeated, trips)?.id, trips[2].id);
  const numbered = [{ role: "assistant" as const, text: `1. ${trips[0].route_name}\n3. ${trips[2].route_name}\nАль аяллыг сонгох вэ?` }];
  assert.equal(tripFromRecentMenu("2 iin program", numbered, trips), null);
  assert.equal(tripFromRecentMenu("3 iin program", numbered, trips)?.id, trips[2].id);
  const ambiguous = [...trips, { ...trips[1], id: "duplicate-id" }];
  assert.equal(tripFromRecentMenu("2 iin program", history, ambiguous), null);
  const latest = [...history, { role: "assistant" as const, text: `• ${trips[2].route_name}\nАль аяллыг сонгох вэ?` }];
  assert.equal(tripFromRecentMenu("2 iin program", latest, trips), null);
  assert.equal(tripFromRecentMenu("1 iin program", latest, trips)?.id, trips[2].id);
  const expired = [...history, ...Array.from({ length: 12 }, () => ({ role: "user" as const, text: "За" }))];
  assert.equal(tripFromRecentMenu("1 iin program", expired, trips), null);
  const prose = [{ role: "assistant" as const, text: `${trips[0].route_name}\nАль аяллын талаар асууж байна вэ?` }];
  assert.equal(tripFromRecentMenu("1 iin program", prose, trips), null);
});
