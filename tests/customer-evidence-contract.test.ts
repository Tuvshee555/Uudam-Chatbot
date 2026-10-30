import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { TripSelection } from "../src/lib/tripRequest";
import { buildTripRequest, mergeTripSelection } from "../src/lib/tripRequest";
import { understandTripMessage, type UnderstandingHistory } from "../src/lib/tripUnderstanding";

const NOW = new Date("2098-04-01T00:00:00Z");
const trip = (id: string, route_name: string, hotel: string, departure: string): TravelTrip => ({
  id, route_name, hotel, category: "Аялал", operator_name: "Agency", duration_text: "5 өдөр 4 шөнө",
  adult_price: 2_000_000, child_price: 1_000_000, infant_price: null, currency: "MNT",
  departure_dates: [departure], seats_total: null, seats_left: null, has_food: true, status: "active",
  notes: "", source_description: "", photo_urls: [], extra: { transport_type: "land" }, created_at: "", updated_at: "",
});
const A = trip("velmor-lake", "Вэлмор нуурын аялал", "Lumen Lodge", "2098-04-10");
const B = trip("velmor-forest", "Вэлмор ойн аялал", "Sable Lodge", "2098-04-17");
const C = trip("nerith", "Нерит цамхгийн аялал", "Tavren Lodge", "2098-05-11");
const CATALOG = [A, B, C];
const selected = (tripId = A.id): TripSelection => ({ tripId, date: "2098-04-10", hotel: "Lumen Lodge", package: "Lake", passengers: [{ kind: "adult", count: 2 }] });
const proposal = (values: Record<string, unknown> = {}) => ({ intent: "trip", place: null, topics: ["price"], trips: ["T3"], ...values });
const read = (text: string, model = proposal(), context: { selection?: TripSelection; pendingTripIds?: string[]; history?: UnderstandingHistory } = {}) =>
  understandTripMessage({ text, trips: CATALOG, history: context.history || [], ...context, now: NOW, ask: async () => JSON.stringify(model) });

let routeFastPathText: typeof import("../src/lib/fastPathRouting").routeFastPathText;
let setTripSelection: typeof import("../src/lib/tripSelectionState").setTripSelection;
let getTripSelection: typeof import("../src/lib/tripSelectionState").getTripSelection;
let setClarificationState: typeof import("../src/lib/clarificationState").setClarificationState;
before(async () => {
  applyTestEnv();
  ({ routeFastPathText } = await import("../src/lib/fastPathRouting"));
  ({ setTripSelection, getTripSelection } = await import("../src/lib/tripSelectionState"));
  ({ setClarificationState } = await import("../src/lib/clarificationState"));
});

test("current destination evidence beats a different valid model ID and stale selected trip", async () => {
  for (const model of [proposal(), proposal({ place: "Вэлмор", trips: ["T3"] })]) {
    const result = await read("Вэлмор ойн аялал үнэ хэд вэ", model, { selection: selected() });
    assert.deepEqual(result?.trips.map(t => t.id), [B.id]);
    assert.equal(result?.evidence?.source, "current");
  }
  const omittedPlace = await read("Нерит цамхгийн аялал үнэ", proposal({ trips: ["T1"] }), { selection: selected() });
  assert.deepEqual(omittedPlace?.trips.map(t => t.id), [C.id]);
});

test("one model candidate cannot erase other trips named by the customer's shared destination", async () => {
  const result = await read("Вэлмор аяллын үнэ", proposal({ place: "Вэлмор", trips: ["T1"] }));
  assert.equal(result?.certainty, "several");
  assert.deepEqual(result?.trips.map(t => t.id).sort(), [A.id, B.id].sort());
});

test("a pending list or selected offer bounds follow-ups instead of authorizing any catalog ID", async () => {
  const pending = await read("Үнэ хэд вэ", proposal(), { pendingTripIds: [A.id, B.id] });
  assert.deepEqual(pending?.trips.map(t => t.id), [A.id, B.id]);
  const selection = await read("Үнэ хэд вэ", proposal({ place: "Нерит" }), { selection: selected() });
  assert.deepEqual(selection?.trips.map(t => t.id), [A.id], "an invented place span grants no new identity");
});

test("a greeting or bot-origin trip mention supplies no customer identity, while a customer's earlier trip does", async () => {
  for (const history of [[], [{ role: "assistant" as const, text: "Сайн байна уу" }], [{ role: "assistant" as const, text: C.route_name }]]) {
    const result = await read("Үнэ хэд вэ", proposal({ place: "Нерит" }), { history });
    assert.equal(result?.certainty, "none");
    assert.deepEqual(result?.trips, []);
  }
  const historical = await read("Үнэ хэд вэ", proposal(), { history: [{ role: "user", text: A.route_name }, { role: "assistant", text: "Мэдээлэл" }] });
  assert.deepEqual(historical?.trips.map(t => t.id), [A.id]);
  const greeting = await read("Сайн байна уу", proposal(), { selection: selected() });
  assert.deepEqual(greeting?.trips, []);
});

test("unknown current destination does not inherit the selected trip", async () => {
  const result = await read("Луравен аялал", proposal({ place: "Луравен", unknown_destination: "Луравен" }), { selection: selected() });
  assert.deepEqual(result?.trips, []);
  assert.equal(result?.unknownDestination, "Луравен");
});

test("existing Latin spelling and catalog typo matching remain usable without model identity authority", async () => {
  for (const text of ["velmor аяллын үнэ", "Вэлморр аяллын үнэ"]) {
    const result = await read(text, proposal());
    assert.deepEqual(result?.trips.map(t => t.id).sort(), [A.id, B.id].sort());
  }
});

test("explicit dates are checked even when the model omits or contradicts them", async () => {
  for (const model of [proposal({ trips: ["T1"] }), proposal({ trips: ["T1"], date: "2098-04-10" })]) {
    const result = await read("Вэлмор нуурын аялал 2098-04-11 үнэ хэд вэ", model);
    assert.equal(result?.date, "2098-04-11");
    assert.equal(result?.unmet, "date");
  }
});

test("a current range or month defeats a model's invented single date", async () => {
  const range = await read("Вэлмор 2098-04-10 2098-04-20 хооронд", proposal({ date: "2098-04-10" }));
  assert.equal(range?.date, null);
  assert.deepEqual(range?.range, ["2098-04-10", "2098-04-20"]);
  assert.deepEqual(range?.trips.map(t => t.id).sort(), [A.id, B.id].sort());
  const month = await read("Вэлмор 5 сард үнэ", proposal({ date: "2098-04-10", month: 4 }));
  assert.equal(month?.date, null);
  assert.equal(month?.month, 5);
  assert.equal(month?.unmet, "month");
  const request = buildTripRequest("2098 оны 5 сард үнэ", CATALOG, month || undefined, NOW);
  assert.equal(mergeTripSelection(A.id, request, selected()).date, null);
});

test("explicit duration and transport are enforced before a candidate is accepted", async () => {
  const duration = await read("Вэлмор нуурын аялал 8 хоног", proposal({ days: [5, 5] }));
  assert.deepEqual(duration?.days, [8, 8]);
  assert.equal(duration?.unmet, "days");
  const transport = await read("Вэлмор нуурын аялал шууд нислэгтэй юу", proposal({ transport: "land" }));
  assert.equal(transport?.transport, "direct_flight");
  assert.equal(transport?.unmet, "transport");
});

test("explicit hotel and passengers replace model values; unrelated invented options are discarded", async () => {
  const result = await read("Вэлмор нуурын аялал Lumen Lodge 3 том хүн", proposal({ hotel: "Sable Lodge", passengers: [{ kind: "adult", count: 1 }] }));
  assert.equal(result?.hotel, "Lumen Lodge");
  assert.deepEqual(result?.passengers, [{ kind: "adult", count: 3 }]);
  const invented = await read("Вэлмор нуурын аялал үнэ", proposal({ hotel: "Sable Lodge", package: "Forest", passengers: [{ kind: "adult", count: 4 }] }));
  assert.equal(invented?.hotel, null);
  assert.equal(invented?.package, null);
  assert.deepEqual(invented?.passengers, []);
  const request = buildTripRequest("Lumen Lodge Sable Lodge үнийн ялгаа", CATALOG, { hotel: "Lumen Lodge" }, NOW);
  assert.equal(request.hotel, null, "a comparison between two named hotels cannot silently select the first");
});

test("a calendar month is not a passenger age or an extra price question", () => {
  const seats = buildTripRequest("4 сарын 10-нд суудал байгаа юу", CATALOG, undefined, NOW);
  assert.ok(seats.topics.includes("availability"));
  assert.ok(!seats.topics.includes("price"));
  const infant = buildTripRequest("10 сартай хүүхэд", CATALOG, undefined, NOW);
  assert.ok(infant.topics.includes("price"));
  assert.deepEqual(infant.passengers, [{ kind: "infant", count: 1, age: 10, ageUnit: "month" }]);
});

test("routing persists the reconciled current identity and never the model's unsupported ID", async () => {
  const senderId = "evidence-current-route";
  await setTripSelection(senderId, selected());
  const text = "Нерит цамхгийн аялал үнэ";
  const route = await routeFastPathText({ senderId, text, contextualUserText: `${A.route_name}\n${text}`, trips: CATALOG, now: NOW,
    understand: (pendingTripIds, selection) => understandTripMessage({ text, trips: CATALOG, history: [], pendingTripIds, selection, now: NOW, ask: async () => JSON.stringify(proposal({ trips: ["T1"] })) }) });
  assert.equal(route.chosenTripId, C.id);
  assert.equal((await getTripSelection(senderId))?.tripId, C.id);
  assert.equal(route.selection?.hotel, null);
  assert.equal(route.selection?.date, null);
});

test("routing cannot persist a model-picked outsider under a genuine offered list", async () => {
  const senderId = "evidence-pending-route";
  await setClarificationState(senderId, [A.id, B.id]);
  // 2026-10-30: this used "Үнэ хэд вэ". A bare fare question under a list is now answered from
  // the listed trips before the model is asked (P2-1, below), so the model path is exercised
  // with a price question that also refers to the trips.
  const text = "Тэр аяллын үнэ хэд вэ";
  const route = await routeFastPathText({ senderId, text, contextualUserText: text, trips: CATALOG, now: NOW,
    history: [{ role: "assistant", text: `${A.route_name}\n${B.route_name}\nАль аяллыг нь сонирхож байна вэ?` }],
    understand: (pendingTripIds, selection) => understandTripMessage({ text, trips: CATALOG, history: [], pendingTripIds, selection, now: NOW, ask: async () => JSON.stringify(proposal()) }) });
  assert.equal(route.chosenTripId, undefined);
  assert.deepEqual(route.understanding?.trips.map(t => t.id), [A.id, B.id]);
  assert.equal(await getTripSelection(senderId), null);
});

test("a bare fare question under an offered list prices exactly the offered trips, with no model pick", async () => {
  const senderId = "evidence-pending-fare";
  await setClarificationState(senderId, [A.id, B.id]);
  const text = "Үнэ хэд вэ";
  const route = await routeFastPathText({ senderId, text, contextualUserText: text, trips: CATALOG, now: NOW,
    history: [{ role: "assistant", text: `${A.route_name}\n${B.route_name}\nАль аяллыг нь сонирхож байна вэ?` }],
    understand: async () => { throw new Error("a fare question under the list is answered from the list"); } });
  assert.equal(route.chosenTripId, undefined);
  assert.deepEqual(route.scopedClarify?.map(t => t.id), [A.id, B.id], "only the offered trips");
  assert.equal(await getTripSelection(senderId), null);
});

test("a numeric trip choice preserves the customer's pending question and its explicit constraints", async () => {
  const senderId = "evidence-menu-request";
  await setClarificationState(senderId, [A.id, B.id]);
  const question = "Вэлмор аялал 3 том хүн үнэ хэд вэ";
  const history: UnderstandingHistory = [
    { role: "user", text: question },
    { role: "assistant", text: `${A.route_name}\n${B.route_name}\nАль аяллыг нь сонирхож байна вэ?` },
    { role: "user", text: "2" },
  ];
  const route = await routeFastPathText({ senderId, text: "2", contextualUserText: "2", trips: CATALOG, history, now: NOW,
    understand: async () => { throw new Error("a numeric menu selection must stay deterministic"); } });
  assert.equal(route.chosenTripId, B.id);
  assert.equal(route.requestText, question);
  assert.deepEqual(route.selection?.passengers, [{ kind: "adult", count: 3 }]);
  assert.ok(buildTripRequest(route.requestText!, CATALOG, undefined, NOW).topics.includes("price"));
});
