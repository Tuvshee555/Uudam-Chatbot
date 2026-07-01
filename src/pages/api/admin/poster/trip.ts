import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { deletePosterTrip, getPosterTrip } from "@/lib/poster/db";

// GET    ?id=... -> load one poster (full data)
// DELETE ?id=... -> delete a poster + its versions
// (Pages Router: query-param id instead of App Router's [id] segment.)
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.trip");
  if (!allowed) return;

  const id = typeof req.query.id === "string" ? req.query.id : "";
  if (!id) return res.status(400).json({ error: "id шаардлагатай" });

  if (req.method === "GET") {
    const trip = await getPosterTrip(id);
    if (!trip) return res.status(404).json({ error: "Олдсонгүй" });
    return res.status(200).json({ trip });
  }

  if (req.method === "DELETE") {
    const ok = await deletePosterTrip(id);
    if (!ok) return res.status(404).json({ error: "Олдсонгүй" });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).end();
}
