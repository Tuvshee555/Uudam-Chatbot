import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCURACY_METRICS, accuracyDigest, evaluateChatbotAccuracy,
  type AccuracyCase, type AccuracyDataset, type AccuracyObservation, type AccuracyReplay,
} from "../src/lib/chatbotAccuracy";
import type { TravelTrip } from "../src/lib/travelTypes";
import type { FastPathRoute } from "../src/lib/fastPathRouting";
import type { TripSelection } from "../src/lib/tripRequest";
import type { UnderstandingHistory } from "../src/lib/tripUnderstanding";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AS_OF = "2026-10-02T04:00:00.000Z";

// A conservative source superset also fingerprints uncommitted parent changes.
// Read-only: neither Git nor the capture runner creates or rewrites files.
export function pipelineSourceDigest(): string {
  const files: string[] = [];
  function walk(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx|js|mjs|json)$/.test(entry.name)) files.push(path);
    }
  }
  walk(join(ROOT, "src", "lib"));
  files.push(join(ROOT, "scripts", "chatbot-accuracy.ts"), join(ROOT, "scripts", "chatbot-accuracy-pipeline.ts"), join(ROOT, "package-lock.json"));
  return accuracyDigest(files.sort().map((file) => ({ path: relative(ROOT, file).replaceAll("\\", "/"), digest: accuracyDigest(readFileSync(file, "utf8")) })));
}

export function inventedPipelineInputs() {
  const trip = (patch: Partial<TravelTrip>): TravelTrip => ({
    id: "invented", category: "Аялал", operator_name: "Invented Travel",
    route_name: "Invented trip", duration_text: "8 өдөр 7 шөнө",
    adult_price: 1_200_000, child_price: 900_000, infant_price: null,
    currency: "MNT", departure_dates: ["2026-12-17"], seats_total: null,
    seats_left: null, has_food: true, status: "active", notes: "", hotel: "",
    source_description: "", photo_urls: [], extra: {}, created_at: "", updated_at: "", ...patch,
  });
  const direct = trip({ id: "invented-direct", route_name: "Вэлмор шууд нислэгтэй аялал", extra: { transport_type: "direct_flight" } });
  const land = trip({ id: "invented-land", route_name: "Вэлмор Кардан газрын аялал", duration_text: "10 өдөр 9 шөнө", adult_price: 2_400_000, departure_dates: ["2026-12-18"], extra: { transport_type: "land" } });
  const hotel = trip({ id: "invented-hotel", route_name: "Нерит нуурын аялал", departure_dates: ["2026-12-20", "2026-12-21"], adult_price: 1_000_000, child_price: 500_000, extra: {
    price_groups: [
      { hotel: "Nerith House A", dates: ["2026-12-20"], adult_price: 2_000_000, child_price: 1_000_000 },
      { hotel: "Nerith House B", dates: ["2026-12-20"], adult_price: 3_000_000, child_price: 2_000_000 },
      { hotel: "Nerith House B", dates: ["2026-12-21"], adult_price: 3_500_000, child_price: 2_500_000 },
    ],
  } });
  const closed = trip({ id: "invented-closed", route_name: "Тармиз нуурын аялал", departure_dates: ["2026-12-22"], extra: {
    website_departure_availability: [{ date: "2026-12-22", status: "SOLD_OUT", seatsLeft: 0 }],
  } });
  const unknown = trip({ id: "invented-unknown", route_name: "Лумиа хотын аялал", departure_dates: ["2026-12-23"] });
  const catalog = [direct, land, hotel, closed, unknown];
  const na = Object.fromEntries(ACCURACY_METRICS.map((key) => [key, null]));
  const directChecks: AccuracyCase["checks"] = {
    ...na, wrong_trip: { allOf: [direct.route_name], noneOf: [land.route_name, hotel.route_name] },
    wrong_price: { allOf: ["1,200,000", "900,000"], noneOf: ["2,400,000", "3,000,000"] },
    needless_clarification: { action: "answer" }, unanswered: { action: "answer", allOf: ["1,200,000"] },
  };
  const hotelChecks: AccuracyCase["checks"] = {
    ...na, wrong_trip: { allOf: [hotel.route_name], noneOf: [direct.route_name] },
    wrong_price: { allOf: ["3,000,000", "2,000,000"], noneOf: ["3,500,000", "2,500,000", "500,000"] },
    ignored_constraint: { allOf: ["2026-12-20", "Nerith House B"], noneOf: ["Nerith House A", "2026-12-21"] },
    needless_clarification: { action: "answer" }, unanswered: { action: "answer", allOf: ["3,000,000"] },
  };
  const cases: AccuracyCase[] = [];
  const modelOutputs: Record<string, string> = {};
  function add(id: string, input: string, model: Record<string, unknown>, checks: AccuracyCase["checks"], kind: AccuracyCase["kind"] = "single_turn", groupId = id, conversationId = id, turn = 1) {
    cases.push({ id, input, groupId, conversationId, turn, kind, split: "dev", checks });
    modelOutputs[id] = JSON.stringify({ intent: "trip", ...model });
  }
  add("direct-multi-topic", "Вэлмор 2026-12-17 үнэ, хугацаа, нислэг?", { trips: ["T1"], date: "2026-12-17", topics: ["price", "duration", "transport"] }, {
    ...directChecks, ignored_constraint: { allOf: ["2026-12-17", "8 өдөр", "Шууд нислэгтэй"] },
    incorrect_availability: { allOf: ["Суудлын үлдэгдлийг"], noneOf: ["захиалга нээлттэй", "суудал үлдсэн"] },
  });
  add("duration-narrows-model-picks", "Вэлмор 8 хоногийн аяллын үнэ?", { trips: ["T1", "T2", "T99"], days: [8, 8], topics: ["price", "duration"] }, {
    ...directChecks, ignored_constraint: { allOf: ["8 өдөр"], noneOf: ["10 өдөр"] },
  });
  add("transport-narrows-model-picks", "Вэлмор шууд нислэгтэй аяллын үнэ?", { trips: ["T1", "T2"], transport: "direct_flight", topics: ["price", "transport"] }, {
    ...directChecks, ignored_constraint: { allOf: ["Шууд нислэгтэй"], noneOf: ["Газрын аялал"] },
  });
  const passengers = [{ kind: "adult", count: 2 }, { kind: "child", count: 1, age: 6 }];
  add("date-hotel-passenger-total", "Нерит 2026-12-20 Nerith House B, 2 том хүн 6 настай хүүхэд нийт хэд вэ?", { trips: ["T3"], date: "2026-12-20", hotel: "Nerith House B", passengers, topics: ["price", "hotel"] }, {
    ...hotelChecks, wrong_price: { ...hotelChecks.wrong_price!, allOf: ["3,000,000", "2,000,000", "8,000,000"] },
  });
  add("closed-departure", "Тармиз 2026-12-22 суудал, үнэ?", { trips: ["T4"], date: "2026-12-22", topics: ["price", "availability"] }, {
    ...na, wrong_trip: { allOf: [closed.route_name] },
    incorrect_availability: { allOf: ["2026-12-22", "суудал дүүрсэн"], noneOf: ["захиалга нээлттэй", "суудал үлдсэн"] },
    ignored_constraint: { allOf: ["2026-12-22"] }, needless_clarification: { action: "answer" },
    unanswered: { allOf: ["суудал дүүрсэн"], action: "answer" },
  });
  add("unknown-seats", "Лумиа 2026-12-23 суудал байгаа юу?", { trips: ["T5"], date: "2026-12-23", topics: ["availability"] }, {
    ...na, wrong_trip: { allOf: [unknown.route_name] },
    incorrect_availability: { allOf: ["Суудлын үлдэгдлийг"], noneOf: ["захиалга нээлттэй", "суудал үлдсэн"] },
    needless_clarification: { action: "answer" }, unanswered: { action: "answer", allOf: ["2026-12-23"] },
  });
  add("conversation-offer", "Нерит 2026-12-20 Nerith House B үнэ?", { trips: ["T3"], date: "2026-12-20", hotel: "Nerith House B", topics: ["price", "hotel"] }, hotelChecks, "conversation", "offer-followup", "offer-followup", 1);
  add("conversation-total", "2 том хүн, 6 настай нэг хүүхэд нийт хэд вэ?", { trips: ["T3"], topics: ["price"], passengers }, {
    ...hotelChecks, wrong_price: { ...hotelChecks.wrong_price!, allOf: ["3,000,000", "2,000,000", "8,000,000"] },
  }, "conversation", "offer-followup", "offer-followup", 2);
  add("fare-paraphrase-latin", "Velmor une hed ve?", { trips: ["T1"], topics: ["price"] }, directChecks, "paraphrase", "fare-variants");
  add("fare-paraphrase-cyrillic", "Вэлмор аялал хэдэн төгрөг вэ?", { trips: ["T1"], topics: ["price"] }, directChecks, "paraphrase", "fare-variants");
  const dataset: AccuracyDataset = { schemaVersion: 1, cases };
  return { dataset, catalog, modelOutputs, asOf: AS_OF };
}

export async function runInventedPipelineFixture(inputs = inventedPipelineInputs()) {
  const sourceDigest = pipelineSourceDigest();
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  // Import only the pure functions. No router, webhook, provider or DB module.
  const { buildTripAnswerPlan } = await import("../src/lib/tripAnswerPlan");
  const { buildUnderstandingPrompt, interpretUnderstanding } = await import("../src/lib/tripUnderstanding");
  const initialCatalogDigest = accuracyDigest(inputs.catalog);
  const now = new Date(inputs.asOf);
  const observations: AccuracyObservation[] = [];
  const histories = new Map<string, UnderstandingHistory>();
  const selections = new Map<string, TripSelection>();
  const traces = [];
  for (const c of inputs.dataset.cases) {
    const history = histories.get(c.conversationId) ?? [];
    const previous = selections.get(c.conversationId);
    const prompt = buildUnderstandingPrompt({ text: c.input, trips: inputs.catalog, now, history, selection: previous });
    const understanding = interpretUnderstanding(inputs.modelOutputs[c.id], prompt.keys, now);
    const route: FastPathRoute = {
      matchText: c.input, scopedClarify: null,
      chosenTripId: understanding?.certainty === "one" ? understanding.trips[0]?.id : undefined,
      understanding: understanding ?? undefined, selection: previous,
    };
    const plan = buildTripAnswerPlan({ text: c.input, trips: inputs.catalog, route, now });
    // A null plan is an actual unanswered result at this boundary, not an
    // excuse to fill in the expected answer or exclude the case from scoring.
    const observation: AccuracyObservation = {
      id: c.id, status: "ok", reply: plan?.reply ?? "",
      action: !plan?.reply ? "silent" : plan.status === "answered" ? "answer" : plan.status,
    };
    observations.push(observation);
    if (plan) selections.set(c.conversationId, plan.selection);
    histories.set(c.conversationId, [...history, { role: "user", text: c.input }, { role: "assistant", text: observation.reply }]);
    traces.push({ id: c.id, prompt: prompt.user, modelOutput: inputs.modelOutputs[c.id], interpretedTripIds: understanding?.trips.map((t) => t.id) ?? [], route, plan });
  }
  if (accuracyDigest(inputs.catalog) !== initialCatalogDigest) throw new Error("Pipeline mutated the invented catalog");
  if (pipelineSourceDigest() !== sourceDigest) throw new Error("Source changed during pipeline capture; rerun");
  const replay: AccuracyReplay = {
    schemaVersion: 1, datasetDigest: accuracyDigest(inputs.dataset), provenance: "invented_pipeline",
    capture: { revision, sourceDigest, asOf: inputs.asOf, catalogDigest: initialCatalogDigest, configurationDigest: accuracyDigest({ model: "injected JSON; no provider", modelOutputs: inputs.modelOutputs, pipeline: ["buildUnderstandingPrompt", "interpretUnderstanding", "buildTripAnswerPlan"] }) },
    observations,
  };
  return { dataset: inputs.dataset, replay, traces };
}

export function inventedPipelineCaseResults(fixture: Awaited<ReturnType<typeof runInventedPipelineFixture>>) {
  return fixture.dataset.cases.map((c) => {
    const observation = fixture.replay.observations.find((o) => o.id === c.id)!;
    const dataset = { ...fixture.dataset, cases: [c] };
    const report = evaluateChatbotAccuracy(dataset, { ...fixture.replay, datasetDigest: accuracyDigest(dataset), observations: [observation] });
    return { id: c.id, input: c.input, reply: observation.reply, action: observation.action, passed: report.passed === 1, errors: ACCURACY_METRICS.filter((key) => report.metrics[key].errors > 0) };
  });
}
