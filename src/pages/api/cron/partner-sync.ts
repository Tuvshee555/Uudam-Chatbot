import type { NextApiRequest, NextApiResponse } from "next";
import { safeSecretCompare } from "../../../lib/adminAuth";
import { runPartnerSync } from "../../../lib/partnerSync/run";

// GitHub Actions calls this every 30 minutes; Vercel's daily cron is a fallback.
export const config = { maxDuration: 300 };
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
  const results = await runPartnerSync();
  const ok = results.every((result) => result.status === "synced" || result.status === "unchanged");
  res.setHeader("Cache-Control", "no-store");
  return res.status(ok ? 200 : 503).json({ ok, results });
}
