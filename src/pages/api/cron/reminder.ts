import type { NextApiRequest, NextApiResponse } from "next";
import { dbClaimReminder, dbGetPendingReminders } from "../../../lib/travelOps";
import { sendTextMessage, sendImageMessage } from "../../../lib/messenger";
import { getEnv } from "../../../lib/env";
import { getTravelBotSettings } from "../../../lib/travelOps";

// Vercel cron secret — must match CRON_SECRET env var
function isCronAuthorized(req: NextApiRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured = allow (dev mode)
  return req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).end();
  if (!isCronAuthorized(req)) return res.status(401).json({ error: "unauthorized" });

  const env = getEnv();
  const token = env.facebookPages[0]?.token ?? env.tokenPage;
  const pageId = env.facebookPages[0]?.pageId ?? "";

  if (!token || !pageId) {
    return res.status(200).json({ ok: false, reason: "no page token" });
  }

  // Load reminder config from bot settings extra field
  const settings = await getTravelBotSettings();
  const extra = (settings?.extra ?? {}) as Record<string, unknown>;
  const reminderText = typeof extra.reminder_text === "string" && extra.reminder_text.trim()
    ? extra.reminder_text.trim()
    : null;
  const reminderPhotoUrl = typeof extra.reminder_photo_url === "string" && extra.reminder_photo_url.trim()
    ? extra.reminder_photo_url.trim()
    : null;

  // Must have at least text or photo configured
  if (!reminderText && !reminderPhotoUrl) {
    return res.status(200).json({ ok: false, reason: "no reminder_text or reminder_photo_url in bot settings extra" });
  }

  const candidates = await dbGetPendingReminders();

  let sent = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const candidate of candidates) {
    // Atomic claim — prevents double-send if cron overlaps
    const claimed = await dbClaimReminder(candidate.sender_id);
    if (!claimed) { skipped++; continue; }

    try {
      // Send photo first (if configured), then text
      if (reminderPhotoUrl) {
        await sendImageMessage(candidate.sender_id, reminderPhotoUrl, token);
      }
      if (reminderText) {
        await sendTextMessage(candidate.sender_id, reminderText, token);
      }
      sent++;
    } catch (e) {
      errors.push(`${candidate.sender_id.slice(-6)}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return res.status(200).json({
    ok: true,
    candidates: candidates.length,
    sent,
    skipped,
    errors: errors.slice(0, 10),
  });
}
