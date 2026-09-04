import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { exportPosterTrips } from "@/lib/poster/db";
import { buildPosterBulkPlan } from "@/lib/poster/bulkPlan";
import { listTrips } from "@/lib/travelDb";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster-bulk-plan");
  if (!allowed) return;

  if (req.method !== "POST" && req.method !== "GET") return res.status(405).end();

  const [posterRows, trips] = await Promise.all([
    exportPosterTrips(),
    listTrips({ limit: 5000 }),
  ]);
  const plan = buildPosterBulkPlan(posterRows, trips);

  const allTrips = trips
    .map((trip) => ({
      id: trip.id,
      route_name: trip.route_name,
      category: trip.category,
      photoCount: Array.isArray(trip.photo_urls) ? trip.photo_urls.length : 0,
    }))
    .sort((a, b) => a.route_name.localeCompare(b.route_name, "mn"));

  return res.status(200).json({ ...plan, allTrips });
}
