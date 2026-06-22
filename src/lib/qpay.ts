/**
 * QPay client for Uudam — adapted from SelloAI's qpay.ts.
 *
 * SAFETY: QPay is OFF by default. It only activates when QPAY_ENABLED=true AND
 * all credentials are present. `isQPayConfigured()` is the single gate every
 * caller (and the admin UI) must check first. When it returns false, NOTHING in
 * this module runs against the network and the bot never learns QPay exists.
 *
 * No keys yet → leave QPAY_ENABLED unset/false. The payment table + admin
 * section still work in a read-only "disabled" state; nothing throws.
 */

import { getEnv } from "./env";

/**
 * The master gate. Returns true only when the feature is switched on AND every
 * required credential is present. Callers MUST check this before doing anything.
 */
export function isQPayConfigured(): boolean {
  const env = getEnv();
  return Boolean(
    env.qpayEnabled &&
      env.qpayBaseUrl &&
      env.qpayUsername &&
      env.qpayPassword &&
      env.qpayInvoiceCode,
  );
}

function requireConfig() {
  const env = getEnv();
  if (!isQPayConfigured()) {
    throw new Error("QPay is not configured (QPAY_ENABLED + credentials required)");
  }
  return {
    baseUrl: env.qpayBaseUrl as string,
    username: env.qpayUsername as string,
    password: env.qpayPassword as string,
    invoiceCode: env.qpayInvoiceCode as string,
  };
}

interface QPayToken {
  access_token: string;
  expires_in: number;
}

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const { baseUrl, username, password } = requireConfig();

  const res = await fetch(`${baseUrl}/auth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    },
  });
  if (!res.ok) throw new Error(`QPay auth failed: ${res.status}`);

  const data: QPayToken = await res.json();
  tokenCache = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return data.access_token;
}

export interface QPayInvoice {
  invoice_id: string;
  qr_text: string;
  qr_image: string;
  urls: Array<{ name: string; description: string; logo: string; link: string }>;
}

export async function createInvoice(params: {
  amount: number;
  description: string;
  callbackUrl: string;
  senderInvoiceNo: string;
}): Promise<QPayInvoice> {
  const { baseUrl, invoiceCode } = requireConfig();
  const token = await getToken();

  const res = await fetch(`${baseUrl}/invoice`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      invoice_code: invoiceCode,
      sender_invoice_no: params.senderInvoiceNo,
      invoice_receiver_code: "terminal",
      invoice_description: params.description,
      amount: params.amount,
      callback_url: params.callbackUrl,
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`QPay create invoice failed: ${res.status} ${err}`);
  }
  return res.json();
}

export interface QPayPaymentCheck {
  count: number;
  paid_amount: number;
  rows: Array<{
    payment_id: string;
    payment_status: string;
    payment_date: string;
    payment_amount: number;
  }>;
}

/**
 * Returns true if the invoice has at least one PAID row. Used by the callback
 * and any polling to confirm a payment landed.
 */
export async function checkPayment(invoiceId: string): Promise<QPayPaymentCheck> {
  const { baseUrl } = requireConfig();

  const doRequest = async (token: string) =>
    fetch(`${baseUrl}/payment/check`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ object_type: "INVOICE", object_id: invoiceId }),
    });

  let token = await getToken();
  let res = await doRequest(token);
  if (res.status === 401) {
    tokenCache = null;
    token = await getToken();
    res = await doRequest(token);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`QPay check payment failed: ${res.status} ${body}`);
  }
  return res.json();
}

export function isPaidCheck(check: QPayPaymentCheck): boolean {
  return (
    check.count > 0 &&
    check.rows.some((r) => (r.payment_status || "").toUpperCase() === "PAID")
  );
}

/** Reset the cached token (used in tests / after credential changes). */
export function resetQPayTokenCacheForTests() {
  tokenCache = null;
}
