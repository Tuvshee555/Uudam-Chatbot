import {
  dbAutoHandoffSender,
  dbIsPaused,
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

/**
 * A customer who has booked, sent documents, asked for the bank account or
 * said they paid belongs to staff from then on. The 60-minute handoff pause
 * let the bot return the next day and re-send the trip card over a staff
 * member's own replies (2026-10-06..08). Meta's staff-reply echoes do not
 * reach the webhook, so this cannot wait for an operator echo to pause it.
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
