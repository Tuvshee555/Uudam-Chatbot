import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { queryNeon } from "../../../lib/neonDb";
import { collectAdminAnalytics, type AnalyticsPeriod } from "../../../lib/adminAnalytics";
import { hasStaffAlertChannel } from "../../../lib/staffAlerts";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "private, no-store");
  const allowed = await requireAdminAccess(req, res, "api.admin.analytics");
  if (!allowed) return;
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  const days = req.query.days;
  if (days !== undefined && days !== "7" && days !== "30") {
    return res.status(400).json({ ok: false, error: "Хугацаа 7 эсвэл 30 хоног байна." });
  }
  try {
    const result = await collectAdminAnalytics(queryNeon, Number(days || 7) as AnalyticsPeriod);
    if (result.attention) result.attention.staffAlertsConfigured = hasStaffAlertChannel();
    return res.status(200).json(result);
  } catch {
    return res.status(503).json({ ok: false, error: "Статистикийг ачаалж чадсангүй. Дахин оролдоно уу." });
  }
}
