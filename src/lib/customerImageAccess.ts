import { createHmac, timingSafeEqual } from "node:crypto";
import { getEnv } from "./env";
import type { CustomerDocument } from "./customerDocuments";
import type { HistoryRow } from "./travelSessionDb";

const LINK_TTL_SECONDS = 60 * 60;

function sign(message: string) {
  const secret = getEnv().adminSecret;
  if (!secret) throw new Error("admin_image_signing_unavailable");
  return createHmac("sha256", secret).update(message).digest("hex");
}

// A document link signs "<id>:<expires>"; an inbox attachment link signs
// "attachment:<row>:<index>:<expires>", so neither can be replayed as the other.
const documentMessage = (id: number, expires: number) => `${id}:${expires}`;
const attachmentMessage = (rowId: number, index: number, expires: number) => `attachment:${rowId}:${index}:${expires}`;

function verify(message: string, expires: number, candidate: string) {
  if (!getEnv().adminSecret) return false;
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(expires) || expires < now || expires > now + LINK_TTL_SECONDS
    || !/^[a-f0-9]{64}$/.test(candidate)) return false;
  return timingSafeEqual(Buffer.from(sign(message), "hex"), Buffer.from(candidate, "hex"));
}

const validId = (value: number) => Number.isSafeInteger(value) && value > 0;

export function customerImagePreviewUrl(id: number, now = Date.now()) {
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  return `/api/admin/customer-image?id=${id}&expires=${expires}&signature=${sign(documentMessage(id, expires))}`;
}

export function verifyCustomerImagePreview(id: number, expires: number, candidate: string) {
  return validId(id) && verify(documentMessage(id, expires), expires, candidate);
}

export function conversationAttachmentPreviewUrl(rowId: number, index: number, now = Date.now()) {
  const expires = Math.floor(now / 1000) + LINK_TTL_SECONDS;
  return `/api/admin/conversation-attachment?row=${rowId}&index=${index}&expires=${expires}&signature=${sign(attachmentMessage(rowId, index, expires))}`;
}

export function verifyConversationAttachmentPreview(rowId: number, index: number, expires: number, candidate: string) {
  return validId(rowId) && Number.isSafeInteger(index) && index >= 0 && index < 50
    && verify(attachmentMessage(rowId, index, expires), expires, candidate);
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

/**
 * The inbox's shape of a conversation: every attachment (a customer's photo or file, or a
 * trip photo the bot sent) is a signed link the server resolves to the private copy; the
 * Meta CDN, Cloudinary or Blob URL never reaches the browser.
 */
// In message text only file-CDN links go; a Facebook post a customer shares stays readable.
const FILE_CDN_HOST = /(?:^|\.)(?:cloudinary\.com|fbcdn\.net|fbsbx\.com|cdninstagram\.com|blob\.vercel-storage\.com)$/i;
const withoutFileCdnUrls = (text: string) => text.replace(URL_IN_TEXT, (url) => {
  try { return FILE_CDN_HOST.test(new URL(url).hostname) ? "" : url; } catch { return url; }
});

export function adminConversationMessages(messages: HistoryRow[]): HistoryRow[] {
  return messages.map((message) => ({
    ...message,
    text: withoutFileCdnUrls(message.text ?? ""),
    attachments: (message.attachments ?? []).map((attachment, index) => ({
      type: attachment.type,
      ...(attachment.caption ? { caption: attachment.caption } : {}),
      url: attachment.url ? conversationAttachmentPreviewUrl(message.id, index) : "",
    })),
  }));
}
