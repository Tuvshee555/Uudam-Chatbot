import { createHash } from "node:crypto";

export const QUALITY_METRICS = ["length", "lines", "repeatedContent", "irrelevantContent", "unsolicitedMedia", "latency", "delivery"] as const;
export const HUMAN_METRICS = ["friendliness", "helpfulness"] as const;
export const REVIEWED_CHECKS = ["cost", "privacy", "taskCompletion", "context"] as const;
type Metric = typeof QUALITY_METRICS[number];
type HumanMetric = typeof HUMAN_METRICS[number];
type ReviewedCheck = typeof REVIEWED_CHECKS[number];
type Verdict = "pass" | "fail" | "unreviewed" | "not_applicable";
export type QualityDataset = {
  schemaVersion: 1;
  humanRequired: boolean;
  cases: Array<{ id: string; input: string; request: "simple" | "detailed" }>;
};
export type QualityReplay = {
  schemaVersion: 1;
  datasetDigest: string;
  provenance: "invented_fixture" | "captured_replay";
  observations: Array<{
    id: string;
    status: "ok" | "provider_failure" | "harness_failure";
    reply: string;
    latencyMs: number | null;
    unsolicitedMedia: number | null;
    delivery: "delivered" | "failed" | "unknown";
    annotations?: { repeatedContent?: boolean | null; irrelevantContent?: boolean | null };
  }>;
};
export type QualityLabels = {
  schemaVersion: 1;
  datasetDigest: string;
  replayDigest: string;
  reviewer: string;
  ratings: Array<{
    id: string; friendliness: number | null; helpfulness: number | null;
    reviewedErrors?: Partial<Record<ReviewedCheck, boolean | null>>;
  }>;
};

// Fixed policy is included in every report, so thresholds cannot change silently.
export const QUALITY_POLICY = {
  simple: { maxCharacters: 500, maxLines: 6 },
  detailed: { maxCharacters: 2000, maxLines: 24 },
  maxLatencyMs: 10000, maxUnsolicitedMedia: 0, minHumanRating: 4,
} as const;

export function qualityDigest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") {
      const row = item as Record<string, unknown>;
      return `{${Object.keys(row).sort().map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
    }
    const encoded = JSON.stringify(item);
    if (encoded === undefined) throw new Error("Expected JSON data");
    return encoded;
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
  const row = value as Record<string, unknown>;
  requireCondition(Object.keys(row).every((key) => allowed.includes(key)), "Unknown schema field");
  return row;
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function digest(value: unknown) {
  requireCondition(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Expected SHA-256 digest");
}
function rows(value: unknown): unknown[] {
  requireCondition(Array.isArray(value), "Expected rows");
  return value;
}
function identifier(row: Record<string, unknown>, ids: Set<string>) {
  requireCondition(nonempty(row.id) && !ids.has(row.id), "Missing or duplicate identifier");
  ids.add(row.id);
}
function measurement(value: unknown, integer = false) {
  requireCondition(value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value))), "Expected nonnegative measurement or null");
}
export function parseQualityDataset(value: unknown): QualityDataset {
  const data = object(value, ["schemaVersion", "humanRequired", "cases"]);
  requireCondition(data.schemaVersion === 1 && typeof data.humanRequired === "boolean", "Expected version 1 and explicit humanRequired");
  const cases = rows(data.cases), ids = new Set<string>();
  requireCondition(cases.length > 0, "Expected nonempty cases");
  for (const raw of cases) {
    const row = object(raw, ["id", "input", "request"]);
    identifier(row, ids);
    requireCondition(typeof row.input === "string" && (row.request === "simple" || row.request === "detailed"), "Expected input and request classification");
  }
  return value as QualityDataset;
}
export function parseQualityReplay(value: unknown): QualityReplay {
  const data = object(value, ["schemaVersion", "datasetDigest", "provenance", "observations"]);
  requireCondition(data.schemaVersion === 1 && (data.provenance === "invented_fixture" || data.provenance === "captured_replay"), "Expected version 1 and provenance");
  digest(data.datasetDigest);
  const ids = new Set<string>();
  for (const raw of rows(data.observations)) {
    const row = object(raw, ["id", "status", "reply", "latencyMs", "unsolicitedMedia", "delivery", "annotations"]);
    identifier(row, ids);
    requireCondition(typeof row.status === "string" && ["ok", "provider_failure", "harness_failure"].includes(row.status) && typeof row.reply === "string", "Expected status and reply");
    requireCondition(typeof row.delivery === "string" && ["delivered", "failed", "unknown"].includes(row.delivery), "Expected delivery status");
    measurement(row.latencyMs);
    measurement(row.unsolicitedMedia, true);
    if (row.annotations !== undefined) {
      const annotations = object(row.annotations, ["repeatedContent", "irrelevantContent"]);
      requireCondition(Object.values(annotations).every((v) => v === null || typeof v === "boolean"), "Expected boolean annotations or null");
    }
  }
  return value as QualityReplay;
}
export function parseQualityLabels(value: unknown): QualityLabels {
  const data = object(value, ["schemaVersion", "datasetDigest", "replayDigest", "reviewer", "ratings"]);
  requireCondition(data.schemaVersion === 1 && nonempty(data.reviewer), "Expected version 1 and explicit reviewer");
  digest(data.datasetDigest); digest(data.replayDigest);
  const ids = new Set<string>();
  for (const raw of rows(data.ratings)) {
    const row = object(raw, ["id", ...HUMAN_METRICS, "reviewedErrors"]);
    identifier(row, ids);
    requireCondition(HUMAN_METRICS.every((key) => row[key] === null || (Number.isInteger(row[key]) && Number(row[key]) >= 1 && Number(row[key]) <= 5)), "Expected explicit ratings 1 through 5 or null");
    if (row.reviewedErrors !== undefined) {
      const checks = object(row.reviewedErrors, REVIEWED_CHECKS);
      requireCondition(Object.values(checks).every((v) => v === null || typeof v === "boolean"), "Expected reviewed boolean errors or null");
    }
  }
  return value as QualityLabels;
}
const rate = (n: number, d: number) => d ? n / d : null;
function summarize(values: Verdict[]) {
  const count = (v: Verdict) => values.filter((value) => value === v).length;
  const errors = count("fail"), evaluated = errors + count("pass");
  return { errors, evaluated, errorRate: rate(errors, evaluated), unreviewed: count("unreviewed"), notApplicable: count("not_applicable") };
}

export function evaluateChatbotQuality(datasetValue: unknown, replayValue: unknown, labelsValue?: unknown) {
  const dataset = parseQualityDataset(datasetValue), replay = parseQualityReplay(replayValue);
  const datasetDigest = qualityDigest(dataset), replayDigest = qualityDigest(replay);
  requireCondition(replay.datasetDigest === datasetDigest, "Replay dataset digest mismatch");
  const labels = labelsValue === undefined ? undefined : parseQualityLabels(labelsValue);
  requireCondition(!labels || (labels.datasetDigest === datasetDigest && labels.replayDigest === replayDigest), "Review digest mismatch");
  const ids = new Set(dataset.cases.map((c) => c.id));
  requireCondition(replay.observations.every((o) => ids.has(o.id)), "Unknown observation identifier");
  const observations = new Map(replay.observations.map((o) => [o.id, o]));
  requireCondition(!labels || labels.ratings.every((r) => observations.get(r.id)?.status === "ok"), "Review requires a healthy observation");
  const reviews = new Map(labels?.ratings.map((r) => [r.id, r]));
  const scored = dataset.cases.map((c) => {
    const o = observations.get(c.id);
    const human = Object.fromEntries(HUMAN_METRICS.map((key) => {
      const rating = reviews.get(c.id)?.[key];
      return [key, rating == null ? "unreviewed" : rating >= QUALITY_POLICY.minHumanRating ? "pass" : "fail"];
    })) as Record<HumanMetric, Verdict>;
    if (!o || o.status !== "ok") return { state: o?.status ?? "missing", objective: null, human: null, checks: null };
    const budget = QUALITY_POLICY[c.request];
    const flag = (v: boolean | null | undefined): Verdict => v === undefined ? "unreviewed" : v === null ? "not_applicable" : v ? "fail" : "pass";
    const checks = Object.fromEntries(REVIEWED_CHECKS.map((key) => [key, flag(reviews.get(c.id)?.reviewedErrors?.[key])])) as Record<ReviewedCheck, Verdict>;
    const objective: Record<Metric, Verdict> = {
      length: Array.from(o.reply).length > budget.maxCharacters ? "fail" : "pass",
      lines: (o.reply === "" ? 0 : o.reply.split(/\r\n|\r|\n/).length) > budget.maxLines ? "fail" : "pass",
      repeatedContent: flag(o.annotations?.repeatedContent),
      irrelevantContent: flag(o.annotations?.irrelevantContent),
      unsolicitedMedia: o.unsolicitedMedia === null ? "unreviewed" : o.unsolicitedMedia > QUALITY_POLICY.maxUnsolicitedMedia ? "fail" : "pass",
      latency: o.latencyMs === null ? "unreviewed" : o.latencyMs > QUALITY_POLICY.maxLatencyMs ? "fail" : "pass",
      delivery: o.delivery === "unknown" ? "unreviewed" : o.delivery === "failed" ? "fail" : "pass",
    };
    const required = [...Object.values(objective), ...(dataset.humanRequired ? Object.values(human) : [])];
    return { state: o.delivery === "failed" ? "delivery_failure" : required.includes("unreviewed") ? "unreviewed" : "scored", objective, human, checks };
  });
  const eligible = scored.filter((r) => r.objective !== null && r.state !== "delivery_failure");
  const completed = eligible.filter((r) => r.state === "scored");
  const fails = (r: typeof scored[number]) => [...Object.values(r.objective ?? {}), ...Object.values(r.checks ?? {}), ...(dataset.humanRequired ? Object.values(r.human ?? {}) : [])].includes("fail");
  const passed = completed.filter((r) => !fails(r)).length;
  const count = (state: string) => scored.filter((r) => r.state === state).length;
  const metrics = Object.fromEntries(QUALITY_METRICS.map((key) => [key, summarize(
    (key === "delivery" ? scored.filter((r) => r.objective !== null) : eligible).map((r) => r.objective![key]),
  )]));
  const humanRatings = Object.fromEntries(HUMAN_METRICS.map((key) => [key, summarize(eligible.map((r) => r.human![key]))]));
  const reviewedChecks = Object.fromEntries(REVIEWED_CHECKS.map((key) => [key, summarize(eligible.map((r) => r.checks![key]))]));
  return {
    schemaVersion: 1, evaluatorVersion: "1.1.0", evidence: replay.provenance,
    datasetDigest, replayDigest, labelsDigest: labels ? qualityDigest(labels) : null,
    policy: QUALITY_POLICY, humanRequired: dataset.humanRequired,
    humanAssessment: labels ? "supplied_explicit_review" : "unreviewed",
    total: scored.length, scored: completed.length, passed, failed: completed.length - passed,
    observedFailures: scored.filter((r) => ["provider_failure", "harness_failure", "delivery_failure"].includes(r.state) || fails(r)).length,
    qualityScore: rate(passed, completed.length), qualityCoverage: rate(completed.length, scored.length),
    missing: count("missing"), unreviewed: count("unreviewed"),
    providerFailures: count("provider_failure"), harnessFailures: count("harness_failure"), deliveryFailures: count("delivery_failure"),
    integrityValid: count("harness_failure") === 0, complete: completed.length === scored.length,
    metrics, humanRatings, reviewedChecks,
  };
}

// Entirely invented saved outputs; this fixture does not run or benchmark the bot.
export function inventedQualityFixture(): { dataset: QualityDataset; replay: QualityReplay } {
  const dataset: QualityDataset = { schemaVersion: 1, humanRequired: true, cases: [
    { id: "simple", input: "What is the invented Velmor fare?", request: "simple" },
    { id: "detailed", input: "Describe an invented Velmor itinerary in detail.", request: "detailed" },
  ] };
  const replay: QualityReplay = { schemaVersion: 1, datasetDigest: qualityDigest(dataset), provenance: "invented_fixture", observations: [
    { id: "simple", status: "ok", reply: "The invented fare is 1200000 MNT.", latencyMs: 100, unsolicitedMedia: 0, delivery: "delivered", annotations: { repeatedContent: false, irrelevantContent: false } },
    { id: "detailed", status: "ok", reply: "Invented itinerary detail.\n".repeat(26), latencyMs: 11000, unsolicitedMedia: 3, delivery: "delivered", annotations: { repeatedContent: true, irrelevantContent: true } },
  ] };
  return { dataset, replay };
}
