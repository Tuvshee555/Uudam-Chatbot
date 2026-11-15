import { createHmac } from "node:crypto";
import { appSecretForToken, getEnv } from "./env";
import { GRAPH_API_BASE } from "./metaGraph";
import { isMetaOutboundDisabled, logMetaOutboundSuppressed } from "./metaOutboundKillSwitch";
import { BOT_MESSAGE_METADATA } from "./messenger";
import { assertBotMaySend } from "./takeoverGuard";
import { logError, logInfo } from "./observability";
import { isPosterPdfEndpointUrl } from "./poster/pdfUrl";

const GDRIVE_VIEW_RE = /drive\.google\.com\/file\/d\/([^/?#]+)/;
const FB_API_VERSION = "v19.0";

function toCloudinaryJpegUrl(url: string): string {
  if (!url.startsWith("https://res.cloudinary.com/")) return url;
  if (!url.includes("/image/upload/")) return url;
  if (url.includes("/image/upload/f_jpg,q_100/")) return url;
  return url.replace("/image/upload/", "/image/upload/f_jpg,q_100/");
}

/** Prefer the server's own file name, so Messenger labels the trip, not an id. */
function filenameFromDisposition(header: string | null): string {
  if (!header) return "";
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header)?.[1];
  const plain = /filename\s*=\s*"([^"]+)"/i.exec(header)?.[1];
  const raw = encoded ? decodeURIComponent(encoded.trim()) : plain?.trim() || "";
  const cleaned = raw.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || !cleaned.toLowerCase().endsWith(".pdf")) return "";
  return cleaned.slice(0, 100);
}

/**
 * Convert a Google Drive share/view URL to a direct-download URL and
 * download the PDF bytes on our server (bypassing the need for Facebook's
 * servers to access Drive, which they can't do reliably).
 *
 * Returns { buffer, filename } if the download is a valid PDF, or null if:
 * - The URL resolves to an HTML page (login wall, virus-scan confirmation)
 * - The first bytes are not %PDF
 * - Network/timeout errors
 */
async function downloadPdfBuffer(
  url: string,
  timeoutMs = 20_000,
): Promise<{ buffer: Buffer; filename: string } | null> {
  let resolvedUrl = url;
  let filename = "ayalal.pdf";

  const driveMatch = GDRIVE_VIEW_RE.exec(url);
  if (driveMatch) {
    const fileId = driveMatch[1];
    resolvedUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    filename = `drive-${fileId}.pdf`;
    logInfo("fbAttachmentUpload.gdrive_converted", { original: url, resolved: resolvedUrl });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const resp = await fetch(resolvedUrl, {
      signal: controller.signal,
      headers: {
        // Impersonate a browser so Drive serves the file directly without a confirmation page.
        "User-Agent": "Mozilla/5.0 (compatible; TravelBot/1.0)",
      },
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      logInfo("fbAttachmentUpload.pdf_download_not_ok", { url: resolvedUrl, status: resp.status });
      return null;
    }

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.startsWith("text/html")) {
      // Drive login wall or virus-scan confirmation page — not a PDF.
      logInfo("fbAttachmentUpload.pdf_download_html", { url: resolvedUrl, contentType });
      return null;
    }

    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // Check PDF magic bytes.
    if (buffer.length < 4 || buffer.slice(0, 4).toString("ascii") !== "%PDF") {
      logInfo("fbAttachmentUpload.pdf_download_bad_magic", {
        url: resolvedUrl,
        header: buffer.slice(0, 4).toString("ascii"),
        sizeBytes: buffer.length,
      });
      return null;
    }

    logInfo("fbAttachmentUpload.pdf_download_ok", {
      url: resolvedUrl,
      sizeBytes: buffer.length,
    });
    return { buffer, filename: filenameFromDisposition(resp.headers.get("content-disposition")) || filename };
  } catch (err) {
    logInfo("fbAttachmentUpload.pdf_download_error", {
      url: resolvedUrl,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * resolveAndValidatePdfUrl — kept for callers that only need to check a URL.
 * Downloads the first bytes and checks the PDF magic header. Returns the
 * resolved URL if valid, null otherwise.
 */
export async function resolveAndValidatePdfUrl(url: string): Promise<string | null> {
  const result = await downloadPdfBuffer(url);
  if (!result) return null;
  // Return the resolved (possibly converted Drive) URL.
  const driveMatch = GDRIVE_VIEW_RE.exec(url);
  if (driveMatch) {
    return `https://drive.google.com/uc?export=download&id=${driveMatch[1]}`;
  }
  return url;
}

/**
 * Build a clean PDF filename from a trip route name.
 */
export function pdfFilenameFromRoute(routeName: string): string {
  const slug = routeName
    .replace(/[–—]/g, "-")
    .replace(/[^a-zA-Z0-9а-яА-ЯөүёЁ\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${slug || "ayalal"}.pdf`;
}

/**
 * Uploads a PDF to the Facebook Reusable Attachment API.
 * Returns a permanent attachment_id that can be re-sent to any user
 * on the same page without re-uploading. Returns null on any error so
 * the caller (trip save) is never blocked.
 */
export async function uploadPdfToFacebook(
  base64Data: string,
  filename: string,
): Promise<string | null> {
  try {
    if (isMetaOutboundDisabled()) {
      logMetaOutboundSuppressed("fbAttachmentUpload.uploadPdfToFacebook");
      return null;
    }

    const env = getEnv();
    const token = env.facebookPages[0]?.token;
    if (!token) return null;

    const cleanBase64 = base64Data.includes(",")
      ? base64Data.slice(base64Data.indexOf(",") + 1)
      : base64Data;

    const buffer = Buffer.from(cleanBase64, "base64");
    const pdfFilename = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;

    const formData = new FormData();
    formData.append(
      "message",
      JSON.stringify({ attachment: { type: "file", payload: { is_reusable: true } } }),
    );
    formData.append("filedata", new Blob([buffer], { type: "application/pdf" }), pdfFilename);

    const resp = await fetch(
      `https://graph.facebook.com/${FB_API_VERSION}/me/message_attachments?access_token=${token}`,
      { method: "POST", body: formData },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("fbAttachmentUpload.failed", { status: resp.status, body: text, filename });
      return null;
    }

    const json = (await resp.json()) as { attachment_id?: string };
    return typeof json.attachment_id === "string" ? json.attachment_id : null;
  } catch (err) {
    logError("fbAttachmentUpload.error", {
      message: err instanceof Error ? err.message : String(err),
      filename,
    });
    return null;
  }
}

/**
 * Upload a PDF buffer directly to Facebook's attachment API.
 * Returns an attachment_id, or null on failure.
 */
async function uploadPdfBufferToFacebook(
  buffer: Buffer,
  filename: string,
  pageToken: string,
): Promise<string | null> {
  try {
    if (isMetaOutboundDisabled()) {
      logMetaOutboundSuppressed("fbAttachmentUpload.uploadPdfBufferToFacebook");
      return null;
    }

    const pdfFilename = filename.endsWith(".pdf") ? filename : `${filename}.pdf`;
    const formData = new FormData();
    formData.append(
      "message",
      JSON.stringify({ attachment: { type: "file", payload: { is_reusable: true } } }),
    );
    const arrayBuf: ArrayBuffer = buffer.buffer instanceof ArrayBuffer
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      : new Uint8Array(buffer).buffer;
    formData.append("filedata", new Blob([arrayBuf], { type: "application/pdf" }), pdfFilename);

    const resp = await fetch(
      `https://graph.facebook.com/${FB_API_VERSION}/me/message_attachments?access_token=${pageToken}`,
      { method: "POST", body: formData },
    );

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      logError("fbAttachmentUpload.buffer_upload_failed", {
        status: resp.status,
        body: text,
        filename,
      });
      return null;
    }

    const json = (await resp.json()) as { attachment_id?: string };
    return typeof json.attachment_id === "string" ? json.attachment_id : null;
  } catch (err) {
    logError("fbAttachmentUpload.buffer_upload_error", {
      message: err instanceof Error ? err.message : String(err),
      filename,
    });
    return null;
  }
}

async function downloadImageBuffer(
  url: string,
): Promise<{ buffer: Buffer; filename: string; contentType: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TravelBot/1.0)",
      },
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      logInfo("fbAttachmentUpload.image_download_not_ok", { url, status: resp.status });
      return null;
    }

    const contentType = (resp.headers.get("content-type") || "").toLowerCase();
    if (!contentType.startsWith("image/")) {
      logInfo("fbAttachmentUpload.image_download_bad_type", { url, contentType });
      return null;
    }

    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").pop() || "trip-image";
    return { buffer, filename, contentType };
  } catch (err) {
    logInfo("fbAttachmentUpload.image_download_error", {
      url,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function buildPdfFromImageUrl(
  imageUrl: string,
  fallbackFilename: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  let downloaded = await downloadImageBuffer(imageUrl);
  if (
    (!downloaded || (!downloaded.contentType.includes("png") && !downloaded.contentType.includes("jpeg") && !downloaded.contentType.includes("jpg"))) &&
    imageUrl.startsWith("https://res.cloudinary.com/")
  ) {
    downloaded = await downloadImageBuffer(toCloudinaryJpegUrl(imageUrl));
  }
  if (!downloaded) return null;

  try {
    const { PDFDocument } = await import("pdf-lib");
    const pdf = await PDFDocument.create();
    const isPng = downloaded.contentType.includes("png");
    const embedded = isPng
      ? await pdf.embedPng(downloaded.buffer)
      : await pdf.embedJpg(downloaded.buffer);
    const width = embedded.width;
    const height = embedded.height;
    const page = pdf.addPage([width, height]);
    page.drawImage(embedded, { x: 0, y: 0, width, height });
    const bytes = await pdf.save();
    const filename = fallbackFilename.endsWith(".pdf")
      ? fallbackFilename
      : `${fallbackFilename}.pdf`;
    return { buffer: Buffer.from(bytes), filename };
  } catch (err) {
    logError("fbAttachmentUpload.image_pdf_build_failed", {
      imageUrl,
      contentType: downloaded.contentType,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Sends a previously-uploaded reusable attachment to a Messenger recipient.
 * Returns true if the API accepted it.
 */
export async function sendFbFileAttachment(
  recipientId: string,
  attachmentId: string,
  pageToken: string,
): Promise<boolean> {
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed("fbAttachmentUpload.sendFbFileAttachment");
    return true;
  }
  // These senders post to /me/messages directly, so they were outside the send-time takeover guard
  // (messenger.ts): a consultant who answered between the text and the PDF still got the PDF under their
  // message. Throws StaffTakeoverSendBlocked, which ends the turn quietly (webhook.ts handleMessage).
  await assertBotMaySend(recipientId, { source: "fbAttachmentUpload.sendFbFileAttachment" });
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${FB_API_VERSION}/me/messages?access_token=${pageToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: {
            attachment: {
              type: "file",
              payload: { attachment_id: attachmentId },
            },
            // Must carry the bot tag: Meta echoes every Page-sent message back
            // to the webhook, and an untagged echo is treated as a HUMAN
            // operator reply, which pauses the bot for this customer. Without
            // it, sending a program PDF silenced the bot for the next 14 days.
            metadata: BOT_MESSAGE_METADATA,
          },
        }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Sends a PDF file to a Messenger recipient.
 *
 * For Google Drive URLs (which Facebook's servers cannot access directly),
 * we download the PDF on our own server and re-upload it to Facebook's
 * attachment API, then send the resulting attachment_id.
 *
 * For other publicly accessible URLs, we pass them directly to the
 * Facebook URL attachment API (Facebook fetches the file itself).
 *
 * Returns true if the message was delivered successfully.
 */
export async function sendFbFileByUrl(
  recipientId: string,
  fileUrl: string,
  pageToken: string,
): Promise<boolean> {
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed("fbAttachmentUpload.sendFbFileByUrl");
    return true;
  }
  // Before the (slow) download and upload, not after: a customer a consultant owns gets no file.
  await assertBotMaySend(recipientId, { source: "fbAttachmentUpload.sendFbFileByUrl" });

  const isGoogleDrive = GDRIVE_VIEW_RE.test(fileUrl);
  // Our poster endpoint renders the poster in a headless browser on a cold
  // cache, which outlasts Facebook's own fetch. Pull the bytes ourselves and
  // hand Facebook a finished upload instead.
  const isRenderedPoster = isPosterPdfEndpointUrl(fileUrl);

  if (isGoogleDrive || isRenderedPoster) {
    const downloaded = await downloadPdfBuffer(fileUrl, isRenderedPoster ? 45_000 : 20_000);
    if (!downloaded) {
      logError(
        isRenderedPoster
          ? "fbAttachmentUpload.poster_render_failed"
          : "fbAttachmentUpload.gdrive_download_failed",
        { fileUrl },
      );
      return false;
    }

    const attachmentId = await uploadPdfBufferToFacebook(
      downloaded.buffer,
      downloaded.filename,
      pageToken,
    );
    if (!attachmentId) {
      logError(
        isRenderedPoster
          ? "fbAttachmentUpload.poster_upload_failed"
          : "fbAttachmentUpload.gdrive_upload_failed",
        { fileUrl },
      );
      return false;
    }

    return sendFbFileAttachment(recipientId, attachmentId, pageToken);
  }

  // Non-Drive URL: let Facebook fetch it directly (simpler, no proxy needed).
  try {
    const resp = await fetch(
      `https://graph.facebook.com/${FB_API_VERSION}/me/messages?access_token=${pageToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipient: { id: recipientId },
          message: {
            attachment: {
              type: "file",
              payload: { url: fileUrl, is_reusable: false },
            },
            metadata: BOT_MESSAGE_METADATA,
          },
        }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function sendFbImageAsPdfByUrl(
  recipientId: string,
  imageUrl: string,
  pageToken: string,
  filenameBase: string,
): Promise<boolean> {
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed("fbAttachmentUpload.sendFbImageAsPdfByUrl");
    return true;
  }
  await assertBotMaySend(recipientId, { source: "fbAttachmentUpload.sendFbImageAsPdfByUrl" });
  const pdf = await buildPdfFromImageUrl(imageUrl, filenameBase);
  if (!pdf) {
    logError("fbAttachmentUpload.image_to_pdf_failed", { imageUrl, filenameBase });
    return false;
  }
  const attachmentId = await uploadPdfBufferToFacebook(
    pdf.buffer,
    pdf.filename,
    pageToken,
  );
  if (!attachmentId) {
    logError("fbAttachmentUpload.image_pdf_upload_failed", {
      imageUrl,
      filename: pdf.filename,
    });
    return false;
  }
  return sendFbFileAttachment(recipientId, attachmentId, pageToken);
}

// ── Detailed variants (corporate catalogue, src/lib/catalogue/send.ts) ───────────────────────────
// The functions above answer "did it work". A catalogue send must also know WHY it did not (Meta
// refused a cached attachment id, the 24-hour window closed, the token lacks permission) and which
// message id Meta gave the file, so each failure is logged machine-readably and a rejected id is
// uploaded again once. Additive: nothing above changed.

/** What one Meta call returned. `errorCode`/`errorSubcode` are Meta's own numbers. */
export type FbCallDetail = {
  ok: boolean;
  status: number | null;
  errorCode: number | null;
  errorSubcode: number | null;
  errorMessage: string | null;
  /** Outbound sends are switched off (kill switch / Vercel preview): nothing was sent. */
  suppressed?: boolean;
};
export type FbUploadDetail = FbCallDetail & { attachmentId: string | null };
export type FbSendDetail = FbCallDetail & { messageId: string | null; recipientId: string | null };

/** Why a file call failed, in the few classes a caller acts on differently. */
export type FbFailureClass = "attachment_rejected" | "window_closed" | "permission" | "rate_limited" | "transient" | "suppressed" | "other";

function graphUrl(path: string, token: string): string {
  const params = new URLSearchParams({ access_token: token });
  // The proof is only valid with the secret of the app that issued the token (env.ts).
  const secret = appSecretForToken(token);
  if (secret) params.set("appsecret_proof", createHmac("sha256", secret).update(token).digest("hex"));
  return `${GRAPH_API_BASE}${path}?${params.toString()}`;
}

async function readFbError(resp: Response): Promise<Pick<FbCallDetail, "errorCode" | "errorSubcode" | "errorMessage">> {
  const body = await resp.json().catch(() => null) as { error?: { message?: unknown; code?: unknown; error_subcode?: unknown } } | null;
  const error = body?.error;
  return {
    errorCode: typeof error?.code === "number" ? error.code : null,
    errorSubcode: typeof error?.error_subcode === "number" ? error.error_subcode : null,
    errorMessage: typeof error?.message === "string" ? error.message.slice(0, 300) : null,
  };
}

export function classifyFbFailure(detail: FbCallDetail): FbFailureClass {
  if (detail.suppressed) return "suppressed";
  const message = (detail.errorMessage || "").toLowerCase();
  // 10 / 2018278 and #551 are Meta's "outside the allowed window" and "person unavailable" answers.
  if (detail.errorCode === 10 || detail.errorSubcode === 2018278 || detail.errorCode === 551 || /outside of allowed window|allowed window/.test(message)) return "window_closed";
  if (detail.errorCode === 200 || detail.errorCode === 190 || detail.status === 401 || detail.status === 403) return "permission";
  if (detail.errorCode === 4 || detail.errorCode === 17 || detail.errorCode === 32 || detail.errorCode === 613 || detail.status === 429) return "rate_limited";
  if (detail.status === null || detail.status >= 500 || detail.errorCode === 1 || detail.errorCode === 2) return "transient";
  // A bad, expired or other-page attachment id: Meta says 100 (invalid parameter) with a message about the attachment.
  if (detail.errorCode === 100 || detail.status === 400) return /attachment|payload|media|file|url/.test(message) || detail.errorCode === 100 ? "attachment_rejected" : "other";
  return "other";
}

/** Upload PDF bytes as a reusable attachment. `ok` with an `attachmentId` is the only success. */
export async function uploadPdfBufferDetailed(buffer: Buffer, filename: string, pageToken: string): Promise<FbUploadDetail> {
  const none = { status: null, errorCode: null, errorSubcode: null, errorMessage: null };
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed("fbAttachmentUpload.uploadPdfBufferDetailed");
    return { ok: false, attachmentId: null, suppressed: true, ...none };
  }
  try {
    const pdfFilename = filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`;
    const formData = new FormData();
    formData.append("message", JSON.stringify({ attachment: { type: "file", payload: { is_reusable: true } } }));
    const arrayBuf: ArrayBuffer = buffer.buffer instanceof ArrayBuffer
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
      : new Uint8Array(buffer).buffer;
    formData.append("filedata", new Blob([arrayBuf], { type: "application/pdf" }), pdfFilename);
    const resp = await fetch(graphUrl("/me/message_attachments", pageToken), { method: "POST", body: formData });
    if (!resp.ok) {
      const error = await readFbError(resp);
      logError("fbAttachmentUpload.catalogue_upload_failed", { status: resp.status, errorCode: error.errorCode, errorSubcode: error.errorSubcode, sizeBytes: buffer.length });
      return { ok: false, attachmentId: null, status: resp.status, ...error };
    }
    const json = await resp.json().catch(() => null) as { attachment_id?: unknown } | null;
    const attachmentId = typeof json?.attachment_id === "string" && json.attachment_id ? json.attachment_id : null;
    return { ok: attachmentId !== null, attachmentId, status: resp.status, errorCode: null, errorSubcode: null, errorMessage: attachmentId ? null : "no attachment_id in response" };
  } catch (err) {
    logError("fbAttachmentUpload.catalogue_upload_error", { message: err instanceof Error ? err.name : "unknown", sizeBytes: buffer.length });
    return { ok: false, attachmentId: null, ...none, errorMessage: err instanceof Error ? err.name : "unknown" };
  }
}

/** The JSON body of a file send, exactly as it goes to Meta: tagged as the bot's own message (see sendFbFileAttachment). */
export function buildFbFileMessageBody(recipientId: string, source: { attachmentId: string } | { url: string }): Record<string, unknown> {
  return {
    recipient: { id: recipientId },
    messaging_type: "RESPONSE",
    message: {
      attachment: { type: "file", payload: "attachmentId" in source ? { attachment_id: source.attachmentId } : { url: source.url, is_reusable: false } },
      metadata: BOT_MESSAGE_METADATA,
    },
  };
}

/** Send an uploaded attachment; returns Meta's message id so the send can be logged and recognised as the bot's own. */
export async function sendFbFileAttachmentDetailed(recipientId: string, attachmentId: string, pageToken: string): Promise<FbSendDetail> {
  const none = { status: null, errorCode: null, errorSubcode: null, errorMessage: null, messageId: null, recipientId: null };
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed("fbAttachmentUpload.sendFbFileAttachmentDetailed");
    return { ok: false, suppressed: true, ...none };
  }
  try {
    const resp = await fetch(graphUrl("/me/messages", pageToken), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildFbFileMessageBody(recipientId, { attachmentId })),
    });
    if (!resp.ok) {
      const error = await readFbError(resp);
      logError("fbAttachmentUpload.catalogue_send_failed", { status: resp.status, errorCode: error.errorCode, errorSubcode: error.errorSubcode });
      return { ok: false, status: resp.status, messageId: null, recipientId: null, ...error };
    }
    const json = await resp.json().catch(() => null) as { message_id?: unknown; recipient_id?: unknown } | null;
    return {
      ok: true, status: resp.status, errorCode: null, errorSubcode: null, errorMessage: null,
      messageId: typeof json?.message_id === "string" ? json.message_id : null,
      recipientId: typeof json?.recipient_id === "string" ? json.recipient_id : null,
    };
  } catch (err) {
    logError("fbAttachmentUpload.catalogue_send_error", { message: err instanceof Error ? err.name : "unknown" });
    return { ok: false, ...none, errorMessage: err instanceof Error ? err.name : "unknown" };
  }
}
