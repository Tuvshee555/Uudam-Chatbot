/**
 * Photos for a trip that arrived without any (a partner's Word or PDF program):
 * free, commercially usable photographs of the places it visits, found on
 * Wikimedia Commons — CC0, public domain, CC BY or CC BY-SA, a credit line kept
 * for each — filtered for size and subject, then ranked by a cheap vision model
 * so the page never shows a map, a logo or a derelict building. Pinterest and
 * the like are not sources: no API, and the pins are other people's copyrighted
 * photos. Every function here is best-effort and keyless.
 */
import sharp from "sharp";
import { askOpenAIChatParts } from "./openaiFallback";
import { logWarn } from "./observability";

export type FoundPhoto = {
  /** A 1920px rendition, ready to download. */
  url: string;
  pageUrl: string;
  title: string;
  width: number;
  height: number;
  license: string;
  author: string;
  query: string;
};

export type PhotoCredit = { url: string; title: string; author: string; license: string; source: string };

const USER_AGENT = "UudamTravelChatbot/1.0 (https://uudamtravel.mn; trip photos)";
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
export const MIN_PHOTO_WIDTH = 1600;
export const PHOTOS_PER_TRIP = 6;
/** Most photos a file-created trip gets from the search. */
export const MAX_FOUND_PHOTOS = 12;

/**
 * Owner's rule (2026-11-05): a trip gets one photo per day, and never fewer than six —
 * a 4-day trip 6, a 7-day trip 7, a 9-day trip 9.
 */
export function photosWantedFor(dayCount: number): number {
  return Math.min(MAX_FOUND_PHOTOS, Math.max(PHOTOS_PER_TRIP, dayCount));
}
const RENDITION_WIDTH = 1920;
// Commons serves only its standard thumbnail widths (… 250, 330, 500, 960, 1280, 1920); 480 is
// refused with a 400 page, so the ranker never saw a preview and fell back to raw search order
// (a war map was picked for a beach, 2026-11-04).
const PREVIEW_WIDTH = 330;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
const ALLOWED_LICENSE = /^(cc0|public domain|cc[ -]by(-sa)?(\s|$)|copyrighted free use)/i;
// Files that are not photographs of a place.
const NOT_A_PHOTO = /\b(map|maps|logo|diagram|flag|coat of arms|plan|chart|satellite|screenshot|icon|seal|emblem|poster|banner|locator|svg|graph|table|sign|ticket|stamp|coin|banknote|menu|brochure|collage|panorama stitch|abandoned|derelict|ruins? of|demolition|construction site|accident|flood|protest|war|wars|military|army|soldiers?|space station|from orbit|iss\d|zoo|hippopotamus|store|shop|supermarket|trading|rail transit|line \d|metro|subway|bus|taxi|toyota|honda|car|vehicle|truck|parking|street view|interior|office|factory|hospital|school|university campus)\b/i;
// Food and things on a table are not a destination: a bowl of hotpot spices was picked as a
// city's fifth photo because the search phrase was a local dish (2026-11-05).
const FOOD_OR_OBJECT = /\b(hot ?pot|hotpot|dish|dishes|cuisine|food|foods|noodles?|soup|spices?|chili|chilli|restaurant|meal|snack|dumplings?|dessert|ingredients?|recipe|bowl|souvenirs?|packaging|portrait|selfie)\b/i;
// Transit places on every train route: never a trip photo (the border town's gate was picked, 2026-11-04).
const TRANSIT_PLACE = /erenhot|erlian|二连|zamyn|замын|эрээн|ulaanbaatar|улаанбаатар|border crossing|railway station|airport/i;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type CommonsPage = { title?: string; imageinfo?: Array<{ url?: string; thumburl?: string; descriptionurl?: string; width?: number; height?: number; mime?: string;
  extmetadata?: Record<string, { value?: string }> }> };

const plain = (html: string) => html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

// Camera and file words that say nothing about what a photo shows ("IMG_2041", "DSC 5531", "photo 3").
const FILE_WORDS = new Set(["file", "img", "image", "images", "dsc", "dscn", "dscf", "dcim", "cimg", "pxl", "mvimg", "photo", "photos", "pic", "pics", "pict", "picture",
  "jpg", "jpeg", "png", "tif", "tiff", "webp", "heic", "edit", "edited", "crop", "cropped", "hdr", "copy", "version", "ver", "rev", "wp"]);

function titleWords(title: string): string[] {
  return title.normalize("NFKC").toLowerCase()
    .replace(/^file:/, "")
    .replace(/\.(jpe?g|png|tiff?|webp|heic)$/, "")
    // Dates and every other number: the same view shot twice on one day differs only there.
    .replace(/\p{N}+/gu, " ")
    .split(/[^\p{L}]+/u)
    .filter((word) => word.length > 1 && !FILE_WORDS.has(word));
}

/**
 * True when two candidates are the same picture for a trip page: their titles match once
 * digits, dates, the file extension, punctuation and camera words are gone, or — found
 * for the same sight — the titles differ by at most a word in four. "Hall of the People
 * 20240721" and "Hall of the People 20240721 13" were both picked for one trip (2026-11-06).
 * A title with no words left (only "IMG 2041") says nothing, so it matches only itself.
 */
export function samePicture(a: Pick<FoundPhoto, "url" | "title" | "query">, b: Pick<FoundPhoto, "url" | "title" | "query">): boolean {
  if (a.url && a.url === b.url) return true;
  const left = titleWords(a.title);
  const right = titleWords(b.title);
  if (!left.length || !right.length) return false;
  if (left.join("") === right.join("")) return true;
  if (!a.query || a.query.trim().toLowerCase() !== b.query.trim().toLowerCase()) return false;
  const one = new Set(left);
  const two = new Set(right);
  const shared = [...one].filter((word) => two.has(word)).length;
  return shared / new Set([...one, ...two]).size >= 0.75;
}

/** The photos in order with every later copy of an earlier picture dropped (the earlier one ranks higher). */
export function withoutSamePictures<T extends Pick<FoundPhoto, "url" | "title" | "query">>(photos: T[], already: Array<Pick<FoundPhoto, "url" | "title" | "query">> = []): T[] {
  const kept: T[] = [];
  for (const photo of photos) {
    if (already.some((other) => samePicture(other, photo)) || kept.some((other) => samePicture(other, photo))) continue;
    kept.push(photo);
  }
  return kept;
}

/** The same Commons rendition at another width (its thumbnail URLs carry the width in the path). */
export function commonsRendition(url: string, width: number): string {
  return url.replace(/\?.*$/, "").replace(/\/\d+px-/, `/${width}px-`);
}

function acceptable(page: CommonsPage): boolean {
  const info = page.imageinfo?.[0];
  if (!info || !info.width || !info.height || !info.thumburl) return false;
  if (!/^image\/(jpeg|png)$/.test(info.mime || "")) return false;
  if (info.width < MIN_PHOTO_WIDTH || info.width < info.height * 1.05) return false;
  const title = String(page.title || "");
  if (NOT_A_PHOTO.test(title) || FOOD_OR_OBJECT.test(title) || TRANSIT_PLACE.test(title)) return false;
  const license = plain(info.extmetadata?.LicenseShortName?.value || "");
  return ALLOWED_LICENSE.test(license);
}

/**
 * Commons photographs for one search phrase, largest first; never throws. With
 * `quality`, only the files Commons reviewers rated "Quality images" — the best
 * pool when a place has them.
 */
export async function searchCommonsPhotos(query: string, options: { limit?: number; fetchImpl?: FetchLike; quality?: boolean } = {}): Promise<FoundPhoto[]> {
  const fetchImpl = options.fetchImpl || fetch;
  const url = new URL(COMMONS_API);
  for (const [key, value] of Object.entries({
    action: "query", format: "json", generator: "search", gsrsearch: `${query} filetype:bitmap${options.quality ? ' incategory:"Quality images"' : ""}`, gsrnamespace: "6",
    gsrlimit: String(options.limit ?? 30), prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: String(RENDITION_WIDTH),
    iiextmetadatafilter: "LicenseShortName|Artist",
  })) url.searchParams.set(key, value);
  try {
    const response = await fetchImpl(url.toString(), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [];
    const data = await response.json() as { query?: { pages?: Record<string, CommonsPage> } };
    return Object.values(data.query?.pages || {})
      .filter(acceptable)
      .map((page) => {
        const info = page.imageinfo![0];
        return {
          url: commonsRendition(info.thumburl!, RENDITION_WIDTH),
          pageUrl: info.descriptionurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(page.title))}`,
          title: String(page.title || "").replace(/^File:/, "").replace(/\.[a-z0-9]+$/i, ""),
          width: info.width!, height: info.height!,
          license: plain(info.extmetadata?.LicenseShortName?.value || ""),
          author: plain(info.extmetadata?.Artist?.value || "").slice(0, 80),
          query,
        };
      })
      .sort((a, b) => b.width * b.height - a.width * a.height);
  } catch (error) {
    logWarn("trip_photos.commons_search_failed", { query, message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * Candidates for several phrases, round-robin so no single place dominates;
 * duplicates dropped. Reviewer-rated "Quality images" come first for each
 * phrase. Searches run one at a time: a burst of ten made Commons refuse some
 * and left too few candidates to rank (2026-11-04).
 */
export async function collectPhotoCandidates(queries: string[], options: { perQuery?: number; fetchImpl?: FetchLike } = {}): Promise<FoundPhoto[]> {
  const perQuery = options.perQuery ?? 8;
  const lists: FoundPhoto[][] = [];
  for (const query of queries) {
    const quality = await searchCommonsPhotos(query, { fetchImpl: options.fetchImpl, quality: true, limit: 20 });
    const plain = await searchCommonsPhotos(query, { fetchImpl: options.fetchImpl });
    const urls = new Set(quality.map((photo) => photo.url));
    lists.push([...quality, ...plain.filter((photo) => !urls.has(photo.url))]);
  }
  const seen = new Set<string>();
  const out: FoundPhoto[] = [];
  for (let round = 0; round < perQuery; round += 1) {
    for (const list of lists) {
      const photo = list[round];
      if (photo && !seen.has(photo.url)) { seen.add(photo.url); out.push(photo); }
    }
  }
  return out;
}

/**
 * The best `count` of the candidates for a trip page, chosen by a vision model from
 * small previews (a few hundred tokens per photo). The model also rejects, so it
 * runs even on a small pool. Falls back to the largest ones when it cannot answer.
 */
export async function rankPhotos(candidates: FoundPhoto[], input: { subject: string; count?: number;
  /** Extra different pictures kept after the wanted count, for the caller to fall back on (a download that fails, a copy found only in the bytes). */
  reserve?: number; fetchImpl?: FetchLike;
  ask?: typeof askOpenAIChatParts; trace?: { requestId?: string; correlationId?: string } }): Promise<FoundPhoto[]> {
  const count = input.count ?? PHOTOS_PER_TRIP;
  if (!candidates.length) return [];
  const fetchImpl = input.fetchImpl || fetch;
  const ask = input.ask || askOpenAIChatParts;
  // Different pictures take the preview slots first; a second copy of one is shown only when slots are left.
  const distinct = withoutSamePictures(candidates);
  const pool = [...distinct, ...candidates.filter((photo) => !distinct.includes(photo))];
  const previews = await Promise.all(pool.slice(0, Math.min(30, Math.max(18, count * 3))).map(async (photo) => {
    try {
      const response = await fetchImpl(commonsRendition(photo.url, PREVIEW_WIDTH), { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return null;
      const bytes = Buffer.from(await response.arrayBuffer());
      return { photo, part: { inlineData: { mimeType: response.headers.get("content-type")?.split(";")[0] || "image/jpeg", data: bytes.toString("base64") } } };
    } catch { return null; }
  }));
  const usable = previews.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
  // Unjudged search results include unrelated files; no photo is better than a wrong one.
  if (!usable.length) {
    logWarn("trip_photos.no_previews", { candidates: candidates.length });
    return [];
  }
  // A few reserves after the wanted number: a pick that turns out to be another copy of an
  // earlier one is replaced by the next different picture, not left as a gap.
  const spare = Math.min(4, Math.max(0, usable.length - count));
  const instruction = `You choose photographs for a travel agency's web page about: ${input.subject}.
Each photo below is labelled with the place it was searched for. Pick up to ${count + spare} of the ${usable.length} photos, best first. A photo qualifies only when a traveller would recognise in it the PLACE it is labelled with: that landmark, skyline or night view, beach, old town, famous street, bridge, park or natural scenery; sharp, well lit, inviting.
Aim for ${count} photos: cover as many different places from the list as you can, then add more views of the best places${spare ? `; then list up to ${spare} more qualifying photos as reserves` : ""}. Never pick a photo that fails the rules below just to reach the number, and never two photos of the same view.
Reject every one of these, however good the picture: food, dishes, drinks, ingredients, spices, tables, menus and restaurant interiors; objects, products and souvenirs; maps, satellite or aerial survey images; text overlays, logos, gates and signs; zoo animals; museum or shop interiors; plain buildings; close-ups of people, portraits and selfies; derelict or under-construction places; bad weather, blurry or dark images; another company's branding; border towns, railway and airport scenes; and any photo that shows a different city or country, or where you cannot tell that it is the labelled place.
Answer with JSON only: {"picks":[photo numbers, best first]}.`;
  const parts: Parameters<typeof askOpenAIChatParts>[0] = [{ text: instruction }];
  usable.forEach((entry, index) => { parts.push({ text: `Photo ${index + 1} — searched for "${entry.photo.query}": ${entry.photo.title}` }); parts.push(entry.part); });
  try {
    // Low detail: enough to tell a beach from a map, a third of the tokens (2026-11-04: ~148k → ~50k per trip).
    const result = await ask(parts, { model: "gpt-4o-mini", jsonMode: true, temperature: 0, maxOutputTokens: 200, timeoutMs: 30_000, imageDetail: "low",
      source: "trip_photos.rank", requestId: input.trace?.requestId, correlationId: input.trace?.correlationId });
    const picks = (JSON.parse(result?.text || "{}") as { picks?: unknown }).picks;
    const picked = (Array.isArray(picks) ? picks : []).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= usable.length)
      .filter((n, i, all) => all.indexOf(n) === i).map((n) => usable[n - 1].photo);
    // Two files of one view (same landmark, same day): the better-ranked stays, the next different pick fills in.
    const chosen = withoutSamePictures(picked).slice(0, count + Math.max(0, input.reserve ?? 0));
    // Fewer good photos beat a full set with a weak one; the model's rejections stand.
    if (chosen.length) return chosen;
  } catch (error) {
    logWarn("trip_photos.rank_failed", { message: error instanceof Error ? error.message : String(error) });
  }
  return [];
}

/** The photo as a JPEG no wider than 1920px (uploads over ~800 KB time out on the poster path). */
export async function downloadPhoto(photo: FoundPhoto, fetchImpl: FetchLike = fetch): Promise<{ buffer: Buffer; mimeType: "image/jpeg" } | null> {
  try {
    const response = await fetchImpl(photo.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const raw = Buffer.from(await response.arrayBuffer());
    if (!raw.length || raw.length > MAX_DOWNLOAD_BYTES) return null;
    const buffer = await sharp(raw).rotate().resize({ width: RENDITION_WIDTH, withoutEnlargement: true }).jpeg({ quality: 82, mozjpeg: true }).toBuffer();
    return { buffer, mimeType: "image/jpeg" };
  } catch (error) {
    logWarn("trip_photos.download_failed", { url: photo.url, message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

export function photoCredit(photo: FoundPhoto): PhotoCredit {
  return { url: photo.url, title: photo.title, author: photo.author, license: photo.license, source: photo.pageUrl };
}

/**
 * Short English search phrases for the places and sights of an itinerary — transit
 * days (airports, trains, border towns) skipped. One small text call.
 */
export type PhotoQuery = { query: string; day: number | null };

export async function photoQueriesForTrip(input: { title: string; days: Array<{ day?: number; title?: string; description?: string }>; destinations?: string[]; wanted?: number;
  ask?: typeof askOpenAIChatParts; trace?: { requestId?: string; correlationId?: string } }): Promise<PhotoQuery[]> {
  const ask = input.ask || askOpenAIChatParts;
  const program = input.days.map((day, index) => `${day.day ?? index + 1}. ${String(day.title || "").trim()} — ${String(day.description || "").replace(/\s+/g, " ").trim().slice(0, 220)}`).join("\n");
  const destinations = (input.destinations || []).filter((place) => !TRANSIT_PLACE.test(place));
  const prompt = `Trip: ${input.title}${destinations.length ? `\nDestinations: ${destinations.join(", ")}` : ""}\nProgram:\n${program}\n\nList ${Math.max(6, input.wanted ?? 6)} to ${Math.max(8, (input.wanted ?? 6) + 3)} short English search phrases (2-5 words each) — at least one for every program day that visits a named place — for photographs of the PLACES this trip visits: a named landmark, viewpoint, bridge, park, old town, beach, island, famous street or natural sight that the program itself mentions, written as it is known in English together with its city, each with the number of the program day that visits it. Only places: never a dish, food, drink, restaurant, market stall, shop, hotel, shopping centre, show, animal or activity. A free day with no named sight gets no phrase. Also list every city the program names, in English, each marked stopover true or false: a stopover is a city where the group only changes planes, or sleeps one night between two flights, with no sight visited there; a destination (stopover false) is where the trip's sights and free days are. A stopover city gets no phrase. Never include Erenhot/Erlian, Zamyn-Uud, Ulaanbaatar, any border town, transfer city, airport or railway station, and skip days that are only travel. Answer with JSON only: {"queries":[{"q":"...","day":2}],"cities":[{"name":"...","stopover":false}]}.`;
  try {
    const result = await ask([{ text: prompt }], { model: "gpt-4o-mini", jsonMode: true, temperature: 0, maxOutputTokens: 400, timeoutMs: 20_000,
      source: "trip_photos.queries", requestId: input.trace?.requestId, correlationId: input.trace?.correlationId });
    const parsed = JSON.parse(result?.text || "{}") as { queries?: unknown; cities?: unknown };
    const valid = new Set(input.days.map((day, index) => day.day ?? index + 1));
    const fromModel = (Array.isArray(parsed.queries) ? parsed.queries : [])
      .map((item) => {
        const entry: Record<string, unknown> = item && typeof item === "object" ? item as Record<string, unknown> : { q: item };
        const day = Number(entry.day);
        return { query: String(entry.q ?? entry.query ?? "").trim(), day: valid.has(day) ? day : null };
      });
    // A city's skyline and best-known landmark are what a trip card wants most; they are not tied to a day.
    // A city the trip only flies through is not what the trip looks like (a beach trip got three skylines of its stopover).
    const listed = (Array.isArray(parsed.cities) ? parsed.cities : []).map((city) => (city && typeof city === "object"
      ? { name: String((city as Record<string, unknown>).name ?? "").trim(), stopover: (city as Record<string, unknown>).stopover === true }
      : { name: String(city).trim(), stopover: false }));
    const stopovers = listed.filter((city) => city.stopover && city.name.length >= 3).map((city) => city.name.toLowerCase());
    const cities = listed.filter((city) => !city.stopover).map((city) => city.name).filter((city) => city.length >= 3 && !TRANSIT_PLACE.test(city)).slice(0, 3);
    const general = cities.flatMap((city) => [{ query: `${city} skyline`, day: null }, { query: `${city} famous landmark`, day: null }]);
    return [...fromModel, ...general]
      .filter((item) => item.query.length >= 3 && item.query.length <= 60 && !TRANSIT_PLACE.test(item.query) && !FOOD_OR_OBJECT.test(item.query))
      .filter((item) => !stopovers.some((city) => item.query.toLowerCase().includes(city)))
      .filter((item, index, all) => all.findIndex((other) => other.query.toLowerCase() === item.query.toLowerCase()) === index)
      .slice(0, Math.max(10, (input.wanted ?? 6) + 4));
  } catch (error) {
    logWarn("trip_photos.queries_failed", { message: error instanceof Error ? error.message : String(error) });
    return [];
  }
}
