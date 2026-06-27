/**
 * Internal endpoint: download a PDF brochure and forward it to a Messenger user.
 *
 * Called fire-and-forget from the webhook after the main reply is sent, so the
 * webhook can return 200 to Meta immediately without waiting for the (slow)
 * Drive download + Facebook upload cycle.
 *
 * POST body: { recipientId, brochureUrl, pageToken }
 * Authorization: shared secret via WEBHOOK_VERIFY_TOKEN header.
 */
import type { NextApiRequest, NextApiResponse } from "next";
import { sendFbFileAttachment, sendFbFileByUrl } from "../../lib/fbAttachmentUpload";
import { getEnv } from "../../lib/env";
import { logError, logInfo } from "../../lib/observability";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const env = getEnv();
  // Protect with the same verify token already in env.
  const authHeader = req.headers["x-internal-token"];
  if (authHeader !== env.verifyToken) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const { recipientId, brochureUrl, brochureId, pageToken } = req.body as {
    recipientId?: string;
    brochureUrl?: string;
    brochureId?: string;
    pageToken?: string;
  };

  if (!recipientId || (!brochureUrl && !brochureId) || !pageToken) {
    return res.status(400).json({ error: "missing_fields" });
  }

  // Respond immediately so the caller (webhook) isn't blocked.
  res.status(202).json({ ok: true });

  // Do the heavy work after responding.
  try {
    let ok = false;
    if (brochureId) {
      ok = await sendFbFileAttachment(recipientId, brochureId, pageToken);
    } else if (brochureUrl) {
      ok = await sendFbFileByUrl(recipientId, brochureUrl, pageToken);
    }
    logInfo("send-brochure.result", { recipientId, ok, brochureUrl, brochureId });
  } catch (err) {
    logError("send-brochure.error", {
      message: err instanceof Error ? err.message : String(err),
      recipientId,
      brochureUrl,
    });
  }
}
