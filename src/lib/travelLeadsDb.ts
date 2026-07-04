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
  };
}

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
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT *
      FROM travel_leads
      ORDER BY (status = 'new') DESC, created_at DESC
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
    `SELECT COUNT(*)::text AS count FROM travel_leads WHERE status = 'new'`,
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
      FROM travel_leads
    `),
    queryNeon<{ platform: string; count: string }>(`
      SELECT COALESCE(NULLIF(platform, ''), 'unknown') AS platform, COUNT(*)::text AS count
      FROM travel_leads
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ kind: string; count: string }>(`
      SELECT COALESCE(NULLIF(kind, ''), 'handoff') AS kind, COUNT(*)::text AS count
      FROM travel_leads
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ day: string; count: string }>(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::text AS count
      FROM travel_leads
      WHERE created_at >= NOW() - INTERVAL '7 days'
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
