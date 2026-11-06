/**
 * A link the admin pastes is IDENTITY, never words to fuzzy-match.
 *
 * uudamtravel.mn trip pages are resolved by their slug: the live slug the website
 * overlay put on each trip (staff can rename it there), the generated
 * "trip-" + sha256(chatbot id)[0:20] form (reversible offline), and as a last resort
 * the slug recorded at the last website sync. A short link uudamtravel.mn/<alias> is
 * followed exactly one hop (GET, redirect "manual", Location). A poster PDF link names
 * its poster, which names its trip. Anything else is a foreign page: the agent may read
 * it with read_web_page (SSRF-safe), never identify a trip from it.
 */
import { createHash } from "node:crypto";
import { storedWebsiteTripSlug, websiteTripSlugFromUrl } from "../bookingWebsite";
import type { TravelTrip } from "../travelTypes";
import type { AgentDeps } from "./types";

export type LinkKind = "website_trip" | "short_link" | "poster" | "drive" | "web" | "invalid";

export type LinkResolution = {
  url: string;
  kind: LinkKind;
  /** Set only when the link names exactly one trip of the catalogue. */
  trip_id?: string;
  trip_name?: string;
  slug?: string;
  /** Where a short link led. */
  target?: string;
  /** One plain sentence for the model (and the admin) about what the link is. */
  note: string;
};

// Our own trip links are also read when pasted without "https://" ("uudamtravel.mn/mn/trips/…"):
// unread, such a link left the model to pick the conversation's trip.
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`«»]+|(?<![\w.@/:-])(?:www\.)?uudamtravel\.mn\/[^\s<>"'`«»]+/giu;
const TRAILING = /[).,!?;:}\]]+$/u;

/** A link as typed, with "https://" put in front of our own bare-host links. */
export function withScheme(url: string): string {
  return /^(?:www\.)?uudamtravel\.mn\//i.test(url) ? `https://${url}` : url;
}
const OUR_HOSTS = new Set(["uudamtravel.mn", "www.uudamtravel.mn"]);
const ALIAS_PATH = /^\/[A-Za-z0-9](?:[A-Za-z0-9_-]{0,62}[A-Za-z0-9])?\/?$/;
// The website's own top-level routes are never short links (web: src/lib/shortLink.ts SKIP).
const NOT_ALIASES = new Set(["mn", "en", "ko", "about", "booking", "category", "contact", "custom-trip", "data-deletion", "departures",
  "discover", "faq", "gift", "guide", "provider", "qa-pricing", "saved", "terms", "trips", "admin", "api", "images", "public"]);
const HASHED_SLUG = /^trip-[0-9a-f]{20}$/;
// A case ending may follow with a hyphen ("trip-…-г устга"); another hex group may not.
const CHATBOT_ID = /(?<![\w-])(trip-(?:poster-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?!\w|-[A-Za-z0-9])/giu;

/** Every web address in the text, without the punctuation a sentence put after it. */
export function urlsInText(text: string): string[] {
  return [...new Set([...String(text || "").matchAll(URL_IN_TEXT)].map((match) => withScheme(match[0].replace(TRAILING, ""))).filter(Boolean))];
}

/** The text with its web addresses taken out (a "?" inside a link is not a question). */
export function withoutUrls(text: string): string {
  return String(text || "").replace(URL_IN_TEXT, " ").replace(/\s{2,}/g, " ").trim();
}

/** The slug the website generates for a chatbot trip that staff never renamed. */
export function hashedSlugFor(tripId: string): string {
  return `trip-${createHash("sha256").update(tripId).digest("hex").slice(0, 20)}`;
}

/** Chatbot trip ids typed or pasted as text ("trip-<uuid>", "trip-poster-<uuid>"), matched to the catalogue. */
export function chatbotIdsInText(text: string, trips: TravelTrip[]): TravelTrip[] {
  const ids = new Set([...String(text || "").matchAll(CHATBOT_ID)].map((match) => match[1].toLowerCase()));
  return trips.filter((trip) => ids.has(trip.id.toLowerCase()));
}

function parse(url: string): URL | null {
  try { return new URL(url); } catch { return null; }
}

function found(url: string, kind: LinkKind, trip: TravelTrip, extra: Partial<LinkResolution> = {}): LinkResolution {
  return { url, kind, trip_id: trip.id, trip_name: trip.route_name, ...extra, note: `Энэ холбоос «${trip.route_name}» аяллынх.` };
}

async function tripForSlug(slug: string, trips: TravelTrip[], deps: Pick<AgentDeps, "slugToTripId">): Promise<TravelTrip | null> {
  const wanted = slug.toLowerCase();
  const live = trips.filter((trip) => storedWebsiteTripSlug(trip)?.toLowerCase() === wanted);
  if (live.length === 1) return live[0];
  if (HASHED_SLUG.test(wanted)) {
    const hashed = trips.filter((trip) => hashedSlugFor(trip.id) === wanted);
    if (hashed.length === 1) return hashed[0];
  }
  const id = await deps.slugToTripId(slug).catch(() => null);
  return id ? trips.find((trip) => trip.id === id) ?? null : null;
}

function posterIdOf(url: URL): string | null {
  if (url.pathname !== "/api/poster-pdf") return null;
  const id = url.searchParams.get("id")?.trim();
  return id && /^[\w.:-]{1,200}$/.test(id) ? id : null;
}

function tripForPoster(posterId: string, trips: TravelTrip[]): TravelTrip | null {
  const linked = trips.filter((trip) => trip.extra?.poster_trip_id === posterId);
  if (linked.length === 1) return linked[0];
  const own = /^poster-for-(.+)$/.exec(posterId)?.[1];
  return own ? trips.find((trip) => trip.id === own) ?? null : null;
}

/** What one link is, and the trip it names when it names one. Never throws. */
export async function resolveLink(rawUrl: string, trips: TravelTrip[], deps: Pick<AgentDeps, "slugToTripId" | "shortLinkLocation">, hops = 0): Promise<LinkResolution> {
  const url = withScheme(String(rawUrl || "").trim().replace(TRAILING, ""));
  const parsed = parse(url);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return { url, kind: "invalid", note: "Энэ бол хүчинтэй вэб хаяг биш." };
  }
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)(drive|docs)\.google\.com$/.test(host)) {
    return { url, kind: "drive", note: "Google Drive/Docs холбоос: файлыг «Файл оруулах»-аар уншуулна (шинэ аялал, шинэчлэл)." };
  }
  const posterId = posterIdOf(parsed);
  if (posterId) {
    const trip = tripForPoster(posterId, trips);
    return trip ? found(url, "poster", trip) : { url, kind: "poster", note: "Постерын холбоос боловч аль аяллынх нь бүртгэлээс олдсонгүй." };
  }
  if (OUR_HOSTS.has(host)) {
    const httpsUrl = parsed.protocol === "https:" ? url : url.replace(/^http:/i, "https:");
    const slug = websiteTripSlugFromUrl(httpsUrl.split("#")[0].split("?")[0]);
    if (slug) {
      const trip = await tripForSlug(slug, trips, deps);
      return trip ? found(url, "website_trip", trip, { slug })
        : { url, kind: "website_trip", slug, note: `uudamtravel.mn дээрх «${slug}» хуудас бүртгэлийн аль ч аялалтай холбогдсонгүй.` };
    }
    const alias = ALIAS_PATH.test(parsed.pathname) ? parsed.pathname.replace(/^\/|\/$/g, "") : "";
    if (alias && !NOT_ALIASES.has(alias.toLowerCase()) && hops === 0) {
      const location = await deps.shortLinkLocation(`https://uudamtravel.mn/${alias}`).catch(() => null);
      if (!location) return { url, kind: "short_link", note: `«${alias}» богино холбоос хаашаа ч заасангүй (идэвхгүй эсвэл байхгүй).` };
      const target = (() => { try { return new URL(location, "https://uudamtravel.mn").toString(); } catch { return ""; } })();
      if (!target) return { url, kind: "short_link", note: "Богино холбоосын чиглэл уншигдсангүй." };
      const next = await resolveLink(target, trips, deps, hops + 1);
      if (next.trip_id) return { ...next, url, kind: "short_link", target };
      if (next.kind === "website_trip") return { ...next, url, kind: "short_link", target };
      return { url, kind: "short_link", target, note: `«${alias}» богино холбоос ${target} руу заадаг; энэ нь бүртгэлийн аяллын хуудас биш.` };
    }
    return { url, kind: "web", note: "uudamtravel.mn-ийн аяллын хуудас биш (аяллын хуудас …/trips/<нэр> хэлбэртэй)." };
  }
  return { url, kind: "web", note: "Гадны сайт: аяллыг эндээс таньж болохгүй; хэрэгтэй бол read_web_page-ээр уншина." };
}

/** Every link in the message, resolved, in order. */
export async function resolveLinksInText(text: string, trips: TravelTrip[], deps: Pick<AgentDeps, "slugToTripId" | "shortLinkLocation">): Promise<LinkResolution[]> {
  const out: LinkResolution[] = [];
  for (const url of urlsInText(text).slice(0, 6)) out.push(await resolveLink(url, trips, deps));
  return out;
}

/**
 * Links that are meant to name one of our trips (a trip page, a poster, a short link that
 * leads to a trip page or nowhere readable), resolved or not. A short link to a foreign
 * page is not one: that page may be read, it identifies nothing.
 */
export function identityLinks(resolutions: LinkResolution[]): LinkResolution[] {
  return resolutions.filter((link) => link.kind === "website_trip" || link.kind === "poster"
    || (link.kind === "short_link" && (Boolean(link.trip_id) || !link.target || /uudamtravel\.mn\/(?:(?:mn|en|ko)\/)?trips\//.test(link.target))));
}
