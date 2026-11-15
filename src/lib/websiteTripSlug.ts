import { createHash } from "node:crypto";

/**
 * The slug the website row of a trip gets when the sync first creates it
 * (websiteTripSync upsertWebsiteTrip); staff may rename it on the website later,
 * and the sync then keeps their slug.
 */
export function newWebsiteTripSlug(sourceTripId: string): string {
  return `trip-${createHash("sha256").update(sourceTripId).digest("hex").slice(0, 20)}`;
}
