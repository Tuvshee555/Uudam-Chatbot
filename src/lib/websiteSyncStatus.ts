export type WebsiteSyncRow = {
  trip_id: string;
  trip_name?: string | null;
  trip_status?: string | null;
  synced: boolean;
  last_error: string | null;
  website_slug: string | null;
  website_trip_id?: string | null;
  synced_at?: string | null;
  updated_at?: string | null;
  content_conflict?: boolean;
  shared_conflict_count?: number;
  attempts?: number;
};

export function hasWebsiteSyncConflict(row: Pick<WebsiteSyncRow, "content_conflict" | "shared_conflict_count">): boolean {
  return row.content_conflict === true || (row.shared_conflict_count ?? 0) > 0;
}

export function summarizeWebsiteSync(rows: Array<Omit<WebsiteSyncRow, "synced_at"> & { synced_at?: string | Date | null }>) {
  const successful = rows.map(row => row.synced_at instanceof Date
    ? Number.isFinite(row.synced_at.getTime()) ? row.synced_at.toISOString() : null
    : row.synced_at).filter((value): value is string =>
    typeof value === "string" && Number.isFinite(Date.parse(value)));
  return {
    total: rows.length,
    synced: rows.filter(row => row.synced).length,
    pending: rows.filter(row => !row.synced).length,
    failed: rows.filter(row => Boolean(row.last_error)).length,
    conflicts: rows.filter(hasWebsiteSyncConflict).length,
    lastSyncedAt: successful.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null,
  };
}

/** An invalid response must never look like a successfully emptied queue. */
export function parseWebsiteSyncStatus(value: unknown): { configured: boolean; trips: WebsiteSyncRow[] } | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (typeof input.configured !== "boolean" || !Array.isArray(input.trips)) return null;
  for (const entry of input.trips) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
    const row = entry as Record<string, unknown>;
    if (typeof row.trip_id !== "string" || !row.trip_id.trim() || typeof row.synced !== "boolean") return null;
    for (const key of ["trip_name", "trip_status", "last_error", "website_slug", "website_trip_id", "synced_at", "updated_at"]) {
      if (row[key] != null && typeof row[key] !== "string") return null;
    }
    if (row.content_conflict != null && typeof row.content_conflict !== "boolean") return null;
    for (const key of ["attempts", "shared_conflict_count"]) {
      if (row[key] != null && (typeof row[key] !== "number" || !Number.isInteger(row[key]) || (row[key] as number) < 0)) return null;
    }
  }
  return { configured: input.configured, trips: input.trips as WebsiteSyncRow[] };
}
