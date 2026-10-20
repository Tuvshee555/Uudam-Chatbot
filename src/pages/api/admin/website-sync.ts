import type { NextApiRequest, NextApiResponse } from "next";
import { waitUntil } from "@vercel/functions";
import { requireAdminAccess } from "@/lib/adminAccess";
import { ensureConnectedTripSchema } from "@/lib/connectedTripStore";
import { flushWebsiteSync, websiteSyncStatus } from "@/lib/websiteTripSync";
import { summarizeWebsiteSync } from "@/lib/websiteSyncStatus";

export const config = { maxDuration: 60 };
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();
  if (!await requireAdminAccess(req,res,"api.admin.website-sync")) return;
  const configured = Boolean(process.env.BOOKING_DATABASE_URL?.trim());
  if (req.method === "POST" && !configured) return res.status(409).json({ error: "website_sync_not_configured" });
  try {
    await ensureConnectedTripSchema();
    if (configured) {
      if (req.method === "POST") await flushWebsiteSync(undefined, 5);
      else waitUntil(flushWebsiteSync(undefined, 2).catch(() => {
        console.error("Background website sync could not complete");
      }));
    }
    const trips = await websiteSyncStatus();
    return res.status(200).json({ configured, trips, summary: summarizeWebsiteSync(trips) });
  } catch {
    return res.status(503).json({ error: "website_sync_status_unavailable" });
  }
}
