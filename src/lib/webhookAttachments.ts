/**
 * Attachment handling for the Messenger webhook — extracted from webhook.ts
 * (over the 2,000-line cap).
 *
 * Covers: the fire-and-forget vision pipeline for customer-sent images
 * (payment receipts, passports, trip screenshots) and the ack path for
 * messages that arrive with attachments but no text.
 */
import { appendMessage } from "./conversation";
import { rateLimitAsync } from "./rateLimit";
import { scheduleCustomerMemoryUpdate } from "./conversationMemory";
import { scheduleCustomerAttachmentProcessing, scheduleCustomerImageProcessing, type FileAttachmentInput } from "./customerDocuments";
import { reserveCustomerImages, scheduleReservedCustomerImages } from "./customerImageIngest";
import { isPaused } from "./pause";
import { createLead, hasRecentOpenLead, isPagePaused, listTrips } from "./travelOps";
import { notifyStaffOfLead } from "./staffAlerts";
import type { AttachmentReplyPayload, Platform } from "./webhookDedup";
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
    id?: string;
    payload?: { url?: string; attachment_id?: string };
    title?: string;
    name?: string;
    mime_type?: string;
  }>,
  base: Pick<FileAttachmentInput, "platform" | "senderId" | "pageId" | "trace">,
): FileAttachmentInput[] {
  return attachments
    .filter((a) => a?.type !== "image" && !a?.mime_type?.startsWith("image/")
      && typeof a?.payload?.url === "string")
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

type AttachmentDelivery = (reply: AttachmentReplyPayload) => Promise<void>;

/**
 * Category-aware confirmation sent AFTER the vision pipeline classified what
 * the customer sent. Only for documents a customer anxiously waits on
 * (payment receipt, passport, booking code, travel document) — trip
 * screenshots get their own matched-trip answer, misc images stay covered by
 * the generic ack alone.
 */
export function buildDocumentReceivedMessage(docs: ProcessedDocumentLike[]): string | null {
  const categories = new Set(docs.map((doc) => doc.category));
  const received: string[] = [];
  if (categories.has("payment_screenshot")) {
    // Do not echo OCR-read amounts to the customer. A misread number can feel
    // like payment verification; staff see the amount in the review tab.
    received.push("төлбөрийн баримтыг");
  }
  // Each item carries its own accusative ending ("баримт-ыг" read as a typo to customers).
  if (categories.has("passport")) received.push("паспортын зургийг");
  if (categories.has("booking_code")) received.push("захиалгын кодыг");
  if (categories.has("travel_document")) received.push("бичиг баримтыг");
  if (received.length === 0) return null;
  const documents = received.join(", ");
  return `${documents[0].toUpperCase()}${documents.slice(1)} хүлээн авлаа. Зөвлөх шалгана.`;
}

/**
 * A trip screenshot that resolved against the REAL catalog gets an instant
 * answer — the customer asking "what is this trip?" via screenshot receives
 * a compact identification. Canonical facts and selection are checked at the
 * shared delivery boundary, not trusted from OCR text.
 */
export async function buildMatchedTripReply(docs: ProcessedDocumentLike[]): Promise<AttachmentReplyPayload | null> {
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
  const match = matched.extracted_json?.trip_match as Record<string, unknown>;
  const trips = await listTrips({ limit: 5000 });
  const exact = trips.filter((trip) => trip.route_name === routeName && (!match.id || trip.id === match.id));
  if (exact.length !== 1) return { reply: "REFER" };
  return { reply: routeName, tripId: exact[0].id };
}

async function deliverProcessedDocuments(input: {
  platform: Platform; senderId: string; pageId: string;
  trace?: { requestId: string; correlationId: string };
  deliverReply: AttachmentDelivery;
}, docs: ProcessedDocumentLike[]) {
  const { platform, senderId, pageId, trace } = input;
  scheduleCustomerMemoryUpdate({ senderId, requestId: trace?.requestId,
    correlationId: trace?.correlationId, source: "api.webhook.attachments" });
  await leadForUnmatchedTripScreenshot(docs, { platform, senderId, trace });
  if ((await isPagePaused(pageId)) || (await isPaused(senderId))) {
    recordCounter("webhook.document_received_suppressed_total", 1, { platform });
    return;
  }
  // One response per upload: sensitive documents go to staff; a trip poster
  // identifies its canonical trip without adding an unsolicited brochure.
  const confirmation = buildDocumentReceivedMessage(docs);
  const reply = confirmation ? { reply: confirmation, pauseAfter: true } : await buildMatchedTripReply(docs);
  if (!reply) return;
  try {
    await input.deliverReply(reply);
  } catch (error) {
    logWarn("webhook.document_received_send_failed", { requestId: trace?.requestId,
      correlationId: trace?.correlationId, platform, pageId, senderHash: hashIdentifier(senderId),
      classification: classifyError(error), message: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * A trip screenshot the catalog could not place is a question about a trip the bot cannot
 * answer: staff take it (owner's rule — silence plus a lead). It used to be treated like an
 * unrelated image, so a customer who sent the agency's own ad got neither a reply nor a
 * lead (2026-10-18).
 */
async function leadForUnmatchedTripScreenshot(
  docs: ProcessedDocumentLike[],
  input: { platform: Platform; senderId: string; trace?: { requestId: string; correlationId: string } },
) {
  const unmatched = docs.find((doc) => doc.category === "trip_screenshot" && !doc.extracted_json?.trip_match);
  if (!unmatched || docs.some((doc) => doc.category === "trip_screenshot" && doc.extracted_json?.trip_match)) return;
  try {
    if (await hasRecentOpenLead(input.senderId, "handoff")) return;
    const summary = typeof unmatched.extracted_json?.summary === "string" ? unmatched.extracted_json.summary : "";
    await createLead({
      kind: "handoff",
      platform: input.platform,
      senderId: input.senderId,
      customerMessage: "[Аяллын зураг]",
      context: `Хэрэглэгч аяллын зураг илгээсэн${summary ? ` (${summary})` : ""}, аль аялал болохыг бот тогтоож чадсангүй — «Ирсэн зургууд»-аас үзээд хариулна уу.`,
    });
    await notifyStaffOfLead(
      { kind: "handoff", platform: input.platform, customerMessage: "[Аяллын зураг]" },
      { requestId: input.trace?.requestId, correlationId: input.trace?.correlationId, source: "api.webhook.trip_screenshot_unmatched" },
    );
  } catch (error) {
    logWarn("webhook.trip_screenshot_lead_failed", {
      requestId: input.trace?.requestId,
      platform: input.platform,
      senderHash: hashIdentifier(input.senderId),
      classification: classifyError(error),
    });
  }
}

/**
 * Fire-and-forget vision processing + post-classification confirmation. The
 * pipeline (download + private storage + AI extraction per image) must NEVER sit
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
  deliverReply: AttachmentDelivery;
  trace?: { requestId: string; correlationId: string };
}) {
  const { platform, senderId, pageId, imageUrls, trace } = input;
  if (imageUrls.length === 0) return;
  scheduleCustomerImageProcessing({
    platform,
    senderId,
    pageId,
    urls: imageUrls,
    trace,
    onProcessed: (docs) => deliverProcessedDocuments(input, docs),
  });
}

export async function scheduleAttachmentDocumentPipeline(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  eventKey: string;
  timestamp?: number;
  token?: string;
  attachments: Array<{
    type?: string;
    id?: string;
    payload?: { url?: string; attachment_id?: string };
    title?: string;
    name?: string;
    mime_type?: string;
  }>;
  deliverReply: AttachmentDelivery;
  trace?: { requestId: string; correlationId: string };
}) {
  const { platform, senderId, pageId, attachments, trace } = input;
  // Persist each image before acknowledging the webhook. Slow byte transfer and
  // classification continue in waitUntil and can be retried from this receipt.
  const receipts = await reserveCustomerImages({
    platform, senderId, pageId, eventKey: input.eventKey,
    timestamp: input.timestamp, attachments,
  });
  const files = extractFileAttachmentInputs(attachments, {
    platform,
    senderId,
    pageId,
    trace,
  });
  if (receipts.length === 0 && files.length === 0) return;
  scheduleReservedCustomerImages(receipts, trace, (docs) => deliverProcessedDocuments(input, docs));
  if (files.length === 0) return;
  scheduleCustomerAttachmentProcessing({
    platform,
    senderId,
    pageId,
    imageUrls: [],
    files,
    trace,
    onProcessed: (docs) => deliverProcessedDocuments(input, docs),
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
  eventKey: string;
  timestamp?: number;
  token?: string;
  attachments: Array<{ type?: string; id?: string; mime_type?: string;
    payload?: { url?: string; attachment_id?: string } }>;
  deliverReply: AttachmentDelivery;
  trace?: { requestId: string; correlationId: string };
}) {
  const { platform, senderId, pageId, token, attachments, trace } = input;
  const kinds = Array.from(
    new Set(attachments.map((a) => a?.mime_type?.startsWith("image/")
      ? "зураг" : ATTACHMENT_LABELS[a?.type || ""] || "файл")),
  );
  const storedAttachments = attachments
    .filter((a) => typeof a?.payload?.url === "string")
    .map((a) => ({ type: a.type === "image" || a.mime_type?.startsWith("image/")
      ? "image" as const : "file" as const, url: String(a.payload?.url) }));
  await appendMessage(
    senderId,
    "user",
    `[Хэрэглэгч ${kinds.join(", ")} илгээсэн]`,
    storedAttachments,
  );
  await scheduleAttachmentDocumentPipeline({
    platform, senderId, pageId, token,
    eventKey: input.eventKey, timestamp: input.timestamp,
    attachments, deliverReply: input.deliverReply, trace,
  });
  // Staff still need the image while the bot is muted. Storage continues;
  // post-classification replies are suppressed by deliverProcessedDocuments.
  if (await isPagePaused(pageId)) return;
  if (await isPaused(senderId)) return;

  recordCounter("webhook.attachment_only_total", 1, {
    platform,
    kinds: kinds.join(","),
  });

  const hasFileLikeAttachment = attachments.some((attachment) => attachment?.type !== "image"
    && !attachment?.mime_type?.startsWith("image/"));
  if (!hasFileLikeAttachment) {
    // Image-only messages can be unknown screenshots. The background pipeline
    // will send a category-specific confirmation for payment/passport/booking
    // docs or a matched-trip answer; unrelated images stay silent.
    scheduleCustomerMemoryUpdate({
      senderId,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source: "api.webhook.attachment_only",
    });
    return;
  }

  // The bot cannot listen to a voice note, but staff can. It used to get the
  // generic "write it in text" ack and nothing else — a paying customer sent a
  // dozen voice notes over a week that no alert ever pointed staff to.
  const isVoiceNote = attachments.some((attachment) => attachment?.type === "audio");
  if (isVoiceNote) {
    try {
      if (!(await hasRecentOpenLead(senderId, "handoff"))) {
        await createLead({
          kind: "handoff",
          platform,
          senderId,
          customerMessage: "[Дуут мессеж]",
          context: "Хэрэглэгч дуут мессеж илгээсэн — бот сонсож чадахгүй тул зөвлөх сонсоод хариулна уу.",
        });
        await notifyStaffOfLead(
          { kind: "handoff", platform, customerMessage: "[Дуут мессеж]" },
          { requestId: trace?.requestId, correlationId: trace?.correlationId, source: "api.webhook.voice_note" },
        );
      }
    } catch (error) {
      logWarn("webhook.voice_note_lead_failed", {
        requestId: trace?.requestId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
  }

  // Ack file-like uploads at most once per 2 minutes — an album arrives as
  // several events and must not trigger a burst of identical acknowledgements.
  // Voice notes: once per 6 hours; the same line after every note reads as a wall.
  const ackLimit = await rateLimitAsync(
    `attach_ack:${isVoiceNote ? "voice:" : ""}${senderId}`,
    1,
    isVoiceNote ? 6 * 60 * 60 * 1000 : 2 * 60 * 1000,
  );
  if (!ackLimit.allowed || platform !== "facebook" || !token) {
    scheduleCustomerMemoryUpdate({
      senderId,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source: "api.webhook.attachment_only",
    });
    return;
  }
  const ack = isVoiceNote ? "Дуут мессеж хүлээн авлаа." : "Файл хүлээн авлаа.";
  try {
    await input.deliverReply({ reply: ack });
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
