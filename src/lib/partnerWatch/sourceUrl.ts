/**
 * The partner page a trip was made from (`extra.source_url`), and how two links are told to
 * be the same page.
 *
 * Stored: the page's own https URL without its #fragment and tracking parameters (utm_*,
 * fbclid, …), so the watch can fetch it as it is. Compared: by key — host without "www.",
 * path without the trailing slash, the remaining query sorted, case folded — so the admin
 * pasting "partner.example/x/" and the stored "https://www.partner.example/x" is one page.
 *
 * Pure.
 */
import type { TravelTrip } from "../travelTypes";

const TRACKING = /^(?:utm_.*|fbclid|gclid|dclid|msclkid|igshid|mc_cid|mc_eid|_ga|_gl|ref|ref_src)$/i;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});

function parse(raw: unknown): URL | null {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
}

/** The link as stored on a trip: https only, no fragment, no tracking parameters; "" when it is not a web page link. */
export function cleanSourceUrl(raw: unknown): string {
  const url = parse(raw);
  if (!url || url.protocol !== "https:" || !url.hostname.includes(".")) return "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (TRACKING.test(key)) url.searchParams.delete(key);
  return url.toString();
}

/** One page's identity: two links with the same key are the same partner page. */
export function sourceUrlKey(raw: unknown): string {
  const url = parse(raw);
  if (!url || !/^https?:$/.test(url.protocol) || !url.hostname.includes(".")) return "";
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "";
  const query = [...url.searchParams.entries()].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b));
  const search = query.length ? `?${new URLSearchParams(query).toString()}` : "";
  return `${host}${path}${search}`.toLowerCase();
}

/** The partner page this trip was made from ("" for a trip not made from a link). */
export function tripSourceUrl(trip: Pick<TravelTrip, "extra">): string {
  const value = trip.extra?.source_url;
  return typeof value === "string" ? value.trim() : "";
}

/** The page a partner-synced trip mirrors (that sync owns the trip). */
export function partnerSyncUrl(trip: Pick<TravelTrip, "extra">): string {
  const value = record(trip.extra?.partner_sync).source_url;
  return typeof value === "string" ? value.trim() : "";
}

/** Every trip (any status) made from, or synced from, the page this link points at. */
export function tripsFromPage(trips: TravelTrip[], link: string): TravelTrip[] {
  const key = sourceUrlKey(link);
  if (!key) return [];
  return trips.filter((trip) => sourceUrlKey(tripSourceUrl(trip)) === key || sourceUrlKey(partnerSyncUrl(trip)) === key);
}
