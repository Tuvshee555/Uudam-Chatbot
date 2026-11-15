import type { CatalogueEdition, CatalogueEditionConfig } from "@/lib/catalogue/types";
import { selectionBounds } from "@/lib/catalogue/admin/validation";

/** The staff's unsaved curation of one edition. Ids and group keys only: never titles, prices or dates. */
export type CurationDraft = {
  tripIds: string[];
  featured: string[];
  excluded: string[];
  overrides: Record<string, string>;
};

export function draftFromConfig(config: CatalogueEditionConfig): CurationDraft {
  return {
    tripIds: [...config.tripIds],
    featured: [...config.featuredTripIds],
    excluded: [...config.excludedTripIds],
    overrides: { ...config.groupOverrides },
  };
}

export function draftToConfig(draft: CurationDraft): CatalogueEditionConfig {
  const selected = new Set(draft.tripIds);
  return {
    tripIds: draft.tripIds,
    featuredTripIds: draft.featured.filter((id) => selected.has(id)),
    excludedTripIds: draft.excluded.filter((id) => !selected.has(id)),
    groupOverrides: draft.overrides,
  };
}

function stable(draft: CurationDraft): string {
  return JSON.stringify([
    draft.tripIds,
    [...draft.featured].sort(),
    [...draft.excluded].sort(),
    Object.entries(draft.overrides).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export function isDirty(a: CurationDraft, b: CurationDraft): boolean {
  return stable(a) !== stable(b);
}

export function addTrip(draft: CurationDraft, tripId: string, max: number): CurationDraft {
  if (draft.tripIds.includes(tripId) || draft.tripIds.length >= max) return draft;
  return { ...draft, tripIds: [...draft.tripIds, tripId], excluded: draft.excluded.filter((id) => id !== tripId) };
}

export function removeTrip(draft: CurationDraft, tripId: string): CurationDraft {
  return {
    ...draft,
    tripIds: draft.tripIds.filter((id) => id !== tripId),
    featured: draft.featured.filter((id) => id !== tripId),
  };
}

/** Moves one place up (-1) or down (+1); a move past either end changes nothing. */
export function moveTrip(draft: CurationDraft, tripId: string, direction: -1 | 1): CurationDraft {
  const from = draft.tripIds.indexOf(tripId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= draft.tripIds.length) return draft;
  const next = [...draft.tripIds];
  [next[from], next[to]] = [next[to], next[from]];
  return { ...draft, tripIds: next };
}

export function toggleFeatured(draft: CurationDraft, tripId: string): CurationDraft {
  if (!draft.tripIds.includes(tripId)) return draft;
  return {
    ...draft,
    featured: draft.featured.includes(tripId) ? draft.featured.filter((id) => id !== tripId) : [...draft.featured, tripId],
  };
}

export function toggleExcluded(draft: CurationDraft, tripId: string): CurationDraft {
  return {
    ...draft,
    excluded: draft.excluded.includes(tripId) ? draft.excluded.filter((id) => id !== tripId) : [...draft.excluded, tripId],
  };
}

/** An empty group key clears the override (the automatic group applies again). */
export function setGroupOverride(draft: CurationDraft, tripId: string, groupKey: string): CurationDraft {
  const overrides = { ...draft.overrides };
  if (groupKey) overrides[tripId] = groupKey;
  else delete overrides[tripId];
  return { ...draft, overrides };
}

export type SelectionStatus = { count: number; min: number; max: number; ok: boolean; message: string | null };

/** The counter next to the Quick list: how many are chosen versus what the edition allows. */
export function selectionStatus(edition: CatalogueEdition, count: number): SelectionStatus {
  const { min, max } = selectionBounds(edition);
  if (edition === "complete") return { count, min, max, ok: true, message: null };
  if (count === 0) return { count, min, max, ok: true, message: `Дор хаяж ${min} аялал сонгоно.` };
  if (count < min) return { count, min, max, ok: false, message: `Дахин ${min - count} аялал нэмнэ үү (доод хэмжээ ${min}).` };
  if (count > max) return { count, min, max, ok: false, message: `${count - max} аялал илүү байна (дээд хэмжээ ${max}).` };
  return { count, min, max, ok: true, message: null };
}
