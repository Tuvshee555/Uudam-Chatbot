#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  evaluateChatbotAccuracy, inventedAccuracyFixture,
  type AccuracyKind, type AccuracySplit,
} from "../src/lib/chatbotAccuracy";

const usage = `Offline chatbot accuracy evaluator (no network, DB or customer sends).
  node --import tsx scripts/chatbot-accuracy.ts --fixture [--split held_out]
  node --import tsx scripts/chatbot-accuracy.ts --fixture-json
  node --import tsx scripts/chatbot-accuracy.ts --pipeline-fixture [--require-pass]
  node --import tsx scripts/chatbot-accuracy.ts --pipeline-json
  node --import tsx scripts/chatbot-accuracy.ts --dataset <json> --replay <json> [--labels <json>]
Options: --split train|dev|held_out --kind single_turn|conversation|paraphrase
         --require-complete (exit 1 for incomplete coverage or harness failure)
         --require-pass (exit 1 unless every selected case is scored and passes)
JSON reports contain aggregates and hashes only. Invented fixtures test the
evaluator; they do not measure current chatbot accuracy. See docs/chatbot-accuracy.md.`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--help")) {
    console.log(usage);
    return;
  }
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--fixture", "--fixture-json", "--pipeline-fixture", "--pipeline", "--pipeline-json", "--require-complete", "--require-pass"].includes(arg)) {
      if (flags.has(arg)) throw new Error("Duplicate CLI flag");
      flags.add(arg);
    } else if (["--dataset", "--replay", "--labels", "--split", "--kind"].includes(arg)) {
      if (values.has(arg) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Missing or duplicate CLI option");
      values.set(arg, args[++i]);
    } else throw new Error("Unknown CLI option; use --help");
  }
  const split = values.get("--split"), kind = values.get("--kind");
  if (split && !["train", "dev", "held_out"].includes(split)) throw new Error("Unknown split");
  if (kind && !["single_turn", "conversation", "paraphrase"].includes(kind)) throw new Error("Unknown kind");
  const fixtureMode = flags.has("--fixture") || flags.has("--fixture-json");
  const pipelineMode = flags.has("--pipeline-fixture") || flags.has("--pipeline") || flags.has("--pipeline-json");
  if (fixtureMode && pipelineMode) throw new Error("Select one fixture mode");
  if ((fixtureMode || pipelineMode) && ["--dataset", "--replay", "--labels"].some((key) => values.has(key))) throw new Error("Fixture and external inputs cannot be combined");
  if (flags.has("--fixture-json")) {
    if (flags.size !== 1 || values.size) throw new Error("--fixture-json must be used alone");
    console.log(JSON.stringify(inventedAccuracyFixture(), null, 2));
    return;
  }
  if (flags.has("--pipeline-json") && (flags.size !== 1 || values.size)) throw new Error("--pipeline-json must be used alone");
  if (!fixtureMode && !pipelineMode && (!values.has("--dataset") || !values.has("--replay"))) throw new Error("Both --dataset and --replay are required");
  const readJson = (path: string): unknown => {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch { throw new Error("Unable to read input JSON"); }
  };
  const pipeline = pipelineMode ? await import("./chatbot-accuracy-pipeline") : undefined;
  const runtimeFixture = pipeline ? await pipeline.runInventedPipelineFixture() : undefined;
  if (flags.has("--pipeline-json")) {
    console.log(JSON.stringify(runtimeFixture, null, 2));
    return;
  }
  const fixture = runtimeFixture ?? (fixtureMode ? inventedAccuracyFixture() : undefined);
  const report = evaluateChatbotAccuracy(
    fixture?.dataset ?? readJson(values.get("--dataset")!),
    fixture?.replay ?? readJson(values.get("--replay")!),
    values.has("--labels") ? readJson(values.get("--labels")!) : undefined,
    { split: split as AccuracySplit | undefined, kind: kind as AccuracyKind | undefined },
  );
  console.log(JSON.stringify(runtimeFixture && pipeline ? { ...report, caseResults: pipeline.inventedPipelineCaseResults(runtimeFixture).filter((row) => fixture!.dataset.cases.some((c) => c.id === row.id && (!split || c.split === split) && (!kind || c.kind === kind))) } : report, null, 2));
  if (!report.integrityValid || (flags.has("--require-complete") && !report.complete) || (flags.has("--require-pass") && (!report.complete || report.failed > 0))) process.exitCode = 1;
}

main().catch((error) => {
  // Never print input values or paths, which may contain private customer data.
  console.error(`Accuracy evaluation failed: ${error instanceof Error ? error.message : "invalid input"}`);
  process.exitCode = 2;
});
