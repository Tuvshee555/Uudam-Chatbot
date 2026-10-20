/**
 * Where a customer can see every trip, its full programme and prices without
 * waiting on anyone. Dependency-free on purpose: importing it must not pull
 * in Redis or the environment checks (bookingCollect.ts re-exports it).
 */
import type { TravelTrip } from "./travelTypes";

export const BOOKING_WEBSITE_URL = "https://uudamtravel.mn";

const PUBLIC_TRIP_STATUSES = new Set(["active", "sold_out", "paused"]);
const TRIP_SLUG = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}$/u;
const WEB_URL = /https?:\/\/[^\s<>"'`]+/giu;

/** Only a stored path segment can identify a website trip; never a title guess. */
export function storedWebsiteTripSlug(trip: Pick<TravelTrip, "extra">): string | null {
  const slug = trip.extra?.website_slug;
  return typeof slug === "string" && TRIP_SLUG.test(slug.trim()) ? slug.trim() : null;
}

/** A generated slug is a real route once the website says the trip is published. */
export function publishedTripWebsiteLink(trip: Pick<TravelTrip, "status" | "extra">): string | null {
  const slug = storedWebsiteTripSlug(trip);
  if (!slug || trip.extra?.website_published !== true || trip.extra?.customer_visible === false || !PUBLIC_TRIP_STATUSES.has(trip.status)) return null;
  return `${BOOKING_WEBSITE_URL}/trips/${encodeURIComponent(slug)}`;
}

/** Read only our public detail routes, with or without the website's locale prefix. */
export function websiteTripSlugFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password
      || !["uudamtravel.mn", "www.uudamtravel.mn"].includes(url.hostname)) return null;
    const path = /^\/(?:mn\/|en\/|ko\/)?trips\/([^/]+)\/?$/.exec(url.pathname);
    if (!path) return null;
    const slug = decodeURIComponent(path[1]);
    return TRIP_SLUG.test(slug) ? slug : null;
  } catch {
    return null;
  }
}

/** URLs are identity, not destination words or date/price hints from their query strings. */
export function websiteTripLinksInText(text: string): { slugs: string[]; textWithoutUrls: string } {
  const slugs: string[] = [];
  const textWithoutUrls = text.replace(WEB_URL, (value) => {
    const slug = websiteTripSlugFromUrl(value.replace(/[).,!?;:}\]]+$/g, ""));
    if (slug && !slugs.includes(slug)) slugs.push(slug);
    return " ";
  });
  return { slugs, textWithoutUrls };
}

/** The website's Messenger button sends its exact persisted slug as the referral. */
export function tripsForWebsiteReference(ref: unknown, trips: TravelTrip[]): TravelTrip[] {
  const wanted = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (!wanted) return [];
  return trips.filter((trip) => PUBLIC_TRIP_STATUSES.has(trip.status)
    && trip.extra?.customer_visible !== false && trip.extra?.website_published !== false
    && (trip.id.toLowerCase() === wanted
      || storedWebsiteTripSlug(trip)?.toLowerCase() === wanted));
}
