import { createHash } from "node:crypto";

export const ACCURACY_METRICS = [
  "wrong_trip", "wrong_price", "ignored_constraint", "incorrect_availability",
  "needless_clarification", "unanswered",
] as const;
export type AccuracyMetric = typeof ACCURACY_METRICS[number];
export type AccuracySplit = "train" | "dev" | "held_out";
export type AccuracyKind = "single_turn" | "conversation" | "paraphrase";
export type AccuracyAction = "answer" | "clarify" | "handoff" | "silent";
export type AccuracyCheck = {
  allOf?: string[];
  anyOf?: string[];
  noneOf?: string[];
  action?: AccuracyAction;
};
export type AccuracyCase = {
  id: string;
  groupId: string;
  conversationId: string;
  turn: number;
  split: AccuracySplit;
  kind: AccuracyKind;
  input: string;
  checks?: Partial<Record<AccuracyMetric, AccuracyCheck | null>>;
};
export type AccuracyDataset = { schemaVersion: 1; cases: AccuracyCase[] };
export type AccuracyObservation = {
  id: string;
  status: "ok" | "provider_failure" | "harness_failure";
  reply: string;
  action: AccuracyAction;
};
export type AccuracyReplay = {
  schemaVersion: 1;
  datasetDigest: string;
  provenance: "invented_fixture" | "invented_pipeline" | "captured_replay";
  capture?: {
    revision: string;
    asOf: string;
    catalogDigest: string;
    configurationDigest: string;
    sourceDigest?: string;
  };
  observations: AccuracyObservation[];
};
export type AccuracyLabels = {
  schemaVersion: 1;
  datasetDigest: string;
  replayDigest: string;
  reviewer: string;
  verdicts: Array<{ id: string; errors: Record<AccuracyMetric, boolean | null> }>;
};
type Verdict = "pass" | "fail" | "not_applicable" | "unreviewed";
type ScoredCase = {
  case: AccuracyCase;
  state: "scored" | "unreviewed" | "missing" | "provider_failure" | "harness_failure";
  verdicts: Record<AccuracyMetric, Verdict>;
};

// Canonical JSON makes labels independent of object-key order, but binds every
// case, output, action and failure status to the exact reviewed artifacts.
export function accuracyDigest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
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
function object(value: unknown): Record<string, unknown> {
  requireCondition(value !== null && typeof value === "object" && !Array.isArray(value), "Expected JSON object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: string[]) {
  requireCondition(Object.keys(value).every((key) => allowed.includes(key)), "Unknown schema field");
}
function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
function member(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}
function digest(value: unknown) {
  requireCondition(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Expected SHA-256 digest");
}
const actions = ["answer", "clarify", "handoff", "silent"];

export function parseAccuracyDataset(value: unknown): AccuracyDataset {
  const data = object(value);
  fields(data, ["schemaVersion", "cases"]);
  requireCondition(data.schemaVersion === 1 && Array.isArray(data.cases) && data.cases.length > 0, "Expected schemaVersion 1 and nonempty cases");
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  const conversations = new Map<string, { split: string; groupId: string; turns: Set<number> }>();
  for (const raw of data.cases) {
    const c = object(raw);
    fields(c, ["id", "groupId", "conversationId", "turn", "split", "kind", "input", "checks"]);
    requireCondition(nonempty(c.id) && nonempty(c.groupId) && nonempty(c.conversationId), "Case identifiers must be nonempty strings");
    requireCondition(!ids.has(c.id), "Duplicate case identifier");
    ids.add(c.id);
    requireCondition(member(c.split, ["train", "dev", "held_out"]), "Unknown case split");
    requireCondition(member(c.kind, ["single_turn", "conversation", "paraphrase"]), "Unknown case kind");
    requireCondition(typeof c.input === "string" && Number.isInteger(c.turn) && Number(c.turn) >= 1, "Expected input text and positive integer turn");
    const split = c.split;
    requireCondition(!groups.has(c.groupId) || groups.get(c.groupId) === split, "Group crosses splits: held-out leakage");
    groups.set(c.groupId, split);
    const conversation = conversations.get(c.conversationId);
    requireCondition(!conversation || (conversation.split === split && conversation.groupId === c.groupId), "Conversation crosses split or group");
    requireCondition(!conversation?.turns.has(Number(c.turn)), "Duplicate conversation turn");
    const turns = conversation?.turns ?? new Set<number>();
    turns.add(Number(c.turn));
    conversations.set(c.conversationId, { split, groupId: c.groupId, turns });
    if (c.checks !== undefined) {
      const checks = object(c.checks);
      fields(checks, [...ACCURACY_METRICS]);
      for (const check of Object.values(checks)) {
        if (check === null) continue;
        const rule = object(check);
        fields(rule, ["allOf", "anyOf", "noneOf", "action"]);
        requireCondition(Object.keys(rule).length > 0, "Empty accuracy check");
        for (const key of ["allOf", "anyOf", "noneOf"]) {
          if (rule[key] !== undefined) requireCondition(Array.isArray(rule[key]) && rule[key].length > 0 && rule[key].every(nonempty), "Check markers must be nonempty string arrays");
        }
        if (rule.action !== undefined) requireCondition(member(rule.action, actions), "Unknown check action");
      }
    }
  }
  return value as AccuracyDataset;
}

export function parseAccuracyReplay(value: unknown): AccuracyReplay {
  const replay = object(value);
  fields(replay, ["schemaVersion", "datasetDigest", "provenance", "capture", "observations"]);
  requireCondition(replay.schemaVersion === 1 && Array.isArray(replay.observations), "Expected schemaVersion 1 and observations");
  digest(replay.datasetDigest);
  requireCondition(member(replay.provenance, ["invented_fixture", "invented_pipeline", "captured_replay"]), "Unknown replay provenance");
  if (replay.provenance !== "invented_fixture" || replay.capture !== undefined) {
    const capture = object(replay.capture);
    fields(capture, ["revision", "asOf", "catalogDigest", "configurationDigest", "sourceDigest"]);
    requireCondition(typeof capture.revision === "string" && /^[a-f0-9]{40}$/.test(capture.revision), "Capture requires a full Git revision");
    requireCondition(typeof capture.asOf === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(capture.asOf) && Number.isFinite(Date.parse(capture.asOf)), "Capture requires an ISO UTC evaluation clock");
    requireCondition(new Date(capture.asOf).toISOString() === capture.asOf, "Invalid evaluation clock date");
    digest(capture.catalogDigest);
    digest(capture.configurationDigest);
    if (capture.sourceDigest !== undefined || replay.provenance === "invented_pipeline") digest(capture.sourceDigest);
  }
  const ids = new Set<string>();
  for (const raw of replay.observations) {
    const row = object(raw);
    fields(row, ["id", "status", "reply", "action"]);
    requireCondition(nonempty(row.id) && !ids.has(row.id), "Missing or duplicate observation identifier");
    ids.add(row.id);
    requireCondition(member(row.status, ["ok", "provider_failure", "harness_failure"]), "Unknown observation status");
    requireCondition(typeof row.reply === "string" && member(row.action, actions), "Expected reply text and action");
    if (row.status === "ok") requireCondition((row.action === "silent") === !row.reply.trim(), "Silent action must match empty reply");
  }
  return value as AccuracyReplay;
}

export function parseAccuracyLabels(value: unknown): AccuracyLabels {
  const labels = object(value);
  fields(labels, ["schemaVersion", "datasetDigest", "replayDigest", "reviewer", "verdicts"]);
  requireCondition(labels.schemaVersion === 1 && Array.isArray(labels.verdicts) && nonempty(labels.reviewer), "Expected schemaVersion 1, reviewer and verdicts");
  digest(labels.datasetDigest);
  digest(labels.replayDigest);
  const ids = new Set<string>();
  for (const raw of labels.verdicts) {
    const row = object(raw);
    fields(row, ["id", "errors"]);
    requireCondition(nonempty(row.id) && !ids.has(row.id), "Missing or duplicate review identifier");
    ids.add(row.id);
    const errors = object(row.errors);
    fields(errors, [...ACCURACY_METRICS]);
    requireCondition(ACCURACY_METRICS.every((key) => typeof errors[key] === "boolean" || errors[key] === null), "Review must label all six metrics with boolean or null");
  }
  return value as AccuracyLabels;
}

function matches(rule: AccuracyCheck, observation: AccuracyObservation): boolean {
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
  const reply = normalize(observation.reply);
  const has = (marker: string) => reply.includes(normalize(marker));
  return (!rule.allOf || rule.allOf.every(has)) &&
    (!rule.anyOf || rule.anyOf.some(has)) &&
    (!rule.noneOf || !rule.noneOf.some(has)) &&
    (!rule.action || observation.action === rule.action);
}
function rate(numerator: number, denominator: number): number | null {
  return denominator ? numerator / denominator : null;
}
function summarize(rows: ScoredCase[]) {
  const scored = rows.filter((row) => row.state === "scored");
  const passed = scored.filter((row) => !Object.values(row.verdicts).includes("fail")).length;
  const metrics = Object.fromEntries(ACCURACY_METRICS.map((key) => {
    const count = (verdict: Verdict) => rows.filter((row) => row.verdicts[key] === verdict && ["scored", "unreviewed"].includes(row.state)).length;
    const errors = count("fail"), evaluated = errors + count("pass");
    return [key, { errors, evaluated, errorRate: rate(errors, evaluated), notApplicable: count("not_applicable"), unreviewed: count("unreviewed") }];
  })) as Record<AccuracyMetric, { errors: number; evaluated: number; errorRate: number | null; notApplicable: number; unreviewed: number }>;
  const conversations = [...new Set(rows.map((row) => row.case.conversationId))].map((id) => rows.filter((row) => row.case.conversationId === id));
  const completeConversations = conversations.filter((turns) => turns.every((turn) => turn.state === "scored"));
  const passedConversations = completeConversations.filter((turns) => turns.every((turn) => !Object.values(turn.verdicts).includes("fail"))).length;
  const groups = [...new Set(rows.map((row) => row.case.groupId))].map((id) => rows.filter((row) => row.case.groupId === id));
  const completeGroups = groups.filter((cases) => cases.every((c) => c.state === "scored"));
  const passedGroups = completeGroups.filter((cases) => cases.every((c) => !Object.values(c.verdicts).includes("fail"))).length;
  const stateCount = (state: ScoredCase["state"]) => rows.filter((row) => row.state === state).length;
  const providerFailures = stateCount("provider_failure");
  return {
    total: rows.length, scored: scored.length, passed, failed: scored.length - passed,
    qualityScore: rate(passed, scored.length), qualityCoverage: rate(scored.length, rows.length),
    missing: stateCount("missing"), unreviewed: stateCount("unreviewed"),
    providerFailures, providerFailureRate: rate(providerFailures, rows.length - stateCount("missing")),
    harnessFailures: stateCount("harness_failure"), metrics,
    conversations: { total: conversations.length, scored: completeConversations.length, passed: passedConversations, qualityScore: rate(passedConversations, completeConversations.length) },
    groups: { total: groups.length, scored: completeGroups.length, passed: passedGroups, qualityScore: rate(passedGroups, completeGroups.length) },
  };
}

export function evaluateChatbotAccuracy(
  datasetValue: unknown, replayValue: unknown, labelsValue?: unknown,
  options: { split?: AccuracySplit; kind?: AccuracyKind } = {},
) {
  const dataset = parseAccuracyDataset(datasetValue);
  const replay = parseAccuracyReplay(replayValue);
  const datasetDigest = accuracyDigest(dataset), replayDigest = accuracyDigest(replay);
  requireCondition(replay.datasetDigest === datasetDigest, "Replay dataset digest mismatch");
  const labels = labelsValue === undefined ? undefined : parseAccuracyLabels(labelsValue);
  if (labels) requireCondition(labels.datasetDigest === datasetDigest && labels.replayDigest === replayDigest, "Reviewed labels do not match this dataset and replay");
  const ids = new Set(dataset.cases.map((c) => c.id));
  requireCondition(replay.observations.every((o) => ids.has(o.id)), "Replay contains unknown case identifiers");
  const observations = new Map(replay.observations.map((o) => [o.id, o]));
  requireCondition(!labels || labels.verdicts.every((v) => observations.has(v.id)), "Review contains unknown or missing observations");
  const reviews = new Map(labels?.verdicts.map((v) => [v.id, v.errors]));
  const selected = dataset.cases.filter((c) => (!options.split || c.split === options.split) && (!options.kind || c.kind === options.kind));
  requireCondition(selected.length > 0, "Selection contains no cases");
  const rows: ScoredCase[] = selected.map((c) => {
    const observation = observations.get(c.id);
    const verdicts = Object.fromEntries(ACCURACY_METRICS.map((key) => [key, "unreviewed"])) as Record<AccuracyMetric, Verdict>;
    if (!observation) return { case: c, state: "missing", verdicts };
    if (observation.status !== "ok") return { case: c, state: observation.status, verdicts };
    const review = reviews.get(c.id);
    for (const key of ACCURACY_METRICS) {
      if (review) verdicts[key] = review[key] === null ? "not_applicable" : review[key] ? "fail" : "pass";
      else if (c.checks?.[key] === null) verdicts[key] = "not_applicable";
      else if (c.checks?.[key]) verdicts[key] = matches(c.checks[key], observation) ? "pass" : "fail";
    }
    const complete = !Object.values(verdicts).includes("unreviewed") && Object.values(verdicts).some((v) => v === "pass" || v === "fail");
    return { case: c, state: complete ? "scored" : "unreviewed", verdicts };
  });
  const summary = summarize(rows);
  const eligible = rows.filter((row) => row.state === "scored" || row.state === "unreviewed");
  const reviewedTurns = eligible.filter((row) => reviews.has(row.case.id)).length;
  const explicitCheckTurns = eligible.length - reviewedTurns;
  return {
    schemaVersion: 1, evaluatorVersion: "1.1.0", evidence: replay.provenance,
    datasetDigest, replayDigest, labelsDigest: labels ? accuracyDigest(labels) : null,
    capture: replay.capture ?? null,
    reviewMethod: reviewedTurns ? explicitCheckTurns ? "mixed" : "reviewed_labels" : "explicit_checks",
    reviewedTurns, explicitCheckTurns,
    integrityValid: summary.harnessFailures === 0,
    complete: summary.scored === summary.total,
    ...summary,
    bySplit: Object.fromEntries(["train", "dev", "held_out"].map((split) => [split, summarize(rows.filter((row) => row.case.split === split))])),
    byKind: Object.fromEntries(["single_turn", "conversation", "paraphrase"].map((kind) => [kind, summarize(rows.filter((row) => row.case.kind === kind))])),
  };
}

// These are invented outputs for testing the evaluator, never a bot benchmark.
export function inventedAccuracyFixture(): { dataset: AccuracyDataset; replay: AccuracyReplay } {
  const notApplicable = Object.fromEntries(ACCURACY_METRICS.map((key) => [key, null])) as Record<AccuracyMetric, null>;
  const cases: AccuracyCase[] = [
    { id: "trip", groupId: "trip", conversationId: "trip", turn: 1, split: "dev", kind: "single_turn", input: "Tell me about Velmor Lake.", checks: { ...notApplicable, wrong_trip: { allOf: ["Velmor Lake"], noneOf: ["Nerith Ridge"] } } },
    { id: "price", groupId: "price", conversationId: "price", turn: 1, split: "held_out", kind: "single_turn", input: "Velmor costs 1200000 MNT; what is the adult fare?", checks: { ...notApplicable, wrong_price: { allOf: ["1200000 MNT"], noneOf: ["990000 MNT"] } } },
    { id: "constraint", groupId: "constraint", conversationId: "constraint", turn: 1, split: "held_out", kind: "single_turn", input: "Only show nonstop trips below 1500000 MNT.", checks: { ...notApplicable, ignored_constraint: { allOf: ["nonstop"], noneOf: ["two stops", "1800000 MNT"] } } },
    { id: "availability", groupId: "availability", conversationId: "availability", turn: 1, split: "held_out", kind: "single_turn", input: "Nerith is sold out on 2027-02-03. Can I book it?", checks: { ...notApplicable, incorrect_availability: { allOf: ["sold out"], noneOf: ["seats available"] } } },
    { id: "context-1", groupId: "context", conversationId: "context", turn: 1, split: "held_out", kind: "conversation", input: "I choose Velmor Lake.", checks: { ...notApplicable, wrong_trip: { allOf: ["Velmor Lake"] } } },
    { id: "context-2", groupId: "context", conversationId: "context", turn: 2, split: "held_out", kind: "conversation", input: "What does that trip cost?", checks: { ...notApplicable, needless_clarification: { action: "answer" }, unanswered: { allOf: ["1200000 MNT"] } } },
    { id: "paraphrase-1", groupId: "fare-variants", conversationId: "variant-1", turn: 1, split: "held_out", kind: "paraphrase", input: "How much is the Velmor adult ticket?", checks: { ...notApplicable, unanswered: { action: "answer", allOf: ["1200000 MNT"] } } },
    { id: "paraphrase-2", groupId: "fare-variants", conversationId: "variant-2", turn: 1, split: "held_out", kind: "paraphrase", input: "Quote one adult fare to Velmor.", checks: { ...notApplicable, unanswered: { action: "answer", allOf: ["1200000 MNT"] } } },
    { id: "provider", groupId: "provider", conversationId: "provider", turn: 1, split: "held_out", kind: "single_turn", input: "Provider-outage test.", checks: { ...notApplicable, unanswered: { action: "answer" } } },
  ];
  const replies: Array<[string, AccuracyAction, string]> = [
    ["trip", "answer", "Nerith Ridge"], ["price", "answer", "990000 MNT"],
    ["constraint", "answer", "Two stops, 1800000 MNT"], ["availability", "answer", "Seats available"],
    ["context-1", "answer", "Velmor Lake selected"], ["context-2", "clarify", "Which trip?"],
    ["paraphrase-1", "silent", ""], ["paraphrase-2", "answer", "1200000 MNT"],
    ["provider", "silent", ""],
  ];
  const dataset: AccuracyDataset = { schemaVersion: 1, cases };
  return { dataset, replay: { schemaVersion: 1, datasetDigest: accuracyDigest(dataset), provenance: "invented_fixture", observations: replies.map(([id, action, reply]) => ({ id, action, reply, status: id === "provider" ? "provider_failure" : "ok" })) } };
}
