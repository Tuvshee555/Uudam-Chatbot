import type { NextApiRequest, NextApiResponse } from "next";
import { safeSecretCompare } from "../../../lib/adminAuth";
import { runPartnerWatch } from "../../../lib/partnerWatch/run";

// GitHub Actions calls this every 6 hours (.github/workflows/partner-watch.yml): each trip made from a
// partner page is checked against that page; seat states are applied, the rest is recorded for the admin.
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
  res.setHeader("Cache-Control", "no-store");
  try {
    const results = await runPartnerWatch();
    // A page that could not be read is recorded and shown in the admin; the run itself still succeeded.
    return res.status(200).json({
      ok: true,
      results: results.map((result) => ({
        trip_id: result.trip_id, status: result.status, applied: result.applied.length, pending: result.pending.length,
        ...(result.error ? { error: result.error } : {}),
      })),
    });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/g, "[database]");
    return res.status(503).json({ ok: false, error: reason.slice(0, 300) });
  }
}
