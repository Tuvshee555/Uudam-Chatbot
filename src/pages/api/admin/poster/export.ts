import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { exportPosterTrips } from "@/lib/poster/db";

// Download all saved posters as one JSON file (full data included).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.export");
  if (!allowed) return;
  if (req.method !== "GET") return res.status(405).end();

  const trips = await exportPosterTrips();
  const payload = JSON.stringify(
    { exported_at: new Date().toISOString(), trips },
    null,
    2,
  );
  res.setHeader("Content-Type", "application/json");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="uudam-posters-${new Date().toISOString().slice(0, 10)}.json"`,
  );
  return res.status(200).send(payload);
}
