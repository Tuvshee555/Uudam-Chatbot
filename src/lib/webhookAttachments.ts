/**
 * Attachment handling for the Messenger webhook — extracted from webhook.ts
 * (over the 2,000-line cap).
 *
 * Covers: the fire-and-forget vision pipeline for customer-sent images
 * (payment receipts, passports, trip screenshots) and the ack path for
 * messages that arrive with attachments but no text.
 */
import { sendTextMessage } from "./messenger";
import { appendMessage } from "./conversation";
import { rateLimitAsync } from "./rateLimit";
import { scheduleCustomerMemoryUpdate } from "./conversationMemory";
import { scheduleCustomerAttachmentProcessing, scheduleCustomerImageProcessing, type FileAttachmentInput } from "./customerDocuments";
import { isPaused } from "./pause";
import { isPagePaused, listTrips } from "./travelOps";
import { buildStructuredTripReply } from "./travelFastPaths";
import { enforceWebsiteForPayment, sanitizeAssistantReply } from "./reply";
import type { Platform } from "./webhookDedup";
import {
  classifyError,
  hashIdentifier,
  logWarn,
  recordCounter,
} from "./observability";

const ATTACHMENT_LABELS: Record<string, string> = {
  image: "зураг",
  video: "видео",
  audio: "дуут мессеж",
  file: "файл",
};

export function extractImageAttachmentUrls(
  attachments: Array<{ type?: string; payload?: { url?: string } }>,
) {
  return attachments
    .filter((a) => a?.type === "image" && typeof a?.payload?.url === "string")
    .map((a) => String(a.payload?.url || "").trim())
    .filter((url) => url.startsWith("http"));
}

export function extractFileAttachmentInputs(
  attachments: Array<{
    type?: string;
    payload?: { url?: string };
    title?: string;
    name?: string;
    mime_type?: string;
  }>,
  base: Pick<FileAttachmentInput, "platform" | "senderId" | "pageId" | "trace">,
): FileAttachmentInput[] {
  return attachments
    .filter((a) => a?.type !== "image" && typeof a?.payload?.url === "string")
    .map((a) => ({
      ...base,
      url: String(a.payload?.url || "").trim(),
      attachmentType: String(a.type || "file"),
      fileName: typeof a.name === "string"
        ? a.name
        : typeof a.title === "string"
          ? a.title
          : undefined,
      mimeType: typeof a.mime_type === "string" ? a.mime_type : undefined,
    }))
    .filter((file) => file.url.startsWith("http"));
}

type ProcessedDocumentLike = {
  category: string;
  extracted_json?: Record<string, unknown>;
};

function readDocString(doc: ProcessedDocumentLike, section: string, field: string): string {
  const data = doc.extracted_json?.[section];
  if (!data || typeof data !== "object") return "";
  const value = (data as Record<string, unknown>)[field];
  return value == null || typeof value === "object" ? "" : String(value).trim();
}

/**
 * Category-aware confirmation sent AFTER the vision pipeline classified what
 * the customer sent. Only for documents a customer anxiously waits on
 * (payment receipt, passport, booking code, travel document) — trip
 * screenshots get their own matched-trip answer, misc images stay covered by
 * the generic ack alone.
 */
function buildDocumentReceivedMessage(docs: ProcessedDocumentLike[]): string | null {
  const categories = new Set(docs.map((doc) => doc.category));
  const received: string[] = [];
  if (categories.has("payment_screenshot")) {
    // Echoing the amount the system read makes the confirmation feel real
    // ("we saw your 4,180,000₮ transfer") and lets the customer correct a
    // misread immediately.
    const paymentDoc = docs.find((doc) => doc.category === "payment_screenshot");
    const amount = paymentDoc ? readDocString(paymentDoc, "payment", "amount") : "";
    const currency = paymentDoc ? readDocString(paymentDoc, "payment", "currency") : "";
    received.push(
      amount ? `${amount}${currency ? ` ${currency}` : ""} төлбөрийн баримт` : "төлбөрийн баримт",
    );
  }
  if (categories.has("passport")) received.push("паспортын зураг");
  if (categories.has("booking_code")) received.push("захиалгын код");
  if (categories.has("travel_document")) received.push("бичиг баримт");
  if (received.length === 0) return null;
  return `Таны илгээсэн ${received.join(", ")}-ыг хүлээн авч бүртгэлээ ✅ Манай аяллын зөвлөх шалгаад баталгаажуулна. Баярлалаа! 🙌`;
}

/**
 * A trip screenshot that resolved against the REAL catalog gets an instant
 * answer — the customer asking "what is this trip?" via screenshot receives
 * the same price/dates reply they'd get by typing the trip name, with no
 * staff involvement.
 */
async function buildMatchedTripReply(docs: ProcessedDocumentLike[]): Promise<string | null> {
  const matched = docs.find((doc) => {
    if (doc.category !== "trip_screenshot") return false;
    const match = doc.extracted_json?.trip_match;
    return Boolean(match && typeof match === "object" && (match as Record<string, unknown>).route_name);
  });
  if (!matched) return null;
  const routeName = String(
    (matched.extracted_json?.trip_match as Record<string, unknown>).route_name || "",
  ).trim();
  if (!routeName) return null;
  const trips = await listTrips({ limit: 5000 }).catch(() => []);
  const structured = trips.length > 0 ? buildStructuredTripReply(routeName, trips) : null;
  const intro = `Таны илгээсэн зураг манай «${routeName}» аялал байна ✨`;
  if (!structured) return intro;
  return `${intro}\n\n${enforceWebsiteForPayment(sanitizeAssistantReply(structured))}`;
}

/**
 * Fire-and-forget vision processing + post-classification confirmation. The
 * pipeline (download + Cloudinary + AI extraction per image) must NEVER sit
 * between the customer and their reply/ack — it used to be awaited inline,
 * stalling text replies for up to minutes and risking a killed function on
 * multi-image albums.
 */
export function scheduleImageDocumentPipeline(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  token?: string;
  imageUrls: string[];
  trace?: { requestId: string; correlationId: string };
}) {
  const { platform, senderId, pageId, token, imageUrls, trace } = input;
  if (imageUrls.length === 0) return;
  scheduleCustomerImageProcessing({
    platform,
    senderId,
    pageId,
    urls: imageUrls,
    trace,
    onProcessed: async (docs) => {
      scheduleCustomerMemoryUpdate({
        senderId,
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        source: "api.webhook.image_documents",
      });
      if (platform !== "facebook" || !token) return;
      const confirmation = buildDocumentReceivedMessage(docs);
      const tripReply = await buildMatchedTripReply(docs);
      if (!confirmation && !tripReply) return;
      // Pause state is re-checked at SEND time, not schedule time: a payment
      // receipt is exactly the moment staff jump in manually (operator echo
      // pauses the bot), and processing takes long enough for that to happen.
      // The document is still stored either way — only the bot's voice stops.
      if ((await isPagePaused(pageId)) || (await isPaused(senderId))) {
        recordCounter("webhook.document_received_suppressed_total", 1, { platform });
        return;
      }
      for (const message of [confirmation, tripReply].filter(
        (value): value is string => Boolean(value),
      )) {
        try {
          await sendTextMessage(senderId, message, token, {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.document_received",
          });
          await appendMessage(senderId, "assistant", message).catch(() => {});
        } catch (error) {
          logWarn("webhook.document_received_send_failed", {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            platform,
            pageId,
            senderHash: hashIdentifier(senderId),
            classification: classifyError(error),
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    },
  });
}

export function scheduleAttachmentDocumentPipeline(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  token?: string;
  attachments: Array<{
    type?: string;
    payload?: { url?: string };
    title?: string;
    name?: string;
    mime_type?: string;
  }>;
  trace?: { requestId: string; correlationId: string };
}) {
  const { platform, senderId, pageId, token, attachments, trace } = input;
  const imageUrls = extractImageAttachmentUrls(attachments);
  const files = extractFileAttachmentInputs(attachments, {
    platform,
    senderId,
    pageId,
    trace,
  });
  if (imageUrls.length === 0 && files.length === 0) return;
  scheduleCustomerAttachmentProcessing({
    platform,
    senderId,
    pageId,
    imageUrls,
    files,
    trace,
    onProcessed: async (docs) => {
      scheduleCustomerMemoryUpdate({
        senderId,
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        source: "api.webhook.attachments",
      });
      if (platform !== "facebook" || !token) return;
      const confirmation = buildDocumentReceivedMessage(docs);
      const tripReply = await buildMatchedTripReply(docs);
      if (!confirmation && !tripReply) return;
      if ((await isPagePaused(pageId)) || (await isPaused(senderId))) {
        recordCounter("webhook.document_received_suppressed_total", 1, { platform });
        return;
      }
      for (const message of [confirmation, tripReply].filter(
        (value): value is string => Boolean(value),
      )) {
        try {
          await sendTextMessage(senderId, message, token, {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.document_received",
          });
          await appendMessage(senderId, "assistant", message).catch(() => {});
        } catch (error) {
          logWarn("webhook.document_received_send_failed", {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            platform,
            pageId,
            senderHash: hashIdentifier(senderId),
            classification: classifyError(error),
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
    },
  });
}

/**
 * A message with attachments but no text. Record what arrived (so history and
 * long-term memory both know), and acknowledge it once so the customer never
 * feels ignored — the old behavior dropped these events entirely.
 */
export async function handleAttachmentOnlyMessage(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  token?: string;
  attachments: Array<{ type?: string; payload?: { url?: string } }>;
  trace?: { requestId: string; correlationId: string };
}) {
  const { platform, senderId, pageId, token, attachments, trace } = input;
  if (await isPagePaused(pageId)) return;
  if (await isPaused(senderId)) return;

  const kinds = Array.from(
    new Set(attachments.map((a) => ATTACHMENT_LABELS[a?.type || ""] || "файл")),
  );
  const storedImages = attachments
    .filter((a) => a?.type === "image" && typeof a?.payload?.url === "string")
    .map((a) => ({ type: "image" as const, url: String(a.payload?.url) }));
  await appendMessage(
    senderId,
    "user",
    `[Хэрэглэгч ${kinds.join(", ")} илгээсэн]`,
    storedImages,
  ).catch(() => {});
  // Document pipeline runs in the background — the customer gets the ack
  // immediately, then a category-aware confirmation once classification lands.
  scheduleAttachmentDocumentPipeline({
    platform,
    senderId,
    pageId,
    token,
    attachments,
    trace,
  });

  recordCounter("webhook.attachment_only_total", 1, {
    platform,
    kinds: kinds.join(","),
  });

  // Ack at most once per 2 minutes — an album arrives as several events and
  // must not trigger a burst of identical acknowledgements.
  const ackLimit = await rateLimitAsync(`attach_ack:${senderId}`, 1, 2 * 60 * 1000);
  if (!ackLimit.allowed || platform !== "facebook" || !token) {
    scheduleCustomerMemoryUpdate({
      senderId,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source: "api.webhook.attachment_only",
    });
    return;
  }
  const ack =
    "Илгээсэн зүйлийг тань хүлээн авлаа 🙌 Асуултаа бичгээр илгээвэл би шууд хариулъя. " +
    "Эсвэл утасны дугаараа үлдээвэл манай аяллын зөвлөх тантай холбогдоно 😊";
  try {
    await sendTextMessage(senderId, ack, token, {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source: "api.webhook.attachment_ack",
    });
    await appendMessage(senderId, "assistant", ack).catch(() => {});
  } catch (error) {
    logWarn("webhook.attachment_ack_failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
  scheduleCustomerMemoryUpdate({
    senderId,
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: "api.webhook.attachment_only",
  });
}
