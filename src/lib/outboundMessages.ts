import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";

/**
 * Every message the bot sends through the Send API, by the id Meta returns (`m_…`). In a
 * Messenger thread all Page messages come "from" the Page — this bot, a consultant typing in
 * Business Suite on a computer, Meta's automations — and the computer and the bot carry the
 * same `source:web` tag (takeover diagnostics, 2026-10-30). The id is what tells the bot's
 * own messages apart (staffTakeover.ts). Kept 30 days; never holds message text.
 */
export async function recordOutboundMessage(mid: string, recipientId: string): Promise<void> {
  if (!mid) return;
  if (!await ensureTravelSchema()) return;
  await queryNeon(
    "INSERT INTO travel_outbound_messages (mid, recipient_id) VALUES ($1, $2) ON CONFLICT (mid) DO NOTHING",
    [mid, recipientId],
  );
}

/** Which of these thread message ids the bot sent. */
export async function knownOutboundMids(mids: string[]): Promise<Set<string>> {
  if (!mids.length || !await ensureTravelSchema()) return new Set();
  const result = await queryNeon<{ mid: string }>("SELECT mid FROM travel_outbound_messages WHERE mid = ANY($1::text[])", [mids]);
  return new Set((result?.rows ?? []).map((row) => row.mid));
}

let recordingSince: number | null = null;

/** When the oldest recorded send is from: Page messages before it cannot be told apart by id. */
export async function outboundRecordingSince(): Promise<number | null> {
  if (recordingSince !== null) return recordingSince;
  if (!await ensureTravelSchema()) return null;
  const result = await queryNeon<{ since: string | null }>("SELECT min(created_at) AS since FROM travel_outbound_messages");
  const since = result?.rows[0]?.since ? Date.parse(String(result.rows[0].since)) : NaN;
  if (Number.isFinite(since)) recordingSince = since;
  return recordingSince;
}

export function resetOutboundRecordingForTests() { recordingSince = null; }

/** Daily: ids older than 30 days are no longer needed (a takeover lasts three days). */
export async function pruneOutboundMessages(): Promise<void> {
  if (!await ensureTravelSchema()) return;
  // The oldest id is kept so outboundRecordingSince() still knows when recording began.
  await queryNeon(
    `DELETE FROM travel_outbound_messages WHERE created_at < NOW() - INTERVAL '30 days'
       AND mid <> (SELECT mid FROM travel_outbound_messages ORDER BY created_at LIMIT 1)`,
  );
}
