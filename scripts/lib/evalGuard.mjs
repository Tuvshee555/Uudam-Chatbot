/**
 * Guard for every script that spends model credit (live replay, golden questions, catalogue QA,
 * real-conversation replay, mimic scoring). On 2026-10-30 a day of uncontrolled replays helped
 * exhaust the OpenAI balance and left customers unanswered. The owner accepts spending the existing
 * key's credit on testing, but a run must still be deliberate and bounded:
 *   1. opted in for this run: EVAL_RUN_APPROVED=1 (no script spends credit just by being started);
 *   2. never target the production site (its replies and logs are real customer data);
 *   3. stay under EVAL_MAX_MODEL_CALLS (default 150) model calls;
 *   4. one run at a time: a second concurrent run is refused, so runs cannot pile up.
 * It uses EVAL_OPENAI_API_KEY when set, otherwise the normal OPENAI_API_KEY.
 * Routine CI never needs any of this: it runs on mocked model responses.
 */

import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PRODUCTION_HOSTS = ["uudam-chatbot.vercel.app"];
const COST_PER_CALL_ESTIMATE_USD = 0.03;
const LOCK_FILE = join(tmpdir(), "uudam-eval-run.lock");

export function evaluationCallBudget() {
  const value = Number(process.env.EVAL_MAX_MODEL_CALLS || 150);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 150;
}

const processAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

/** Takes the single-run lock; a stale lock from a crashed run is replaced. */
function takeRunLock(estimate) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(LOCK_FILE, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      const release = () => { try { if (readFileSync(LOCK_FILE, "utf8") === String(process.pid)) unlinkSync(LOCK_FILE); } catch { /* already gone */ } };
      process.once("exit", release);
      return;
    } catch {
      let holder = 0;
      try { holder = Number(readFileSync(LOCK_FILE, "utf8")); } catch { /* removed meanwhile */ }
      if (holder && holder !== process.pid && processAlive(holder)) {
        throw new Error(`${estimate}. Refused: another evaluation run (pid ${holder}) is still going. Wait for it to finish.`);
      }
      if (holder === process.pid) return;
      try { unlinkSync(LOCK_FILE); } catch { /* removed meanwhile */ }
    }
  }
}

/**
 * Throws with an actionable message unless the run is allowed. Returns the key the run uses and
 * labels this process's spend as "evaluation".
 */
export function requireApprovedEvaluation({ name, estimatedModelCalls, baseUrl }) {
  const key = process.env.EVAL_OPENAI_API_KEY || process.env.LIVE_REPLAY_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "";
  const calls = Math.min(estimatedModelCalls, evaluationCallBudget());
  const estimate = `${name}: about ${calls} model calls, roughly $${(calls * COST_PER_CALL_ESTIMATE_USD).toFixed(2)}`;
  if (!key) throw new Error(`${estimate}. Refused: no OPENAI_API_KEY (or EVAL_OPENAI_API_KEY) is set.`);
  if (baseUrl) {
    let host = "";
    try { host = new URL(baseUrl).hostname; } catch { /* not a URL: checked by the caller */ }
    const productionSite = (process.env.SITE_URL ? [new URL(process.env.SITE_URL).hostname] : []).concat(PRODUCTION_HOSTS);
    if (productionSite.includes(host)) throw new Error(`${estimate}. Refused: ${host} is production. Run against a local or preview server.`);
  }
  if (process.env.EVAL_RUN_APPROVED !== "1") throw new Error(`${estimate}. Not approved: this run spends model credit. Re-run with EVAL_RUN_APPROVED=1.`);
  takeRunLock(estimate);
  process.env.OPENAI_API_KEY = key;
  process.env.AI_USAGE_ENVIRONMENT = "evaluation";
  console.log(`[eval] ${estimate}; cap ${evaluationCallBudget()} calls; spend recorded as environment "evaluation".`);
  return key;
}
