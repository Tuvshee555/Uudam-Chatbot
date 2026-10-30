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

export function adminCustomerDocument(doc: CustomerDocument): CustomerDocument {
  if (!doc.mime_type?.startsWith("image/")) return doc;
  return {
    ...doc,
    source_url: "",
    stored_url: doc.stored_url ? customerImagePreviewUrl(doc.id) : "",
    attachment_id: "",
    event_key: "",
  };
}
