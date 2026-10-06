/**
 * The understanding step: the model picks catalog keys, code checks the pick
 * against the trip data, and routing turns the result into one trip, a scoped
 * "which one?", or "no trip". Trip names are invented; the model is faked.
 */
import assert from "node:assert/strict";
import test, { before } from "node:test";
import { applyTestEnv } from "./helpers/env";
import type { TravelTrip } from "../src/lib/travelOps";
import type { Understanding } from "../src/lib/tripUnderstanding";

let routeFastPathText: typeof import("../src/lib/fastPathRouting").routeFastPathText;
let tu: typeof import("../src/lib/tripUnderstanding");
let resolveTripFromUserMessage: typeof import("../src/lib/travelFastPathsSearch").resolveTripFromUserMessage;
let getClarificationState: typeof import("../src/lib/clarificationState").getClarificationState;

before(async () => {
  applyTestEnv();
  routeFastPathText = (await import("../src/lib/fastPathRouting")).routeFastPathText;
  tu = await import("../src/lib/tripUnderstanding");
  resolveTripFromUserMessage = (await import("../src/lib/travelFastPathsSearch")).resolveTripFromUserMessage;
  getClarificationState = (await import("../src/lib/clarificationState")).getClarificationState;
});

function trip(fields: Partial<TravelTrip>): TravelTrip {
  return {
    id: "trip-x", category: "Аялал", operator_name: "Uudam Travel", route_name: "Аялал",
    duration_text: "8 өдөр 7 шөнө", adult_price: 1_500_000, child_price: 1_200_000, infant_price: 300_000,
    currency: "MNT", departure_dates: ["12 сарын 3"], seats_total: null, seats_left: null, has_food: true,
    status: "active", notes: "", hotel: "", source_description: "", photo_urls: [], extra: {},
    created_at: "", updated_at: "", ...fields,
  };
}

const LONG = trip({ id: "t-long", route_name: "Вэлмор – Кардан газар нислэг хосолсон аялал", duration_text: "10 өдөр 9 шөнө", departure_dates: ["12 сарын 10"] });
const SHORT = trip({ id: "t-short", route_name: "Вэлмор шууд нислэгтэй аялал", duration_text: "8 өдөр 7 шөнө", departure_dates: ["12 сарын 17"] });
const OTHER = trip({ id: "t-other", route_name: "Тармиз нуурын аялал", duration_text: "5 өдөр 4 шөнө", departure_dates: ["12 сарын 3"] });
const DRAFT = trip({ id: "t-draft", route_name: "Ноорог аялал", status: "draft" });
const CATALOG = [LONG, SHORT, OTHER, DRAFT];
const NOW = new Date("2026-10-02T04:00:00Z");

function keysFor(trips: TravelTrip[]) {
  return tu.buildUnderstandingPrompt({ text: "x", history: [], trips, now: NOW }).keys;
}

test("the prompt lists only bookable trips and the bot's last numbered list", () => {
  const { user, keys } = tu.buildUnderstandingPrompt({
    text: "2",
    history: [{ role: "user", text: "вэлмор" }, { role: "assistant", text: "Аль аяллыг нь сонирхож байна вэ?" }, { role: "user", text: "2" }],
    trips: CATALOG,
    pendingTripIds: ["t-short", "t-long"],
    now: NOW,
  });
  assert.equal(keys.size, 3, "a draft trip is never offered to the model");
  assert.ok(!user.includes("Ноорог"));
  assert.match(user, /1=T2, 2=T1/);
  assert.equal(user.match(/Customer: 2/g), null, "the current message is not repeated as history");
});

test("only real catalog keys survive, and a stated trip length is checked against the data", () => {
  const keys = keysFor(CATALOG);
  const picked = tu.interpretUnderstanding('{"intent":"trip","trips":["T1","T2","T99","T1"],"certainty":"several","days":[8,8]}', keys, NOW)!;
  assert.deepEqual(picked.trips.map((t) => t.id), ["t-short"], "unknown key dropped, length narrows to the 8-day trip");
  assert.equal(picked.certainty, "one");
  assert.equal(picked.unmet, null);
});

test("a length no trip of that destination has is reported, not passed off as a fit", () => {
  const keys = keysFor(CATALOG);
  const u = tu.interpretUnderstanding('{"intent":"trip","trips":["T1","T2"],"certainty":"several","days":[5,6]}', keys, NOW)!;
  assert.equal(u.unmet, "days");
  assert.equal(u.trips.length, 2, "the destination's trips are kept so the customer still sees them");
  assert.match(tu.unmetNote(u)!, /5-6 өдрийн аялал одоогоор алга байна/);
});

test("a departure date narrows a destination to the trip that actually leaves that day", () => {
  const keys = keysFor(CATALOG);
  const u = tu.interpretUnderstanding('{"intent":"trip","trips":["T1","T2"],"certainty":"several","date":"2026-12-17"}', keys, NOW)!;
  assert.deepEqual(u.trips.map((t) => t.id), ["t-short"]);
  assert.equal(u.certainty, "one");
});

test("unreadable model output means no understanding, never a guess", () => {
  assert.equal(tu.interpretUnderstanding("Уучлаарай, систем түр алдаатай байна.", keysFor(CATALOG), NOW), null);
});

const understood = (u: Partial<Understanding>): Understanding => ({
  intent: "trip", place: null, trips: [], certainty: "none", date: null, range: null, month: null, days: null,
  transport: null, unmet: null, unknownRequirement: null, unknownDestination: null, ...u,
});

test("a transport the destination does not offer is reported, not ignored", () => {
  const u = tu.interpretUnderstanding('{"place":"вэлмор","intent":"trip","trips":["T2"],"certainty":"one","transport":"land"}', keysFor(CATALOG), NOW)!;
  assert.equal(u.unmet, "transport");
  assert.match(tu.unmetNote(u)!, /Газрын аялал энэ чиглэлд одоогоор байхгүй/);
});

test("missing transport and duration facts stay unknown instead of becoming matches", () => {
  const unknown = trip({
    id: "t-unknown",
    route_name: "Лумиа хотын аялал",
    category: "Аялал",
    duration_text: "",
  });
  const keys = keysFor([unknown]);
  const transport = tu.interpretUnderstanding(
    '{"place":"лумиа","intent":"trip","trips":["T1"],"certainty":"one","transport":"land"}',
    keys,
    NOW,
  )!;
  assert.equal(transport.unmet, null);
  assert.equal(transport.unknownRequirement, "transport");
  const duration = tu.interpretUnderstanding(
    '{"place":"лумиа","intent":"trip","trips":["T1"],"certainty":"one","days":[5,6]}',
    keys,
    NOW,
  )!;
  assert.equal(duration.unmet, null);
  assert.equal(duration.unknownRequirement, "days");
});

test("conflicting transport evidence is unknown rather than whichever detector ran first", () => {
  const conflicting = trip({
    id: "t-conflict",
    route_name: "Лумиа шууд нислэгтэй аялал",
    source_description: "Автобусаар газрын аялал",
  });
  const u = tu.interpretUnderstanding(
    '{"place":"лумиа","intent":"trip","trips":["T1"],"certainty":"one","transport":"direct_flight"}',
    keysFor([conflicting]),
    NOW,
  )!;
  assert.equal(u.unknownRequirement, "transport");
  assert.equal(u.unmet, null);
});

test("a span of dates keeps only the trip that leaves inside it", () => {
  const u = tu.interpretUnderstanding('{"place":"вэлмор","intent":"trip","trips":["T1","T2"],"certainty":"several","from":"2026-12-15","to":"2026-12-20"}', keysFor(CATALOG), NOW)!;
  assert.deepEqual(u.trips.map((t) => t.id), ["t-short"]);
});

test("naming two places only one trip has settles it even if the model listed more", () => {
  const u = tu.interpretUnderstanding('{"place":"вэлмор кардан","intent":"trip","trips":["T1","T2"],"certainty":"several"}', keysFor(CATALOG), NOW)!;
  assert.deepEqual(u.trips.map((t) => t.id), ["t-long"]);
  const shared = tu.interpretUnderstanding('{"place":"вэлмор","intent":"trip","trips":["T1","T2"],"certainty":"several"}', keysFor(CATALOG), NOW)!;
  assert.equal(shared.trips.length, 2, "one shared place word never narrows to an arbitrary trip");
});

test("no note above a trip list is ever swallowed by the no-data silence guard", async () => {
  const { shouldSilenceNoDataReply } = await import("../src/lib/reply");
  for (const u of [
    understood({ unmet: "days", days: [5, 6] }),
    understood({ unmet: "date", date: "2026-10-10" }),
    understood({ unmet: "range", range: ["2026-10-31", "2026-11-04"] }),
    understood({ unmet: "month", month: 4 }),
    understood({ unmet: "transport", transport: "land_flight" }),
  ]) {
    assert.equal(shouldSilenceNoDataReply(tu.unmetNote(u)!), false, tu.unmetNote(u));
  }
  assert.equal(shouldSilenceNoDataReply(tu.notInCatalogReply("Тармиз")), false);
});

test("asking about the trips just listed does not repeat the same which-trip question", async () => {
  await routeFastPathText({
    senderId: "u-same", text: "вэлмор", contextualUserText: "вэлмор", trips: CATALOG, history: [],
    understand: async () => understood({ trips: [LONG, SHORT], certainty: "several" }),
  });
  const route = await routeFastPathText({
    senderId: "u-same", text: "4 одтой юу", contextualUserText: "4 одтой юу", trips: CATALOG,
    history: [{ role: "assistant", text: "• a\n• b\n\nАль аяллыг нь сонирхож байна вэ?" }],
    understand: async () => understood({ trips: [LONG, SHORT], certainty: "several" }),
  });
  assert.equal(route.scopedClarify, null);
});

test("a destination we do not sell is said plainly — only when the keyword matcher agrees", async () => {
  const unknown = await routeFastPathText({
    senderId: "u-unknown", text: "Зорвин аялал бн уу", contextualUserText: "Зорвин аялал бн уу", trips: CATALOG, history: [],
    understand: async () => understood({ unknownDestination: "Зорвин" }),
  });
  assert.equal(unknown.notInCatalog, "Зорвин");
  const typo = await routeFastPathText({
    senderId: "u-typo", text: "Тармиз нуурын аялал", contextualUserText: "Тармиз нуурын аялал", trips: CATALOG, history: [],
    understand: async () => understood({ unknownDestination: "Тармиз" }),
  });
  assert.equal(typo.notInCatalog, undefined, "a real trip by that name is never denied");
});

test("one understood trip becomes the routed trip, by id", async () => {
  const route = await routeFastPathText({
    senderId: "u-one", text: "тэр хэд вэ", contextualUserText: "тэр хэд вэ", trips: CATALOG, history: [],
    understand: async () => understood({ trips: [SHORT], certainty: "one" }),
  });
  assert.equal(route.chosenTripId, "t-short");
  assert.match(route.matchText, /Вэлмор шууд нислэгтэй аялал/);
  assert.equal(route.scopedClarify, null);
});

test("no trip meant: downstream matchers cannot pull one in from a weak word", async () => {
  const route = await routeFastPathText({
    senderId: "u-none", text: "тармиз aylal", contextualUserText: "тармиз aylal", trips: CATALOG, history: [],
    understand: async () => understood({ intent: "smalltalk" }),
  });
  assert.equal(route.scopedClarify, null);
  assert.equal(resolveTripFromUserMessage(route.matchText, CATALOG).status, "not_found");
});

test("several trips that miss a requirement are informational alternatives, not a new choice question", async () => {
  const route = await routeFastPathText({
    senderId: "u-several", text: "вэлмор 5-6 хоног", contextualUserText: "вэлмор 5-6 хоног", trips: CATALOG, history: [],
    understand: async () => understood({ trips: [LONG, SHORT], certainty: "several", days: [5, 6], unmet: "days" }),
  });
  assert.deepEqual(route.scopedClarify?.map((t) => t.id), ["t-long", "t-short"]);
  assert.match(route.scopedClarifyNote || "", /5-6 өдрийн/);
  assert.equal(route.informationalAlternatives, true);
  assert.equal(await getClarificationState("u-several"), null);
});

test("one closest trip with an unmet requirement is an informational alternative, not a confirmed pick", async () => {
  const route = await routeFastPathText({
    senderId: "u-one-unmet", text: "вэлмор газрын аялал", contextualUserText: "вэлмор газрын аялал", trips: CATALOG, history: [],
    understand: async () => understood({ trips: [SHORT], certainty: "one", transport: "land", unmet: "transport" }),
  });
  assert.equal(route.chosenTripId, undefined);
  assert.equal(route.informationalAlternatives, true);
  assert.deepEqual(route.scopedClarify?.map((t) => t.id), ["t-short"]);
  assert.match(route.scopedClarifyNote || "", /Газрын аялал.*байхгүй/);
});

test("a catalog question with several trips is not turned into a which-trip question", async () => {
  const route = await routeFastPathText({
    senderId: "u-catalog", text: "12 сард аялал байна уу", contextualUserText: "12 сард аялал байна уу", trips: CATALOG, history: [],
    understand: async () => understood({ intent: "catalog", trips: [LONG, OTHER], certainty: "several", month: 12 }),
  });
  assert.equal(route.scopedClarify, null);
  assert.equal(resolveTripFromUserMessage(route.matchText, CATALOG).status, "not_found");
});

test("model unavailable: the keyword routing decides exactly as before", async () => {
  const route = await routeFastPathText({
    senderId: "u-null", text: "Тармиз нуурын аялал", contextualUserText: "Тармиз нуурын аялал", trips: CATALOG, history: [],
    understand: async () => null,
  });
  assert.equal(route.understanding, undefined);
  assert.equal(resolveTripFromUserMessage(route.matchText, CATALOG).status, "verified");
});

test("a numbered pick from the offered list stays deterministic — the model is not asked", async () => {
  await routeFastPathText({
    senderId: "u-num", text: "вэлмор", contextualUserText: "вэлмор", trips: CATALOG, history: [],
    understand: async () => understood({ trips: [LONG, SHORT], certainty: "several" }),
  });
  let asked = false;
  const route = await routeFastPathText({
    senderId: "u-num", text: "2", contextualUserText: "2", trips: CATALOG,
    history: [{ role: "assistant", text: "• a\n• b\n\nАль аяллыг нь сонирхож байна вэ?" }],
    understand: async () => { asked = true; return null; },
  });
  assert.equal(asked, false);
  assert.equal(route.chosenTripId, "t-short");
});

test("a place plus a month checks every trip at that place, not only the ones the model kept", () => {
  const u = tu.interpretUnderstanding('{"place":"вэлмор","intent":"trip","trips":["T2"],"certainty":"one","month":12}', keysFor(CATALOG), NOW, "вэлмор 12 сард аялал байна уу")!;
  assert.deepEqual(u.trips.map((t) => t.id).sort(), ["t-long", "t-short"]);
  assert.equal(u.certainty, "several");
});

test("a place plus a date lands on the trip at that place that departs then", () => {
  const u = tu.interpretUnderstanding('{"place":"вэлмор","intent":"trip","trips":["T2"],"certainty":"one","date":"2026-12-10"}', keysFor(CATALOG), NOW, "вэлмор 12/10-нд")!;
  assert.deepEqual(u.trips.map((t) => t.id), ["t-long"]);
  assert.equal(u.unmet, null);
});

test("a trip the customer named in full is never swapped for a sibling that fits the date", () => {
  const u = tu.interpretUnderstanding('{"place":"вэлмор","intent":"trip","trips":["T2"],"certainty":"one","date":"2026-12-10"}', keysFor(CATALOG), NOW, "Вэлмор шууд нислэгтэй аялал 12/10-нд гарах уу")!;
  assert.deepEqual(u.trips.map((t) => t.id), ["t-short"]);
  assert.equal(u.unmet, "date");
});
