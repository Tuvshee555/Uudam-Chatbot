import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { partnerWatchOverview } from "../../../lib/partnerWatch/store";

/** The «Тойм» card: each watched trip's latest partner-page check, and the seat states applied this week. */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const allowed = await requireAdminAccess(req, res, "api.admin.partner_watch");
  if (!allowed) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  try {
    return res.status(200).json({ ok: true, watch: await partnerWatchOverview() });
  } catch {
    return res.status(503).json({ ok: false, error: "Хамтрагчийн хуудасны шалгалтыг ачаалж чадсангүй. Дахин оролдоно уу." });
  }
}
