/**
 * Travel payment records (QPay). The table is created by ensureTravelSchema().
 * These helpers work whether or not QPay is configured — they only read/write
 * the local ledger. The actual QPay network calls live in qpay.ts and are gated
 * by isQPayConfigured().
 */

import { ensureTravelSchema } from "./travelOps";
import { queryNeon } from "./neonDb";

export type PaymentStatus = "pending" | "paid" | "expired" | "cancelled";

export type TravelPayment = {
  id: number;
  invoice_id: string;
  sender_invoice_no: string;
  platform: string;
  sender_id: string;
  customer_name: string;
  trip_name: string;
  amount: number;
  currency: string;
  status: PaymentStatus;
  qr_text: string;
  note: string;
  created_at: string;
  paid_at: string | null;
};

const VALID_STATUS = new Set<PaymentStatus>(["pending", "paid", "expired", "cancelled"]);

function coerceStatus(value: unknown): PaymentStatus {
  const s = String(value || "").toLowerCase();
  return VALID_STATUS.has(s as PaymentStatus) ? (s as PaymentStatus) : "pending";
}

function mapRow(row: Record<string, unknown>): TravelPayment {
  return {
    id: Number(row.id || 0),
    invoice_id: String(row.invoice_id || ""),
    sender_invoice_no: String(row.sender_invoice_no || ""),
    platform: String(row.platform || "facebook"),
    sender_id: String(row.sender_id || ""),
    customer_name: String(row.customer_name || ""),
    trip_name: String(row.trip_name || ""),
    amount: Number(row.amount || 0),
    currency: String(row.currency || "MNT"),
    status: coerceStatus(row.status),
    qr_text: String(row.qr_text || ""),
    note: String(row.note || ""),
    created_at: String(row.created_at || ""),
    paid_at: row.paid_at ? String(row.paid_at) : null,
  };
}

export async function createPaymentRecord(input: {
  invoiceId: string;
  senderInvoiceNo: string;
  platform?: string;
  senderId?: string;
  customerName?: string;
  tripName?: string;
  amount: number;
  currency?: string;
  qrText?: string;
  note?: string;
}): Promise<TravelPayment | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;

  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_payments (
        invoice_id, sender_invoice_no, platform, sender_id, customer_name,
        trip_name, amount, currency, status, qr_text, note
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9, $10)
      RETURNING *
    `,
    [
      input.invoiceId,
      input.senderInvoiceNo,
      input.platform || "facebook",
      input.senderId || "",
      input.customerName || "",
      input.tripName || "",
      Math.max(0, Math.trunc(input.amount)),
      input.currency || "MNT",
      input.qrText || "",
      input.note || "",
    ],
  );
  return result?.rows?.[0] ? mapRow(result.rows[0]) : null;
}

export async function markPaymentPaid(invoiceId: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `
      UPDATE travel_payments
      SET status = 'paid', paid_at = NOW()
      WHERE invoice_id = $1 AND status <> 'paid'
    `,
    [invoiceId],
  );
  return Boolean(result && result.rowCount && result.rowCount > 0);
}

export async function updatePaymentStatus(
  id: number,
  status: PaymentStatus,
): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const paidClause = status === "paid" ? ", paid_at = NOW()" : "";
  const result = await queryNeon(
    `UPDATE travel_payments SET status = $2${paidClause} WHERE id = $1`,
    [id, status],
  );
  return Boolean(result && result.rowCount && result.rowCount > 0);
}

export async function listPayments(options?: {
  status?: PaymentStatus;
  limit?: number;
}): Promise<TravelPayment[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const limit = Math.min(Math.max(Number(options?.limit || 100), 1), 500);
  const status = options?.status && VALID_STATUS.has(options.status) ? options.status : null;

  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT * FROM travel_payments
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [status, limit],
  );
  return result?.rows?.map(mapRow) || [];
}

export async function getPaymentStats(): Promise<{
  total: number;
  paid: number;
  pending: number;
  paidAmount: number;
}> {
  const ready = await ensureTravelSchema();
  if (!ready) return { total: 0, paid: 0, pending: 0, paidAmount: 0 };
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'paid')::int AS paid,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COALESCE(SUM(amount) FILTER (WHERE status = 'paid'), 0)::int AS paid_amount
      FROM travel_payments
    `,
  );
  const row = result?.rows?.[0];
  return {
    total: Number(row?.total || 0),
    paid: Number(row?.paid || 0),
    pending: Number(row?.pending || 0),
    paidAmount: Number(row?.paid_amount || 0),
  };
}
