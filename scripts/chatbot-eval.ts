/**
 * Chatbot evaluation: customer conversations through the REAL webhook handler over the invented
 * catalogue (tests/eval/catalogue.ts), with the real model or with no model at all, scored on
 * hard rules (nothing invented, no control tokens, silence only with a lead) and on each case's
 * expectations. Prints a scoreboard with model calls, tokens and estimated cost per turn and
 * writes the full transcript to tmp/ (gitignored).
 *
 *   EVAL_MODE=rules node --import tsx --test scripts/chatbot-eval.ts      # no model, free
 *   EVAL_RUN_APPROVED=1 EVAL_MODE=live npm run eval:chatbot                # real model (evalGuard)
 *
 * Env: EVAL_SET=dev|heldout (default dev) · EVAL_ONLY=<category or id prefix>[,…] · EVAL_LABEL=<name>
 *      EVAL_REPLY_MODEL / EVAL_UNDERSTANDING_MODEL / EVAL_DEFAULT_MODEL (live mode model overrides)
 *      EVAL_MAX_MODEL_CALLS (cap, default 150) · EVAL_STRICT=1 fails the process on any hard-rule violation
 * Live runs spend credit, so they go through scripts/lib/evalGuard.mjs (opt-in, capped, one at a time).
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { conversationGateHarness, type LiveModelCall } from "../tests/helpers/conversationGateHarness";
import { evalCatalogue, evalSettings, EVAL_PHONES, EVAL_TODAY } from "../tests/eval/catalogue";
import { estimateCostUsd } from "../src/lib/aiUsage";
import type { EvalCase, EvalTurn } from "../tests/eval/dev.cases";

const MODE = (process.env.EVAL_MODE || "rules") as "rules" | "live";
const SET = process.env.EVAL_SET || "dev";
const LABEL = process.env.EVAL_LABEL || `${SET}-${MODE}`;
const ONLY = (process.env.EVAL_ONLY || "").split(",").map((value) => value.trim()).filter(Boolean);

type TurnRow = { text: string; sends: string[]; leads: string[]; hard: string[]; failures: string[]; silent: boolean;
  calls: number; promptTokens: number; completionTokens: number; costUsd: number; models: Record<string, number>;
  /** What the understanding model read (live mode), for diagnosing a wrong route. */
  understanding?: string[] };
type CaseRow = { id: string; category: string; script: string; turns: TurnRow[] };

// The same estimator production spend tracking uses (cached input billed at its discounted share).
const cost = (call: LiveModelCall) =>
  estimateCostUsd(call.model, { prompt_tokens: call.promptTokens, completion_tokens: call.completionTokens, cached_tokens: call.cachedTokens }) ?? 0;

/** Every number and departure the catalogue holds, so a reply can be checked without the engine's own verifier. */
function groundTruth() {
  const json = JSON.stringify(evalCatalogue);
  const numbers = new Set([...json.matchAll(/\d{1,3}(?:,\d{3})+|\d{5,}/g)].map((match) => Number(match[0].replace(/,/g, ""))));
  const days = new Set<string>();
  for (const match of json.matchAll(/20\d\d-(\d\d)-(\d\d)/g)) days.add(`${Number(match[1])}/${Number(match[2])}`);
  // A weekly trip ("Баасан гараг бүр") departs every Friday from today.
  const start = new Date(`${EVAL_TODAY}T00:00:00Z`);
  for (let i = 0; i < 20; i += 1) {
    const date = new Date(start.getTime() + i * 86_400_000);
    if (date.getUTCDay() === 5) days.add(`${date.getUTCMonth() + 1}/${date.getUTCDate()}`);
  }
  return { numbers, days };
}

const truth = groundTruth();
const amountOf = (value: string) => Number(value.replace(/[.,]/g, ""));

/** Rules every turn must pass whatever the case expects. */
function hardChecks(reply: string, customerText: string): string[] {
  const problems: string[] = [];
  if (/\b(?:REFER|SILENT)\b/.test(reply)) problems.push("control token leaked");
  if (/undefined|NaN|Invalid Date|NEEDS_MANUAL_FIX|\bContext\b/.test(reply)) problems.push("internal value leaked");
  const lines = reply.split(/\r?\n/);
  let partySum = 0;
  for (const line of lines) {
    // "• Трип: 8,270,000₮ (2 том хүн x 2,890,000₮ + 1 хүүхэд x 2,490,000₮)": a total that adds up.
    const inline = /^(.*?):\s*([\d.,]+)\s*₮\s*\(([^()]*)\)/u.exec(line);
    if (inline) {
      const terms = inline[3].split(/\s\+\s/).map((part) => /(\d{1,3})\s+.*?x\s*([\d.,]+)\s*₮/u.exec(part));
      if (terms.length && terms.every(Boolean)) {
        const expected = terms.reduce((sum, term) => sum + Number(term![1]) * amountOf(term![2]), 0);
        if (expected !== amountOf(inline[2])) problems.push(`total ${inline[2]} does not add up`);
        for (const term of terms) if (!truth.numbers.has(amountOf(term![2]))) problems.push(`invented amount ${term![2]}₮`);
        continue;
      }
    }
    const each = /x\s*(\d{1,3})\s*:\s*([\d.,]+)\s*₮/i.exec(line);
    if (each) partySum += Number(each[1]) * amountOf(each[2]);
    const total = /^\s*нийт\s*:\s*([\d.,]+)\s*₮/i.exec(line);
    if (total) {
      if (partySum > 0 && amountOf(total[1]) !== partySum) problems.push(`total ${total[1]} != ${partySum}`);
      if (partySum === 0 && !truth.numbers.has(amountOf(total[1]))) problems.push(`total ${total[1]} without lines`);
      partySum = 0;
      continue;
    }
    for (const match of line.matchAll(/(\d{1,3}(?:[.,]\d{3})+|\d{5,})\s*₮/g)) {
      if (!truth.numbers.has(amountOf(match[1]))) problems.push(`invented amount ${match[1]}₮`);
    }
  }
  // Lines that quote a window or a condition ("3 сарын 1-ээс өмнө захиалбал") name days that are not departures.
  const withoutWindows = reply.replace(/[^\n]*(?:хооронд|-с хойш|-ээс хойш|хуваарь байхгүй|өмнө|хямдрал|нөхцөл)[^\n]*/g, "");
  for (const match of withoutWindows.matchAll(/(?<![\d,.])(\d{1,2})\/(\d{1,2})(?![\d,])|(\d{1,2}) сарын (\d{1,2})(?![\d])/g)) {
    const day = match[1] ? `${Number(match[1])}/${Number(match[2])}` : `${Number(match[3])}/${Number(match[4])}`;
    if (!truth.days.has(day)) problems.push(`date ${day} is not a catalogue departure`);
  }
  const customerDigits: string[] = customerText.match(/\d{8}/g) || [];
  for (const match of reply.replace(/https?:\/\/\S+/g, "").matchAll(/(?<![\d-])(?:\+?976[ -]?)?(\d{4}[ -]?\d{4})(?![\d-])/g)) {
    const digits = match[1].replace(/\D/g, "");
    if (!EVAL_PHONES.includes(digits) && !customerDigits.includes(digits)) problems.push(`unknown phone ${match[1]}`);
  }
  return problems;
}

function expectationChecks(turn: EvalTurn, sends: string[], leads: string[]): string[] {
  const expect = turn.expect || {};
  const reply = sends.join("\n");
  const failures: string[] = [];
  if (expect.silent) {
    if (sends.length) failures.push(`expected silence (no data), got a reply`);
    if (!leads.length) failures.push("expected a staff lead");
    return failures;
  }
  if (!sends.length && !expect.allowSilent) failures.push("silent turn");
  for (const pattern of expect.must || []) if (!new RegExp(pattern, "iu").test(reply)) failures.push(`missing /${pattern}/`);
  for (const pattern of expect.mustNot || []) if (new RegExp(pattern, "iu").test(reply)) failures.push(`forbidden /${pattern}/`);
  if (expect.lead && !leads.length) failures.push("expected a staff lead");
  if (expect.noLead && leads.length) failures.push("unexpected staff lead");
  return failures;
}

test(`chatbot evaluation (${LABEL})`, { timeout: 3_600_000 }, async (context) => {
  const { devCases } = await import("../tests/eval/dev.cases");
  const cases: EvalCase[] = SET === "heldout" ? (await import("../tests/eval/heldout.cases")).heldoutCases : devCases;
  const selected = cases.filter((item) => !ONLY.length || ONLY.some((only) => item.category === only || item.id.startsWith(only)));
  const turnCount = selected.reduce((sum, item) => sum + item.turns.length, 0);

  let liveKey = "";
  let budget = 0;
  if (MODE === "live") {
    const { evaluationCallBudget, requireApprovedEvaluation } = await import("./lib/evalGuard.mjs");
    liveKey = requireApprovedEvaluation({ name: `chatbot eval ${LABEL}`, estimatedModelCalls: turnCount * 3 });
    budget = evaluationCallBudget();
  }
  const calls: LiveModelCall[] = [];
  // Spend by call type (understanding / reply / memory / other) across the whole run.
  const byKind: Record<string, { calls: number; promptTokens: number; cachedTokens: number; completionTokens: number; costUsd: number }> = {};
  const harness = await conversationGateHarness(context, {
    settings: evalSettings,
    env: {
      ...(MODE === "live" ? { OPENAI_API_KEY: liveKey, OPENAI_TIMEOUT_MS: "45000", OPENAI_MAX_RETRIES: "1" } : {}),
      ...(process.env.EVAL_REPLY_MODEL ? { OPENAI_REPLY_MODEL: process.env.EVAL_REPLY_MODEL } : {}),
      ...(process.env.EVAL_UNDERSTANDING_MODEL ? { TRIP_UNDERSTANDING_MODEL: process.env.EVAL_UNDERSTANDING_MODEL } : {}),
      ...(process.env.EVAL_DEFAULT_MODEL ? { OPENAI_MODEL: process.env.EVAL_DEFAULT_MODEL } : {}),
    },
    ...(MODE === "live" ? { liveModel: { budget, onCall: (call) => calls.push(call) } } : {}),
  });
  harness.catalog(evalCatalogue);
  const report: CaseRow[] = [];
  try {
    for (const item of selected) {
      harness.reset();
      const sender = `eval-${item.id}`;
      const rows: TurnRow[] = [];
      for (const turn of item.turns) {
        const before = calls.length;
        const result = await harness.turn(sender, turn.text, MODE === "rules" ? { unavailable: true } : {});
        // Background work (memory merge) may call the model after the reply: let it land before counting.
        await new Promise((resolve) => setTimeout(resolve, MODE === "live" ? 300 : 0));
        const sends = result.sends.map((send) => send.text);
        const leads = result.leads.map((lead) => `${lead.kind}: ${lead.context.slice(0, 160)}`);
        const made = calls.slice(before);
        const models: Record<string, number> = {};
        for (const call of made) {
          models[`${call.kind}:${call.model}`] = (models[`${call.kind}:${call.model}`] || 0) + 1;
          const bucket = byKind[call.kind] ||= { calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, costUsd: 0 };
          bucket.calls += 1; bucket.promptTokens += call.promptTokens; bucket.cachedTokens += call.cachedTokens;
          bucket.completionTokens += call.completionTokens; bucket.costUsd += cost(call);
        }
        rows.push({
          text: turn.text, sends, leads, silent: sends.length === 0,
          hard: sends.flatMap((send) => hardChecks(send, turn.text)).concat(!sends.length && !leads.length && !turn.expect?.noLead ? ["silent without a lead"] : []),
          failures: expectationChecks(turn, sends, leads),
          calls: made.length, promptTokens: made.reduce((sum, call) => sum + call.promptTokens, 0),
          completionTokens: made.reduce((sum, call) => sum + call.completionTokens, 0), costUsd: made.reduce((sum, call) => sum + cost(call), 0), models,
          ...(made.some((call) => call.kind === "understanding") ? { understanding: made.filter((call) => call.kind === "understanding").map((call) => call.response.slice(0, 600)) } : {}),
        });
      }
      report.push({ id: item.id, category: item.category, script: item.script, turns: rows });
    }
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 50));
    await harness.close().catch((error) => console.error(String(error)));
  }

  // ── Scoreboard ──
  const turns = report.flatMap((row) => row.turns.map((turn) => ({ ...turn, id: row.id, category: row.category, script: row.script })));
  const passed = turns.filter((turn) => !turn.hard.length && !turn.failures.length);
  const hardOk = turns.filter((turn) => !turn.hard.length);
  const by = (key: "category" | "script") => {
    const groups = new Map<string, { turns: number; passed: number }>();
    for (const turn of turns) {
      const bucket = groups.get(turn[key]) || { turns: 0, passed: 0 };
      bucket.turns += 1; if (!turn.hard.length && !turn.failures.length) bucket.passed += 1;
      groups.set(turn[key], bucket);
    }
    return [...groups].map(([name, value]) => `${name} ${value.passed}/${value.turns}`).join(" · ");
  };
  const totalCalls = turns.reduce((sum, turn) => sum + turn.calls, 0);
  const promptTokens = turns.reduce((sum, turn) => sum + turn.promptTokens, 0);
  const completionTokens = turns.reduce((sum, turn) => sum + turn.completionTokens, 0);
  const costUsd = turns.reduce((sum, turn) => sum + turn.costUsd, 0);
  const modelMix: Record<string, number> = {};
  for (const turn of turns) for (const [key, count] of Object.entries(turn.models)) modelMix[key] = (modelMix[key] || 0) + count;
  mkdirSync("tmp", { recursive: true });
  const file = `tmp/eval-${LABEL}.json`;
  writeFileSync(file, JSON.stringify({ label: LABEL, mode: MODE, set: SET, summary: { turns: turns.length, passed: passed.length, hardOk: hardOk.length,
    calls: totalCalls, promptTokens, completionTokens, costUsd, modelMix, byKind }, report }, null, 1));
  console.log(`\n== chatbot eval ${LABEL}: ${passed.length}/${turns.length} turns correct (${(passed.length / Math.max(1, turns.length) * 100).toFixed(1)}%), hard rules ${hardOk.length}/${turns.length}`);
  console.log(`   by category: ${by("category")}`);
  console.log(`   by script: ${by("script")}`);
  console.log(`   model: ${totalCalls} calls, ${promptTokens} in / ${completionTokens} out tokens, $${costUsd.toFixed(4)} (${(costUsd / Math.max(1, turns.length)).toFixed(5)}/turn, ${(totalCalls / Math.max(1, turns.length)).toFixed(2)} calls/turn)`);
  if (Object.keys(modelMix).length) console.log(`   mix: ${Object.entries(modelMix).map(([key, count]) => `${key}=${count}`).join(" ")}`);
  for (const [kind, value] of Object.entries(byKind)) {
    console.log(`   ${kind}: ${value.calls} calls, ${Math.round(value.promptTokens / value.calls)} in (${Math.round(value.cachedTokens / Math.max(1, value.promptTokens) * 100)}% cached) / ${Math.round(value.completionTokens / value.calls)} out per call, ${value.costUsd.toFixed(4)}`);
  }
  for (const turn of turns.filter((row) => row.hard.length || row.failures.length)) {
    console.log(`   ✗ ${turn.id} «${turn.text}» → ${[...turn.hard, ...turn.failures].join("; ")}${turn.sends.length ? `\n       bot: ${turn.sends.join(" ⏎ ").replace(/\n/g, " ⏎ ").slice(0, 220)}` : ""}${turn.understanding?.length ? `\n       understanding: ${turn.understanding.join(" | ").replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
  }
  console.log(`   report: ${file}`);
  if (process.env.EVAL_STRICT === "1") assert.equal(hardOk.length, turns.length, "hard rules must hold on every turn");
});
