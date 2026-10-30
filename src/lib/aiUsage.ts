import type { queryNeon as QueryNeon } from "./neonDb";
import { logError, logWarn, recordCounter } from "./observability";
import type { ReadinessIssue } from "./readiness";

// Loaded on first use, like aiHealth: the OpenAI client imports this module and must stay
// importable without a validated server env.
const queryNeon: typeof QueryNeon = async (...args) => (await import("./neonDb")).queryNeon(...args);

export type AiUsage = { prompt_tokens: number; completion_tokens: number; total_tokens?: number };

/**
 * Estimated USD per million tokens [input, output]. An estimate for spend tracking and alerts,
 * not billing: check the provider's pricing page when it changes. Unknown models are counted
 * in tokens with no cost.
 */
const PRICE_PER_MILLION_USD: Record<string, [number, number]> = {
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
};

export function estimateCostUsd(model: string, usage: AiUsage): number | null {
  const price = PRICE_PER_MILLION_USD[model] ?? PRICE_PER_MILLION_USD[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  if (!price) return null;
  return (usage.prompt_tokens * price[0] + usage.completion_tokens * price[1]) / 1_000_000;
}

/**
 * Where the spend happened: production / preview (Vercel), evaluation (a live replay or
 * accuracy run, set by the run itself), test, or local. Spend is always reported per environment
 * so a day of testing can never hide inside, or drain, the production budget unnoticed.
 */
export function aiEnvironment(): string {
  return process.env.AI_USAGE_ENVIRONMENT || process.env.VERCEL_ENV || (process.env.NODE_ENV === "test" ? "test" : "local");
}

type Totals = { calls: number; promptTokens: number; completionTokens: number; costUsd: number };
const processTotals: Totals = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };

/** Calls and estimated spend made by this process (a replay prints these at the end). */
export function processAiTotals(): Totals {
  return { ...processTotals };
}

/**
 * Count one successful completion: in-process totals, a metric, and one upsert into the daily
 * per-environment table. Never throws and never blocks the reply (the write runs in background).
 */
export function recordAiUsage(input: { model: string; source: string; usage: AiUsage }): void {
  const costUsd = estimateCostUsd(input.model, input.usage) ?? 0;
  processTotals.calls += 1;
  processTotals.promptTokens += input.usage.prompt_tokens;
  processTotals.completionTokens += input.usage.completion_tokens;
  processTotals.costUsd += costUsd;
  const environment = aiEnvironment();
  recordCounter("openai.usage_tokens_total", input.usage.prompt_tokens + input.usage.completion_tokens, { model: input.model, environment });
  if (environment === "test") return;
  void queryNeon(
    `INSERT INTO travel_ai_usage (day, environment, model, source, calls, prompt_tokens, completion_tokens, est_cost_usd)
     VALUES ((NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date, $1, $2, $3, 1, $4, $5, $6)
     ON CONFLICT (day, environment, model, source) DO UPDATE SET
       calls = travel_ai_usage.calls + 1,
       prompt_tokens = travel_ai_usage.prompt_tokens + EXCLUDED.prompt_tokens,
       completion_tokens = travel_ai_usage.completion_tokens + EXCLUDED.completion_tokens,
       est_cost_usd = travel_ai_usage.est_cost_usd + EXCLUDED.est_cost_usd,
       updated_at = NOW()`,
    [environment, input.model, input.source.slice(0, 80), input.usage.prompt_tokens, input.usage.completion_tokens, costUsd],
  ).catch((error) => logError("ai_usage.record_failed", { message: error instanceof Error ? error.message : String(error) }));
}

export type AiUsageRow = { day: string; environment: string; model: string; calls: number; prompt_tokens: number; completion_tokens: number; est_cost_usd: number };

/** Daily usage and estimated cost by environment and model, newest first. */
export async function getAiUsageSummary(days = 30): Promise<AiUsageRow[]> {
  const result = await queryNeon<AiUsageRow>(
    `SELECT day::text, environment, model, SUM(calls)::int AS calls, SUM(prompt_tokens)::bigint AS prompt_tokens,
            SUM(completion_tokens)::bigint AS completion_tokens, ROUND(SUM(est_cost_usd)::numeric, 4)::float AS est_cost_usd
       FROM travel_ai_usage WHERE day > (NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date - $1::int
      GROUP BY day, environment, model ORDER BY day DESC, est_cost_usd DESC`,
    [Math.min(Math.max(Math.trunc(days), 1), 90)],
  );
  return result?.rows ?? [];
}

/** Today's estimated production spend against AI_DAILY_BUDGET_USD (default 20): an admin warning when over. */
export async function getAiSpendIssues(budgetUsd = Number(process.env.AI_DAILY_BUDGET_USD || 20)): Promise<ReadinessIssue[]> {
  try {
    const today = (await queryNeon<{ cost: number | null }>(
      `SELECT SUM(est_cost_usd)::float AS cost FROM travel_ai_usage
        WHERE environment = 'production' AND day = (NOW() AT TIME ZONE 'Asia/Ulaanbaatar')::date`,
    ))?.rows[0]?.cost ?? 0;
    if (Number.isFinite(budgetUsd) && budgetUsd > 0 && today > budgetUsd) {
      logWarn("ai_usage.daily_budget_exceeded", { costUsd: today, budgetUsd });
      return [{ severity: "critical", key: "ai_spend",
        message: `Өнөөдрийн AI зардал (production) ойролцоогоор $${today.toFixed(2)} — өдрийн төсөв $${budgetUsd}-аас хэтэрсэн. platform.openai.com → Usage хэсгийг шалгана уу.` }];
    }
  } catch (error) {
    logError("ai_usage.spend_check_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  return [];
}
