import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getHistory } from "../../../lib/conversation";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.conversation");
  if (!allowed) return;

  if (req.method !== "GET") return res.status(405).end();

  const { sender_id } = req.query;
  if (typeof sender_id !== "string" || !sender_id.trim()) {
    return res.status(400).json({ error: "sender_id required" });
  }

  const messages = await getHistory(sender_id.trim());
  return res.status(200).json({ ok: true, messages });
}
