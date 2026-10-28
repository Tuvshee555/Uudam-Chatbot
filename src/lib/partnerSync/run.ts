import { fetchGlobalTravelTour, validDate, type PartnerTour } from "./globalTravel";
import { buildPosterData, describeChanges, lowestAdultPrice } from "./posterPayload";
import { buildTripFields } from "./tripPayload";
import { normalizeExtraPatch } from "../tripExtraSchema";
import { isDeepStrictEqual } from "node:util";

export type TourConfig = { slug: string; posterId: string; tripId: string };

export const TOURS: TourConfig[] = [{
  slug: "hainan-aylal",
  posterId: "poster-5bf8e4a6-55cc-4074-bcbf-669527e2530c",
  tripId: "trip-poster-5bf8e4a6-55cc-4074-bcbf-669527e2530c",
}];

export type SyncResult = {
  slug: string;
  status: "unchanged" | "dry-run" | "synced" | "failed" | "blocked" | "busy";
  lines: string[];
  reason?: string;
  price?: number | null;
};
type Flags = { dryRun?: boolean; force?: boolean };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

/** Validate structure, not business decisions: every valid source price change is mirrored. */
export function tripwire(_before: PartnerTour | null, after: PartnerTour): string | null {
  if (!after.rows.length || !after.days.length) return "Partner returned incomplete tour data";
  const keys = new Set<string>();
  for (const row of after.rows) {
    const key = `${row.date}|${row.hotel}`;
    if (!validDate(row.date) || !row.hotel || keys.has(key)) return "Partner returned invalid or duplicate rows";
    keys.add(key);
    if (row.prices.adult == null && row.prices.programAdult == null) return "Partner row has no adult fare";
    if (Object.values(row.prices).some((price) => price !== null && (!Number.isSafeInteger(price) || price <= 0))) return "Partner returned an invalid fare";
  }
  return null;
}

export function dateSeatState(tour: PartnerTour, date: string): "open" | "full" {
  return tour.rows.some((row) => row.date === date && row.open) ? "open" : "full";
}

export function syncIsComplete(data: unknown, tour: PartnerTour, queueSynced: boolean): boolean {
  const sync = record(record(data).partner_sync);
  return sync.content_hash === tour.contentHash && sync.status === "complete" && queueSynced;
}

async function syncLocked(config: TourConfig, flags: Flags): Promise<SyncResult> {
  const { getPosterTrip } = await import("../poster/db");
  const { queryNeon } = await import("../neonDb");
  const tour = await fetchGlobalTravelTour(config.slug);
  const existing = await getPosterTrip(config.posterId);
  if (!existing) throw new Error(`Poster ${config.posterId} not found`);
  const linked = await queryNeon("SELECT * FROM travel_trip_entries WHERE id=$1 AND extra->>'poster_trip_id'=$2", [config.tripId, config.posterId]);
  if (!linked?.rows.length) throw new Error("Configured poster and trip are not linked");
  const stored = record(existing.data).partner_snapshot as PartnerTour | undefined;
  const before = stored && Array.isArray(stored.rows) ? stored : null;
  const queue = await queryNeon<{ synced: boolean }>("SELECT revision=synced_revision AS synced FROM trip_website_sync WHERE trip_id=$1", [config.tripId]);
  const posterData = buildPosterData(tour, existing.data);
  const desired = buildTripFields(tour, posterData);
  const canonical = linked.rows[0];
  const matches = Object.entries(desired).every(([key, value]) => key === "extra"
    ? Object.entries(normalizeExtraPatch(record(value))).every(([name, fact]) => isDeepStrictEqual(canonical.extra[name], fact))
    : value === undefined || isDeepStrictEqual(canonical[key], value));
  if (!flags.force && matches && isDeepStrictEqual(posterData, existing.data)
    && syncIsComplete(existing.data, tour, queue?.rows[0]?.synced === true)) {
    return { slug: config.slug, status: "unchanged", lines: [] };
  }
  const blocked = tripwire(before, tour);
  if (blocked) return { slug: config.slug, status: "blocked", reason: blocked, lines: [] };
  const lines = describeChanges(before, tour);
  if (flags.dryRun) return { slug: config.slug, status: "dry-run", lines };
  if (!process.env.BOOKING_DATABASE_URL) throw new Error("BOOKING_DATABASE_URL is required for partner sync");

  const data = {
    ...posterData, partner_snapshot: tour,
    partner_sync: { source_url: tour.sourceUrl, content_hash: tour.contentHash, partner_updated: tour.updatedAt, status: "pending" },
  };
  const { patchTrip } = await import("../travelDb");
  // The existing canonical mutation saves the poster and the trip in one transaction.
  const saved = await patchTrip(config.tripId, desired, false, {
    id: config.posterId, title: existing.title, data, source_file: existing.source_file ?? null,
    note: `Partner sync ${new Date().toISOString()}`,
  }, canonical.updated_at instanceof Date ? canonical.updated_at.toISOString() : String(canonical.updated_at));
  if (!saved) throw new Error("Canonical partner save failed");

  const { flushWebsiteSync } = await import("../websiteTripSync");
  await flushWebsiteSync(config.tripId);
  const delivered = await queryNeon<{ synced: boolean; last_error: string | null }>(
    "SELECT revision=synced_revision AS synced,last_error FROM trip_website_sync WHERE trip_id=$1", [config.tripId],
  );
  if (!delivered?.rows[0]?.synced) throw new Error(delivered?.rows[0]?.last_error || "Website projection is still pending");
  // A failed projection leaves 'pending' behind so an unchanged source is retried.
  await queryNeon(`UPDATE poster_trips SET data=jsonb_set(data,'{partner_sync}',
    (data->'partner_sync') || jsonb_build_object('status','complete','synced_at',NOW())),updated_at=NOW()
    WHERE id=$1 AND data->'partner_sync'->>'content_hash'=$2`, [config.posterId, tour.contentHash]);
  return { slug: config.slug, status: "synced", lines, price: lowestAdultPrice(tour) };
}

export async function syncTour(config: TourConfig, flags: Flags = {}): Promise<SyncResult> {
  if (flags.dryRun) return syncLocked(config, flags);
  const { withNeonClient } = await import("../neonDb");
  const result = await withNeonClient(async (client) => {
    await client.query("BEGIN");
    try {
      // A transaction lock works through a pooled database connection. Its separate key
      // avoids interfering with canonical-save locks on the other connection.
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [`partner-sync:${config.tripId}`]);
      if (!lock.rows[0].acquired) return { slug: config.slug, status: "busy" as const, lines: [] };
      return await syncLocked(config, flags);
    } finally { await client.query("ROLLBACK"); }
  });
  if (!result) throw new Error("Partner sync database is unavailable");
  return result;
}

/** Tells staff what the sync changed or why it stopped. Never throws: an alert must not fail the sync. */
export function alertText(result: SyncResult): string | null {
  if (result.status === "synced" && result.lines.length) {
    return [`🔄 Хамтрагч аялал шинэчлэгдлээ (${result.slug})`, ...result.lines.slice(0, 25), result.lines.length > 25 ? `…дахиад ${result.lines.length - 25} өөрчлөлт` : ""].filter(Boolean).join("\n");
  }
  if (result.status === "blocked" || result.status === "failed") {
    return `⚠️ Хамтрагч аяллын sync зогслоо (${result.slug}): ${result.reason ?? result.status}`;
  }
  return null;
}

async function alertStaff(result: SyncResult): Promise<void> {
  const text = alertText(result);
  if (!text) return;
  try {
    const { notifyStaff } = await import("../staffAlerts");
    await notifyStaff(text, "partner_sync");
  } catch {
    // The run's return value is the record.
  }
}

export async function runPartnerSync(flags: Flags = {}): Promise<SyncResult[]> {
  const results: SyncResult[] = [];
  for (const config of TOURS) {
    try { results.push(await syncTour(config, flags)); }
    catch (error) {
      const reason = (error instanceof Error ? error.message : String(error)).replace(/postgres(?:ql)?:\/\/\S+/g, "[database]");
      results.push({ slug: config.slug, status: "failed", reason, lines: [] });
    }
    if (!flags.dryRun) await alertStaff(results[results.length - 1]);
  }
  return results;
}
