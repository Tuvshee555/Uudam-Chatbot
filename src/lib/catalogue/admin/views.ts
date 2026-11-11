/**
 * Shaping store records for the admin: version views with their admin URLs and the freshness verdict.
 */

import { CATALOGUE_ADMIN_API, CATALOGUE_PUBLIC_FILE_PATH, type CatalogueVersionMeta } from "../types";
import { checkLiveDrift, evaluateFreshness, type LiveDrift } from "../freshness";
import type { LazyDeps } from "./deps";
import type { CatalogueFreshnessView, CatalogueVersionView } from "./types";

export function toVersionView(meta: CatalogueVersionMeta): CatalogueVersionView {
  const base = `${CATALOGUE_ADMIN_API}/version/${encodeURIComponent(meta.id)}`;
  return {
    ...meta,
    downloadPath: `${base}/pdf`,
    openPath: `${base}/pdf?disposition=inline`,
    pagePath: `${base}/page`,
    publicPath: meta.status === "published" ? `${CATALOGUE_PUBLIC_FILE_PATH}/${meta.publicToken}` : null,
    blockingCount: meta.warnings.filter((w) => w.severity === "blocking").length,
    warningCount: meta.warnings.filter((w) => w.severity === "warning").length,
  };
}

/**
 * Is the published version still safe to send as is? The SAME rules the bot applies before it
 * sends (freshness.ts): stale when older than 21 days, or when the live trip data now differs
 * materially from the snapshot the file printed. A comparison that cannot be made is "unknown",
 * never "fresh" and never "stale": the infrastructure being down is no evidence about prices.
 */
export async function computeFreshness(params: {
  meta: CatalogueVersionMeta | null;
  deps: Pick<LazyDeps, "store" | "data" | "now">;
}): Promise<CatalogueFreshnessView> {
  const { meta, deps } = params;
  if (!meta) return { status: "none", ageDays: null, reasons: [] };
  const nowIso = deps.now().toISOString();
  let drift: LiveDrift | null = null;
  try {
    const [store, data] = await Promise.all([deps.store(), deps.data()]);
    drift = await checkLiveDrift(meta, nowIso, {
      getVersionSnapshot: (id) => store.getVersionSnapshot(id),
      loadLiveSnapshot: async (edition, tripIds, iso) =>
        data.buildCatalogueSnapshot(await data.loadSnapshotInput(edition, { nowIso: iso, tripIdsOverride: tripIds })),
      liveDrift: (published, live) => data.liveDrift(published, live),
    });
  } catch {
    drift = null;
  }
  const verdict = evaluateFreshness({ published: meta, nowIso, drift });
  return {
    status: verdict.state === "fresh" ? "fresh" : verdict.state === "stale" ? "stale" : "unknown",
    ageDays: verdict.ageDays === null ? null : Math.floor(verdict.ageDays),
    reasons: verdict.reasons,
  };
}
