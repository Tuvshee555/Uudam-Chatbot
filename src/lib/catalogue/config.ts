/**
 * What staff curate in the admin: which trips go in which edition, in what order, featured and
 * excluded trips, and group overrides. It never holds a title, price or date: those are read live
 * from the canonical trip store every time a snapshot is built.
 *
 * One row (id = 1) of JSONB. Every read and write passes through sanitizeCatalogueConfig, so a
 * hand-edited or half-valid row can never break snapshot building.
 */
import type { CatalogueConfig, CatalogueEdition, CatalogueEditionConfig } from "./types";
import {
  CATALOGUE_EDITIONS,
  CatalogueStoreError,
  catalogueNowIso,
  catalogueQuery,
  catalogueTransaction,
  cleanActor,
  toIso,
  writeAudit,
} from "./schema";

const MAX_TRIP_IDS = 500;
const MAX_OVERRIDES = 500;
const TRIP_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,160}$/u;
const GROUP_KEY_RE = /^[A-Za-z0-9_-]{1,48}$/;

export function emptyEditionConfig(): CatalogueEditionConfig {
  return { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] };
}

export function defaultCatalogueConfig(): CatalogueConfig {
  return {
    quick: emptyEditionConfig(),
    complete: emptyEditionConfig(),
    preview: emptyEditionConfig(),
    updatedAt: null,
    updatedBy: null,
  };
}

function cleanIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!TRIP_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_TRIP_IDS) break;
  }
  return out;
}

/** Pure. Drops anything malformed; excluded wins over selected and featured. */
export function sanitizeEditionConfig(value: unknown): CatalogueEditionConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const excludedTripIds = cleanIdList(raw.excludedTripIds);
  const excluded = new Set(excludedTripIds);
  const tripIds = cleanIdList(raw.tripIds).filter((id) => !excluded.has(id));
  const featuredTripIds = cleanIdList(raw.featuredTripIds).filter((id) => !excluded.has(id));

  const groupOverrides: Record<string, string> = {};
  if (raw.groupOverrides && typeof raw.groupOverrides === "object" && !Array.isArray(raw.groupOverrides)) {
    let count = 0;
    for (const [tripId, groupKey] of Object.entries(raw.groupOverrides as Record<string, unknown>)) {
      if (count >= MAX_OVERRIDES) break;
      if (!TRIP_ID_RE.test(tripId) || typeof groupKey !== "string") continue;
      const key = groupKey.trim();
      if (!GROUP_KEY_RE.test(key)) continue;
      groupOverrides[tripId] = key;
      count++;
    }
  }
  return { tripIds, groupOverrides, featuredTripIds, excludedTripIds };
}

export function sanitizeCatalogueConfig(value: unknown): CatalogueConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    quick: sanitizeEditionConfig(raw.quick),
    complete: sanitizeEditionConfig(raw.complete),
    preview: sanitizeEditionConfig(raw.preview),
    updatedAt: typeof raw.updatedAt === "string" ? toIso(raw.updatedAt) : null,
    updatedBy: typeof raw.updatedBy === "string" ? cleanActor(raw.updatedBy) : null,
  };
}

type ConfigRow = { data: unknown; updated_at: unknown; updated_by: string | null };

function rowToConfig(row: ConfigRow | undefined): CatalogueConfig {
  if (!row) return defaultCatalogueConfig();
  const data = typeof row.data === "string" ? safeJson(row.data) : row.data;
  const config = sanitizeCatalogueConfig(data);
  config.updatedAt = toIso(row.updated_at);
  config.updatedBy = cleanActor(row.updated_by);
  return config;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function getCatalogueConfig(): Promise<CatalogueConfig> {
  const result = await catalogueQuery<ConfigRow>(
    `/* cat:config_get */ SELECT data, updated_at, updated_by FROM catalogue_config WHERE id = 1`,
  );
  return rowToConfig(result.rows[0]);
}

/**
 * Replace the whole curation. `expectedUpdatedAt` (optional) is the `updatedAt` the editor was
 * loaded with: when somebody else saved in between, the save is refused with `config_conflict`
 * instead of silently overwriting their work. Pass `null` to assert "nothing was saved yet".
 */
export async function saveCatalogueConfig(
  next: unknown,
  actor: string | null,
  opts: { expectedUpdatedAt?: string | null } = {},
): Promise<CatalogueConfig> {
  if (!next || typeof next !== "object") {
    throw new CatalogueStoreError("invalid_input", "Catalogue config must be an object");
  }
  const clean = sanitizeCatalogueConfig(next);
  const savedAt = catalogueNowIso();
  const by = cleanActor(actor);
  const editions: Record<CatalogueEdition, CatalogueEditionConfig> = {
    quick: clean.quick,
    complete: clean.complete,
    preview: clean.preview,
  };

  await catalogueTransaction(async (query) => {
    const current = await query<ConfigRow>(
      `/* cat:config_lock */ SELECT data, updated_at, updated_by FROM catalogue_config WHERE id = 1 FOR UPDATE`,
    );
    if (opts.expectedUpdatedAt !== undefined) {
      const currentAt = toIso(current.rows[0]?.updated_at);
      if ((opts.expectedUpdatedAt ? toIso(opts.expectedUpdatedAt) : null) !== currentAt) {
        throw new CatalogueStoreError("config_conflict", "Catalogue config was changed by somebody else", {
          currentUpdatedAt: currentAt,
        });
      }
    }
    await query(
      `/* cat:config_upsert */ INSERT INTO catalogue_config (id, data, updated_at, updated_by)
       VALUES (1, $1::jsonb, $2::timestamptz, $3)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at,
         updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(editions), savedAt, by],
    );
    await writeAudit(query, {
      action: "config_save",
      actor: by,
      detail: Object.fromEntries(
        CATALOGUE_EDITIONS.map((edition) => [edition, editions[edition].tripIds.length]),
      ),
    });
  });
  return { ...clean, updatedAt: savedAt, updatedBy: by };
}
