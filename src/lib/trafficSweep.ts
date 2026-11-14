/**
 * Runs the follow-up and get-started sweeps on customer traffic, not only on GitHub's schedule.
 *
 * Production 2026-11-12 → 11-14: the GitHub Actions job is scheduled every 5 minutes but GitHub ran it a few times
 * a day, so every follow-up went out 151–725 minutes after the answer instead of the owner's 30. Customer messages
 * reach the webhook all day, so each webhook call (after its response, via waitUntil) also runs the sweeps, at most
 * once per TRAFFIC_SWEEP_MINUTES across all instances (one-row lock in Neon). The GitHub job stays as the backup for
 * quiet hours with no traffic. Each sweep already claims every send atomically, so an overlap never double-sends.
 *
 * Off switch: TRAFFIC_SWEEP=off.
 */
import { waitUntil } from "@vercel/functions";
import { runFollowUpSweep } from "./followUp";
import { runGetStartedNudgeSweep } from "./getStartedNudge";
import { queryNeon } from "./neonDb";
import { logWarn } from "./observability";
import { ensureTravelSchema } from "./travelSchema";

export const TRAFFIC_SWEEP_MINUTES = 4;

/** Off with TRAFFIC_SWEEP=off; only on Vercel deployments unless forced with TRAFFIC_SWEEP=on (tests, local runs). */
export function trafficSweepDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.TRAFFIC_SWEEP ?? "").trim();
  if (/^(?:off|false|0|no)$/i.test(flag)) return true;
  return !env.VERCEL && !/^(?:on|true|1|yes)$/i.test(flag);
}

/** Atomic: true for exactly one caller per TRAFFIC_SWEEP_MINUTES. */
async function claimSweepSlot(): Promise<boolean> {
  const result = await queryNeon<{ id: number }>(
    `INSERT INTO travel_sweep_lock (id, last_run_at) VALUES (1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_run_at = NOW()
       WHERE travel_sweep_lock.last_run_at < NOW() - ($1 || ' minutes')::interval
     RETURNING id`,
    [String(TRAFFIC_SWEEP_MINUTES)],
  );
  return Boolean(result?.rows.length);
}

/** Runs both sweeps when this call holds the slot. Never throws. */
export async function runSweepsIfDue(): Promise<boolean> {
  try {
    if (trafficSweepDisabledByEnv() || !await ensureTravelSchema()) return false;
    if (!await claimSweepSlot()) return false;
    await runFollowUpSweep().catch((error) => logWarn("traffic_sweep.follow_up_failed", { message: error instanceof Error ? error.name : "unknown" }));
    await runGetStartedNudgeSweep().catch((error) => logWarn("traffic_sweep.get_started_failed", { message: error instanceof Error ? error.name : "unknown" }));
    return true;
  } catch {
    return false;
  }
}

/** Called once per webhook request, after its work: keeps the sweeps alive past the response on Vercel. */
export function scheduleSweepsFromTraffic(): void {
  if (trafficSweepDisabledByEnv()) return;
  const work = runSweepsIfDue();
  try {
    waitUntil(work);
  } catch {
    // Not on Vercel (tests, local node): a detached promise is fine; it never rejects.
    void work;
  }
}
