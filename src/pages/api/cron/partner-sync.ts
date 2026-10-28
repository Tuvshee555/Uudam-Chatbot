import type { NextApiRequest, NextApiResponse } from "next";
import { waitUntil } from "@vercel/functions";
import { safeSecretCompare } from "../../../lib/adminAuth";
import { runPartnerSync } from "../../../lib/partnerSync/run";

// Re-reads the mirrored partner tour pages and copies any price, date or programme change into
// their trips. Partner trips are owned by the partner agency; Uudam's own trips are never touched.
//
// Vercel's Hobby plan only runs crons once a day, so vercel.json schedules the daily safety net and
// a shorter interval is driven by an external pinger hitting this same URL with the CRON_SECRET.
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
  // The sync talks to an external site and the database; answer the scheduler at once and let it
  // finish in the background, the way the reminder cron does.
  waitUntil(runPartnerSync().then(() => {}).catch(() => {}));
  return res.status(202).json({ started: true });
}
