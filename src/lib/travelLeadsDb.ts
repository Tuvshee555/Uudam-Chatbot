/**
 * Leads — human-handoff requests and booking-intent captures.
 *
 * Extracted from travelDb.ts (over the 2,000-line cap). A clean leaf: depends
 * only on the Neon client and the schema bootstrap. Re-exported from travelDb.ts
 * so existing importers of createLead/listLeads/getLeadStats/etc. keep working.
 */

import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";
import type { LeadKind, LeadCrmStatus, TravelLead, LeadStats } from "./travelTypes";

const VALID_CRM_STATUSES: LeadCrmStatus[] = ["new_lead", "contacted", "booked", "no_answer"];

function mapLeadRow(row: Record<string, unknown>): TravelLead {
  const kind = row.kind === "booking" ? "booking" : "handoff";
  const rawCrm = String(row.lead_status || "new_lead");
  const lead_status: LeadCrmStatus = (VALID_CRM_STATUSES as string[]).includes(rawCrm)
    ? (rawCrm as LeadCrmStatus)
    : "new_lead";
  return {
    id: Number(row.id),
    kind,
    platform: String(row.platform || ""),
    sender_id: String(row.sender_id || ""),
    customer_message: String(row.customer_message || ""),
    contact_phone: String(row.contact_phone || ""),
    context: String(row.context || ""),
    status: row.status === "seen" ? "seen" : "new",
    lead_status,
    created_at: String(row.created_at || ""),
    seen_at: row.seen_at ? String(row.seen_at) : null,
    last_activity_at: row.last_activity_at ? String(row.last_activity_at) : null,
    ...(row.staff_replied_at ? { staff_replied_at: new Date(String(row.staff_replied_at)).toISOString() } : {}),
    notify_status: String(row.notify_status || ""),
    notified_at: row.notified_at ? new Date(String(row.notified_at)).toISOString() : null,
    assigned_to: String(row.assigned_to || ""),
    bot_paused: Boolean(row.bot_paused),
    bot_pause_reason: row.bot_paused ? String(row.bot_pause_reason || "manual") : "",
  };
}

/** The lead a staff ping is about: the given id, else the customer's latest lead. */
async function leadForAlert(target: { leadId?: number; senderId?: string }) {
  if (!target.leadId && !target.senderId) return null;
  const result = await queryNeon<{ id: string; notify_status: string; notified_at: string | null }>(
    target.leadId
      ? "SELECT id, notify_status, notified_at FROM travel_leads WHERE id=$1"
      : "SELECT id, notify_status, notified_at FROM travel_leads WHERE sender_id=$1 ORDER BY id DESC LIMIT 1",
    [target.leadId ?? target.senderId],
  ).catch(() => null);
  return result?.rows[0] ?? null;
}

/** True when staff were already pinged for this lead in the last ten minutes. */
export async function leadRecentlyNotified(target: { leadId?: number; senderId?: string }, withinMs = 10 * 60_000): Promise<boolean> {
  const lead = await leadForAlert(target);
  return Boolean(lead?.notify_status === "sent" && lead.notified_at && Date.now() - Date.parse(lead.notified_at) < withinMs);
}

/** Records on the lead whether staff were reached, so the Leads tab can show it. Never throws. */
export async function recordLeadNotification(target: { leadId?: number; senderId?: string }, status: "sent" | "failed" | "no_channel", error = ""): Promise<void> {
  const lead = await leadForAlert(target);
  if (!lead) return;
  await queryNeon("UPDATE travel_leads SET notify_status=$2, notify_error=$3, notified_at=NOW() WHERE id=$1", [lead.id, status, error.slice(0, 200)])
    .catch(() => null);
}

export async function assignLead(id: number, assignee: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const name = assignee.trim().slice(0, 80);
  const result = await queryNeon(
    `UPDATE travel_leads SET assigned_to=$2, assigned_at=CASE WHEN $2='' THEN NULL ELSE NOW() END,
        status='seen', seen_at=COALESCE(seen_at, NOW()) WHERE id=$1`,
    [id, name],
  );
  return (result?.rowCount ?? 0) > 0;
}

/**
 * When the customer last added to a lead (a follow-up reopens an older lead). Added here on
 * first use rather than in the schema bootstrap; null on rows from before it existed, where
 * the creation time stands in (leadAttention.ts).
 */
let leadActivityColumn: Promise<void> | null = null;
function ensureLeadActivityColumn(): Promise<void> {
  leadActivityColumn ||= queryNeon(`ALTER TABLE travel_leads ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ NULL`)
    .then(() => undefined, (error) => { leadActivityColumn = null; throw error; });
  return leadActivityColumn;
}

/** Test sessions (/api/demo and the QA scripts behind it) never count as a customer lead. */
const REAL_SENDER = `sender_id NOT LIKE 'demo:%'`;

/**
 * Returns true if an unresolved lead of the same kind already exists for this
 * sender within the lookback window — used to avoid spamming duplicate leads
 * when a customer sends several intent messages in a row.
 */
export async function hasRecentOpenLead(
  senderId: string,
  kind: LeadKind,
  withinMs = 6 * 60 * 60 * 1000,
): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM travel_leads
      WHERE sender_id = $1
        AND kind = $2
        AND status = 'new'
        AND created_at > NOW() - ($3::int * INTERVAL '1 millisecond')
    `,
    [senderId, kind, withinMs],
  );
  return Number(result?.rows?.[0]?.count || 0) > 0;
}

/** The customer's latest lead in the window, a booking before a handoff of the same age. */
export async function latestCustomerLead(senderId: string, withinDays = 14): Promise<TravelLead | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<Record<string, unknown>>(
    `SELECT * FROM travel_leads WHERE sender_id = $1 AND created_at > NOW() - ($2::int * INTERVAL '1 day')
     ORDER BY (kind = 'booking') DESC, created_at DESC LIMIT 1`,
    [senderId, withinDays],
  );
  const row = result?.rows[0];
  return row ? mapLeadRow(row) : null;
}

/**
 * A message from a customer staff already own: appended to their lead, which goes back to
 * unread so it shows in the Leads tab again. The CRM status staff set is kept. Returns
 * whether the lead was updated.
 */
export async function recordLeadFollowup(leadId: number, line: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  await ensureLeadActivityColumn();
  const result = await queryNeon<{ id: number }>(
    `UPDATE travel_leads SET status = 'new', seen_at = NULL, last_activity_at = NOW(), context = RIGHT(context || E'\\n' || $2, 4000)
     WHERE id = $1 RETURNING id`,
    [leadId, line],
  );
  return Boolean(result?.rows.length);
}

export async function createLead(input: {
  kind: LeadKind;
  platform: string;
  senderId: string;
  customerMessage: string;
  contactPhone?: string;
  context?: string;
}): Promise<TravelLead | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_leads (
        kind, platform, sender_id, customer_message, contact_phone, context, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'new')
      RETURNING *
    `,
    [
      input.kind,
      input.platform,
      input.senderId,
      input.customerMessage.slice(0, 2000),
      (input.contactPhone || "").slice(0, 40),
      (input.context || "").slice(0, 4000),
    ],
  );
  return result?.rows?.[0] ? mapLeadRow(result.rows[0]) : null;
}

export async function listLeads(limit = 50): Promise<TravelLead[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  // A lead the customer just wrote to again comes first, not where its creation date puts it.
  const activity = await ensureLeadActivityColumn().then(() => "COALESCE(last_activity_at, created_at)", () => "created_at");
  // A consultant's reply seen in the thread after the lead (pause "operator_reply") tells the
  // Leads tab the customer was answered in Messenger (leadAttention.ts).
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT l.*, CASE WHEN s.pause_reason = 'operator_reply' THEN s.paused_at END AS staff_replied_at,
             (s.paused AND s.expires_at > NOW()) AS bot_paused, s.pause_reason AS bot_pause_reason
      FROM travel_leads l
      LEFT JOIN travel_senders s ON s.sender_id = l.sender_id
      WHERE l.${REAL_SENDER}
      ORDER BY (l.status = 'new') DESC, ${activity.replace(/(last_activity_at|created_at)/g, "l.$1")} DESC
      LIMIT $1
    `,
    [safeLimit],
  );
  return result?.rows ? result.rows.map(mapLeadRow) : [];
}

export async function countNewLeads(): Promise<number> {
  const ready = await ensureTravelSchema();
  if (!ready) return 0;
  const result = await queryNeon<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM travel_leads WHERE status = 'new' AND ${REAL_SENDER}`,
  );
  return Number(result?.rows?.[0]?.count || 0);
}

export async function markLeadSeen(id: number): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `UPDATE travel_leads SET status = 'seen', seen_at = NOW() WHERE id = $1`,
    [id],
  );
  return (result?.rowCount ?? 0) > 0;
}

export async function updateLeadStatus(
  id: number,
  leadStatus: LeadCrmStatus,
): Promise<boolean> {
  if (!(VALID_CRM_STATUSES as string[]).includes(leadStatus)) return false;
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `UPDATE travel_leads SET lead_status = $1, status = 'seen', seen_at = COALESCE(seen_at, NOW()) WHERE id = $2`,
    [leadStatus, id],
  );
  return (result?.rowCount ?? 0) > 0;
}

/** Aggregated lead numbers for the dashboard. Safe defaults if DB is absent. */
export async function getLeadStats(): Promise<LeadStats> {
  const empty: LeadStats = {
    total: 0,
    new_count: 0,
    today: 0,
    last7days: 0,
    last30days: 0,
    by_platform: [],
    by_kind: [],
    daily: [],
  };
  const ready = await ensureTravelSchema();
  if (!ready) return empty;

  const [totals, platforms, kinds, daily] = await Promise.all([
    queryNeon<{
      total: string;
      new_count: string;
      today: string;
      last7days: string;
      last30days: string;
    }>(`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'new')::text AS new_count,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::text AS today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text AS last7days,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::text AS last30days
      FROM travel_leads WHERE ${REAL_SENDER}
    `),
    queryNeon<{ platform: string; count: string }>(`
      SELECT COALESCE(NULLIF(platform, ''), 'unknown') AS platform, COUNT(*)::text AS count
      FROM travel_leads WHERE ${REAL_SENDER}
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ kind: string; count: string }>(`
      SELECT COALESCE(NULLIF(kind, ''), 'handoff') AS kind, COUNT(*)::text AS count
      FROM travel_leads WHERE ${REAL_SENDER}
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ day: string; count: string }>(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::text AS count
      FROM travel_leads
      WHERE created_at >= NOW() - INTERVAL '7 days' AND ${REAL_SENDER}
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const t = totals?.rows?.[0];
  return {
    total: Number(t?.total || 0),
    new_count: Number(t?.new_count || 0),
    today: Number(t?.today || 0),
    last7days: Number(t?.last7days || 0),
    last30days: Number(t?.last30days || 0),
    by_platform: (platforms?.rows || []).map((r) => ({
      platform: r.platform,
      count: Number(r.count || 0),
    })),
    by_kind: (kinds?.rows || []).map((r) => ({
      kind: r.kind,
      count: Number(r.count || 0),
    })),
    daily: (daily?.rows || []).map((r) => ({
      day: r.day,
      count: Number(r.count || 0),
    })),
  };
}
