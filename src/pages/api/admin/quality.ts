import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { queryNeon } from "../../../lib/neonDb";
import { collectDeliveryQuality } from "../../../lib/deliveryQuality";
import { listLeads } from "../../../lib/travelOps";

/** Real customers' message outcomes over the last 7 days, from records only (deliveryQuality.ts). */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const allowed = await requireAdminAccess(req, res, "api.admin.quality");
  if (!allowed) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  try {
    const quality = await collectDeliveryQuality(queryNeon, await listLeads(200));
    return res.status(200).json({ ok: true, quality });
  } catch {
    return res.status(503).json({ ok: false, error: "Чанарын тоймыг ачаалж чадсангүй. Дахин оролдоно уу." });
  }
}
