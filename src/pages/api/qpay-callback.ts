import type { NextApiRequest, NextApiResponse } from "next";
import { checkPayment, isPaidCheck, isQPayConfigured } from "../../lib/qpay";
import { markPaymentPaid } from "../../lib/travelPayments";
import { logInfo, logWarn, recordCounter } from "../../lib/observability";
import { getClientKey, rateLimitAsync } from "../../lib/rateLimit";

/**
 * QPay payment callback. QPay calls this URL when a customer pays an invoice.
 * If QPay is not configured (the default), this is a hard no-op — we never touch
 * the network and just return 200 so QPay (or anyone probing) gets a clean reply.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Feature off → silently accept and do nothing.
  if (!isQPayConfigured()) {
    return res.status(200).json({ ok: true, disabled: true });
  }

  // This endpoint is unauthenticated (QPay calls it with no shared secret) and
  // every hit triggers a real checkPayment() network round-trip to QPay, so it
  // needs its own guard against being hammered — per-IP and a global cap.
  const clientKey = getClientKey(req);
  const clientLimit = await rateLimitAsync(`qpay_callback:${clientKey}`, 20, 60 * 1000);
  if (!clientLimit.allowed) {
    recordCounter("abuse.rate_limited_total", 1, { route: "api.qpay_callback", scope: "client" });
    return res.status(429).json({ error: "rate_limited" });
  }
  const globalLimit = await rateLimitAsync("qpay_callback:global", 300, 60 * 1000);
  if (!globalLimit.allowed) {
    recordCounter("abuse.rate_limited_total", 1, { route: "api.qpay_callback", scope: "global" });
    return res.status(429).json({ error: "server_busy" });
  }

  const invoiceId =
    (typeof req.query.invoice_id === "string" && req.query.invoice_id) ||
    (typeof req.body?.invoice_id === "string" && req.body.invoice_id) ||
    "";

  if (!invoiceId) {
    return res.status(400).json({ error: "invoice_id required" });
  }

  try {
    // Confirm with QPay before trusting the callback (don't mark paid on hearsay).
    const check = await checkPayment(invoiceId);
    if (isPaidCheck(check)) {
      const updated = await markPaymentPaid(invoiceId);
      logInfo("qpay.callback.paid", { invoiceId, updated });
      return res.status(200).json({ ok: true, paid: true });
    }
    logInfo("qpay.callback.not_paid", { invoiceId });
    return res.status(200).json({ ok: true, paid: false });
  } catch (error) {
    logWarn("qpay.callback.error", {
      invoiceId,
      message: error instanceof Error ? error.message : String(error),
    });
    // Return 200 so QPay doesn't hammer retries; we logged it for follow-up.
    return res.status(200).json({ ok: false });
  }
}
