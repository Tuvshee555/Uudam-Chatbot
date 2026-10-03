#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { evaluateChatbotQuality, inventedQualityFixture } from "../src/lib/chatbotQuality";

const usage = `Offline conversation-quality evaluator; no network, DB or sends.
  node --import tsx scripts/chatbot-quality.ts --fixture
  node --import tsx scripts/chatbot-quality.ts --fixture-json
  node --import tsx scripts/chatbot-quality.ts --dataset <json> --replay <json> [--labels <json>]
Options: --require-complete --require-pass
Reports contain aggregates and digests only. Fixtures are invented, not bot benchmarks.
See docs/chatbot-quality.md.`;

function main() {
  const args = process.argv.slice(2);
  if (!args.length || (args.length === 1 && args[0] === "--help")) { console.log(usage); return; }
  const flags = new Set<string>(), values = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (["--fixture", "--fixture-json", "--require-complete", "--require-pass"].includes(arg)) {
      if (flags.has(arg)) throw new Error("Duplicate flag");
      flags.add(arg);
    } else if (["--dataset", "--replay", "--labels"].includes(arg)) {
      if (values.has(arg) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Missing or duplicate option");
      values.set(arg, args[++i]);
    } else throw new Error("Unknown option");
  }
  const fixtureMode = flags.has("--fixture") || flags.has("--fixture-json");
  if (fixtureMode && values.size) throw new Error("Mixed input modes");
  if (flags.has("--fixture-json")) {
    if (flags.size !== 1) throw new Error("Export must be used alone");
    console.log(JSON.stringify(inventedQualityFixture(), null, 2)); return;
  }
  if (!fixtureMode && (!values.has("--dataset") || !values.has("--replay"))) throw new Error("Dataset and replay required");
  const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));
  const fixture = fixtureMode ? inventedQualityFixture() : undefined;
  const report = evaluateChatbotQuality(
    fixture?.dataset ?? readJson(values.get("--dataset")!),
    fixture?.replay ?? readJson(values.get("--replay")!),
    values.has("--labels") ? readJson(values.get("--labels")!) : undefined,
  );
  console.log(JSON.stringify(report, null, 2));
  const operationalFailure = report.providerFailures > 0 || report.harnessFailures > 0 || report.deliveryFailures > 0;
  if (!report.integrityValid || (flags.has("--require-complete") && !report.complete) ||
    (flags.has("--require-pass") && (operationalFailure || !report.complete || report.failed > 0))) process.exitCode = 1;
}
try { main(); }
catch {
  // Node parse and filesystem errors can contain private text or paths.
  console.error("Quality evaluation failed: invalid inputs or options; see --help.");
  process.exitCode = 2;
}
