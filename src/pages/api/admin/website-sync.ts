import type { NextApiRequest, NextApiResponse } from "next";
import { waitUntil } from "@vercel/functions";
import { requireAdminAccess } from "@/lib/adminAccess";
import { ensureConnectedTripSchema } from "@/lib/connectedTripStore";
import { flushWebsiteSync, websiteSyncStatus } from "@/lib/websiteTripSync";

export const config = { maxDuration: 60 };
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAccess(req,res,"api.admin.website-sync")) return;
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();
  await ensureConnectedTripSchema();
  if (req.method === "POST") await flushWebsiteSync(undefined, 5);
  else waitUntil(flushWebsiteSync(undefined, 2));
  res.setHeader("Cache-Control","no-store");
  return res.json({ configured: Boolean(process.env.BOOKING_DATABASE_URL), trips: await websiteSyncStatus() });
}
