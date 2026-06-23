/**
 * Inbound customer message logging + "most asked questions" analytics.
 *
 * Each customer message is logged to travel_messages (best-effort — never blocks
 * the bot). The admin analytics tab aggregates them into top questions by
 * week / month / all-time, grouped by a normalized form so near-duplicate
 * phrasings collapse together.
 */

import { ensureTravelSchema } from "./travelOps";
import { queryNeon } from "./neonDb";

/** Normalize a message for grouping: lowercase, strip punctuation, collapse spaces. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Log one inbound customer message. Best-effort: swallows all errors so a
 * logging failure never affects the bot's reply.
 */
export async function logInboundMessage(input: {
  platform: string;
  senderId: string;
  text: string;
}): Promise<void> {
  try {
    const text = (input.text || "").trim();
    if (!text) return;
    // Skip very long pastes — they're not "questions" and bloat the table.
    if (text.length > 500) return;
    const ready = await ensureTravelSchema();
    if (!ready) return;
    await queryNeon(
      `INSERT INTO travel_messages (platform, sender_id, text, norm)
       VALUES ($1, $2, $3, $4)`,
      [input.platform, input.senderId, text.slice(0, 500), normalizeQuestion(text).slice(0, 500)],
    );
  } catch {
    // Logging must never break the bot.
  }
}

export type TopQuestion = { question: string; count: number };

export type FaqPeriodStats = {
  week: TopQuestion[];
  month: TopQuestion[];
  allTime: TopQuestion[];
  totalMessages: number;
};

async function topForInterval(intervalSql: string | null, limit: number): Promise<TopQuestion[]> {
  // We GROUP BY the normalized form but display the most recent raw text of
  // each group (more readable than the stripped norm).
  const where = intervalSql
    ? `WHERE created_at >= NOW() - INTERVAL '${intervalSql}' AND norm <> ''`
    : `WHERE norm <> ''`;
  const result = await queryNeon<{ question: string; count: string }>(
    `
      SELECT
        (ARRAY_AGG(text ORDER BY created_at DESC))[1] AS question,
        COUNT(*) AS count
      FROM travel_messages
      ${where}
      GROUP BY norm
      ORDER BY count DESC, MAX(created_at) DESC
      LIMIT ${limit}
    `,
  );
  return (
    result?.rows?.map((r) => ({
      question: String(r.question || ""),
      count: Number(r.count || 0),
    })) || []
  );
}

export async function getFaqStats(limit = 10): Promise<FaqPeriodStats> {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return { week: [], month: [], allTime: [], totalMessages: 0 };
  }
  const [week, month, allTime, total] = await Promise.all([
    topForInterval("7 days", limit),
    topForInterval("30 days", limit),
    topForInterval(null, limit),
    queryNeon<{ count: string }>("SELECT COUNT(*) AS count FROM travel_messages"),
  ]);
  return {
    week,
    month,
    allTime,
    totalMessages: Number(total?.rows?.[0]?.count || 0),
  };
}
