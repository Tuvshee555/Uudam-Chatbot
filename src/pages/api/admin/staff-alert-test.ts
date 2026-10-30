import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { notifyStaff, staffAlertChannelStatus } from "../../../lib/staffAlerts";

/**
 * Sends one test message to every configured staff channel, so an admin can see that new-lead
 * alerts arrive. Holds no customer data. Returns how many channels were tried and reached.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAccess(req, res, "api.admin.staff_alert_test")) return;
  if (req.method !== "POST") return res.status(405).end();
  const result = await notifyStaff(
    "🔧 UUDAM чатбот: ажилтны мэдэгдлийн туршилт. Энэ мессеж ирсэн бол шинэ хүсэлтийн мэдэгдэл энд ирнэ.",
    "test",
  );
  return res.status(200).json({ ok: result.delivered > 0, ...result, channels: await staffAlertChannelStatus().catch(() => null) });
}
