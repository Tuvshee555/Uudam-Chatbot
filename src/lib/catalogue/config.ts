/**
 * What staff curate in the admin: which trips go in which edition, in what order, featured and
 * excluded trips, group overrides, and (display only) the hero photo + crop and a display title per
 * trip. It never holds a price, a date or a canonical title: those are read live from the canonical
 * trip store every time a snapshot is built. A stored row from before the photo / title overrides
 * existed has neither key and reads as "no overrides".
 *
 * One row (id = 1) of JSONB. Every read and write passes through sanitizeCatalogueConfig, so a
 * hand-edited or half-valid row can never break snapshot building.
 */
import { MAX_TITLE_OVERRIDE_CHARS } from "./editorial";
import type { CatalogueConfig, CatalogueEdition, CatalogueEditionConfig, CatalogueHeroChoice, CataloguePhotoQuality } from "./types";
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
const MAX_HEROES = 500;
const MAX_TITLE_OVERRIDES = 500;
const MAX_URL_CHARS = 2048;
export const MIN_HERO_ZOOM = 1;
export const MAX_HERO_ZOOM = 3;
const HTTPS_URL_RE = /^https:\/\/[^\s\u0000-\u001f\u007f]+$/i;
const QUALITIES = new Set<string>(["excellent", "good", "weak", "missing"]);

export function emptyEditionConfig(): CatalogueEditionConfig {
  return { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] };
}

export function defaultCatalogueConfig(): CatalogueConfig {
  return {
    heroByTripId: {},
    titleOverrides: {},
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

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One staff hero choice: https url, focal point inside the frame (0..1), zoom 1..3, optional editorial quality. Null when unusable. */
export function sanitizeHeroChoice(value: unknown): CatalogueHeroChoice | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url || url.length > MAX_URL_CHARS || !HTTPS_URL_RE.test(url)) return null;
  const choice: CatalogueHeroChoice = { url };
  const focal = raw.focal && typeof raw.focal === "object" ? (raw.focal as Record<string, unknown>) : null;
  if (focal && finite(focal.x) && finite(focal.y)) choice.focal = { x: clamp(focal.x, 0, 1), y: clamp(focal.y, 0, 1) };
  if (finite(raw.zoom)) choice.zoom = clamp(raw.zoom, MIN_HERO_ZOOM, MAX_HERO_ZOOM);
  if (typeof raw.quality === "string" && QUALITIES.has(raw.quality)) choice.quality = raw.quality as CataloguePhotoQuality;
  return choice;
}

export function sanitizeHeroByTripId(value: unknown): Record<string, CatalogueHeroChoice> {
  const out: Record<string, CatalogueHeroChoice> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [tripId, choice] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_HEROES) break;
    if (!TRIP_ID_RE.test(tripId)) continue;
    const clean = sanitizeHeroChoice(choice);
    if (!clean) continue;
    out[tripId] = clean;
    count++;
  }
  return out;
}

/** Display-title overrides: trimmed, single-spaced, at most 80 characters; empty ones are dropped. */
export function sanitizeTitleOverrides(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  let count = 0;
  for (const [tripId, title] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_TITLE_OVERRIDES) break;
    if (!TRIP_ID_RE.test(tripId) || typeof title !== "string") continue;
    const clean = title.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) continue;
    out[tripId] = [...clean].slice(0, MAX_TITLE_OVERRIDE_CHARS).join("").trim();
    count++;
  }
  return out;
}

export function sanitizeCatalogueConfig(value: unknown): CatalogueConfig {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    heroByTripId: sanitizeHeroByTripId(raw.heroByTripId),
    titleOverrides: sanitizeTitleOverrides(raw.titleOverrides),
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
      [JSON.stringify({ ...editions, heroByTripId: clean.heroByTripId, titleOverrides: clean.titleOverrides }), savedAt, by],
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
