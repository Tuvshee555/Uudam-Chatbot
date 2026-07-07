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
  // PSIDs are page-scoped: a sender who messaged page B does not exist for
  // page A's token. travel_senders doesn't record which page a sender belongs
  // to, so each reminder tries every configured page token until one succeeds
  // — deterministic, since exactly one page owns any given PSID.
  const pageTokens = env.facebookPages.map((p) => p.token).filter(Boolean);
  if (pageTokens.length === 0 && env.tokenPage) pageTokens.push(env.tokenPage);

  if (pageTokens.length === 0) {
    return res.status(200).json({ ok: false, reason: "no page token" });
  }

  // Load reminder config from bot settings extra field
  const settings = await getTravelBotSettings();
  const extra = (settings?.extra ?? {}) as Record<string, unknown>;

  // Admin-controlled on/off switch (Bot tab). Defaults to enabled only when
  // text/photo were configured before this switch existed, so nothing that
  // was already live silently starts firing again after an unrelated deploy —
  // but once the admin has touched the toggle, their choice always wins.
  if (extra.reminder_enabled === false) {
    return res.status(200).json({ ok: false, reason: "reminder disabled in bot settings" });
  }

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

    let delivered = false;
    let lastError: unknown = null;
    for (const token of pageTokens) {
      try {
        // Send photo first (if configured), then text
        if (reminderPhotoUrl) {
          await sendImageMessage(candidate.sender_id, reminderPhotoUrl, token);
        }
        if (reminderText) {
          await sendTextMessage(candidate.sender_id, reminderText, token);
        }
        delivered = true;
        break;
      } catch (e) {
        // Wrong page for this PSID (or transient failure) — try the next page.
        lastError = e;
      }
    }
    if (delivered) {
      sent++;
    } else {
      errors.push(
        `${candidate.sender_id.slice(-6)}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
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
