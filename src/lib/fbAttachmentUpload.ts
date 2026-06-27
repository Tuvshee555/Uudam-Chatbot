import { getEnv } from "./env";
import { logError, logInfo } from "./observability";

const GDRIVE_VIEW_RE = /drive\.google\.com\/file\/d\/([^/?#]+)/;

/**
 * Convert a Google Drive share/view URL to a direct-download URL, then validate
 * that the resolved URL actually serves a PDF (not an HTML page).
 *
 * Returns the cleaned direct-download URL, or null if:
 * - The URL is a non-public Drive file (login wall)
 * - The response Content-Type is text/html (HTML page instead of PDF)
 * - The first bytes are not a PDF header (%PDF)
 * - Network/timeout errors
 */
export async function resolveAndValidatePdfUrl(url: string): Promise<string | null> {
  let resolvedUrl = url;

  const driveMatch = GDRIVE_VIEW_RE.exec(url);
  if (driveMatch) {
    const fileId = driveMatch[1];
    resolvedUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    logInfo("fbAttachmentUpload.gdrive_converted", { original: url, resolved: resolvedUrl });
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    const resp = await fetch(resolvedUrl, {
      method: "GET",
      signal: controller.signal,
      headers: { "Range": "bytes=0-511" },
    }).finally(() => clearTimeout(timer));

    if (!resp.ok) {
      logInfo("fbAttachmentUpload.pdf_validate_not_ok", { url: resolvedUrl, status: resp.status });
      return null;
    }

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.startsWith("text/html")) {
      logInfo("fbAttachmentUpload.pdf_validate_html", { url: resolvedUrl, contentType });
      return null;
    }

    const buf = await resp.arrayBuffer();
    const header = Buffer.from(buf.slice(0, 4)).toString("ascii");
    if (!header.startsWith("%PDF")) {
      logInfo("fbAttachmentUpload.pdf_validate_bad_magic", { url: resolvedUrl, header });
      return null;
    }

    return resolvedUrl;
  } catch (err) {
    logInfo("fbAttachmentUpload.pdf_validate_error", {
      url: resolvedUrl,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build a clean PDF filename from a trip route name.
 * e.g. "Бээжин - Жинин - Жанжакоу - Эрээн - 4 хотын аялал" → "beezhyn-zhinyn-4-hotin-ayalal.pdf"
 * We keep it ASCII-safe for Messenger by replacing Cyrillic with a simple slug.
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

const FB_API_VERSION = "v19.0";

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
 * Sends a file by URL directly to a Messenger recipient.
 *
 * Before sending, resolves and validates the URL:
 * - Google Drive /view links are converted to direct-download /uc?export=download URLs.
 * - The resolved URL is fetched to confirm it serves an actual PDF (%PDF magic bytes,
 *   not an HTML page). If validation fails, returns false without sending.
 *
 * Returns true if the Messenger API accepted the message.
 */
export async function sendFbFileByUrl(
  recipientId: string,
  fileUrl: string,
  pageToken: string,
): Promise<boolean> {
  try {
    const validUrl = await resolveAndValidatePdfUrl(fileUrl);
    if (!validUrl) {
      logError("fbAttachmentUpload.sendFbFileByUrl_invalid_pdf", { fileUrl });
      return false;
    }

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
              payload: { url: validUrl, is_reusable: false },
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
