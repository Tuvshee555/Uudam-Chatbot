/**
 * Keeps the PUBLISHED catalogues true without anybody clicking Generate / Publish.
 *
 * A scheduled call (GitHub Actions every 30 minutes -> /api/cron/catalogue-refresh) asks, for each
 * edition: is the published file still true and complete? When it is not, the same code the admin's
 * Generate + Publish buttons use builds a new version from the live trips, and publishes it. Nothing
 * is rendered when nothing changed, so a quiet hour costs one cheap comparison.
 *
 * A new version is published only when it has no BLOCKING warning; otherwise the old file stays
 * (the bot's freshness rule keeps withholding it if it is stale) and the result says why.
 */
import type { CatalogueEdition, CatalogueVersionMeta } from "./types";
import { catalogueAgeDays, evaluateFreshness, checkLiveDrift, type FreshnessVerdict } from "./freshness";

/** Refresh a file before the 21-day staleness cutoff would make the bot withhold it. */
export const REFRESH_AFTER_DAYS = 14;
export const AUTO_REFRESH_ACTOR = "auto-refresh";
const LOCK_MINUTES = 12;
/** Versions kept per edition (the published one always stays). */
export const KEEP_VERSIONS = 4;

export type RefreshDecision = { refresh: boolean; reasons: string[] };

export type DecideInput = {
  edition: Exclude<CatalogueEdition, "preview">;
  published: Pick<CatalogueVersionMeta, "generatedAt"> | null;
  freshness: FreshnessVerdict | null;
  /** When staff last saved the catalogue config (photos, titles, cover, notes). */
  configUpdatedAt: string | null;
  publishedTripIds: readonly string[] | null;
  /** Trip ids the live Complete edition would print now (only needed for "complete"). */
  liveTripIds: readonly string[] | null;
  /** Changes that keep the file true but incomplete (new or passed dates): refresh, without being stale. */
  pendingChanges?: number;
  nowIso: string;
};

/** Pure: should this edition be regenerated now, and why. */
export function decideRefresh(input: DecideInput): RefreshDecision {
  const reasons: string[] = [];
  if (!input.published) return { refresh: true, reasons: ["none_published"] };
  if (input.freshness?.stale) reasons.push(`stale:${input.freshness.code}`);
  if ((input.pendingChanges ?? 0) > 0) reasons.push("schedule_changed");
  const age = catalogueAgeDays(input.published.generatedAt, input.nowIso);
  if (age !== null && age > REFRESH_AFTER_DAYS) reasons.push("age");
  const generated = Date.parse(input.published.generatedAt);
  const configAt = input.configUpdatedAt ? Date.parse(input.configUpdatedAt) : NaN;
  if (Number.isFinite(generated) && Number.isFinite(configAt) && configAt > generated) reasons.push("config_changed");
  if (input.edition === "complete" && input.publishedTripIds && input.liveTripIds) {
    const published = new Set(input.publishedTripIds);
    const live = new Set(input.liveTripIds);
    const added = [...live].filter((id) => !published.has(id)).length;
    const removed = [...published].filter((id) => !live.has(id)).length;
    if (added > 0) reasons.push("new_trips");
    if (removed > 0) reasons.push("trips_removed");
  }
  return { refresh: reasons.length > 0, reasons: [...new Set(reasons)] };
}

export type RefreshResult = {
  edition: Exclude<CatalogueEdition, "preview">;
  status: "unchanged" | "published" | "blocked" | "skipped_locked" | "failed";
  reasons: string[];
  versionNo?: number;
  versionId?: string;
  detail?: string;
};

async function tryLock(): Promise<boolean> {
  const { catalogueQuery } = await import("./schema");
  await catalogueQuery(`CREATE TABLE IF NOT EXISTS catalogue_refresh_lock (id INT PRIMARY KEY, locked_until TIMESTAMPTZ NOT NULL)`);
  const res = await catalogueQuery(
    `INSERT INTO catalogue_refresh_lock (id, locked_until) VALUES (1, now() + ($1 || ' minutes')::interval)
     ON CONFLICT (id) DO UPDATE SET locked_until = EXCLUDED.locked_until WHERE catalogue_refresh_lock.locked_until < now()
     RETURNING id`,
    [String(LOCK_MINUTES)],
  );
  return res.rowCount > 0;
}

async function unlock(): Promise<void> {
  const { catalogueQuery } = await import("./schema");
  await catalogueQuery(`UPDATE catalogue_refresh_lock SET locked_until = now() WHERE id = 1`).catch(() => undefined);
}

/** One scheduled pass over both editions. Never throws for one edition's failure: it is reported. */
export async function refreshCatalogues(opts: { now?: Date; only?: "quick" | "complete" } = {}): Promise<RefreshResult[]> {
  const { getDeps } = await import("./admin/deps");
  const { selectionBoundsMessage } = await import("./admin/validation");
  const deps = getDeps();
  const [store, data, render] = await Promise.all([deps.store(), deps.data(), deps.render()]);
  await store.ensureCatalogueSchema();
  if (!(await tryLock())) return (opts.only ? [opts.only] : (["complete", "quick"] as const)).map((edition) => ({ edition, status: "skipped_locked" as const, reasons: ["another_refresh_running"] }));

  const results: RefreshResult[] = [];
  try {
    const now = opts.now ?? deps.now();
    const nowIso = now.toISOString();
    const config = await store.getCatalogueConfig();
    for (const edition of opts.only ? [opts.only] : (["complete", "quick"] as const)) {
      try {
        const published = await store.getPublished(edition);
        let freshness: FreshnessVerdict | null = null;
        let publishedTripIds: string[] | null = null;
        let liveTripIds: string[] | null = null;
        let pendingChanges = 0;
        if (published) {
          const drift = await checkLiveDrift(published, nowIso);
          pendingChanges = drift?.pending?.length ?? 0;
          freshness = evaluateFreshness({ published, nowIso, drift });
          publishedTripIds = ((await store.getVersionSnapshot(published.id))?.trips ?? []).map((trip) => trip.tripId);
          if (edition === "complete") {
            liveTripIds = data.buildCatalogueSnapshot(await data.loadSnapshotInput("complete", { nowIso })).trips.map((trip) => trip.tripId);
          }
        }
        const decision = decideRefresh({ edition, published, freshness, configUpdatedAt: config.updatedAt, publishedTripIds, liveTripIds, pendingChanges, nowIso });
        if (!decision.refresh) { results.push({ edition, status: "unchanged", reasons: [] }); continue; }

        const input = await data.loadSnapshotInput(edition, { nowIso, measurePhotos: true });
        const snapshot = data.buildCatalogueSnapshot(input);
        if (edition === "complete" && snapshot.trips.length < 1) { results.push({ edition, status: "failed", reasons: decision.reasons, detail: "no eligible trips" }); continue; }
        if (edition === "quick") {
          const bounds = selectionBoundsMessage("quick", snapshot.trips.length);
          if (bounds) { results.push({ edition, status: "blocked", reasons: decision.reasons, detail: bounds }); continue; }
        }
        const nextNo = ((await store.listVersions(edition, 1))[0]?.versionNo ?? 0) + 1;
        const rendered = await render.renderCatalogue(snapshot, { pageImages: true, versionLabel: `v${nextNo}` });
        const draft = await store.saveDraftVersion({ edition, snapshot, rendered, actor: AUTO_REFRESH_ACTOR });
        const blocking = draft.warnings.filter((warning) => warning.severity === "blocking");
        if (blocking.length > 0) {
          results.push({ edition, status: "blocked", reasons: decision.reasons, versionNo: draft.versionNo, versionId: draft.id, detail: `${blocking.length} blocking warning(s): ${blocking.map((w) => w.code).join(",")}` });
          continue;
        }
        const live = await store.publishVersion(draft.id, AUTO_REFRESH_ACTOR, { acknowledgeWarnings: false });
        results.push({ edition, status: "published", reasons: decision.reasons, versionNo: live.versionNo, versionId: live.id });
      } catch (error) {
        results.push({ edition, status: "failed", reasons: [], detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) });
      }
    }
    // Every version stores its PDF and page previews in the database: keep the newest few per edition
    // (rollback targets) so storage does not grow with every refresh. A published version is never removed.
    await store.pruneOldVersions?.(KEEP_VERSIONS).catch(() => undefined);
  } finally {
    await unlock();
  }
  return results;
}
