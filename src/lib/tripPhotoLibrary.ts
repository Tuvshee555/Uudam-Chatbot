/**
 * The agency's own photos, by place: every program day of every saved trip that carries a photo
 * is a photo of the places in that day's title. A new trip (or a saved one with empty days) takes
 * a house photo of the same place before anything is searched for on the web.
 *
 * Why (owner, 2026-11-21): a new trip read from a partner's Word file went live with two photos,
 * while the catalogue already held staff-chosen photos of every place it visits (other trips to
 * the same cities). Staff reuse them by hand; the search on Wikimedia finds two to seven usable
 * pictures for a region like this, a different number on every run.
 *
 * A photo is used once per trip. A train or border day (it names no place) takes the photo that
 * a trip to the same places shows on the same train day (the station, the border town), and
 * none when no such trip has one. Pure.
 */
import { isHostedPhotoUrl } from "./tripPhotoEdit";
import { distinctiveTokens } from "./tripNameTokens";
import type { TravelTrip } from "./travelTypes";

export type LibraryPhoto = {
  url: string; trip_id: string; trip_name: string; day_title: string; places: string[]; live: boolean;
  /** A train / border day (no place in its title): the route towns it names, as transitKey writes them. */
  transit?: string;
  /** Every place the photo's own trip visits: a train-day photo is reused only by a trip to the same places. */
  trip_places?: string[];
  /** The photo's credit line where its own trip keeps one (a photo that came from Wikimedia Commons). */
  credit?: Record<string, unknown>;
};
export type LibraryPick = { day: number; url: string; from: string; places: string[] };
type DayLike = { day?: unknown; title?: unknown; description?: unknown; photo?: unknown };

// Places every train route passes: never what a day's photo shows (stems as distinctiveTokens cuts them).
const TRANSIT = new Set(["замын", "үүд", "үүдэд", "үүдий", "эрээн", "хил", "гарна", "гарах", "бууда", "нислэ", "нисэх", "онгоц", "ирнэ", "ирэх", "буцна", "өглөө", "орой"]);
// The same place written another way.
const SAME_PLACE: Record<string, string> = { "хөххо": "хөх", "минин": "мини", "жинни": "жинин", "бээжи": "бээжи" };
// A train-day photo is borrowed only from a trip that shares this many places (or every place of a one-place trip).
const SIBLING_PLACES = 2;

/** The places a program day names (stems), without the border towns and travel words. */
export function dayPlaces(title: unknown): string[] {
  const tokens = distinctiveTokens(String(title ?? "")).map((token) => SAME_PLACE[token] ?? token).filter((token) => !TRANSIT.has(token));
  return [...new Set(tokens)];
}

/** The train-route towns a day's title names, as one key ("уб+зү", "эрээн+зү", "уб"); "" when it names none. */
export function transitKey(title: unknown): string {
  const words = ` ${String(title ?? "").toLowerCase().replace(/[^a-zа-яөүё]+/gi, " ")} `;
  const parts: string[] = [];
  if (words.includes(" улаанбаатар") || words.includes(" уб ")) parts.push("уб");
  if (words.includes(" замын")) parts.push("зү");
  if (words.includes(" эрээн")) parts.push("эрээн");
  return parts.join("+");
}

const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const daysOf = (trip: TravelTrip): DayLike[] => (Array.isArray(trip.extra?.itinerary_days) ? (trip.extra.itinerary_days as DayLike[]) : []);
const placesOfDays = (days: DayLike[]): string[] => [...new Set(days.flatMap((day) => dayPlaces(day.title)))];

/** Every day photo of the saved trips, live trips first (their photos are what the site shows today). */
export function buildPhotoLibrary(trips: TravelTrip[]): LibraryPhoto[] {
  const out: LibraryPhoto[] = [];
  const seen = new Set<string>();
  const ordered = [...trips].sort((a, b) => Number(b.status === "active") - Number(a.status === "active"));
  for (const trip of ordered) {
    if (trip.status === "draft" || trip.status === "cancelled") continue;
    const days = daysOf(trip);
    const tripPlaces = placesOfDays(days);
    for (const day of days) {
      const url = text(day.photo);
      if (!url || !isHostedPhotoUrl(url, "")) continue;
      const places = dayPlaces(day.title);
      const transit = places.length ? "" : transitKey(day.title);
      if (!places.length && !transit) continue;
      const key = `${url}|${places.join(",")}|${transit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const credit = (trip.extra?.photo_credits as Record<string, unknown> | undefined)?.[url];
      out.push({ url, trip_id: trip.id, trip_name: trip.route_name, day_title: text(day.title), places, live: trip.status === "active",
        trip_places: tripPlaces,
        ...(transit ? { transit } : {}),
        ...(credit && typeof credit === "object" ? { credit: credit as Record<string, unknown> } : {}) });
    }
  }
  return out;
}

/**
 * A house photo for each given day that has none: the photo whose day shares the most places with
 * it (a day about exactly that place before one that merely passes it), then for a train or
 * border day the photo a sibling trip shows on that same train day. `exclude` are photos the trip
 * already shows; `ownTripId` keeps a trip from being its own source.
 */
export function pickLibraryPhotos(library: LibraryPhoto[], days: DayLike[], options: { exclude?: Iterable<string>; ownTripId?: string } = {}): LibraryPick[] {
  const used = new Set<string>(options.exclude || []);
  for (const day of days) if (text(day.photo)) used.add(text(day.photo));
  const usable = (photo: LibraryPhoto) => !used.has(photo.url) && !(options.ownTripId && photo.trip_id === options.ownTripId);
  // Every (empty day, photo) pair that shares a place, best first across the whole trip: the photo
  // of exactly a day's places goes to that day before an earlier day that merely passes one of them
  // can take it.
  const pairs: Array<{ index: number; order: number; photo: LibraryPhoto; score: number; shared: string[] }> = [];
  // A photo from a trip that goes only where this trip goes comes first. A two-destination trip's day photos are
  // less sure: «УБ - ШАНХАЙ» of a Shanghai + mountain trip showed a mountain, and a Shanghai-only trip got it
  // (2026-11-25).
  const ownPlaces = placesOfDays(days);
  const sameTrip = (photo: LibraryPhoto) => Boolean(photo.trip_places?.length) && photo.trip_places!.every((place) => ownPlaces.includes(place));
  days.forEach((day, index) => {
    if (text(day.photo)) return;
    const wanted = dayPlaces(day.title);
    if (!wanted.length) return;
    library.forEach((photo, order) => {
      if (!usable(photo)) return;
      const shared = photo.places.filter((place) => wanted.includes(place));
      if (!shared.length) return;
      // Shared places count most; a photo whose day also names other places is a weaker witness.
      const score = shared.length * 10 - (photo.places.length - shared.length) * 2 - (wanted.length - shared.length) + (photo.live ? 1 : 0) + (sameTrip(photo) ? 5 : 0);
      pairs.push({ index, order, photo, score, shared });
    });
  });
  pairs.sort((a, b) => b.score - a.score || a.index - b.index || a.order - b.order);
  const taken = new Map<number, LibraryPick>();
  const dayNumber = (index: number) => (typeof days[index].day === "number" ? (days[index].day as number) : index + 1);
  for (const pair of pairs) {
    if (taken.has(pair.index) || used.has(pair.photo.url)) continue;
    used.add(pair.photo.url);
    taken.set(pair.index, { day: dayNumber(pair.index), url: pair.photo.url, from: pair.photo.trip_name, places: pair.shared });
  }
  // Train and border days: what a trip to the same places shows on that same train day.
  const tripPlaces = placesOfDays(days);
  const needed = Math.min(SIBLING_PLACES, tripPlaces.length);
  // A photo some trip shows on a day about a place is a picture of that place. Where it also sits on a train day (an
  // earlier wrong pick, saved), it is not that train day's photo: offered again, the library fed on its own mistakes
  // (a mountain as «УБ – Замын-Үүд», live 2026-11-25).
  const placePhotos = new Set(library.filter((photo) => photo.places.length).map((photo) => photo.url));
  if (needed > 0) {
    days.forEach((day, index) => {
      if (text(day.photo) || taken.has(index) || dayPlaces(day.title).length) return;
      const key = transitKey(day.title);
      if (!key) return;
      let best: { photo: LibraryPhoto; score: number } | null = null;
      for (const photo of library) {
        if (photo.transit !== key || !usable(photo) || placePhotos.has(photo.url)) continue;
        const shared = (photo.trip_places || []).filter((place) => tripPlaces.includes(place)).length;
        if (shared < needed) continue;
        const score = shared * 10 + (photo.live ? 1 : 0);
        if (!best || score > best.score) best = { photo, score };
      }
      if (!best) return;
      used.add(best.photo.url);
      taken.set(index, { day: dayNumber(index), url: best.photo.url, from: best.photo.trip_name, places: [] });
    });
  }
  return [...taken.entries()].sort((a, b) => a[0] - b[0]).map(([, pick]) => pick);
}
