import type { NextApiRequest, NextApiResponse } from "next";
import { serveAdminFile } from "../../../lib/adminFileProxy";
import { resolveConversationAttachment } from "../../../lib/conversationAttachments";
import { verifyConversationAttachmentPreview } from "../../../lib/customerImageAccess";

/**
 * One inbox attachment behind a signed, expiring link (customerImageAccess.ts), resolved on
 * the server to its private copy (conversationAttachments.ts) and streamed; the browser never
 * gets the raw URL. 410: hidden by deletion/retention, or a Meta link that has expired.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const rowId = Number(req.query.row);
  const index = Number(req.query.index);
  if (!verifyConversationAttachmentPreview(rowId, index, Number(req.query.expires), String(req.query.signature || ""))) {
    return res.status(403).end();
  }
  const source = await resolveConversationAttachment(rowId, index);
  if (source.kind === "missing") return res.status(404).end();
  if (source.kind === "hidden") return res.status(410).end();
  const outcome = await serveAdminFile(res, { url: source.url, mimeType: source.mimeType });
  if (outcome === "not_found") return res.status(404).end();
  if (outcome === "unavailable") return res.status(410).end();
}
