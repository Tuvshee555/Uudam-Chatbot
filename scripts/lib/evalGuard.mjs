/**
 * Guard for every script that spends model credit (live replay, golden questions, catalogue QA,
 * real-conversation replay, mimic scoring). On 2026-10-30 a day of replays on the shared key
 * helped exhaust the production OpenAI balance and left customers unanswered. A run must therefore:
 *   1. use EVAL_OPENAI_API_KEY (alias LIVE_REPLAY_OPENAI_API_KEY): a separate, budget-limited key
 *      from a separate OpenAI project, never the production key;
 *   2. never target the production site;
 *   3. be approved explicitly for this run: EVAL_RUN_APPROVED=1;
 *   4. stay under EVAL_MAX_MODEL_CALLS (default 150) model calls.
 * Routine CI never needs any of this: it runs on mocked model responses.
 */

const PRODUCTION_HOSTS = ["uudam-chatbot.vercel.app"];
const COST_PER_CALL_ESTIMATE_USD = 0.03;

export function evaluationCallBudget() {
  const value = Number(process.env.EVAL_MAX_MODEL_CALLS || 150);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 150;
}

/**
 * Throws with an actionable message unless the run is allowed. Returns the evaluation key and
 * switches this process to it, so nothing below can reach the production key by accident.
 */
export function requireApprovedEvaluation({ name, estimatedModelCalls, baseUrl }) {
  const key = process.env.EVAL_OPENAI_API_KEY || process.env.LIVE_REPLAY_OPENAI_API_KEY || "";
  const productionKey = process.env.PRODUCTION_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  const calls = Math.min(estimatedModelCalls, evaluationCallBudget());
  const estimate = `${name}: about ${calls} model calls, roughly $${(calls * COST_PER_CALL_ESTIMATE_USD).toFixed(2)}`;
  if (!key) throw new Error(`${estimate}. Refused: set EVAL_OPENAI_API_KEY to a separate, budget-limited key (never the production key).`);
  if (productionKey && key === productionKey) throw new Error(`${estimate}. Refused: EVAL_OPENAI_API_KEY is the production key. Use a key from a separate OpenAI project.`);
  if (baseUrl) {
    let host = "";
    try { host = new URL(baseUrl).hostname; } catch { /* not a URL: checked by the caller */ }
    const productionSite = (process.env.SITE_URL ? [new URL(process.env.SITE_URL).hostname] : []).concat(PRODUCTION_HOSTS);
    if (productionSite.includes(host)) throw new Error(`${estimate}. Refused: ${host} is production. Run against a local or preview server started with OPENAI_API_KEY=$EVAL_OPENAI_API_KEY.`);
  }
  if (process.env.EVAL_RUN_APPROVED !== "1") throw new Error(`${estimate}. Not approved: this run spends model credit. Re-run with EVAL_RUN_APPROVED=1 once the owner approved it.`);
  process.env.OPENAI_API_KEY = key;
  process.env.AI_USAGE_ENVIRONMENT = "evaluation";
  console.log(`[eval] ${estimate}; cap ${evaluationCallBudget()} calls; spend recorded as environment "evaluation".`);
  return key;
}
