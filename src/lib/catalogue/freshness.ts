/**
 * Is the published catalogue still true? (spec decision 9)
 *
 * A published version is stale when
 *   (a) it is older than 21 days, or
 *   (b) the live data it would print today differs materially from the snapshot it was printed from
 *       (a trip no longer bookable, a dated price changed, a departure gone, a trip removed).
 *
 * A stale file is never sent as-is: delivery sends one text with the website link and hands the
 * request to staff, and the admin shows a banner. Age is judged on `generatedAt` (when the data was
 * read), not on `publishedAt`: publishing an old draft does not make its prices new.
 *
 * evaluateFreshness is pure. checkLiveDrift is the impure half (it reads live trips); a failure
 * there is "unverified", never "stale": the infrastructure being down is not evidence about prices.
 */
import { liveDrift as compareWithLive } from "./diagnostics";
import type { CatalogueEdition, CatalogueSnapshot, CatalogueVersionMeta } from "./types";

export const CATALOGUE_MAX_AGE_DAYS = 21;
const DAY_MS = 86_400_000;
/** The live comparison reads every trip; once per version per few minutes is plenty. */
const DRIFT_CACHE_MS = 5 * 60_000;

/** `pending`: changes that leave the file true but incomplete (new or passed dates): refresh, never withhold. */
export type LiveDrift = { drifted: boolean; reasons: string[]; pending?: string[] };

export type FreshnessInput = {
  published: Pick<CatalogueVersionMeta, "generatedAt">;
  nowIso: string;
  maxAgeDays?: number;
  /** liveDrift() result; null when the comparison could not be made. */
  drift: LiveDrift | null;
};

export type FreshnessVerdict = {
  /** fresh: send. stale: do not send as-is. unverified: age is fine but live data could not be compared. */
  state: "fresh" | "stale" | "unverified";
  stale: boolean;
  ageDays: number | null;
  /** Mongolian, for the admin banner and the staff lead. */
  reasons: string[];
  /** Machine-readable cause for logs and the send log. */
  code: "ok" | "age" | "drift" | "unreadable_timestamp" | "unverified";
};

export function catalogueAgeDays(generatedAt: string, nowIso: string): number | null {
  const generated = Date.parse(generatedAt);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(generated) || !Number.isFinite(now)) return null;
  return Math.max(0, (now - generated) / DAY_MS);
}

export function evaluateFreshness(input: FreshnessInput): FreshnessVerdict {
  const maxAge = input.maxAgeDays ?? CATALOGUE_MAX_AGE_DAYS;
  const age = catalogueAgeDays(input.published.generatedAt, input.nowIso);
  if (age === null) {
    return { state: "stale", stale: true, ageDays: null, reasons: ["Каталогийн үүсгэсэн огноо уншигдсангүй"], code: "unreadable_timestamp" };
  }
  const reasons: string[] = [];
  if (age > maxAge) reasons.push(`Каталог ${Math.floor(age)} хоногийн настай (${maxAge} хоногоос хэтэрсэн)`);
  if (input.drift?.drifted) reasons.push(...input.drift.reasons);
  if (reasons.length) {
    return { state: "stale", stale: true, ageDays: age, reasons, code: age > maxAge ? "age" : "drift" };
  }
  if (input.drift === null) {
    return { state: "unverified", stale: false, ageDays: age, reasons: ["Одоогийн өгөгдөлтэй тулгаж чадсангүй"], code: "unverified" };
  }
  return { state: "fresh", stale: false, ageDays: age, reasons: [], code: "ok" };
}

export type DriftDeps = {
  getVersionSnapshot: (versionId: string) => Promise<CatalogueSnapshot | null>;
  loadLiveSnapshot: (edition: CatalogueEdition, tripIds: string[], nowIso: string) => Promise<CatalogueSnapshot>;
  liveDrift: (published: CatalogueSnapshot, live: CatalogueSnapshot) => LiveDrift;
};

/** The real wiring: the store's snapshot, today's trips built the same way, the pure comparison. */
export function defaultDriftDeps(): DriftDeps {
  return {
    getVersionSnapshot: async (versionId) => (await import("./store")).getVersionSnapshot(versionId),
    loadLiveSnapshot: async (edition, tripIds, nowIso) => {
      const data = await import("./tripData");
      return data.buildCatalogueSnapshot(await data.loadSnapshotInput(edition, { nowIso, tripIdsOverride: tripIds }));
    },
    liveDrift: compareWithLive,
  };
}

const driftCache = new Map<string, { at: number; drift: LiveDrift | null }>();

export function resetFreshnessCacheForTests() {
  driftCache.clear();
}

/**
 * Compare a published version with live data. The live snapshot is built for the SAME trips the
 * file prints (new trips appearing since are not drift: nothing in the file is false).
 * Returns null when it cannot be done; callers treat that as "unverified".
 */
export async function checkLiveDrift(
  published: Pick<CatalogueVersionMeta, "id" | "edition">,
  nowIso: string,
  deps: DriftDeps = defaultDriftDeps(),
  now: () => number = Date.now,
): Promise<LiveDrift | null> {
  const cached = driftCache.get(published.id);
  if (cached && now() - cached.at < DRIFT_CACHE_MS) return cached.drift;
  let drift: LiveDrift | null = null;
  try {
    const snapshot = await deps.getVersionSnapshot(published.id);
    if (snapshot) {
      const live = await deps.loadLiveSnapshot(published.edition, snapshot.trips.map((card) => card.tripId), nowIso);
      drift = deps.liveDrift(snapshot, live);
    }
  } catch {
    drift = null;
  }
  // A failed comparison is not cached for long: the next request may succeed.
  driftCache.set(published.id, { at: drift ? now() : now() - DRIFT_CACHE_MS + 30_000, drift });
  return drift;
}
