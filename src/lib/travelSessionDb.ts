/**
 * Neon-backed conversation & sender-session state.
 *
 * Extracted from travelDb.ts (over the 2,000-line cap). Covers chat history,
 * per-sender activity/pause tracking, greeting/goodbye/reminder/season claims,
 * and handoff. Depends only on the Neon client and the schema bootstrap — no
 * other travelDb function — so the split is a clean leaf. Re-exported from
 * travelDb.ts so existing importers keep working unchanged.
 */

import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";

const MAX_HISTORY_ROWS = 50;
const HISTORY_TTL_DAYS = 90;

export type ChatAttachment = {
  type: "image";
  url: string;
  caption?: string;
};

export type HistoryRow = {
  id: number;
  role: "user" | "assistant";
  text: string;
  attachments: ChatAttachment[];
  created_at: string;
};

export type CustomerMemoryRow = {
  sender_id: string;
  memory_text: string;
  last_conversation_id: number;
  updated_at: string;
};

export async function dbGetHistory(
  senderId: string,
): Promise<HistoryRow[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const result = await queryNeon<{
    id: number;
    role: string;
    text: string;
    attachments: unknown;
    created_at: string;
  }>(
    `SELECT id, role, text, attachments, created_at FROM travel_conversations
     WHERE sender_id = $1
       AND created_at > NOW() - INTERVAL '${HISTORY_TTL_DAYS} days'
     ORDER BY id DESC
     LIMIT $2`,
    [senderId, MAX_HISTORY_ROWS],
  );
  if (!result) return [];
  return result.rows.reverse().map((r) => ({
    id: Number(r.id),
    role: r.role as "user" | "assistant",
    text: r.text,
    attachments: Array.isArray(r.attachments) ? (r.attachments as ChatAttachment[]) : [],
    created_at: r.created_at,
  }));
}

export async function dbGetHistorySince(
  senderId: string,
  afterConversationId: number,
  limit = 80,
): Promise<HistoryRow[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const result = await queryNeon<{
    id: number;
    role: string;
    text: string;
    attachments: unknown;
    created_at: string;
  }>(
    `SELECT id, role, text, attachments, created_at FROM travel_conversations
     WHERE sender_id = $1
       AND id > $2
     ORDER BY id ASC
     LIMIT $3`,
    [senderId, Math.max(0, Math.trunc(afterConversationId || 0)), safeLimit],
  );
  if (!result) return [];
  return result.rows.map((r) => ({
    id: Number(r.id),
    role: r.role as "user" | "assistant",
    text: r.text,
    attachments: Array.isArray(r.attachments) ? (r.attachments as ChatAttachment[]) : [],
    created_at: r.created_at,
  }));
}

export async function dbAppendMessage(
  senderId: string,
  role: "user" | "assistant",
  text: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  await queryNeon(
    `INSERT INTO travel_conversations (sender_id, role, text, attachments) VALUES ($1, $2, $3, $4)`,
    [senderId, role, text, JSON.stringify(attachments)],
  );
  // Prune ONLY rows that are BOTH past the retention window AND already
  // folded into the customer's long-term memory (id <= memory cursor).
  // The old "keep last 50" delete permanently destroyed conversation content
  // that the memory system had not processed yet (e.g. after a failed merge),
  // which is exactly the silent forgetting this replaces. A row the memory
  // hasn't seen is never deleted, no matter how old.
  await queryNeon(
    `DELETE FROM travel_conversations c
     WHERE c.sender_id = $1
       AND c.created_at < NOW() - INTERVAL '${HISTORY_TTL_DAYS} days'
       AND c.id <= COALESCE(
         (SELECT m.last_conversation_id FROM travel_customer_memories m
          WHERE m.sender_id = $1),
         0
       )`,
    [senderId],
  );
}

export async function dbGetCustomerMemory(
  senderId: string,
): Promise<CustomerMemoryRow | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<CustomerMemoryRow>(
    `SELECT sender_id, memory_text, last_conversation_id, updated_at
     FROM travel_customer_memories
     WHERE sender_id = $1`,
    [senderId],
  );
  const row = result?.rows[0];
  if (!row) return null;
  return {
    sender_id: row.sender_id,
    memory_text: row.memory_text || "",
    last_conversation_id: Number(row.last_conversation_id || 0),
    updated_at: row.updated_at,
  };
}

export async function dbUpsertCustomerMemory(input: {
  senderId: string;
  memoryText: string;
  lastConversationId: number;
}): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  await queryNeon(
    `INSERT INTO travel_customer_memories (sender_id, memory_text, last_conversation_id, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (sender_id) DO UPDATE
       SET memory_text = EXCLUDED.memory_text,
           last_conversation_id = GREATEST(travel_customer_memories.last_conversation_id, EXCLUDED.last_conversation_id),
           updated_at = NOW()
     WHERE travel_customer_memories.last_conversation_id <= EXCLUDED.last_conversation_id`,
    [input.senderId, input.memoryText, Math.max(0, Math.trunc(input.lastConversationId || 0))],
  );
}

// ----------------------------------------------------------------
// Neon-backed per-sender pause + activity tracking
// ----------------------------------------------------------------
export const AUTO_PAUSE_RESET_DAYS = 14;

export type SenderRow = {
  sender_id: string;
  platform: string;
  display_name: string;
  last_seen: string;
  msg_count: number;
  paused: boolean;
  pause_reason: string;
  paused_at: string | null;
  expires_at: string | null;
};

export async function dbTrackSender(
  senderId: string,
  platform = "facebook",
): Promise<{ msg_count: number; prev_msg_at: string | null }> {
  const ready = await ensureTravelSchema();
  if (!ready) return { msg_count: 0, prev_msg_at: null };
  const result = await queryNeon<{ msg_count: number; prev_msg_at: string | null }>(
    `INSERT INTO travel_senders (sender_id, platform, last_seen, msg_count, last_msg_at, updated_at)
     VALUES ($1, $2, NOW(), 1, NOW(), NOW())
     ON CONFLICT (sender_id) DO UPDATE
       SET last_seen   = NOW(),
           platform    = EXCLUDED.platform,
           msg_count   = travel_senders.msg_count + 1,
           updated_at  = NOW()
     RETURNING msg_count, last_msg_at AS prev_msg_at`,
    [senderId, platform],
  );
  // Update last_msg_at AFTER reading the old value (so we get the gap)
  await queryNeon(
    `UPDATE travel_senders SET last_msg_at = NOW() WHERE sender_id = $1`,
    [senderId],
  );
  const row = result?.rows[0];
  return {
    msg_count: row ? Number(row.msg_count) : 0,
    prev_msg_at: row?.prev_msg_at ? String(row.prev_msg_at) : null,
  };
}

// Returns true if this is the first-ever message from this sender (greeting not yet sent).
// Atomically marks greeting as sent so concurrent requests can't double-send.
export async function dbClaimGreeting(senderId: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon<{ claimed: boolean }>(
    `UPDATE travel_senders
     SET greeting_sent = TRUE, updated_at = NOW()
     WHERE sender_id = $1 AND greeting_sent = FALSE
     RETURNING TRUE AS claimed`,
    [senderId],
  );
  return (result?.rows[0]?.claimed) === true;
}

// Returns true if we should send the goodbye message now (not sent in the last 2 days).
// Atomically sets goodbye_sent_at so it won't fire again within the cooldown window.
export async function dbClaimGoodbye(senderId: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const FOURTEEN_DAYS_AGO = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const result = await queryNeon<{ claimed: boolean }>(
    `UPDATE travel_senders
     SET goodbye_sent_at = NOW(), updated_at = NOW()
     WHERE sender_id = $1
       AND (goodbye_sent_at IS NULL OR goodbye_sent_at < $2)
     RETURNING TRUE AS claimed`,
    [senderId, FOURTEEN_DAYS_AGO],
  );
  return (result?.rows[0]?.claimed) === true;
}

export type ReminderCandidate = {
  sender_id: string;
  platform: string;
  last_msg_at: string;
};

// Returns all senders eligible for a follow-up reminder:
// - last_msg_at is between 12h and 24h ago. Messages here use
//   messaging_type RESPONSE, which Facebook only accepts inside the 24h
//   window from the user's last message — the window can widen toward 12h
//   but must never approach/exceed 24h. Widened from the ideal 23-24h
//   because Vercel Hobby crons only run once daily, so a single run must
//   reliably catch senders somewhere in this range before their window closes.
// - reminder_sent_at is NULL or older than 6 months (cooldown)
// - not currently paused
export async function dbGetPendingReminders(): Promise<ReminderCandidate[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const SIX_MONTHS_AGO = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const result = await queryNeon<ReminderCandidate>(
    `SELECT sender_id, platform, last_msg_at
     FROM travel_senders
     WHERE platform = 'facebook'
       AND last_msg_at < NOW() - INTERVAL '12 hours'
       AND last_msg_at > NOW() - INTERVAL '24 hours'
       AND (reminder_sent_at IS NULL OR reminder_sent_at < $1)
       AND (paused = FALSE OR expires_at < NOW())`,
    [SIX_MONTHS_AGO],
  );
  return result?.rows ?? [];
}

// Atomically claim the reminder slot for a sender (prevents double-send if cron overlaps).
export async function dbClaimReminder(senderId: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const SIX_MONTHS_AGO = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  const result = await queryNeon<{ claimed: boolean }>(
    `UPDATE travel_senders
     SET reminder_sent_at = NOW(), updated_at = NOW()
     WHERE sender_id = $1
       AND (reminder_sent_at IS NULL OR reminder_sent_at < $2)
     RETURNING TRUE AS claimed`,
    [senderId, SIX_MONTHS_AGO],
  );
  return result?.rows[0]?.claimed === true;
}

// Returns true if this season album hasn't been sent to this sender yet (within the session).
// If not sent, atomically marks it as sent and returns true.
export async function dbClaimSeasonSend(senderId: string, seasonId: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  // Only send each season album once per 10-hour window — reset by clearing the array
  const result = await queryNeon<{ claimed: boolean }>(
    `UPDATE travel_senders
     SET season_sent_ids = array_append(season_sent_ids, $2), updated_at = NOW()
     WHERE sender_id = $1 AND NOT ($2 = ANY(season_sent_ids))
     RETURNING TRUE AS claimed`,
    [senderId, seasonId],
  );
  return (result?.rows[0]?.claimed) === true;
}

// Call this when the user signals real intent (phone number given, or booking keyword).
// Pauses bot for this sender for 14 days so a human consultant takes over.
export async function dbAutoHandoffSender(senderId: string): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  const expiresAt = new Date(Date.now() + AUTO_PAUSE_RESET_DAYS * 86400_000).toISOString();
  await queryNeon(
    `UPDATE travel_senders
     SET paused = TRUE, pause_reason = 'auto_handoff', paused_at = NOW(), expires_at = $2, updated_at = NOW()
     WHERE sender_id = $1 AND paused = FALSE`,
    [senderId, expiresAt],
  );
}

export async function dbIsPaused(senderId: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon<{ paused: boolean; expires_at: string | null }>(
    `SELECT paused, expires_at FROM travel_senders WHERE sender_id = $1`,
    [senderId],
  );
  const row = result?.rows[0];
  if (!row) return false;
  if (!row.paused) return false;
  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    // expired — auto-clear
    await queryNeon(
      `UPDATE travel_senders SET paused = FALSE, pause_reason = '', paused_at = NULL, expires_at = NULL, updated_at = NOW() WHERE sender_id = $1`,
      [senderId],
    );
    return false;
  }
  return true;
}

const MAX_PAUSE_MS = 14 * 24 * 60 * 60 * 1000;

export async function dbPauseSender(
  senderId: string,
  durationMs?: number,
  reason = "manual",
): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  // Forever pauses are confusing and easy to forget; cap every per-sender pause at 14 days.
  const effectiveMs =
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
      ? Math.min(durationMs, MAX_PAUSE_MS)
      : MAX_PAUSE_MS;
  const expiresAt = new Date(Date.now() + effectiveMs).toISOString();
  await queryNeon(
    `INSERT INTO travel_senders (sender_id, paused, pause_reason, paused_at, expires_at, updated_at)
     VALUES ($1, TRUE, $2, NOW(), $3, NOW())
     ON CONFLICT (sender_id) DO UPDATE
       SET paused = TRUE, pause_reason = $2, paused_at = NOW(), expires_at = $3, updated_at = NOW()`,
    [senderId, reason, expiresAt],
  );
}

export async function dbResumeSender(senderId: string): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  await queryNeon(
    `UPDATE travel_senders
     SET paused = FALSE, pause_reason = '', paused_at = NULL, expires_at = NULL, msg_count = 0, updated_at = NOW()
     WHERE sender_id = $1`,
    [senderId],
  );
}

export async function dbStoreSenderName(senderId: string, name: string): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  await queryNeon(
    `INSERT INTO travel_senders (sender_id, display_name, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (sender_id) DO UPDATE SET display_name = $2, updated_at = NOW()`,
    [senderId, name],
  );
}

export async function dbListPaused(): Promise<SenderRow[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const result = await queryNeon<SenderRow>(
    `SELECT sender_id, platform, display_name, last_seen, msg_count,
            paused, pause_reason, paused_at, expires_at
     FROM travel_senders
     WHERE paused = TRUE
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY paused_at DESC
     LIMIT 100`,
    [],
  );
  return result?.rows ?? [];
}

export async function dbListRecent(): Promise<SenderRow[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const result = await queryNeon<SenderRow>(
    `SELECT sender_id, platform, display_name, last_seen, msg_count,
            paused, pause_reason, paused_at, expires_at
     FROM travel_senders
     ORDER BY last_seen DESC
     LIMIT 50`,
    [],
  );
  return result?.rows ?? [];
}

export async function dbListSendersWithoutName(): Promise<{ sender_id: string; platform: string }[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const result = await queryNeon<{ sender_id: string; platform: string }>(
    `SELECT sender_id, platform FROM travel_senders
     WHERE display_name = '' OR display_name IS NULL
     ORDER BY last_seen DESC
     LIMIT 200`,
    [],
  );
  return result?.rows ?? [];
}
