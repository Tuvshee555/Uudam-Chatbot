import assert from "node:assert/strict";
import test from "node:test";
import { aiEnvironment, estimateCostUsd, processAiTotals, recordAiUsage } from "../src/lib/aiUsage";
import { evaluationCallBudget, requireApprovedEvaluation } from "../scripts/lib/evalGuard.mjs";

// 2026-10-30: the production OpenAI balance ran out (HTTP 429 insufficient_quota) partly because
// live replays ran on the production key; customers got silence and nobody was alerted.

const setEnv = (values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

const withEnv = (values: Record<string, string | undefined>, run: () => void) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  setEnv(values);
  try { run(); } finally { setEnv(saved); }
};

test("model spend is estimated per call and labelled by environment", () => {
  assert.equal(estimateCostUsd("gpt-4o", { prompt_tokens: 1_000_000, completion_tokens: 0 }), 2.5);
  assert.equal(estimateCostUsd("gpt-4.1", { prompt_tokens: 5_220, completion_tokens: 67 })?.toFixed(5), "0.01098");
  assert.equal(estimateCostUsd("some-new-model", { prompt_tokens: 10, completion_tokens: 10 }), null, "unknown models: tokens only, no invented price");
  withEnv({ AI_USAGE_ENVIRONMENT: undefined, VERCEL_ENV: "production" }, () => assert.equal(aiEnvironment(), "production"));
  withEnv({ AI_USAGE_ENVIRONMENT: "evaluation", VERCEL_ENV: "production" }, () => assert.equal(aiEnvironment(), "evaluation"));
  withEnv({ AI_USAGE_ENVIRONMENT: undefined, VERCEL_ENV: undefined, NODE_ENV: "test" }, () => assert.equal(aiEnvironment(), "test"));
  const before = processAiTotals();
  withEnv({ AI_USAGE_ENVIRONMENT: "test" }, () => recordAiUsage({ model: "gpt-4o-mini", source: "unit", usage: { prompt_tokens: 1000, completion_tokens: 100 } }));
  const after = processAiTotals();
  assert.equal(after.calls - before.calls, 1);
  assert.equal(after.promptTokens - before.promptTokens, 1000);
});

test("live-model evaluation needs a separate key, never production, and explicit approval", () => {
  const run = (env: Record<string, string | undefined>, baseUrl?: string) => {
    let outcome = "";
    withEnv({ EVAL_OPENAI_API_KEY: undefined, LIVE_REPLAY_OPENAI_API_KEY: undefined, PRODUCTION_OPENAI_API_KEY: undefined,
      OPENAI_API_KEY: "sk-production-fixture", EVAL_RUN_APPROVED: undefined, AI_USAGE_ENVIRONMENT: undefined, SITE_URL: undefined, ...env }, () => {
      try { requireApprovedEvaluation({ name: "fixture run", estimatedModelCalls: 90, baseUrl }); outcome = `ok:${process.env.OPENAI_API_KEY}:${process.env.AI_USAGE_ENVIRONMENT}`; }
      catch (error) { outcome = (error as Error).message; }
    });
    return outcome;
  };
  assert.match(run({}), /Refused: set EVAL_OPENAI_API_KEY/);
  assert.match(run({ EVAL_OPENAI_API_KEY: "sk-production-fixture", EVAL_RUN_APPROVED: "1" }), /Refused: .* is the production key/);
  assert.match(run({ EVAL_OPENAI_API_KEY: "sk-eval-fixture", EVAL_RUN_APPROVED: "1" }, "https://uudam-chatbot.vercel.app/api/demo"), /Refused: .* is production/);
  assert.match(run({ EVAL_OPENAI_API_KEY: "sk-eval-fixture" }), /Not approved: .* EVAL_RUN_APPROVED=1/);
  assert.match(run({ EVAL_OPENAI_API_KEY: "sk-eval-fixture" }), /about 90 model calls, roughly \$2\.70/, "the estimate is shown before approval");
  assert.equal(run({ EVAL_OPENAI_API_KEY: "sk-eval-fixture", EVAL_RUN_APPROVED: "1" }, "http://localhost:3004/api/demo"), "ok:sk-eval-fixture:evaluation",
    "an approved run switches this process to the evaluation key and labels its spend");
  withEnv({ EVAL_MAX_MODEL_CALLS: undefined }, () => assert.equal(evaluationCallBudget(), 150));
  withEnv({ EVAL_MAX_MODEL_CALLS: "40" }, () => assert.equal(evaluationCallBudget(), 40));
});

test("billing failures alert at once; a provider failure only once it persists", async (context) => {
  const { Pool } = await import("pg");
  const queries: string[] = [];
  let recentProviderFailures = 0;
  context.mock.method(Pool.prototype, "query", (async (sql: string) => {
    queries.push(sql.replace(/\s+/g, " ").trim());
    if (/COUNT\(\*\)::int AS n FROM travel_error_logs/.test(sql)) return { rows: [{ n: recentProviderFailures }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  }) as unknown as typeof Pool.prototype.query);
  const { applyTestEnv } = await import("./helpers/env");
  applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/ai-alerts", STAFF_NOTIFY_PSIDS: undefined, TELEGRAM_BOT_TOKEN: undefined });
  const { resetEnvCacheForTests } = await import("../src/lib/env");
  resetEnvCacheForTests();
  const { reportAiOutage } = await import("../src/lib/aiHealth");

  await reportAiOutage("provider");
  assert.ok(queries.some((sql) => /COUNT\(\*\)::int AS n/.test(sql)), "a provider failure first checks whether it persists");
  assert.ok(!queries.some((sql) => /event = 'ai_outage.staff_alerted' AND fields->>'kind'/.test(sql)), "one blip raises no alert");

  queries.length = 0;
  await reportAiOutage("credits_exhausted");
  assert.ok(!queries.some((sql) => /COUNT\(\*\)::int AS n/.test(sql)), "billing does not wait for repeats");
  assert.ok(queries.some((sql) => /ai_outage.staff_alerted/.test(sql)), "billing goes straight to the alert");

  queries.length = 0;
  recentProviderFailures = 5;
  await reportAiOutage("provider");
  assert.ok(queries.some((sql) => /ai_outage.staff_alerted/.test(sql)), "a persisting provider failure is alerted");
});
