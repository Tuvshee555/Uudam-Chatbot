import { getEnv } from "./env";
import { logError, logInfo } from "./observability";

const GDRIVE_VIEW_RE = /drive\.google\.com\/file\/d\/([^/?#]+)/;
const FB_API_VERSION = "v19.0";

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
    const timer = setTimeout(() => controller.abort(), 20_000);
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
    return { buffer, filename };
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

/**
 * Sends a previously-uploaded reusable attachment to a Messenger recipient.
 * Returns true if the API accepted it.
 */
export async function sendFbFileAttachment(
  recipientId: string,
  attachmentId: string,
  pageToken: string,
): Promise<boolean> {
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
  const isGoogleDrive = GDRIVE_VIEW_RE.test(fileUrl);

  if (isGoogleDrive) {
    // Facebook cannot access Google Drive URLs — download on our server then upload.
    const downloaded = await downloadPdfBuffer(fileUrl);
    if (!downloaded) {
      logError("fbAttachmentUpload.gdrive_download_failed", { fileUrl });
      return false;
    }

    const attachmentId = await uploadPdfBufferToFacebook(
      downloaded.buffer,
      downloaded.filename,
      pageToken,
    );
    if (!attachmentId) {
      logError("fbAttachmentUpload.gdrive_upload_failed", { fileUrl });
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
          },
        }),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}
