/**
 * The partner watch: every trip made from a partner's page (extra.source_url) is checked
 * against that page again.
 *
 * One run (scripts/partner-watch.ts, /api/cron/partner-watch every 6 hours):
 *  - the trips with a source page, not archived or cancelled, not partner-synced (that sync owns
 *    its trips), at most 50, the longest-unchecked first;
 *  - each page fetched once per run however many trips came from it (SSRF-safe safeFetch,
 *    10 s each, at most 4 at a time, the whole run within ~4 minutes);
 *  - the schedule read in code (scheduleTable.ts) and compared with the trip (compare.ts);
 *  - a seat state that changed (open / few seats / full) is written through the assistant's own
 *    set_date_state (travelAIApply.applyAIAction → websiteTripSync.changeDepartureState, behind
 *    the trip's version and the day's observed status), so the bot, the website and the fare
 *    card say the same; prices, new and vanished dates are never written — they are recorded;
 *  - every check is one partner_watch_events row; a failure is recorded, never thrown.
 * `--dry-run` reads and compares only: nothing is written, nothing recorded.
 */
import { compareWithTrip, seatChangeProblem, seatWords, type WatchItem } from "./compare";
import { parseScheduleTables } from "./scheduleTable";
import { cleanSourceUrl, partnerSyncUrl, sourceUrlKey, tripSourceUrl } from "./sourceUrl";
import type { AppliedLine, WatchEventInput } from "./store";
import { dateStatusOf } from "../tripActionPlan";
import { shortDay } from "../tripDatePrice";
import type { AITripAction, TravelTrip } from "../travelTypes";
import type { SafeFetchFn } from "../assistantAgent/types";
import type { WebPageResult } from "../assistantAgent/webPage";

export const WATCH_MAX_TRIPS = 50;
export const WATCH_FETCH_TIMEOUT_MS = 10_000;
const WATCH_BUDGET_MS = 240_000;
const FETCH_CONCURRENCY = 4;
/** A schedule can sit below a long program: the watch reads the whole page, not the assistant's 20k. */
const PAGE_TEXT_MAX_CHARS = 200_000;

export type ApplyResult = { ok: boolean; message: string; snapshot?: { departure_rows?: unknown[] } };

export type WatchDeps = {
  /** The watched trips with their website day states (read only); one trip when `tripId` is given. */
  loadTrips: (tripId?: string) => Promise<TravelTrip[]>;
  lastChecked: () => Promise<Map<string, string>>;
  fetchPage: (url: string) => Promise<WebPageResult>;
  applyAction: (action: AITripAction) => Promise<ApplyResult>;
  record: (event: WatchEventInput) => Promise<unknown>;
  now: () => Date;
};

export type TripWatchResult = {
  trip_id: string;
  route_name: string;
  source_url: string;
  status: "checked" | "failed" | "skipped";
  applied: AppliedLine[];
  pending: WatchItem[];
  notes: string[];
  error?: string;
};

export type WatchOptions = { tripId?: string; dryRun?: boolean; limit?: number; budgetMs?: number };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/g, "[database]").slice(0, 300);

/** A trip the watch checks: made from a partner page, still sold or prepared, not owned by the partner sync. */
export function isWatchable(trip: TravelTrip): boolean {
  return Boolean(cleanSourceUrl(tripSourceUrl(trip))) && !partnerSyncUrl(trip) && !["archived", "cancelled"].includes(trip.status);
}

/** The page read and compared with one trip; nothing written. */
export function readTripAgainstPage(trip: TravelTrip, page: WebPageResult, now: Date): { ok: true; items: WatchItem[]; notes: string[] } | { ok: false; error: string } {
  if (!page.ok) return { ok: false, error: `Хуудсыг уншиж чадсангүй: ${page.error}` };
  const parsed = parseScheduleTables(page.text);
  if (!parsed.ok) return { ok: false, error: parsed.reason };
  const compared = compareWithTrip(trip, parsed.rows, now, parsed.unread);
  const notes = parsed.skipped
    ? [...compared.notes, `Хүснэгтийн ${parsed.skipped} мөрийг уншиж чадсангүй${parsed.unread.length ? ` (${parsed.unread.join(", ")})` : ""} — тэр өдрүүдийг харьцуулсангүй.`]
    : compared.notes;
  return { ok: true, items: compared.items, notes };
}

/** The assistant's set_date_state for one seat change, built as the agent builds it (version and observed status). */
export function seatAction(trip: TravelTrip, item: Extract<WatchItem, { kind: "seat_state" }>): AITripAction {
  return {
    action: "set_date_state", trip_id: trip.id, date: item.date, state: item.to.state,
    observed_status: dateStatusOf(trip, item.date), expected_updated_at: trip.updated_at,
    summary: `«${trip.route_name}» — ${shortDay(item.date)}: ${seatWords(item.from)} → ${seatWords(item.to)} (хамтрагчийн хуудсаар)`,
  } as AITripAction;
}

async function checkTrip(trip: TravelTrip, page: WebPageResult, deps: WatchDeps, dryRun: boolean): Promise<TripWatchResult> {
  const now = deps.now();
  const base = { trip_id: trip.id, route_name: trip.route_name, source_url: cleanSourceUrl(tripSourceUrl(trip)) };
  const read = readTripAgainstPage(trip, page, now);
  if (!read.ok) return { ...base, status: "failed", applied: [], pending: [], notes: [], error: read.error };
  const applied: AppliedLine[] = [];
  const pending: WatchItem[] = [];
  for (const item of read.items) {
    if (item.kind !== "seat_state") { pending.push(item); continue; }
    const problem = seatChangeProblem(trip, item, now);
    if (problem) { pending.push({ ...item, reason: problem }); continue; }
    if (dryRun) { applied.push({ date: item.date, text: item.text, message: "dry-run: бичээгүй" }); continue; }
    try {
      const result = await deps.applyAction(seatAction(trip, item));
      if (result.ok) applied.push({ date: item.date, text: item.text, message: result.message, ...(result.snapshot?.departure_rows ? { rows: result.snapshot.departure_rows } : {}) });
      else pending.push({ ...item, reason: result.message });
    } catch (error) {
      pending.push({ ...item, reason: message(error) });
    }
  }
  return { ...base, status: "checked", applied, pending, notes: read.notes };
}

async function eachLimited<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await work(next);
  }));
}

export async function runPartnerWatch(options: WatchOptions = {}, overrides: Partial<WatchDeps> = {}): Promise<TripWatchResult[]> {
  const deps: WatchDeps = { ...defaultWatchDeps(), ...overrides };
  const startedAt = Date.now();
  const budgetMs = options.budgetMs ?? WATCH_BUDGET_MS;
  const dryRun = Boolean(options.dryRun);
  const loaded = (await deps.loadTrips(options.tripId)).filter((trip) => !options.tripId || trip.id === options.tripId);
  const results: TripWatchResult[] = [];
  const skipped = (trip: TravelTrip, error: string): TripWatchResult => ({ trip_id: trip.id, route_name: trip.route_name, source_url: tripSourceUrl(trip), status: "skipped", applied: [], pending: [], notes: [], error });
  for (const trip of loaded) {
    if (isWatchable(trip)) continue;
    if (options.tripId) results.push(skipped(trip, partnerSyncUrl(trip) ? "хамтрагчийн sync-ээр шинэчлэгддэг аялал" : tripSourceUrl(trip) ? `${trip.status} аяллыг шалгахгүй` : "хамтрагчийн хуудасгүй аялал"));
  }
  const last = await deps.lastChecked().catch(() => new Map<string, string>());
  const watched = loaded.filter(isWatchable)
    .sort((a, b) => (last.get(a.id) || "").localeCompare(last.get(b.id) || ""))
    .slice(0, Math.max(1, Math.min(options.limit ?? WATCH_MAX_TRIPS, WATCH_MAX_TRIPS)));
  // One request per partner page per run, however many trips were made from it.
  const pages = new Map<string, TravelTrip[]>();
  for (const trip of watched) {
    const key = sourceUrlKey(tripSourceUrl(trip));
    pages.set(key, [...(pages.get(key) || []), trip]);
  }
  await eachLimited([...pages.values()], FETCH_CONCURRENCY, async (trips) => {
    if (Date.now() - startedAt > budgetMs) {
      for (const trip of trips) results.push(skipped(trip, "энэ ээлжинд цаг хүрэлцээгүй — дараагийн шалгалтаар"));
      return;
    }
    let page: WebPageResult;
    const url = cleanSourceUrl(tripSourceUrl(trips[0]));
    try { page = await deps.fetchPage(url); } catch (error) { page = { ok: false, url, error: message(error) }; }
    for (const trip of trips) {
      let result: TripWatchResult;
      try { result = await checkTrip(trip, page, deps, dryRun); } catch (error) {
        result = { trip_id: trip.id, route_name: trip.route_name, source_url: url, status: "failed", applied: [], pending: [], notes: [], error: message(error) };
      }
      results.push(result);
      if (dryRun) continue;
      await Promise.resolve(deps.record({
        trip_id: trip.id, source_url: result.source_url, ok: result.status === "checked",
        applied: result.applied, pending: result.pending, error: result.error ?? null,
      })).catch(() => undefined);
    }
  });
  return results;
}

/* ---------------------------------------------------------------- */
/* The real world                                                   */
/* ---------------------------------------------------------------- */

const TRIP_COLUMNS = `id, category, operator_name, route_name, duration_text, adult_price, child_price, infant_price, currency,
  departure_dates, seats_total, seats_left, has_food, status, notes, hotel, source_description, photo_urls, extra, created_at, updated_at`;

/** The watched trips, read with one SELECT (no schema or schedule upkeep runs), with their website day states. */
async function loadWatchedTrips(tripId?: string): Promise<TravelTrip[]> {
  const { queryNeon } = await import("../neonDb");
  const { mapTripRow } = await import("../travelDb");
  const { withWebsiteDepartureAvailability } = await import("../websiteTripSync");
  const result = await queryNeon<Record<string, unknown>>(
    `SELECT ${TRIP_COLUMNS} FROM travel_trip_entries
      WHERE ($1::text IS NULL OR id = $1) AND (COALESCE(extra->>'source_url', '') <> '' OR id = $1)
      ORDER BY updated_at DESC LIMIT 500`,
    [tripId ?? null],
  );
  if (!result) throw new Error("Өгөгдлийн сан холбогдоогүй байна");
  return withWebsiteDepartureAvailability(result.rows.map(mapTripRow));
}

/** A page reader over this fetcher, the way the assistant reads a page (https only, 10 s) but the whole page. */
export function partnerPageReader(fetcher: SafeFetchFn): WatchDeps["fetchPage"] {
  return async (url) => {
    const { readWebPage } = await import("../assistantAgent/webPage");
    return readWebPage(url, fetcher, { timeoutMs: WATCH_FETCH_TIMEOUT_MS, maxChars: PAGE_TEXT_MAX_CHARS });
  };
}

/** A partner page as text through the SSRF-safe safeFetch. */
export async function fetchPartnerPage(url: string): Promise<WebPageResult> {
  const { safeFetch } = await import("../safeFetch");
  return partnerPageReader(safeFetch)(url);
}

export function defaultWatchDeps(): WatchDeps {
  return {
    loadTrips: loadWatchedTrips,
    lastChecked: async () => (await import("./store")).lastCheckedByTrip(),
    fetchPage: fetchPartnerPage,
    applyAction: async (action) => (await import("../travelAIApply")).applyAIAction(action),
    record: async (event) => (await import("./store")).recordWatchEvent(event),
    now: () => new Date(),
  };
}
