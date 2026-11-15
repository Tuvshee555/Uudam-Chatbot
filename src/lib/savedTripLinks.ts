/**
 * The public website page of each trip a save wrote, for the admin's "saved" bar:
 * https://uudamtravel.mn/mn/trips/<slug>. Pure, so the server builds it and the
 * tests check it without a database.
 *
 * The slug is the one the website sync stored after the save (trip_website_sync);
 * a trip this save created that the sync has not reached yet gets the slug the
 * sync gives every new website row (websiteTripSync newWebsiteTripSlug). A draft,
 * archived, cancelled or hidden trip has no public page, so no link.
 */
import { BOOKING_WEBSITE_URL } from "./bookingWebsite";

export type SavedTripLink = {
  trip_id: string;
  route_name: string;
  status: string;
  /** The public page; null while the trip is not on the website. */
  url: string | null;
  /** The save has not reached the website yet: the page opens in a few seconds. */
  pending?: boolean;
};

type SavedTrip = { id: string; route_name?: string | null; status?: string | null; extra?: Record<string, unknown> | null };
export type SavedTripInput = { trip: SavedTrip; created?: boolean; slugHint?: string | null };

const PUBLIC_STATUSES = new Set(["active", "sold_out", "paused"]);
const SLUG = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}$/u;

export function websiteTripPageUrl(slug: string): string {
  return `${BOOKING_WEBSITE_URL}/mn/trips/${encodeURIComponent(slug)}`;
}

export function savedTripLinks(
  saved: SavedTripInput[],
  synced: Record<string, { slug: string | null; pending: boolean }>,
  newSlug: (tripId: string) => string,
): SavedTripLink[] {
  // One line per trip, as it stands after the last action on it.
  const byTrip = new Map<string, SavedTripInput>();
  for (const entry of saved) {
    if (!entry.trip?.id) continue;
    const earlier = byTrip.get(entry.trip.id);
    byTrip.set(entry.trip.id, { ...entry, created: Boolean(entry.created || earlier?.created), slugHint: entry.slugHint || earlier?.slugHint });
  }
  return [...byTrip.values()].map(({ trip, created, slugHint }) => {
    const status = String(trip.status || "active");
    const sync = synced[trip.id];
    // A website row staff unpublished there stays unpublished until the save reaches it: no link to a page that says "not found".
    const hiddenOnWebsite = trip.extra?.website_published === false && sync?.pending !== true;
    const visible = PUBLIC_STATUSES.has(status) && trip.extra?.customer_visible !== false && !hiddenOnWebsite;
    const stored = typeof trip.extra?.website_slug === "string" ? trip.extra.website_slug.trim() : "";
    const slug = [sync?.slug, stored, slugHint, created ? newSlug(trip.id) : ""].map((value) => String(value || "").trim()).find((value) => SLUG.test(value)) || null;
    return {
      trip_id: trip.id,
      route_name: String(trip.route_name || "").trim(),
      status,
      url: visible && slug ? websiteTripPageUrl(slug) : null,
      ...(visible && slug && (sync ? sync.pending : true) ? { pending: true } : {}),
    };
  });
}
