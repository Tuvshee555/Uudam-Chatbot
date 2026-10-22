import { redactAnalyticsText } from "./analyticsMinimization";
import { ANALYTICS_TIMEZONE, type AnalyticsPeriod, type AnalyticsStatsData, type ActivityStatsData, type FaqStatsData, type AnalyticsResponse } from "./adminAnalyticsTypes";
export * from "./adminAnalyticsTypes";
type Row = Record<string, unknown>;
export type AnalyticsQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] } | null>;

function count(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error("Invalid analytics count");
  return number;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid analytics timestamp");
  return date.toISOString();
}

async function read(query: AnalyticsQuery, sql: string, params: unknown[] = []): Promise<Row[]> {
  const result = await query(sql, params);
  if (!result) throw new Error("Analytics database unavailable");
  return result.rows;
}

/** Calendar days follow the agency's timezone, including days with zero rows. */
export function analyticsWindow(now: Date, period: AnalyticsPeriod) {
  if (![7, 30].includes(period) || !Number.isFinite(now.getTime())) throw new Error("Invalid analytics window");
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: ANALYTICS_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(now).filter(part => ["year", "month", "day"].includes(part.type));
  const parts = Object.fromEntries(day.map(part => [part.type, part.value]));
  const endDay = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
  const dates = Array.from({ length: period }, (_, index) =>
    new Date(endDay - (period - index - 1) * 86_400_000).toISOString().slice(0, 10));
  return { dates, start: new Date(Date.parse(`${dates[0]}T00:00:00+08:00`)).toISOString(), end: now.toISOString() };
}

async function activityStats(query: AnalyticsQuery, period: AnalyticsPeriod, window: ReturnType<typeof analyticsWindow>): Promise<ActivityStatsData> {
  const [summary, daily] = await Promise.all([
    read(query, `SELECT COUNT(*) FILTER (WHERE role='user')::text AS inbound,
      COUNT(*) FILTER (WHERE role='assistant')::text AS assistant,
      COUNT(DISTINCT (platform,sender_id)) FILTER (WHERE role='user')::text AS conversations
      FROM travel_conversations WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      AND sender_id NOT LIKE 'demo:%'`, [window.start, window.end]),
    read(query, `SELECT (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date::text AS date,
      COUNT(*) FILTER (WHERE role='user')::text AS inbound,
      COUNT(*) FILTER (WHERE role='assistant')::text AS assistant
      FROM travel_conversations WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      AND sender_id NOT LIKE 'demo:%'
      GROUP BY 1 ORDER BY 1`, [window.start, window.end]),
  ]);
  const byDay = new Map(daily.map(row => [String(row.date), row]));
  return { periodDays: period, inboundMessages: count(summary[0]?.inbound), assistantMessages: count(summary[0]?.assistant),
    activeConversations: count(summary[0]?.conversations), daily: window.dates.map(date => ({ date,
      inboundMessages: count(byDay.get(date)?.inbound ?? 0), assistantMessages: count(byDay.get(date)?.assistant ?? 0) })) };
}

async function faqStats(query: AnalyticsQuery, now: string): Promise<FaqStatsData> {
  const top = async (days: number | null) => {
    const rows = await read(query, `SELECT (ARRAY_AGG(text ORDER BY created_at DESC, id DESC))[1] AS question, COUNT(*)::text AS count
      FROM travel_messages WHERE norm <> '' AND created_at < $1::timestamptz
      ${days === null ? "" : "AND created_at >= $1::timestamptz - ($2::int * INTERVAL '1 day')"}
      GROUP BY norm ORDER BY COUNT(*) DESC, MAX(created_at) DESC, norm LIMIT 8`, days === null ? [now] : [now, days]);
    return rows.map(row => ({ question: redactAnalyticsText(String(row.question)).slice(0, 500), count: count(row.count) }));
  };
  const [week, month, allTime, total] = await Promise.all([
    top(7), top(30), top(null), read(query, "SELECT COUNT(*)::text AS count FROM travel_messages WHERE created_at < $1::timestamptz", [now]),
  ]);
  return { week, month, allTime, totalMessages: count(total[0]?.count) };
}

/** Aggregate reads only. Stored history counts do not certify delivery or answer quality. */
export async function collectAdminAnalytics(query: AnalyticsQuery, periodDays: AnalyticsPeriod = 7, now = new Date()): Promise<AnalyticsResponse> {
  const window = analyticsWindow(now, periodDays);
  const [leadRows, distributions, dailyLeads, trips] = await Promise.all([
    read(query, `SELECT COUNT(*)::text AS total,
      COUNT(*) FILTER (WHERE lead_status='new_lead')::text AS new,
      COUNT(*) FILTER (WHERE kind='booking')::text AS bookings,
      COUNT(DISTINCT (platform,sender_id))::text AS contacts,
      COUNT(*) FILTER (WHERE kind='handoff' AND lead_status='new_lead')::text AS pending_handoffs,
      MIN(created_at) FILTER (WHERE kind='handoff' AND lead_status='new_lead') AS oldest_handoff,
      COUNT(*) FILTER (WHERE kind='booking' AND lead_status='new_lead')::text AS new_bookings
      FROM travel_leads WHERE created_at < $1::timestamptz`, [window.end]),
    read(query, `SELECT lead_status,kind,COUNT(*)::text AS count FROM travel_leads
      WHERE created_at < $1::timestamptz GROUP BY lead_status,kind`, [window.end]),
    read(query, `SELECT (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date::text AS date,COUNT(*)::text AS count
      FROM travel_leads WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY 1 ORDER BY 1`, [window.start, window.end]),
    read(query, `SELECT COUNT(*)::text AS total,COUNT(*) FILTER (WHERE status='active')::text AS active FROM travel_trip_entries`),
  ]);
  const lead = leadRows[0];
  if (!lead || !trips[0]) throw new Error("Analytics summary unavailable");
  const leadsByStatus: Record<string, number> = Object.create(null);
  const kinds = new Map<string, number>();
  for (const row of distributions) {
    const status = String(row.lead_status || "new_lead"), kind = String(row.kind || "handoff"), total = count(row.count);
    leadsByStatus[status] = (leadsByStatus[status] || 0) + total;
    kinds.set(kind, (kinds.get(kind) || 0) + total);
  }
  const byDay = new Map(dailyLeads.map(row => [String(row.date), count(row.count)]));
  const stats: AnalyticsStatsData = { totalLeads: count(lead.total), newLeads: count(lead.new), bookingLeads: count(lead.bookings),
    totalContacts: count(lead.contacts), leadsByDay: window.dates.map(date => ({ date, count: byDay.get(date) || 0 })),
    leadsByStatus, leadsByKind: Array.from(kinds, ([kind, total]) => ({ kind, count: total })),
    totalTrips: count(trips[0].total), activeTrips: count(trips[0].active), leadsByTrip: [], topTrips: [] };
  const warnings: string[] = [];
  const optional = async <T>(work: () => Promise<T>, warning: string): Promise<T | null> => {
    try { return await work(); } catch { warnings.push(warning); return null; }
  };
  const [activity, faq, issues] = await Promise.all([
    optional(() => activityStats(query, periodDays, window), "Ярианы статистикийг ачаалж чадсангүй."),
    optional(() => faqStats(query, window.end), "Түгээмэл асуултын статистикийг ачаалж чадсангүй."),
    optional(async () => {
      const rows = await read(query, `SELECT event,level,COUNT(*)::text AS count,MAX(created_at) AS last_seen
        FROM travel_error_logs WHERE created_at >= $1::timestamptz - INTERVAL '24 hours'
        AND created_at < $1::timestamptz AND level IN ('error','warn') GROUP BY event,level
        ORDER BY COUNT(*) DESC,MAX(created_at) DESC,event`, [window.end]);
      return { count: rows.reduce((sum, row) => sum + count(row.count), 0), recent: rows.slice(0, 5).map(row => ({
        event: String(row.event), level: String(row.level), count: count(row.count), lastSeenAt: iso(row.last_seen)!,
      })) };
    }, "Алдааны бүртгэлийг ачаалж чадсангүй."),
  ]);
  return { ok: true, generatedAt: window.end, periodDays, timezone: ANALYTICS_TIMEZONE, stats, activity, faq, warnings,
    attention: { pendingHandoffs: count(lead.pending_handoffs), oldestPendingHandoffAt: iso(lead.oldest_handoff),
      newBookingRequests: count(lead.new_bookings), errors24h: issues?.count ?? null, recentIssues: issues?.recent ?? [], handoffReasons: [] } };
}
