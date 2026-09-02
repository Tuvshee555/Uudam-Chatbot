import { mapPosterTripToFields, type MappedTripFields } from "./tripMapper";
import type { TravelTrip, TripMutationFields } from "@/lib/travelTypes";

export type PosterBulkPlanRow = {
  id: string;
  title: string;
  source_file: string | null;
  data: unknown;
  updated_at?: string;
};

export type PosterBulkPlanAction = "create" | "attach_exact" | "skip";

export type PosterBulkSkipReason =
  | "empty_title"
  | "duplicate_poster_title"
  | "duplicate_trip_title"
  | "existing_trip_has_photos"
  | "needs_manual_match";

export type PosterBulkPlanItem = {
  posterId: string;
  title: string;
  sourceFile: string | null;
  action: PosterBulkPlanAction;
  targetTripId?: string;
  targetTripName?: string;
  mode?: "replace";
  fields: TripMutationFields;
  mappedFields: MappedTripFields;
  reasonCode?: PosterBulkSkipReason;
  reason?: string;
};

export type PosterBulkPlanSummary = {
  total: number;
  create: number;
  attachExact: number;
  skipped: number;
};

export type PosterBulkPlan = {
  items: PosterBulkPlanItem[];
  summary: PosterBulkPlanSummary;
};

type FlatMappedFields = Omit<MappedTripFields, "extra"> & {
  included_items?: string[];
  excluded_items?: string[];
};

function normalizeTitle(value: string | undefined): string {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("mn")
    .replace(/[’'`"]/g, "")
    .replace(/[‐‑‒–—−]/g, "-")
    .replace(/[\s\-_/\\.,:;·|()[\]{}]+/g, " ")
    .replace(/\b(travel|tour|trip|package|program)\b/g, " ")
    .replace(/аялал|хөтөлбөр/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function posterData(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function flattenMappedFields(mapped: MappedTripFields): FlatMappedFields {
  return {
    ...mapped,
    included_items: mapped.extra?.included_items,
    excluded_items: mapped.extra?.excluded_items,
  };
}

function buildCreateFields(title: string, mapped: MappedTripFields): TripMutationFields {
  const fields: TripMutationFields = { ...mapped };
  fields.route_name = mapped.route_name || title;
  return fields;
}

function hasText(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function buildMissingOnlyFields(target: TravelTrip, mapped: MappedTripFields): TripMutationFields {
  const flat = flattenMappedFields(mapped);
  const fields: TripMutationFields = {};
  const extra: Record<string, unknown> = {};

  if (!hasText(target.duration_text) && hasText(flat.duration_text)) {
    fields.duration_text = flat.duration_text;
  }
  if ((!Array.isArray(target.departure_dates) || target.departure_dates.length === 0) && flat.departure_dates?.length) {
    fields.departure_dates = flat.departure_dates;
  }
  if (target.adult_price == null && typeof flat.adult_price === "number") {
    fields.adult_price = flat.adult_price;
  }
  if (target.child_price == null && typeof flat.child_price === "number") {
    fields.child_price = flat.child_price;
  }
  if (!hasText(target.hotel) && hasText(flat.hotel)) {
    fields.hotel = flat.hotel;
  }
  if (target.has_food == null && typeof flat.has_food === "boolean") {
    fields.has_food = flat.has_food;
  }

  const existingIncludes = Array.isArray(target.extra?.included_items)
    ? (target.extra.included_items as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  const existingExcludes = Array.isArray(target.extra?.excluded_items)
    ? (target.extra.excluded_items as unknown[]).filter((item): item is string => typeof item === "string")
    : [];
  if (existingIncludes.length === 0 && flat.included_items?.length) {
    extra.included_items = flat.included_items;
  }
  if (existingExcludes.length === 0 && flat.excluded_items?.length) {
    extra.excluded_items = flat.excluded_items;
  }
  if (Object.keys(extra).length) fields.extra = extra;

  return fields;
}

function tripTitleKeys(trip: TravelTrip): string[] {
  const aliases = Array.isArray(trip.extra?.aliases)
    ? (trip.extra.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string")
    : [];
  return [trip.route_name, ...aliases].map(normalizeTitle).filter(Boolean);
}

function countSharedTokens(a: string, b: string): number {
  const aTokens = new Set(a.split(" ").filter((token) => token.length >= 2));
  const bTokens = new Set(b.split(" ").filter((token) => token.length >= 2));
  let count = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) count++;
  }
  return count;
}

function findNearTripMatches(trips: TravelTrip[], normalizedTitle: string): TravelTrip[] {
  const titleTokens = normalizedTitle.split(" ").filter((token) => token.length >= 2);
  if (titleTokens.length === 0) return [];

  return trips.filter((trip) =>
    tripTitleKeys(trip).some((key) => {
      if (!key) return false;
      if (key.includes(normalizedTitle) || normalizedTitle.includes(key)) return true;
      const shared = countSharedTokens(normalizedTitle, key);
      return shared >= Math.max(2, Math.ceil(titleTokens.length * 0.72));
    }),
  );
}

function makeSkip(
  row: PosterBulkPlanRow,
  mappedFields: MappedTripFields,
  reasonCode: PosterBulkSkipReason,
  reason: string,
): PosterBulkPlanItem {
  return {
    posterId: row.id,
    title: row.title,
    sourceFile: row.source_file,
    action: "skip",
    fields: {},
    mappedFields,
    reasonCode,
    reason,
  };
}

export function buildPosterBulkPlan(
  posterRows: PosterBulkPlanRow[],
  trips: TravelTrip[],
): PosterBulkPlan {
  const seenTitleKeys = new Set<string>();

  const items: PosterBulkPlanItem[] = posterRows.map((row) => {
    const mappedFields = mapPosterTripToFields(posterData(row.data));
    const title = row.title?.trim() || mappedFields.route_name?.trim() || "";
    const normalized = normalizeTitle(title);

    if (!normalized) {
      return makeSkip(row, mappedFields, "empty_title", "Poster has no usable title.");
    }

    if (seenTitleKeys.has(normalized)) {
      return makeSkip(
        row,
        mappedFields,
        "duplicate_poster_title",
        "Duplicate poster title. The newest saved poster for this title is the only one processed.",
      );
    }
    seenTitleKeys.add(normalized);

    const exactMatches = trips.filter((trip) => tripTitleKeys(trip).includes(normalized));
    if (exactMatches.length > 1) {
      return makeSkip(
        row,
        mappedFields,
        "duplicate_trip_title",
        "More than one catalog trip has this exact title or alias.",
      );
    }

    if (exactMatches.length === 1) {
      const target = exactMatches[0];
      const photoCount = Array.isArray(target.photo_urls) ? target.photo_urls.length : 0;
      if (photoCount > 0) {
        return makeSkip(
          row,
          mappedFields,
          "existing_trip_has_photos",
          `Exact catalog trip already has ${photoCount} photo(s).`,
        );
      }

      return {
        posterId: row.id,
        title,
        sourceFile: row.source_file,
        action: "attach_exact",
        targetTripId: target.id,
        targetTripName: target.route_name,
        mode: "replace",
        fields: buildMissingOnlyFields(target, mappedFields),
        mappedFields,
      };
    }

    const nearMatches = findNearTripMatches(trips, normalized);
    if (nearMatches.length > 0) {
      return makeSkip(
        row,
        mappedFields,
        "needs_manual_match",
        `Possible existing trip match: ${nearMatches.slice(0, 3).map((trip) => trip.route_name).join(", ")}.`,
      );
    }

    return {
      posterId: row.id,
      title,
      sourceFile: row.source_file,
      action: "create",
      mode: "replace",
      fields: buildCreateFields(title, mappedFields),
      mappedFields,
    };
  });

  const summary: PosterBulkPlanSummary = {
    total: items.length,
    create: items.filter((item) => item.action === "create").length,
    attachExact: items.filter((item) => item.action === "attach_exact").length,
    skipped: items.filter((item) => item.action === "skip").length,
  };

  return { items, summary };
}
