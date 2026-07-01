import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { listPosterTrips, savePosterTrip } from "@/lib/poster/db";

export const config = {
  api: { bodyParser: { sizeLimit: "25mb" } },
};

// GET  -> list saved poster history
// POST -> create/update a poster + snapshot a version
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.trips");
  if (!allowed) return;

  if (req.method === "GET") {
    const trips = await listPosterTrips();
    return res.status(200).json({ trips });
  }

  if (req.method === "POST") {
    const body = req.body as {
      id?: unknown;
      title?: unknown;
      data?: unknown;
      source_file?: unknown;
      note?: unknown;
    };
    const title = typeof body.title === "string" ? body.title : "";
    const saved = await savePosterTrip({
      id: typeof body.id === "string" ? body.id : null,
      title,
      data: body.data ?? {},
      source_file: typeof body.source_file === "string" ? body.source_file : null,
      note: typeof body.note === "string" ? body.note : null,
    });
    if (!saved) return res.status(500).json({ error: "Хадгалж чадсангүй (DB тохиргоо?)" });
    return res.status(200).json({ id: saved.id });
  }

  return res.status(405).end();
}
