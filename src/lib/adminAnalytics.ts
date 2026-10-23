import { redactAnalyticsText } from "./analyticsMinimization";
import { COVERAGE_TOPICS, NOT_A_FAILURE_EVENTS, QUESTION_REASONS, classifySilence, missingFactTopic, questionTopic, tripCoverage } from "./adminAnalyticsInsights";
import { ANALYTICS_TIMEZONE, type AnalyticsPeriod, type AnalyticsStatsData, type ActivityStatsData, type FaqStatsData, type AnalyticsResponse, type CoverageTopic, type OverviewData, type SilenceReason } from "./adminAnalyticsTypes";
import type { TravelTrip } from "./travelTypes";
export * from "./adminAnalyticsTypes";
type Row = Record<string, unknown>;
export type AnalyticsQuery = (sql: string, params?: unknown[]) => Promise<{ rows: Row[] } | null>;
/** Adds each trip's website page details, as the bot's trip list does (withWebsiteDepartureAvailability). */
export type WebsiteDetailsReader = (trips: TravelTrip[]) => Promise<TravelTrip[]>;

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

/** Emoji and broken glyphs from tapped buttons ("Холбоо барих дугаар 😊", "…�") are not words. */
function cleanQuestion(text: string): string {
  return text.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{FFFD}]/gu, "").replace(/\s+/g, " ").trim();
}

// Menu buttons, greetings and placeholders are taps, not questions: they filled the
// "most asked" list ("Холбоо барих дугаар", "Манай хаяг", "hi", "[phone]") and hid the
// questions staff should answer in the trip data.
const NOT_A_QUESTION = /^(?:холбоо барих дугаар|манай хаяг|хөтөлбөр үзэх|зураг үзэх|асуулт асуух|захиалга өгөх|зөвлөхтэй холбогдох|мэдээлэл|мэдээлэл авах|get started|эхлэх|hi+|hello|hey|сайн\s*б(?:айна|на)\s*уу|сайн уу|sain\s*b(?:aina|n)\s*uu|sn\s*bn?u+|\[[a-z_]+\]|\[хэрэглэгч[^\]]*\]|can you tell me more about your ad\??|is anyone available to chat\??|\?+|ok|за|баярлалаа)$/i;
export function isNotAQuestion(text: string): boolean {
  return NOT_A_QUESTION.test(text.trim().replace(/[.!]+$/, ""));
}

async function faqStats(query: AnalyticsQuery, now: string): Promise<FaqStatsData> {
  const top = async (days: number | null) => {
    const rows = await read(query, `SELECT (ARRAY_AGG(text ORDER BY created_at DESC, id DESC))[1] AS question, COUNT(*)::text AS count
      FROM travel_messages WHERE norm <> '' AND created_at < $1::timestamptz
      ${days === null ? "" : "AND created_at >= $1::timestamptz - ($2::int * INTERVAL '1 day')"}
      GROUP BY norm ORDER BY COUNT(*) DESC, MAX(created_at) DESC, norm LIMIT 40`, days === null ? [now] : [now, days]);
    return rows.map(row => ({ question: cleanQuestion(redactAnalyticsText(String(row.question))).slice(0, 500), count: count(row.count) }))
      .filter(row => row.question && !isNotAQuestion(row.question)).slice(0, 8);
  };
  const [week, month, allTime, total] = await Promise.all([
    top(7), top(30), top(null), read(query, "SELECT COUNT(*)::text AS count FROM travel_messages WHERE created_at < $1::timestamptz", [now]),
  ]);
  return { week, month, allTime, totalMessages: count(total[0]?.count) };
}

/**
 * The overview of one period, about the bot's answers (the owner sells by hand — leads are
 * records, never a queue): how many people wrote (and the period before), how many the bot
 * answered or stayed silent for and why, the questions it could not answer, which topics the
 * trip data covers, which trips people opened, and whether the AI was down. Counts and
 * stored system texts only; a customer's words appear only redacted, never who sent them.
 */
async function overviewStats(query: AnalyticsQuery, period: AnalyticsPeriod, window: ReturnType<typeof analyticsWindow>, withWebsiteDetails: WebsiteDetailsReader): Promise<OverviewData> {
  const previousStart = new Date(Date.parse(window.start) - period * 86_400_000).toISOString();
  const [people, peopleDaily, leads, leadsDaily, silences, activeTrips, outages, demand] = await Promise.all([
    read(query, `/* overview:people */ SELECT
      COUNT(DISTINCT sender_id) FILTER (WHERE role='user' AND created_at >= $1::timestamptz)::text AS customers,
      COUNT(DISTINCT sender_id) FILTER (WHERE role='user' AND created_at < $1::timestamptz)::text AS previous_customers,
      COUNT(DISTINCT sender_id) FILTER (WHERE role='assistant' AND created_at >= $1::timestamptz)::text AS answered
      FROM travel_conversations WHERE created_at >= $3::timestamptz AND created_at < $2::timestamptz
      AND sender_id NOT LIKE 'demo:%'`, [window.start, window.end, previousStart]),
    read(query, `/* overview:people_daily */ SELECT (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date::text AS date,
      COUNT(DISTINCT sender_id) FILTER (WHERE role='user')::text AS customers,
      COUNT(DISTINCT sender_id) FILTER (WHERE role='assistant')::text AS answered
      FROM travel_conversations WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz
      AND sender_id NOT LIKE 'demo:%' GROUP BY 1 ORDER BY 1`, [window.start, window.end]),
    read(query, `/* overview:leads */ SELECT
      COUNT(DISTINCT sender_id) FILTER (WHERE kind='handoff')::text AS handed_off,
      COUNT(DISTINCT sender_id) FILTER (WHERE COALESCE(contact_phone,'') <> '')::text AS phone_leads,
      COUNT(*) FILTER (WHERE kind='booking')::text AS bookings
      FROM travel_leads WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz`, [window.start, window.end]),
    read(query, `/* overview:leads_daily */ SELECT (created_at AT TIME ZONE 'Asia/Ulaanbaatar')::date::text AS date,
      COUNT(DISTINCT sender_id) FILTER (WHERE kind='handoff')::text AS handed_off
      FROM travel_leads WHERE created_at >= $1::timestamptz AND created_at < $2::timestamptz GROUP BY 1 ORDER BY 1`, [window.start, window.end]),
    read(query, `/* overview:silences */ SELECT COALESCE(context,'') AS context, COALESCE(customer_message,'') AS message, created_at
      FROM travel_leads WHERE kind='handoff' AND created_at >= $1::timestamptz AND created_at < $2::timestamptz
      ORDER BY created_at DESC LIMIT 500`, [window.start, window.end]),
    read(query, `/* overview:coverage */ SELECT id, adult_price, hotel, departure_dates, photo_urls, extra
      FROM travel_trip_entries WHERE status='active'`),
    read(query, `/* overview:outages */ SELECT COUNT(*)::text AS outages, MAX(created_at) AS last_outage
      FROM travel_leads WHERE context LIKE 'AI түр саатсан%'
      AND created_at >= $1::timestamptz - INTERVAL '24 hours' AND created_at < $1::timestamptz`, [window.end]),
    read(query, `/* overview:trip_demand */ SELECT t.route_name AS trip, COUNT(DISTINCT c.sender_id)::text AS customers
      FROM travel_conversations c JOIN travel_trip_entries t
        ON length(t.route_name) >= 6 AND position(t.route_name IN c.text) BETWEEN 1 AND 40
      WHERE c.role='assistant' AND c.created_at >= $1::timestamptz AND c.created_at < $2::timestamptz
      AND c.sender_id NOT LIKE 'demo:%' AND c.text NOT LIKE 'Энэ чиглэлээр%' AND c.text NOT LIKE 'Тийм ээ,%'
      GROUP BY t.route_name ORDER BY COUNT(DISTINCT c.sender_id) DESC, t.route_name LIMIT 8`, [window.start, window.end]),
  ]);
  const peopleByDay = new Map(peopleDaily.map(row => [String(row.date), row]));
  const handoffsByDay = new Map(leadsDaily.map(row => [String(row.date), count(row.handed_off)]));

  const reasonCounts = new Map<SilenceReason, number>();
  const unanswered: OverviewData["unanswered"] = [];
  const askedByTopic = new Map<CoverageTopic, number>();
  for (const row of silences) {
    const context = String(row.context || ""), message = String(row.message || "");
    const reason = classifySilence(context, message);
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
    if (!QUESTION_REASONS.has(reason)) continue;
    // A bare number, an emoji or a placeholder holds no question the trip data could answer.
    const question = cleanQuestion(redactAnalyticsText(message)).slice(0, 300);
    if (!/\p{L}/u.test(question) || isNotAQuestion(question) || /^\[[^\]]*\]$/.test(question)) continue;
    // The fact the bot recorded as missing names the topic; the words decide only when there is no record.
    const recorded = missingFactTopic(context);
    const topic = recorded === undefined ? questionTopic(question) : recorded;
    if (topic) askedByTopic.set(topic, (askedByTopic.get(topic) || 0) + 1);
    if (unanswered.length < 8) unanswered.push({ question, at: iso(row.created_at)!, reason, topic });
  }
  // Counted on the trips as the bot reads them, website page included (its requirements and
  // cancellation policy answer visa and terms questions too).
  const botTrips = await withWebsiteDetails(activeTrips.map(row =>
    ({ ...row, id: String(row.id), extra: row.extra && typeof row.extra === "object" ? row.extra : {} }) as unknown as TravelTrip));
  const coverageSets = botTrips.map(trip => tripCoverage(trip as unknown as Row));
  return {
    customers: count(people[0]?.customers ?? 0), previousCustomers: count(people[0]?.previous_customers ?? 0),
    answeredCustomers: count(people[0]?.answered ?? 0),
    handedOff: count(leads[0]?.handed_off ?? 0), phoneLeads: count(leads[0]?.phone_leads ?? 0), bookingRequests: count(leads[0]?.bookings ?? 0),
    daily: window.dates.map(date => ({ date, customers: count(peopleByDay.get(date)?.customers ?? 0),
      answered: count(peopleByDay.get(date)?.answered ?? 0), handedOff: handoffsByDay.get(date) ?? 0 })),
    silenceReasons: [...reasonCounts].map(([reason, total]) => ({ reason, count: total })).sort((x, y) => y.count - x.count),
    unanswered,
    coverage: COVERAGE_TOPICS.map(topic => ({ topic, trips: coverageSets.filter(set => set.has(topic)).length, asked: askedByTopic.get(topic) ?? 0 })),
    activeTrips: activeTrips.length,
    aiOutages24h: count(outages[0]?.outages ?? 0), lastAiOutageAt: iso(outages[0]?.last_outage ?? null),
    tripDemand: demand.map(row => ({ trip: String(row.trip), customers: count(row.customers) })),
  };
}

/** Aggregate reads only. Stored history counts do not certify delivery or answer quality. */
export async function collectAdminAnalytics(query: AnalyticsQuery, periodDays: AnalyticsPeriod, now: Date,
  withWebsiteDetails: WebsiteDetailsReader): Promise<AnalyticsResponse> {
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
  const [overview, activity, faq, issues] = await Promise.all([
    optional(() => overviewStats(query, periodDays, window, withWebsiteDetails), "Тоймын үндсэн тоог ачаалж чадсангүй."),
    optional(() => activityStats(query, periodDays, window), "Ярианы статистикийг ачаалж чадсангүй."),
    optional(() => faqStats(query, window.end), "Түгээмэл асуултын статистикийг ачаалж чадсангүй."),
    optional(async () => {
      const rows = await read(query, `SELECT event,level,COUNT(*)::text AS count,MAX(created_at) AS last_seen
        FROM travel_error_logs WHERE created_at >= $1::timestamptz - INTERVAL '24 hours'
        AND created_at < $1::timestamptz AND level IN ('error','warn') GROUP BY event,level
        ORDER BY COUNT(*) DESC,MAX(created_at) DESC,event`, [window.end]);
      // Staff replying in Messenger, the bot's deliberate silences and the unused staff-alert
      // channel are normal operation; counting them reported failures on a healthy day.
      const failures = rows.filter(row => !NOT_A_FAILURE_EVENTS.has(String(row.event)));
      return { count: failures.reduce((sum, row) => sum + count(row.count), 0), recent: failures.slice(0, 5).map(row => ({
        event: String(row.event), level: String(row.level), count: count(row.count), lastSeenAt: iso(row.last_seen)!,
      })) };
    }, "Алдааны бүртгэлийг ачаалж чадсангүй."),
  ]);
  return { ok: true, generatedAt: window.end, periodDays, timezone: ANALYTICS_TIMEZONE, overview, stats, activity, faq, warnings,
    attention: { pendingHandoffs: count(lead.pending_handoffs), oldestPendingHandoffAt: iso(lead.oldest_handoff),
      newBookingRequests: count(lead.new_bookings), errors24h: issues?.count ?? null, recentIssues: issues?.recent ?? [], handoffReasons: [] } };
}
