#!/usr/bin/env node
/**
 * Conversation-level understanding scenarios: runner and before/after report.
 *
 *   node scripts/conversation-scenario-report.mjs run [--out report.json] [--only <regex>] [--dump]
 *       Replays tests/understanding-scenarios.test.ts in report mode (never fails) with the same
 *       stripped environment as the conversation gate: no provider key, no database, mocked model,
 *       nothing sent. Writes the JSON rows to --out (default tmp/scenario-report.json).
 *
 *   node scripts/conversation-scenario-report.mjs <report.json>
 *       Prints the markdown summary of one run.
 *
 *   node scripts/conversation-scenario-report.mjs open <report.json> [--write]
 *       Lists the scenarios with at least one failing judged turn. With --write the list becomes
 *       tests/fixtures/understanding-scenarios-open.json: in the default assert mode those scenarios
 *       run as test.todo (visible, never dropped) so npm test stays green while they are open.
 *       Empty the file (or run with SCENARIO_MODE=strict) to see the real verdict.
 *
 *   node scripts/conversation-scenario-report.mjs <before.json> <after.json>
 *       Prints the summary of both runs side by side and lists the turns that changed.
 *
 * THE NUMBERS ARE A DESIGNED SCENARIO SET, NOT PRODUCTION ACCURACY. Every scenario was written
 * to expose a known failure class or to guard an ordinary answer; the mix is chosen, not sampled
 * from customers. Compare two runs of the SAME set; never quote a percentage as "the bot is X%
 * accurate". Denominators are printed next to every figure.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const args = process.argv.slice(2);

if (args[0] === "run") {
  const option = (name, fallback) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : fallback; };
  const out = resolve(option("--out", "tmp/scenario-report.json"));
  mkdirSync(dirname(out), { recursive: true });
  // Same stripping as scripts/conversation-gate.mjs: the run never reaches a real service.
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/TOKEN|SECRET|API_KEY|DATABASE_URL|^NEON_|^REDIS|^UPSTASH|^VERCEL|^BOOKING_|^STAFF_|^TELEGRAM_|_SINK_|^GOOGLE_DRIVE_|^GOOGLE_CLIENT|^ADMIN_GOOGLE_|^FACEBOOK_PAGES$|OPENAI|ANTHROPIC|GEMINI|^EVAL_|^LIVE_REPLAY_/i.test(key)) delete env[key];
  }
  Object.assign(env, { NODE_ENV: "test", OPENAI_API_KEY: "conversation-fixture-key", VERIFY_TOKEN: "conversation-fixture-token",
    TOKEN_PAGE: "conversation-fixture-token", FACEBOOK_PAGE_ID: "1234567890", META_APP_SECRET: "test-meta-secret",
    ADMIN_SESSION_SECRET: "conversation-fixture-session-key-4a8c2e6f0b9d3f7a", REDIS_STATE_ENABLED: "false", REDIS_RATE_LIMIT_ENABLED: "false",
    REDIS_REPLAY_ENABLED: "false", REDIS_CONVERSATION_ENABLED: "false", REDIS_PAUSE_ENABLED: "false",
    SCENARIO_MODE: "report", SCENARIO_REPORT: out });
  const only = option("--only", "");
  if (only) env.SCENARIO_ONLY = only;
  if (args.includes("--dump")) env.SCENARIO_DUMP = "1";
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "--test-reporter=spec", "tests/understanding-scenarios.test.ts"], { cwd: process.cwd(), env, stdio: "inherit" });
  if (result.error) console.error(result.error.message);
  console.log(`\nreport: ${out}`);
  process.exit(result.status ?? 1);
}

if (args[0] === "open") {
  const file = args.find((value, index) => index > 0 && !value.startsWith("--"));
  if (!file) { console.error("usage: conversation-scenario-report.mjs open <report.json> [--write]"); process.exit(2); }
  const failing = [...new Set(JSON.parse(readFileSync(file, "utf8")).filter((row) => !row.setup && row.verdict === "fail").map((row) => row.id))].sort();
  console.log(failing.join("\n"));
  console.error(`${failing.length} scenario(s) with at least one failing judged turn`);
  if (args.includes("--write")) {
    const target = resolve("tests/fixtures/understanding-scenarios-open.json");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(failing, null, 2) + "\n");
    console.error(`written: ${target}`);
  }
  process.exit(0);
}

const files = args.filter((value) => !value.startsWith("--"));
if (files.length < 1 || files.length > 2) {
  console.error("usage: conversation-scenario-report.mjs run [--out file] | <report.json> [<after.json>]");
  process.exit(2);
}

const load = (file) => JSON.parse(readFileSync(file, "utf8")).filter((row) => !row.setup);
const runs = files.map(load);
const labels = files.length === 2 ? ["before", "after"] : ["run"];

const hasTag = (row, ...tags) => tags.some((tag) => row.tags.includes(tag));
const kindOf = (failure) => failure.split(":")[0];
const failedKind = (row, ...kinds) => row.failedPredicates.some((failure) => kinds.includes(kindOf(failure)));
const OUTAGE = /систем түр саатаж/i;
const answered = (row) => row.replyCount > 0;
const passed = (row) => row.verdict === "pass";

const pct = (num, den) => (den ? `${((100 * num) / den).toFixed(0)}%` : "n/a");
const cell = (num, den) => `${num}/${den} (${pct(num, den)})`;

/** A metric is a numerator predicate over a denominator predicate; both run on judged turns. */
const metrics = [
  { name: "intent / need handled right", note: "turns tagged need: pass", den: (r) => hasTag(r, "need"), num: passed, good: true },
  { name: "correct destination / trip", note: "turns tagged trip: pass", den: (r) => hasTag(r, "trip"), num: passed, good: true },
  { name: "correct date / holiday", note: "turns tagged date or holiday: pass", den: (r) => hasTag(r, "date", "holiday"), num: passed, good: true },
  { name: "multi-constraint satisfied", note: "turns tagged multi: pass", den: (r) => hasTag(r, "multi"), num: passed, good: true },
  { name: "wrong-topic reply rate", note: "replies that are about something else or name a rejected trip, of all replies sent", den: answered, num: (r) => failedKind(r, "wrong-topic", "wrong-trip"), good: false },
  { name: "unsupported-claim rate", note: "replies with a price, date or policy the catalogue/settings do not hold, of all replies sent", den: answered, num: (r) => failedKind(r, "unsupported-claim"), good: false },
  { name: "unnecessary clarification", note: "counter-questions where the data answers, of all replies sent", den: answered, num: (r) => failedKind(r, "unnecessary-clarification"), good: false },
  { name: "silence where answerable (positive controls)", note: "positive-control turns where nothing was sent", den: (r) => hasTag(r, "positive"), num: (r) => failedKind(r, "silence-on-answerable") || (!answered(r) && !r.staffOwned), good: false },
  { name: "human-interruption violations", note: "turns under staff ownership where the bot sent or called a model", den: (r) => r.staffOwned, num: (r) => failedKind(r, "human-violation"), good: false },
  { name: "outage text on non-model needs", note: "provider-down turns of needs that never need the model: 'system is down' sent", den: (r) => hasTag(r, "nonmodel") && r.unavailable, num: (r) => answered(r) && OUTAGE.test(r.reply), good: false },
];

function section(title) { console.log(`\n## ${title}\n`); }

console.log("# Conversation understanding scenarios: report\n");
console.log("> **Designed scenario set, not production accuracy.** The scenarios were written to expose known failure classes and to guard ordinary answers; the mix is chosen, not sampled from customers. Use it to compare two runs of the same set. Never quote a percentage here as how accurate the bot is. Denominators are printed with every figure.\n");
console.log(`Inputs: ${files.map((file, index) => `${labels[index]} = ${file}`).join(", ")}\n`);

section("Totals");
console.log(`| | ${labels.join(" | ")} |\n|---|${labels.map(() => "---").join("|")}|`);
console.log(`| scenarios | ${runs.map((rows) => new Set(rows.map((row) => row.id)).size).join(" | ")} |`);
console.log(`| judged turns | ${runs.map((rows) => rows.length).join(" | ")} |`);
console.log(`| turns passed | ${runs.map((rows) => cell(rows.filter(passed).length, rows.length)).join(" | ")} |`);
console.log(`| model calls per turn (understanding + answer) | ${runs.map((rows) => (rows.length ? (rows.reduce((sum, row) => sum + row.modelCalls, 0) / rows.length).toFixed(2) : "n/a")).join(" | ")} |`);

section("Metrics");
console.log(`| metric | ${labels.join(" | ")} | what is counted |\n|---|${labels.map(() => "---").join("|")}|---|`);
for (const metric of metrics) {
  const cells = runs.map((rows) => { const den = rows.filter(metric.den); return cell(den.filter(metric.num).length, den.length); });
  console.log(`| ${metric.name}${metric.good ? "" : " (lower is better)"} | ${cells.join(" | ")} | ${metric.note} |`);
}

section("Model calls per turn by need class (cost; not part of any verdict)");
const costTags = ["social", "corporate", "policy", "service", "existing", "weather", "positive", "date", "trip"];
console.log(`| class | ${labels.join(" | ")} |
|---|${labels.map(() => "---").join("|")}|`);
for (const tag of costTags) console.log(`| ${tag} | ${runs.map((rows) => { const den = rows.filter((row) => row.tags.includes(tag) && !row.unavailable && !row.staffOwned); return den.length ? `${(den.reduce((sum, row) => sum + row.modelCalls, 0) / den.length).toFixed(2)} (n=${den.length})` : "n/a"; }).join(" | ")} |`);

section("Historical cases (CASE-n: the original conversation and its unseen paraphrases)");
const caseIds = [...new Set(runs.flatMap((rows) => rows.map((row) => row.historicalCase).filter(Boolean)))].sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
console.log(`| case | ${labels.map((label) => `${label}: original`).join(" | ")} | ${labels.map((label) => `${label}: paraphrases / variants`).join(" | ")} |\n|---|${labels.map(() => "---").join("|")}|${labels.map(() => "---").join("|")}|`);
for (const caseId of caseIds) {
  const original = runs.map((rows) => rows.filter((row) => row.historicalCase === caseId && !row.id.includes(".")));
  const variants = runs.map((rows) => rows.filter((row) => row.historicalCase === caseId && row.id.includes(".")));
  console.log(`| ${caseId} | ${original.map((rows) => cell(rows.filter(passed).length, rows.length)).join(" | ")} | ${variants.map((rows) => cell(rows.filter(passed).length, rows.length)).join(" | ")} |`);
}

section("Dimensions (scenario tags)");
const tags = [...new Set(runs.flatMap((rows) => rows.flatMap((row) => row.tags)))].sort();
console.log(`| tag | ${labels.join(" | ")} |\n|---|${labels.map(() => "---").join("|")}|`);
for (const tag of tags) console.log(`| ${tag} | ${runs.map((rows) => { const den = rows.filter((row) => row.tags.includes(tag)); return cell(den.filter(passed).length, den.length); }).join(" | ")} |`);

section("Failures by kind (turns with at least one failed predicate of that kind)");
const kinds = [...new Set(runs.flatMap((rows) => rows.flatMap((row) => row.failedPredicates.map(kindOf))))].sort();
console.log(`| kind | ${labels.join(" | ")} |\n|---|${labels.map(() => "---").join("|")}|`);
for (const kind of kinds) console.log(`| ${kind} | ${runs.map((rows) => rows.filter((row) => failedKind(row, kind)).length).join(" | ")} |`);

if (runs.length === 2) {
  const key = (row) => `${row.id}#${row.turn}`;
  const before = new Map(runs[0].map((row) => [key(row), row]));
  const after = new Map(runs[1].map((row) => [key(row), row]));
  const fixed = [], regressed = [], missing = [];
  for (const [id, row] of after) {
    const old = before.get(id);
    if (!old) { missing.push(`${id} (new in after)`); continue; }
    if (old.verdict === "fail" && row.verdict === "pass") fixed.push(id);
    if (old.verdict === "pass" && row.verdict === "fail") regressed.push(id);
  }
  for (const id of before.keys()) if (!after.has(id)) missing.push(`${id} (gone in after)`);
  section("Changed turns");
  console.log(`- fixed (fail -> pass): ${fixed.length}${fixed.length ? `\n  - ${fixed.join("\n  - ")}` : ""}`);
  console.log(`- regressed (pass -> fail): ${regressed.length}${regressed.length ? `\n  - ${regressed.join("\n  - ")}` : ""}`);
  if (missing.length) console.log(`- not comparable: ${missing.length}\n  - ${missing.join("\n  - ")}`);
  if (regressed.length) {
    section("Regressions in detail");
    for (const id of regressed) { const row = after.get(id); console.log(`- ${id} "${row.input.slice(0, 80)}"\n  - reply: ${(row.reply || "(silent)").replace(/\s+/g, " ").slice(0, 200)}\n  - ${row.failedPredicates.join("\n  - ")}`); }
  }
} else {
  section("Failing turns");
  for (const row of runs[0].filter((r) => r.verdict === "fail")) console.log(`- ${row.id}#${row.turn} "${row.input.slice(0, 70)}" -> ${(row.reply || "(silent)").replace(/\s+/g, " ").slice(0, 110)}\n  - ${row.failedPredicates.join("\n  - ")}`);
}

console.log("\n_Reminder: designed scenario set, not production accuracy._");
