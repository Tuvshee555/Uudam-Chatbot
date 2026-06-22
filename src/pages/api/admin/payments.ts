import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  getPaymentStats,
  listPayments,
  updatePaymentStatus,
  type PaymentStatus,
} from "../../../lib/travelPayments";
import { isQPayConfigured } from "../../../lib/qpay";

const VALID: PaymentStatus[] = ["pending", "paid", "expired", "cancelled"];

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.payments");
  if (!allowed) return;

  if (req.method === "GET") {
    const [payments, stats] = await Promise.all([
      listPayments({ limit: 200 }),
      getPaymentStats(),
    ]);
    return res.status(200).json({
      ok: true,
      configured: isQPayConfigured(),
      payments,
      stats,
    });
  }

  if (req.method === "PATCH") {
    const { id, status } = req.body || {};
    const numId = Number(id);
    if (!Number.isFinite(numId) || numId <= 0) {
      return res.status(400).json({ error: "id required" });
    }
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: "invalid status" });
    }
    const ok = await updatePaymentStatus(numId, status as PaymentStatus);
    return res.status(ok ? 200 : 404).json({ ok });
  }

  return res.status(405).end();
}
