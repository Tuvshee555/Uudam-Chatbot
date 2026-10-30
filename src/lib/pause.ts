import {
  dbAutoHandoffSender,
  dbIsPaused,
  dbPauseReason,
  dbListPaused,
  dbListRecent,
  dbMarkGetStarted,
  dbPauseSender,
  dbResumeSender,
  dbStoreSenderName,
  dbTrackSender,
  type TrackedSender,
} from "./travelDb";

export type PausedRow = {
  sender_id: string;
  display_name?: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};
export type RecentSender = { sender_id: string; last_seen: string; display_name?: string };

export async function isPaused(senderId: string): Promise<boolean> {
  return dbIsPaused(senderId);
}

/** The active pause's reason, or null. "booked_customer" is the bot's own pause after a booking. */
export async function pauseReason(senderId: string): Promise<string | null> {
  return dbPauseReason(senderId);
}

/**
 * Marks a customer who has made a booking request, sent documents, asked for the
 * bank account or said they paid: waiting for a consultant, for three days.
 * It used to silence the bot (staff replies were invisible to the webhook,
 * 2026-10-06..08). The webhook now reads the thread and pauses for a real staff
 * reply ("operator_reply"), so this marker no longer silences: the bot keeps
 * helping and answers status questions from the lead (bookedFollowup.ts).
 * Scheduled re-engagement messages still skip these customers.
 */
export const BOOKED_CUSTOMER_PAUSE_MS = 3 * 24 * 60 * 60 * 1000;

export async function pauseBookedCustomer(senderId: string): Promise<void> {
  await dbPauseSender(senderId, BOOKED_CUSTOMER_PAUSE_MS, "booked_customer");
}

export async function pauseBot(
  senderId: string,
  durationMs?: number,
  reason?: string,
): Promise<void> {
  await dbPauseSender(senderId, durationMs, reason ?? "manual");
}

export async function resumeBot(senderId: string): Promise<void> {
  await dbResumeSender(senderId);
}

export async function listPaused(): Promise<PausedRow[]> {
  const rows = await dbListPaused();
  return rows.map((r) => ({
    sender_id: r.sender_id,
    display_name: r.display_name || undefined,
    paused_at: r.paused_at ?? new Date().toISOString(),
    expires_at: r.expires_at,
    reason: r.pause_reason || undefined,
  }));
}

export async function trackSender(
  senderId: string,
  platform = "facebook",
): Promise<TrackedSender> {
  return dbTrackSender(senderId, platform);
}

export async function markGetStarted(senderId: string, platform = "facebook"): Promise<void> {
  await dbMarkGetStarted(senderId, platform);
}

export async function autoHandoffSender(senderId: string): Promise<void> {
  await dbAutoHandoffSender(senderId);
}

export async function storeSenderName(senderId: string, name: string): Promise<void> {
  await dbStoreSenderName(senderId, name);
}

export async function listRecent(): Promise<RecentSender[]> {
  const rows = await dbListRecent();
  return rows.map((r) => ({
    sender_id: r.sender_id,
    last_seen: r.last_seen,
    display_name: r.display_name || undefined,
  }));
}
