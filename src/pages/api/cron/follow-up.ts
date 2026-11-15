import type { NextApiRequest, NextApiResponse } from "next";
import { safeSecretCompare } from "../../../lib/adminAuth";
import { runFollowUpSweep } from "../../../lib/followUp";
import { runGetStartedNudgeSweep } from "../../../lib/getStartedNudge";

// GitHub Actions calls this every 5 minutes (.github/workflows/follow-up.yml): the one follow-up
// question to customers who left the bot's answer on seen (followUp.ts). The response holds counts
// only — the workflow log is public.
export const config = { maxDuration: 60 };

// Same as reminder.ts: FAIL CLOSED in production when CRON_SECRET is missing.
function isCronAuthorized(req: NextApiRequest): boolean {
  const secret = process.env.CRON_SECRET || "";
  const production = process.env.VERCEL_ENV === "production" || process.env.NODE_ENV === "production";
  if (!secret) return !production;
  const header = req.headers.authorization;
  const provided = Array.isArray(header) ? header[0] : header || "";
  return safeSecretCompare(`Bearer ${secret}`, provided);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();
  if (!isCronAuthorized(req)) return res.status(401).json({ error: "unauthorized" });
  const result = await runFollowUpSweep();
  // The one message after a «Get Started» tap followed by silence (getStartedNudge.ts), same cadence.
  const getStarted = await runGetStartedNudgeSweep().catch(() => ({ ok: false, candidates: 0, sent: 0, skipped: {}, disabled: "error" }));
  res.setHeader("Cache-Control", "no-store");
  return res.status(result.ok ? 200 : 503).json({ ...result, getStarted });
}
