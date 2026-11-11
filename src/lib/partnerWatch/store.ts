/**
 * Every partner-page check, one row each (partner_watch_events): what was applied on its own
 * (seat states) and what waits for the admin (prices, new and vanished dates, refused seat
 * changes). The admin's «Тойм» reads the latest check per trip from here.
 *
 * The table is created on first use (CREATE TABLE IF NOT EXISTS), like the other modules'
 * tables. Rows are only ever added.
 */
import { queryNeon } from "../neonDb";
import type { WatchItem } from "./compare";

/** One seat state the watch wrote, with the website rows it changed (their earlier and later status). */
export type AppliedLine = { date: string; text: string; message: string; rows?: unknown[] };

export type WatchEventInput = {
  trip_id: string;
  source_url: string;
  ok: boolean;
  applied: AppliedLine[];
  pending: WatchItem[];
  error?: string | null;
};

let schemaReady: Promise<boolean> | null = null;

export function ensurePartnerWatchSchema(): Promise<boolean> {
  schemaReady ||= (async () => {
    const created = await queryNeon(`
      CREATE TABLE IF NOT EXISTS partner_watch_events (
        id BIGSERIAL PRIMARY KEY,
        trip_id TEXT NOT NULL,
        checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        source_url TEXT NOT NULL DEFAULT '',
        ok BOOLEAN NOT NULL DEFAULT FALSE,
        applied JSONB NOT NULL DEFAULT '[]'::jsonb,
        pending JSONB NOT NULL DEFAULT '[]'::jsonb,
        error TEXT NULL
      )`);
    if (!created) return false;
    await queryNeon("CREATE INDEX IF NOT EXISTS idx_partner_watch_events_trip ON partner_watch_events (trip_id, checked_at DESC)");
    return true;
  })().catch(() => {
    schemaReady = null;
    return false;
  });
  return schemaReady;
}

/** Tests: forget that the table was created. */
export function resetPartnerWatchSchemaForTests(): void {
  schemaReady = null;
}

export async function recordWatchEvent(event: WatchEventInput): Promise<boolean> {
  if (!(await ensurePartnerWatchSchema())) return false;
  const saved = await queryNeon(
    `INSERT INTO partner_watch_events (trip_id, source_url, ok, applied, pending, error) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [event.trip_id, event.source_url, event.ok, JSON.stringify(event.applied), JSON.stringify(event.pending), event.error ? event.error.slice(0, 500) : null],
  );
  return Boolean(saved);
}

/** When each trip was last checked (ISO), so a run with more than its cap checks the longest-waiting first. Read only; {} when nothing is recorded yet. */
export async function lastCheckedByTrip(): Promise<Map<string, string>> {
  try {
    const result = await queryNeon<{ trip_id: string; checked_at: Date | string }>(
      "SELECT trip_id, MAX(checked_at) AS checked_at FROM partner_watch_events GROUP BY trip_id",
    );
    return new Map((result?.rows || []).map((row) => [row.trip_id, new Date(row.checked_at).toISOString()]));
  } catch {
    // The table does not exist before the first recorded check.
    return new Map();
  }
}

export type WatchOverviewTrip = {
  trip_id: string;
  route_name: string;
  checked_at: string;
  source_url: string;
  ok: boolean;
  error: string | null;
  pending: Array<Pick<WatchItem, "kind" | "date" | "text" | "instruction" | "reason">>;
};
export type WatchOverviewApplied = { trip_id: string; route_name: string; checked_at: string; lines: string[] };
export type WatchOverview = { watched: number; trips: WatchOverviewTrip[]; applied: WatchOverviewApplied[]; last_checked_at: string | null };

const iso = (value: unknown) => new Date(value as string).toISOString();

/** The dashboard card: each watched trip's latest check (14 days), and the seat states applied in the last 7 days. */
export async function partnerWatchOverview(): Promise<WatchOverview> {
  const empty: WatchOverview = { watched: 0, trips: [], applied: [], last_checked_at: null };
  if (!(await ensurePartnerWatchSchema())) return empty;
  const [latest, applied] = await Promise.all([
    queryNeon<{ trip_id: string; route_name: string | null; status: string | null; checked_at: Date; source_url: string; ok: boolean; error: string | null; pending: unknown }>(
      `SELECT DISTINCT ON (e.trip_id) e.trip_id, t.route_name, t.status, e.checked_at, e.source_url, e.ok, e.error, e.pending
         FROM partner_watch_events e LEFT JOIN travel_trip_entries t ON t.id = e.trip_id
        WHERE e.checked_at > NOW() - INTERVAL '14 days'
        ORDER BY e.trip_id, e.checked_at DESC`,
    ),
    queryNeon<{ trip_id: string; route_name: string | null; checked_at: Date; applied: unknown }>(
      `SELECT e.trip_id, t.route_name, e.checked_at, e.applied
         FROM partner_watch_events e LEFT JOIN travel_trip_entries t ON t.id = e.trip_id
        WHERE e.checked_at > NOW() - INTERVAL '7 days' AND jsonb_array_length(e.applied) > 0
        ORDER BY e.checked_at DESC LIMIT 30`,
    ),
  ]);
  // A trip archived or deleted since is no longer watched.
  const live = (latest?.rows || []).filter((row) => row.route_name && row.status !== "archived");
  const trips: WatchOverviewTrip[] = live.map((row) => ({
    trip_id: row.trip_id,
    route_name: String(row.route_name),
    checked_at: iso(row.checked_at),
    source_url: row.source_url,
    ok: row.ok,
    error: row.error,
    pending: (Array.isArray(row.pending) ? row.pending : []).slice(0, 40).map((item) => {
      const entry = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return {
        kind: String(entry.kind || "") as WatchItem["kind"],
        date: String(entry.date || ""),
        text: String(entry.text || ""),
        instruction: String(entry.instruction || ""),
        ...(entry.reason ? { reason: String(entry.reason) } : {}),
      };
    }),
  })).sort((a, b) => b.pending.length - a.pending.length || a.route_name.localeCompare(b.route_name));
  const appliedRows: WatchOverviewApplied[] = (applied?.rows || []).filter((row) => row.route_name).map((row) => ({
    trip_id: row.trip_id,
    route_name: String(row.route_name),
    checked_at: iso(row.checked_at),
    lines: (Array.isArray(row.applied) ? row.applied : []).map((line) => String((line as AppliedLine)?.text || "")).filter(Boolean),
  }));
  const last = trips.map((trip) => trip.checked_at).sort().pop() ?? null;
  return { watched: trips.length, trips, applied: appliedRows, last_checked_at: last };
}
