import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  evaluateChatbotQuality, inventedQualityFixture, parseQualityDataset,
  parseQualityLabels, parseQualityReplay, qualityDigest, type QualityLabels,
} from "../src/lib/chatbotQuality";

function passingFixture(humanRequired = true) {
  const { dataset, replay } = inventedQualityFixture();
  dataset.cases = dataset.cases.slice(0, 1);
  dataset.humanRequired = humanRequired;
  replay.observations = replay.observations.slice(0, 1);
  replay.datasetDigest = qualityDigest(dataset);
  return { dataset, replay };
}
function review(fixture: ReturnType<typeof passingFixture>): QualityLabels {
  return { schemaVersion: 1, datasetDigest: qualityDigest(fixture.dataset), replayDigest: qualityDigest(fixture.replay),
    reviewer: "invented-human-reviewer", ratings: fixture.replay.observations.filter((o) => o.status === "ok").map((o) => ({ id: o.id, friendliness: 4, helpfulness: 5 })) };
}
function cli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/chatbot-quality.ts", ...args], { cwd: resolve("."), encoding: "utf8" });
}

test("invented failures remain visible without claiming human quality", () => {
  const f = inventedQualityFixture(), report = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(report.evidence, "invented_fixture");
  assert.equal(report.scored, 0);
  assert.equal(report.qualityScore, null);
  assert.equal(report.unreviewed, 2);
  assert.equal(report.observedFailures, 1);
  assert.equal(report.humanAssessment, "unreviewed");
  for (const metric of ["lines", "repeatedContent", "irrelevantContent", "unsolicitedMedia", "latency"]) {
    assert.equal(report.metrics[metric].errors, 1, metric);
  }
  assert.deepEqual(report.humanRatings.friendliness, { errors: 0, evaluated: 0, errorRate: null, unreviewed: 2, notApplicable: 0 });
});

test("explicit human ratings gate passes and null never earns credit", () => {
  const f = passingFixture(), labels = review(f);
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).complete, false);
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay, labels).passed, 1);
  labels.ratings[0].helpfulness = 3;
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay, labels).failed, 1);
  labels.ratings[0].helpfulness = null;
  const report = evaluateChatbotQuality(f.dataset, f.replay, labels);
  assert.equal(report.complete, false);
  assert.equal(report.humanRatings.helpfulness.evaluated, 0);
  f.dataset.humanRequired = false;
  f.replay.datasetDigest = qualityDigest(f.dataset);
  const objectiveOnly = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(objectiveOnly.passed, 1);
  assert.equal(objectiveOnly.humanAssessment, "unreviewed");
  assert.equal(objectiveOnly.humanRatings.friendliness.evaluated, 0);
});

test("simple versus detailed budgets count code points and physical lines at inclusive thresholds", () => {
  const f = passingFixture(false), o = f.replay.observations[0];
  o.reply = "\u{1F600}".repeat(500);
  o.latencyMs = 10000; o.unsolicitedMedia = 0;
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).passed, 1);
  o.reply += "x";
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).metrics.length.errors, 1);
  f.dataset.cases[0].request = "detailed";
  f.replay.datasetDigest = qualityDigest(f.dataset);
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).passed, 1);
  o.reply = "x".repeat(2001);
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).metrics.length.errors, 1);
  o.reply = Array(24).fill("x").join("\r\n");
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).passed, 1);
  o.reply += "\rx";
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).metrics.lines.errors, 1);
  f.dataset.cases[0].request = "simple"; f.replay.datasetDigest = qualityDigest(f.dataset);
  o.reply = Array(6).fill("x").join("\n");
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).passed, 1);
  o.reply += "\n";
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).metrics.lines.errors, 1);
});

test("absent annotation and unknown telemetry are unreviewed; explicit n/a does not inflate rates", () => {
  const f = passingFixture(false), o = f.replay.observations[0];
  delete o.annotations;
  o.latencyMs = null; o.unsolicitedMedia = null; o.delivery = "unknown";
  let report = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(report.complete, false);
  for (const key of ["repeatedContent", "irrelevantContent", "latency", "unsolicitedMedia", "delivery"]) {
    assert.equal(report.metrics[key].unreviewed, 1);
    assert.equal(report.metrics[key].errorRate, null);
  }
  o.annotations = { repeatedContent: null, irrelevantContent: null };
  o.latencyMs = 0; o.unsolicitedMedia = 0; o.delivery = "delivered";
  report = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(report.complete, true);
  assert.equal(report.metrics.repeatedContent.evaluated, 0);
  assert.equal(report.metrics.repeatedContent.notApplicable, 1);
});

test("missing, provider, harness and delivery failures never enter quality denominator", () => {
  const f = passingFixture(false), base = f.replay.observations[0];
  f.dataset.cases = ["good", "missing", "provider", "harness", "delivery"].map((id) => ({ ...f.dataset.cases[0], id }));
  f.replay.datasetDigest = qualityDigest(f.dataset);
  f.replay.observations = [
    { ...base, id: "good" },
    { ...base, id: "provider", status: "provider_failure" },
    { ...base, id: "harness", status: "harness_failure" },
    { ...base, id: "delivery", delivery: "failed", reply: "x".repeat(501) },
  ];
  const report = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(report.scored, 1); assert.equal(report.passed, 1);
  assert.equal(report.qualityCoverage, 1 / 5);
  for (const key of ["missing", "providerFailures", "harnessFailures", "deliveryFailures"] as const) assert.equal(report[key], 1);
  assert.equal(report.metrics.length.evaluated, 1);
  assert.equal(report.metrics.delivery.errors, 1);
  assert.equal(report.observedFailures, 3);
  assert.equal(report.integrityValid, false); assert.equal(report.complete, false);
});

test("any unsolicited media fails, while explicitly requested/expected media contributes zero", () => {
  const f = passingFixture(false);
  f.replay.observations[0].unsolicitedMedia = 1;
  let report = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(report.policy.maxUnsolicitedMedia, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.metrics.unsolicitedMedia.errors, 1);
  // A capture classifies requested/expected campaign media before scoring.
  f.replay.observations[0].unsolicitedMedia = 0;
  report = evaluateChatbotQuality(f.dataset, f.replay);
  assert.equal(report.passed, 1);
});

test("optional dimensions never infer reviews, and supplied errors gate even objective-only scoring", () => {
  const f = passingFixture(false), labels = review(f);
  const dimensions = ["cost", "privacy", "taskCompletion", "context"] as const;
  let report = evaluateChatbotQuality(f.dataset, f.replay, labels);
  assert.equal(report.passed, 1);
  for (const key of dimensions) assert.deepEqual(report.reviewedChecks[key], { errors: 0, evaluated: 0, errorRate: null, unreviewed: 1, notApplicable: 0 });
  for (const key of dimensions) {
    labels.ratings[0].reviewedErrors = { [key]: true };
    report = evaluateChatbotQuality(f.dataset, f.replay, labels);
    assert.equal(report.failed, 1); assert.equal(report.observedFailures, 1);
    assert.equal(report.reviewedChecks[key].errors, 1);
    labels.ratings[0].reviewedErrors = { [key]: false };
    assert.equal(evaluateChatbotQuality(f.dataset, f.replay, labels).passed, 1);
    labels.ratings[0].reviewedErrors = { [key]: null };
    report = evaluateChatbotQuality(f.dataset, f.replay, labels);
    assert.equal(report.passed, 1);
    assert.equal(report.reviewedChecks[key].evaluated, 0);
    assert.equal(report.reviewedChecks[key].notApplicable, 1);
  }
  for (const reviewedErrors of [{ cost: 1 }, { privacy: "false" }, { other: false }]) {
    assert.throws(() => parseQualityLabels({ ...labels, ratings: [{ ...labels.ratings[0], reviewedErrors }] }));
  }
  f.dataset.humanRequired = true; f.replay.datasetDigest = qualityDigest(f.dataset);
  const requiredReview = review(f);
  requiredReview.ratings[0].friendliness = null;
  requiredReview.ratings[0].helpfulness = null;
  requiredReview.ratings[0].reviewedErrors = { cost: false, privacy: false, taskCompletion: false, context: false };
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay, requiredReview).complete, false);
});

test("CLI require-pass rejects operational and optional review failures despite passing reviews", () => {
  const directory = mkdtempSync(join(tmpdir(), "uudam-quality-gate-"));
  try {
    const paths = ["dataset", "replay", "labels"].map((name) => join(directory, `${name}.json`));
    const args = ["--dataset", paths[0], "--replay", paths[1], "--labels", paths[2], "--require-pass"];
    for (const failure of ["delivery", "provider", "harness", "privacy"] as const) {
      const f = passingFixture(), base = f.replay.observations[0];
      f.dataset.cases.push({ ...f.dataset.cases[0], id: "failure" });
      f.replay.datasetDigest = qualityDigest(f.dataset);
      f.replay.observations.push({ ...base, id: "failure",
        status: failure === "provider" ? "provider_failure" : failure === "harness" ? "harness_failure" : "ok",
        delivery: failure === "delivery" ? "failed" : "delivered" });
      const labels = review(f);
      if (failure === "privacy") labels.ratings[1].reviewedErrors = { privacy: true };
      [f.dataset, f.replay, labels].forEach((value, i) => writeFileSync(paths[i], JSON.stringify(value)));
      const result = cli(args);
      assert.equal(result.status, 1, `${failure}: ${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.observedFailures, 1);
      assert.equal(report.passed, 1);
      assert.equal(report.complete, failure === "privacy");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("digests bind all private inputs, observations, telemetry and annotations", () => {
  assert.equal(qualityDigest({ b: 2, a: 1 }), qualityDigest({ a: 1, b: 2 }));
  const f = passingFixture(), labels = review(f);
  f.dataset.cases[0].input += "changed";
  assert.throws(() => evaluateChatbotQuality(f.dataset, f.replay, labels), /digest mismatch/);
  f.replay.datasetDigest = qualityDigest(f.dataset);
  assert.throws(() => evaluateChatbotQuality(f.dataset, f.replay, labels), /digest mismatch/);
  for (const change of [
    (o: typeof f.replay.observations[number]) => { o.reply += "changed"; },
    (o: typeof f.replay.observations[number]) => { o.latencyMs = 2; },
    (o: typeof f.replay.observations[number]) => { o.annotations!.irrelevantContent = true; },
  ]) {
    const current = review(f); change(f.replay.observations[0]);
    assert.throws(() => evaluateChatbotQuality(f.dataset, f.replay, current), /Review digest mismatch/);
  }
});

test("strict schemas reject duplicates, unknown ids, malformed ratings and measurements", () => {
  const f = passingFixture(), labels = review(f);
  assert.throws(() => parseQualityDataset({ ...f.dataset, humanRequired: undefined }));
  assert.throws(() => parseQualityDataset({ ...f.dataset, cases: [] }));
  assert.throws(() => parseQualityDataset({ ...f.dataset, cases: [f.dataset.cases[0], f.dataset.cases[0]] }));
  assert.throws(() => parseQualityReplay({ ...f.replay, secret: "invented" }));
  for (const latencyMs of [-1, Infinity, undefined, "1"]) assert.throws(() => parseQualityReplay({ ...f.replay, observations: [{ ...f.replay.observations[0], latencyMs }] }));
  assert.throws(() => parseQualityReplay({ ...f.replay, observations: [{ ...f.replay.observations[0], unsolicitedMedia: 1.5 }] }));
  assert.throws(() => parseQualityReplay({ ...f.replay, observations: [{ ...f.replay.observations[0], status: ["ok"] }] }));
  for (const friendliness of [0, 6, 3.5, undefined, "5"]) assert.throws(() => parseQualityLabels({ ...labels, ratings: [{ ...labels.ratings[0], friendliness }] }));
  assert.throws(() => evaluateChatbotQuality(f.dataset, { ...f.replay, observations: [{ ...f.replay.observations[0], id: "unknown" }] }));
  labels.ratings[0].id = "unknown";
  assert.throws(() => evaluateChatbotQuality(f.dataset, f.replay, labels));
});

test("CLI stays deterministic, gates review and rejects mixed or duplicate options", () => {
  const first = cli(["--fixture"]), second = cli(["--fixture"]);
  assert.equal(first.status, 0, first.stderr); assert.equal(first.stdout, second.stdout);
  assert.equal(cli(["--fixture", "--require-pass"]).status, 1);
  assert.equal(cli(["--fixture", "--require-complete"]).status, 1);
  for (const args of [["--fixture", "--dataset", "private.json"], ["--fixture", "--fixture"], ["--fixture-json", "--require-pass"], ["--wat"], ["--dataset"]]) assert.equal(cli(args).status, 2);
  const exported = cli(["--fixture-json"]);
  assert.equal(exported.status, 0);
  const f = JSON.parse(exported.stdout);
  assert.equal(evaluateChatbotQuality(f.dataset, f.replay).evidence, "invented_fixture");
});

test("CLI private reports and errors contain no text, identifiers, reviewer or paths", () => {
  const directory = mkdtempSync(join(tmpdir(), "uudam-quality-test-"));
  try {
    const f = passingFixture(), marker = "INVENTED_PRIVATE_QUALITY_MARKER";
    f.dataset.cases[0].input = marker; f.dataset.cases[0].id = marker;
    f.replay.observations[0].id = marker; f.replay.observations[0].reply = marker;
    f.replay.provenance = "captured_replay";
    f.replay.datasetDigest = qualityDigest(f.dataset);
    const labels = review(f); labels.reviewer = marker;
    const paths = ["dataset", "replay", "labels"].map((name) => join(directory, `${name}.json`));
    [f.dataset, f.replay, labels].forEach((value, i) => writeFileSync(paths[i], JSON.stringify(value)));
    const args = ["--dataset", paths[0], "--replay", paths[1]];
    assert.equal(cli([...args, "--require-pass"]).status, 1);
    const result = cli([...args, "--labels", paths[2], "--require-pass"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, 1);
    assert.ok(!result.stdout.includes(marker)); assert.ok(!result.stdout.includes(directory));
    writeFileSync(paths[0], `{${marker}`);
    const bad = cli(args);
    assert.equal(bad.status, 2);
    assert.ok(!bad.stderr.includes(marker)); assert.ok(!bad.stderr.includes(directory));
    assert.equal(bad.stdout, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
