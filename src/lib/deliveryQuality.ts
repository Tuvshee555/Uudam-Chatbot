import { summarizeLeadAttention, type LeadAttentionSummary } from "./leadAttention";
import type { TravelLead } from "./travelTypes";

/**
 * What actually happened to real customers' messages over the last days (admin Analytics).
 * Read from records only, never the model:
 * - travel_error_logs: the webhook's inbound trail (inboundTrace.ts) — receipt, final outcome,
 *   redelivery skips, failures — production rows only (they carry deploymentRevision; local
 *   and test runs do not). Kept 7 days.
 * - travel_conversations / travel_leads: customers and leads, `demo:` test sessions excluded.
 * Counts of records are "verified". Anything derived from them (messages with no recorded
 * outcome, shares) is labelled an estimate by the page.
 */
export const QUALITY_DAYS = 7;

type Row = Record<string, unknown>;
export type QualityQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] } | null>;

export type DeliveryQuality = {
  generatedAt: string;
  windowStart: string;
  /** When the inbound trail starts within the window (it was added on 2026-10-30). */
  trailSince: string | null;
  customers: { wrote: number; inboundMessages: number };
  trail: {
    deliveries: number; messages: number; textMessages: number; customers: number;
    answered: number; silent: number; storedNoReply: number; notStored: number; failed: number;
    /** Text messages received with no outcome record yet (still processing, or a lost record). */
    withoutOutcome: number;
    silentReasons: Array<{ reason: string; count: number }>;
    failureReasons: Array<{ reason: string; count: number }>;
    repeatedFailures: number; preservedAfterFailures: number; deliveryErrors: number; duplicateDeliveries: number;
  };
  leads: { bookingRequests: number; handoffs: number; attention: LeadAttentionSummary };
  /** Trail records the log store dropped under load; when above zero the trail is incomplete. */
  droppedLogRecords: number;
};

const n = (value: unknown) => {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : 0;
};

async function rows(query: QualityQuery, sql: string, params: unknown[]): Promise<Row[]> {
  const result = await query(sql, params);
  if (!result) throw new Error("Quality database unavailable");
  return result.rows;
}

const PRODUCTION = `fields ? 'deploymentRevision'`;

export async function collectDeliveryQuality(query: QualityQuery, leads: TravelLead[], now = new Date()): Promise<DeliveryQuality> {
  const windowStart = new Date(now.getTime() - QUALITY_DAYS * 86_400_000).toISOString();
  const [received, outcomes, repeated, events, people, leadCounts] = await Promise.all([
    rows(query, `/* quality:received */ SELECT COUNT(*)::text AS deliveries,
      COUNT(DISTINCT fields->>'eventKeyHash')::text AS messages,
      COUNT(DISTINCT fields->>'eventKeyHash') FILTER (WHERE fields->>'kind' <> 'attachment')::text AS text_messages,
      COUNT(DISTINCT NULLIF(sender_hash, ''))::text AS customers, MIN(created_at) AS since
      FROM travel_error_logs WHERE event = 'webhook.inbound_received' AND created_at >= $1::timestamptz AND ${PRODUCTION}`, [windowStart]),
    rows(query, `/* quality:outcomes */ SELECT status, silent, reason, COUNT(*)::text AS count FROM (
      SELECT DISTINCT ON (fields->>'eventKeyHash') fields->>'status' AS status, fields->>'silent' AS silent,
        split_part(COALESCE(fields->>'reason', ''), ':', 1) AS reason
      FROM travel_error_logs WHERE event = 'webhook.inbound_outcome' AND created_at >= $1::timestamptz AND ${PRODUCTION}
      ORDER BY fields->>'eventKeyHash', created_at DESC) final GROUP BY 1, 2, 3`, [windowStart]),
    rows(query, `/* quality:repeated */ SELECT COUNT(*)::text AS count FROM (
      SELECT fields->>'eventKeyHash' FROM travel_error_logs WHERE event = 'webhook.inbound_outcome'
        AND fields->>'status' = 'failed' AND created_at >= $1::timestamptz AND ${PRODUCTION}
      GROUP BY 1 HAVING COUNT(*) >= 2) failing`, [windowStart]),
    rows(query, `/* quality:events */ SELECT event, COUNT(*)::text AS count,
      COALESCE(SUM((fields->>'dropped')::int) FILTER (WHERE event = 'error_log_store.flood_dropped'), 0)::text AS dropped
      FROM travel_error_logs WHERE created_at >= $1::timestamptz
        AND event IN ('webhook.inbound_duplicate', 'webhook.inbound_preserved_after_failures', 'webhook.send.primary_failed', 'error_log_store.flood_dropped')
        AND (${PRODUCTION} OR event = 'error_log_store.flood_dropped')
      GROUP BY 1`, [windowStart]),
    rows(query, `/* quality:people */ SELECT COUNT(DISTINCT sender_id)::text AS customers, COUNT(*)::text AS inbound
      FROM travel_conversations WHERE role = 'user' AND created_at >= $1::timestamptz AND sender_id NOT LIKE 'demo:%'`, [windowStart]),
    rows(query, `/* quality:leads */ SELECT COUNT(*) FILTER (WHERE kind = 'booking')::text AS bookings,
      COUNT(*) FILTER (WHERE kind = 'handoff')::text AS handoffs
      FROM travel_leads WHERE created_at >= $1::timestamptz AND sender_id NOT LIKE 'demo:%'`, [windowStart]),
  ]);
  const byEvent = new Map(events.map((row) => [String(row.event), row]));
  const trail = {
    deliveries: n(received[0]?.deliveries), messages: n(received[0]?.messages), textMessages: n(received[0]?.text_messages),
    customers: n(received[0]?.customers), answered: 0, silent: 0, storedNoReply: 0, notStored: 0, failed: 0, withoutOutcome: 0,
    silentReasons: [] as Array<{ reason: string; count: number }>, failureReasons: [] as Array<{ reason: string; count: number }>,
    repeatedFailures: n(repeated[0]?.count), preservedAfterFailures: n(byEvent.get("webhook.inbound_preserved_after_failures")?.count),
    deliveryErrors: n(byEvent.get("webhook.send.primary_failed")?.count), duplicateDeliveries: n(byEvent.get("webhook.inbound_duplicate")?.count),
  };
  const silent = new Map<string, number>(), failed = new Map<string, number>();
  let withOutcome = 0;
  for (const row of outcomes) {
    const count = n(row.count);
    withOutcome += count;
    const status = String(row.status || "");
    if (status === "answered") trail.answered += count;
    else if (status === "silent") { trail.silent += count; const key = String(row.silent || "unknown"); silent.set(key, (silent.get(key) || 0) + count); }
    else if (status === "stored_no_reply") trail.storedNoReply += count;
    else if (status === "not_stored") trail.notStored += count;
    else if (status === "failed") { trail.failed += count; const key = String(row.reason || "unknown"); failed.set(key, (failed.get(key) || 0) + count); }
  }
  trail.withoutOutcome = Math.max(0, trail.textMessages - withOutcome);
  trail.silentReasons = [...silent].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  trail.failureReasons = [...failed].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);
  const since = received[0]?.since;
  return {
    generatedAt: now.toISOString(), windowStart,
    trailSince: since ? new Date(String(since instanceof Date ? since.toISOString() : since)).toISOString() : null,
    customers: { wrote: n(people[0]?.customers), inboundMessages: n(people[0]?.inbound) },
    trail,
    leads: { bookingRequests: n(leadCounts[0]?.bookings), handoffs: n(leadCounts[0]?.handoffs), attention: summarizeLeadAttention(leads, now) },
    droppedLogRecords: n(byEvent.get("error_log_store.flood_dropped")?.dropped),
  };
}

/** Plain labels for the silence reasons inboundTrace records. */
export const SILENT_REASON_LABELS: Record<string, string> = {
  staff_takeover: "Ажилтан хариуцсан (Messenger дээр хариулсан)",
  page_paused: "Хуудсын бот зогссон",
  greeting_after_get_started: "«Эхлэх» дарсны дараах мэндчилгээ",
  ai_refer: "Мэдээлэл дутуу — ажилтанд шилжүүлсэн",
  ai_no_data: "Баталгаагүй хариуг зогсоосон",
  ai_outage: "AI тасалдсан",
  booked_status_repeat: "Ижил асуултыг давтсан (захиалгын төлөв)",
  booked_status_unrecorded: "Захиалгын төлөв — бүртгэж чадсангүй",
};

export function silentReasonLabel(reason: string): string {
  if (SILENT_REASON_LABELS[reason]) return SILENT_REASON_LABELS[reason];
  if (reason.startsWith("paused:")) return `Бот түр зогссон (${reason.slice(7)})`;
  if (reason.startsWith("no_data:")) return `Мэдээлэлгүй — ажилтанд шилжүүлсэн (${reason.slice(8)})`;
  return reason;
}
