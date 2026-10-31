import type { TravelTrip } from "./travelTypes";

/**
 * The admin trips LIST needs names, prices, dates, status and the facts behind the
 * badges; it does not need editor-only detail. The full catalogue response was
 * ~2 MB for 61 trips (website copy 580 KB, itinerary text 300 KB, conflict and
 * photo provenance 330 KB, a catalogue fact audit 250 KB) and was re-downloaded on
 * every visit, search and refresh. The editor fetches the one trip it opens in full.
 */
const EDITOR_ONLY_EXTRA_KEYS = [
  "website_details",
  "website_departure_availability",
  "shared_conflicts",
  "resolved_conflicts",
  "photo_repair_sources",
  "photo_credits",
  "photo_audit",
  "source_provenance",
  "answer_hints",
] as const;

/** Marks a trip row that is a list projection, so it is never opened or saved as a full trip. */
export const LIST_PROJECTION_KEY = "list_projection";

export function tripListProjection(trip: TravelTrip): TravelTrip {
  const extra = { ...(trip.extra || {}) } as Record<string, unknown>;
  for (const key of EDITOR_ONLY_EXTRA_KEYS) delete extra[key];
  // Completeness only asks whether days exist: keep the count, drop the text.
  if (Array.isArray(extra.itinerary_days)) extra.itinerary_days = extra.itinerary_days.map(() => ({}));
  extra[LIST_PROJECTION_KEY] = true;
  return { ...trip, extra };
}

export function isTripListProjection(trip: Pick<TravelTrip, "extra"> | null | undefined): boolean {
  return (trip?.extra as Record<string, unknown> | undefined)?.[LIST_PROJECTION_KEY] === true;
}
