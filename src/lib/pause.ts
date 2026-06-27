import {
  dbIsPaused,
  dbListPaused,
  dbListRecent,
  dbPauseSender,
  dbResumeSender,
  dbStoreSenderName,
  dbTrackSender,
} from "./travelDb";

export type PausedRow = {
  sender_id: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};
export type RecentSender = { sender_id: string; last_seen: string; display_name?: string };

export async function isPaused(senderId: string): Promise<boolean> {
  return dbIsPaused(senderId);
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
    paused_at: r.paused_at ?? new Date().toISOString(),
    expires_at: r.expires_at,
    reason: r.pause_reason || undefined,
  }));
}

export async function trackSender(
  senderId: string,
  platform = "facebook",
): Promise<{ auto_paused: boolean }> {
  return dbTrackSender(senderId, platform);
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
