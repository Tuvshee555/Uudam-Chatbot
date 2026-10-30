import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getFullHistory } from "../../../lib/conversation";
import { adminConversationMessages } from "../../../lib/customerImageAccess";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.conversation");
  if (!allowed) return;

  if (req.method !== "GET") return res.status(405).end();

  const { sender_id } = req.query;
  if (typeof sender_id !== "string" || !sender_id.trim()) {
    return res.status(400).json({ error: "sender_id required" });
  }

  // Attachments leave only as signed links (customerImageAccess.ts), never Meta CDN URLs.
  const messages = adminConversationMessages(await getFullHistory(sender_id.trim()));
  return res.status(200).json({ ok: true, messages });
}
