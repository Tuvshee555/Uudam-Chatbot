import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";
import type { CustomerDocument } from "./customerDocuments";

function signature(id: number, expires: number) {
  const secret = getEnv().adminSecret;
  if (!secret) throw new Error("admin_image_signing_unavailable");
  return createHmac("sha256", secret)
    .update(`${id}:${expires}`)
    .digest("hex");
}

export function customerImagePreviewUrl(id: number, now = Date.now()) {
  const expires = Math.floor(now / 1000) + 60 * 60;
  return `/api/admin/customer-image?id=${id}&expires=${expires}&signature=${signature(id, expires)}`;
}

export function verifyCustomerImagePreview(id: number, expires: number, candidate: string) {
  if (!getEnv().adminSecret) return false;
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(expires)
    || expires < Math.floor(Date.now() / 1000) || expires > Math.floor(Date.now() / 1000) + 3600
    || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  const expected = Buffer.from(signature(id, expires), "hex");
  return timingSafeEqual(expected, Buffer.from(candidate, "hex"));
}

/**
 * Hosts whose URLs open a customer's file to anyone holding the link: our Cloudinary copies
 * (historical documents are still public there), Meta's attachment CDNs, Facebook links and
 * the Blob store's own URLs. None of them is ever returned to the admin page or API.
 */
const PUBLIC_FILE_HOST = /(?:^|\.)(?:cloudinary\.com|fbcdn\.net|fbsbx\.com|facebook\.com|fb\.com|messenger\.com|cdninstagram\.com|blob\.vercel-storage\.com)$/i;
const URL_IN_TEXT = /https?:\/\/[^\s"'<>]+/gi;

export function isPublicFileUrl(url: string): boolean {
  try { return PUBLIC_FILE_HOST.test(new URL(url).hostname); } catch { return false; }
}

/** Extracted data with those URLs removed at any depth; every other value is kept as it is. */
export function withoutPublicFileUrls(value: unknown): unknown {
  if (typeof value === "string") {
    if (!/https?:\/\//i.test(value)) return value;
    if (/^\s*https?:\/\/\S+\s*$/i.test(value) && isPublicFileUrl(value.trim())) return undefined;
    return value.replace(URL_IN_TEXT, (url) => (isPublicFileUrl(url) ? "" : url));
  }
  if (Array.isArray(value)) return value.map(withoutPublicFileUrls).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const kept = withoutPublicFileUrls(item);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  }
  return value;
}

/**
 * The only shape in which a customer document leaves the admin API: every stored file —
 * image, PDF, sheet, audio, video, private store or historical Cloudinary copy — is reached
 * through a signed, expiring admin link the server proxies. Raw source and storage URLs never
 * leave. For the historical documents this hides their Cloudinary URLs; it does not make
 * those files private (that needs the migration).
 */
export function adminCustomerDocument(doc: CustomerDocument): CustomerDocument {
  return {
    ...doc,
    source_url: "",
    stored_url: doc.stored_url ? customerImagePreviewUrl(doc.id) : "",
    attachment_id: "",
    event_key: "",
    extracted_json: (withoutPublicFileUrls(doc.extracted_json ?? {}) || {}) as Record<string, unknown>,
  };
}
