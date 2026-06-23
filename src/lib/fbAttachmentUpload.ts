import { getEnv } from "./env";
import { logError } from "./observability";

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
