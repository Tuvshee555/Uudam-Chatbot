import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  ACCURACY_METRICS, accuracyDigest, evaluateChatbotAccuracy, inventedAccuracyFixture,
  parseAccuracyDataset, parseAccuracyLabels, parseAccuracyReplay,
  type AccuracyLabels,
} from "../src/lib/chatbotAccuracy";

function reviewFixture(): AccuracyLabels {
  const { dataset, replay } = inventedAccuracyFixture();
  return {
    schemaVersion: 1, datasetDigest: accuracyDigest(dataset), replayDigest: accuracyDigest(replay),
    reviewer: "invented-test-reviewer",
    verdicts: replay.observations.map((o) => ({
      id: o.id, errors: Object.fromEntries(ACCURACY_METRICS.map((key) => [key, key === "unanswered" ? false : null])) as AccuracyLabels["verdicts"][number]["errors"],
    })),
  };
}

test("invented smoke fixture reports each requested failure separately without n/a score inflation", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const report = evaluateChatbotAccuracy(dataset, replay);
  assert.equal(report.evidence, "invented_fixture");
  assert.equal(report.total, 9);
  assert.equal(report.scored, 8);
  assert.equal(report.passed, 2);
  assert.equal(report.qualityScore, 0.25);
  assert.equal(report.qualityCoverage, 8 / 9);
  assert.equal(report.providerFailures, 1);
  assert.equal(report.complete, false);
  for (const key of ACCURACY_METRICS.filter((key) => key !== "unanswered")) assert.equal(report.metrics[key].errors, 1, key);
  assert.deepEqual(report.metrics.wrong_price, { errors: 1, evaluated: 1, errorRate: 1, notApplicable: 7, unreviewed: 0 });
  assert.equal(report.metrics.unanswered.errors, 2);
  assert.equal(report.metrics.unanswered.evaluated, 3);
});

test("held-out, conversation and paraphrase reports preserve grouping and context turns", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const all = evaluateChatbotAccuracy(dataset, replay);
  assert.equal(all.bySplit.dev.total, 1);
  assert.equal(all.bySplit.held_out.total, 8);
  assert.equal(all.byKind.conversation.conversations.total, 1);
  assert.equal(all.byKind.conversation.conversations.passed, 0);
  assert.equal(all.byKind.paraphrase.groups.total, 1);
  assert.equal(all.byKind.paraphrase.groups.passed, 0);
  const heldOut = evaluateChatbotAccuracy(dataset, replay, undefined, { split: "held_out", kind: "paraphrase" });
  assert.equal(heldOut.total, 2);
  assert.equal(heldOut.qualityScore, 0.5);
  assert.equal(heldOut.complete, true);
});

test("provider outage is excluded while a healthy silent answer counts as unanswered", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const providerCase = dataset.cases.find((c) => c.id === "provider")!;
  const one = { ...dataset, cases: [providerCase] };
  const observation = replay.observations.find((o) => o.id === "provider")!;
  const oneReplay = { ...replay, datasetDigest: accuracyDigest(one), observations: [observation] };
  const failed = evaluateChatbotAccuracy(one, oneReplay);
  assert.equal(failed.scored, 0);
  assert.equal(failed.qualityScore, null);
  assert.equal(failed.providerFailureRate, 1);
  assert.equal(failed.metrics.unanswered.evaluated, 0);
  const healthy = evaluateChatbotAccuracy(one, { ...oneReplay, observations: [{ ...observation, status: "ok" }] });
  assert.equal(healthy.qualityScore, 0);
  assert.equal(healthy.metrics.unanswered.errors, 1);
});

test("missing, unreviewed, all-n/a and harness failures never become passes", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  replay.observations = replay.observations.filter((o) => o.id !== "trip");
  replay.observations.find((o) => o.id === "price")!.status = "harness_failure";
  dataset.cases.find((c) => c.id === "constraint")!.checks = { wrong_trip: { noneOf: ["nonexistent invented route"] } };
  dataset.cases.find((c) => c.id === "availability")!.checks = Object.fromEntries(ACCURACY_METRICS.map((key) => [key, null]));
  replay.datasetDigest = accuracyDigest(dataset);
  const report = evaluateChatbotAccuracy(dataset, replay);
  assert.equal(report.missing, 1);
  assert.equal(report.harnessFailures, 1);
  assert.equal(report.unreviewed, 2);
  assert.equal(report.integrityValid, false);
  assert.equal(report.metrics.ignored_constraint.unreviewed, 1);
  assert.equal(report.metrics.wrong_trip.evaluated, 2);
  assert.equal(report.scored, 4);
});

test("reviewed labels require exact dataset and replay digests and override limited text checks", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const labels = reviewFixture();
  const reviewed = evaluateChatbotAccuracy(dataset, replay, labels);
  assert.equal(reviewed.reviewMethod, "reviewed_labels");
  assert.equal(reviewed.qualityScore, 1);
  assert.equal(reviewed.metrics.unanswered.evaluated, 8);
  assert.equal(reviewed.metrics.wrong_price.errorRate, null);
  labels.verdicts[0].errors.wrong_trip = true;
  assert.equal(evaluateChatbotAccuracy(dataset, replay, labels).metrics.wrong_trip.errors, 1);
  replay.observations[0].reply = "Changed invented reply";
  assert.throws(() => evaluateChatbotAccuracy(dataset, replay, labels), /do not match/);
  dataset.cases[0].input = "Changed invented question";
  assert.throws(() => evaluateChatbotAccuracy(dataset, replay), /dataset digest mismatch/);
});

test("canonical hashes are stable across object key order", () => {
  assert.equal(accuracyDigest({ b: [1, 2], a: "x" }), accuracyDigest({ a: "x", b: [1, 2] }));
  assert.notEqual(accuracyDigest([1, 2]), accuracyDigest([2, 1]));
});

test("partial reviewed labels report mixed assessment instead of implying every turn was reviewed", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const labels = reviewFixture();
  labels.verdicts = [labels.verdicts[0]];
  const report = evaluateChatbotAccuracy(dataset, replay, labels);
  assert.equal(report.reviewMethod, "mixed");
  assert.equal(report.reviewedTurns, 1);
  assert.equal(report.explicitCheckTurns, 7);
});

test("captured replay records frozen execution metadata and rejects normalized invalid dates", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const capture = { revision: "a".repeat(40), asOf: "2027-01-01T00:00:00.000Z", catalogDigest: accuracyDigest({ invented: true }), configurationDigest: accuracyDigest({ model: "invented-provider" }) };
  const recorded = { ...replay, provenance: "captured_replay", capture };
  assert.deepEqual(evaluateChatbotAccuracy(dataset, recorded).capture, capture);
  assert.throws(() => parseAccuracyReplay({ ...recorded, capture: { ...capture, asOf: "2027-02-30T00:00:00.000Z" } }), /Invalid evaluation clock/);
  assert.throws(() => parseAccuracyReplay({ ...recorded, capture: { ...capture, revision: "main" } }), /full Git revision/);
});

test("split leakage, duplicate turns and invalid or unknown schema fields fail closed", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  const leaked = structuredClone(dataset);
  leaked.cases.find((c) => c.id === "paraphrase-2")!.split = "dev";
  assert.throws(() => parseAccuracyDataset(leaked), /held-out leakage/);
  const duplicate = structuredClone(dataset);
  duplicate.cases.find((c) => c.id === "context-2")!.turn = 1;
  assert.throws(() => parseAccuracyDataset(duplicate), /Duplicate conversation turn/);
  assert.throws(() => parseAccuracyDataset({ ...dataset, endpoint: "https://example.invalid" }), /Unknown schema field/);
  const emptyRule = structuredClone(dataset);
  emptyRule.cases[0].checks = { wrong_trip: {} };
  assert.throws(() => parseAccuracyDataset(emptyRule), /Empty accuracy check/);
  assert.throws(() => parseAccuracyReplay({ ...replay, observations: [...replay.observations, replay.observations[0]] }), /duplicate observation/);
  assert.throws(() => evaluateChatbotAccuracy(dataset, { ...replay, observations: [{ ...replay.observations[0], id: "unknown" }] }), /unknown case/);
  const labels = reviewFixture();
  delete (labels.verdicts[0].errors as Partial<typeof labels.verdicts[number]["errors"]>).wrong_price;
  assert.throws(() => parseAccuracyLabels(labels), /all six metrics/);
  assert.throws(() => parseAccuracyReplay({ ...replay, provenance: "captured_replay" }), /Expected JSON object/);
  assert.throws(() => parseAccuracyReplay({ ...replay, provenance: ["invented_fixture"] }), /Unknown replay provenance/);
  assert.throws(() => parseAccuracyDataset({ ...dataset, cases: [{ ...dataset.cases[0], split: ["dev"] }] }), /Unknown case split/);
});

test("text checks normalize case, spacing and Unicode without treating generic words as intent", () => {
  const { dataset, replay } = inventedAccuracyFixture();
  replay.observations.find((o) => o.id === "paraphrase-2")!.reply = "  1200000   mnt ";
  assert.equal(evaluateChatbotAccuracy(dataset, replay).byKind.paraphrase.passed, 1);
  replay.observations.find((o) => o.id === "context-2")!.reply = "Which trip? Its fare is 1200000 MNT.";
  const report = evaluateChatbotAccuracy(dataset, replay);
  assert.equal(report.metrics.needless_clarification.errors, 1);
  assert.equal(report.metrics.unanswered.errors, 1);
});

test("offline evaluator does not call fetch or import application DB and delivery code", () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("Network must not be used"); }) as typeof fetch;
  try {
    const { dataset, replay } = inventedAccuracyFixture();
    assert.equal(evaluateChatbotAccuracy(dataset, replay).total, 9);
  } finally { globalThis.fetch = original; }
  for (const file of ["src/lib/chatbotAccuracy.ts", "scripts/chatbot-accuracy.ts"]) {
    const source = readFileSync(resolve(file), "utf8");
    assert.doesNotMatch(source, /\b(?:fetch|Pool|Client|sendMessage|loadEnvFile)\s*\(/);
    assert.doesNotMatch(source, /from ["'][^"']*(?:webhook|neon|travelOps|messenger|observability|reply)["']/);
  }
});

const cli = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/chatbot-accuracy.ts", ...args], {
  cwd: resolve("."), encoding: "utf8", timeout: 30_000,
});

test("CLI produces deterministic aggregate reports and exits nonzero for incomplete coverage", () => {
  const first = cli(["--fixture"]), second = cli(["--fixture"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  assert.equal(cli(["--fixture", "--require-complete"]).status, 1);
  assert.equal(cli(["--fixture", "--require-pass"]).status, 1);
  assert.equal(cli(["--fixture", "--kind", "paraphrase", "--require-complete"]).status, 0);
  assert.equal(cli(["--endpoint", "https://example.invalid"]).status, 2);
  assert.equal(cli(["--fixture", "--dataset", "private.json"]).status, 2);
  assert.equal(cli(["--fixture", "--split", "unknown"]).status, 2);
});

test("runtime fixture evaluates actual pure interpreter and answer-plan outputs with no provider calls", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => { throw new Error("Provider and delivery calls must not run"); }) as typeof fetch;
  try {
    const { runInventedPipelineFixture, inventedPipelineInputs, inventedPipelineCaseResults } = await import("../scripts/chatbot-accuracy-pipeline");
    const fixture = await runInventedPipelineFixture();
    const report = evaluateChatbotAccuracy(fixture.dataset, fixture.replay);
    assert.equal(report.evidence, "invented_pipeline");
    assert.equal(report.total, 10);
    assert.equal(report.passed, 10);
    assert.equal(report.complete, true);
    assert.equal(report.providerFailures, 0);
    assert.equal(report.bySplit.held_out.total, 0, "developer-written cases are not claimed as held out");
    assert.ok(report.capture?.sourceDigest);
    assert.deepEqual(ACCURACY_METRICS.map((metric) => report.metrics[metric].evaluated), [10, 8, 7, 3, 10, 10]);
    assert.ok(inventedPipelineCaseResults(fixture).every((c) => c.passed));
    const { buildTripAnswerPlan } = await import("../src/lib/tripAnswerPlan");
    const inputs = inventedPipelineInputs();
    for (const trace of fixture.traces) {
      const c = inputs.dataset.cases.find((c) => c.id === trace.id)!;
      const plan = buildTripAnswerPlan({ text: c.input, trips: inputs.catalog, route: trace.route, now: new Date(inputs.asOf) });
      assert.equal(fixture.replay.observations.find((o) => o.id === trace.id)!.reply, plan?.reply ?? "", trace.id);
    }
  } finally { globalThis.fetch = original; }
});

test("runtime conversation uses the generated offer selection and assistant reply", async () => {
  const { runInventedPipelineFixture } = await import("../scripts/chatbot-accuracy-pipeline");
  const fixture = await runInventedPipelineFixture();
  const first = fixture.traces.find((t) => t.id === "conversation-offer")!;
  const followup = fixture.traces.find((t) => t.id === "conversation-total")!;
  assert.deepEqual(followup.route.selection, first.plan!.selection);
  assert.equal(followup.route.understanding!.date, null);
  assert.equal(followup.plan!.selection.date, "2026-12-20");
  assert.equal(followup.plan!.selection.hotel, "Nerith House B");
  assert.match(followup.plan!.reply, /8,000,000/);
  assert.ok(followup.prompt.includes(first.plan!.reply.replace(/\s+/g, " ").trim().slice(0, 350)));
  assert.deepEqual(fixture.traces.find((t) => t.id === "duration-narrows-model-picks")!.interpretedTripIds, ["invented-direct"]);
  assert.deepEqual(fixture.traces.find((t) => t.id === "transport-narrows-model-picks")!.interpretedTripIds, ["invented-direct"]);
});

test("an actual null answer plan is scored as unanswered, never replaced with an authored reply", async () => {
  const { runInventedPipelineFixture, inventedPipelineInputs } = await import("../scripts/chatbot-accuracy-pipeline");
  const inputs = inventedPipelineInputs();
  inputs.modelOutputs[inputs.dataset.cases[0].id] = '{"intent":"trip","trips":["T99"],"topics":["price"]}';
  const fixture = await runInventedPipelineFixture(inputs);
  assert.equal(fixture.traces[0].plan, null);
  assert.equal(fixture.replay.observations[0].reply, "");
  assert.equal(fixture.replay.observations[0].status, "ok");
  const report = evaluateChatbotAccuracy(fixture.dataset, fixture.replay);
  assert.equal(report.metrics.unanswered.errors, 1);
  assert.equal(report.scored, 10);
  assert.equal(report.passed, 9);
});

test("runtime CLI is reproducible, gates passing cases and exposes only its invented capture", () => {
  const first = cli(["--pipeline-fixture", "--require-pass"]), second = cli(["--pipeline-fixture", "--require-pass"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
  const report = JSON.parse(first.stdout);
  assert.equal(report.evidence, "invented_pipeline");
  assert.equal(report.caseResults.length, 10);
  assert.ok(report.caseResults.every((row: { passed: boolean }) => row.passed));
  assert.equal(cli(["--pipeline", "--fixture"]).status, 2);
  assert.equal(cli(["--pipeline", "--dataset", "private.json"]).status, 2);
  const exported = cli(["--pipeline-json"]);
  assert.equal(exported.status, 0, exported.stderr);
  const fixture = JSON.parse(exported.stdout);
  assert.equal(evaluateChatbotAccuracy(fixture.dataset, fixture.replay).passed, 10);
});

test("CLI accepts external reviewed replay JSON without echoing input text, identifiers or parse errors", () => {
  const directory = mkdtempSync(join(tmpdir(), "uudam-accuracy-test-"));
  try {
    const { dataset, replay } = inventedAccuracyFixture();
    const privateMarker = "INVENTED_PRIVATE_MARKER_ABC123";
    dataset.cases[0].input = privateMarker;
    dataset.cases[0].id = privateMarker;
    replay.observations[0].id = privateMarker;
    replay.datasetDigest = accuracyDigest(dataset);
    const labels = { ...reviewFixture(), datasetDigest: accuracyDigest(dataset), replayDigest: accuracyDigest(replay) };
    labels.verdicts[0].id = privateMarker;
    const datasetPath = join(directory, "dataset.json"), replayPath = join(directory, "replay.json"), labelsPath = join(directory, "labels.json");
    writeFileSync(datasetPath, JSON.stringify(dataset));
    writeFileSync(replayPath, JSON.stringify(replay));
    writeFileSync(labelsPath, JSON.stringify(labels));
    const result = cli(["--dataset", datasetPath, "--replay", replayPath, "--labels", labelsPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).reviewMethod, "reviewed_labels");
    assert.ok(!result.stdout.includes(privateMarker));
    assert.ok(!result.stderr.includes(privateMarker));
    writeFileSync(datasetPath, `{${privateMarker}`);
    const invalid = cli(["--dataset", datasetPath, "--replay", replayPath]);
    assert.equal(invalid.status, 2);
    assert.ok(!invalid.stderr.includes(privateMarker));
    assert.ok(!invalid.stderr.includes(directory));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
