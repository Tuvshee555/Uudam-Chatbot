/**
 * "Ямар буудалд буудаллах вэ?" about a named trip. It used to fall through to
 * the generic trip card (prices and dates), which never names a hotel even
 * when every day of the itinerary does.
 *
 * Every hotel answer reads ONE source, `tripHotels`: this reply, the answer
 * plan's hotel topic, its price line and its lodging note. The hotels the price
 * rows sell come first, each named and linked by its hotel profile when one
 * matches; then the trip's own hotel line (what the answer plan always said, and
 * what the website's hotel section shows); the itinerary days' hotels only for a
 * trip with neither. The same question used to get two answers: the day-1 hotel
 * here, and the four price-row variants in the answer plan (2026-11-05).
 */
import type { TravelTrip } from "./travelTypes";
import { normalizeTripOffers, resolveTripOffer, type TripOfferResult } from "./tripOffers";
import { hotelOptionParts } from "./partnerSync/hotelProfiles";

const HOTEL_WORD = /зочид\s*буудал|буудал|буудл|hotel|buudal|buudl/iu;
// "Буудал" is also any station or stop: an airport, bus or train station.
const NOT_A_HOTEL = /(?:нисэх|онгоцны|автобусны|тэрэгний|галт)\s+буу?д|airport|метро|mrt/iu;

export type TripHotel = { name: string; urls: string[]; days: number[] };
export type TripHotels = { source: "price_rows" | "itinerary" | "trip"; hotels: TripHotel[] };

type Row = Record<string, unknown>;
const records = (value: unknown): Row[] => Array.isArray(value)
  ? value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
const text = (value: unknown): string => typeof value === "string" ? value.trim() : "";
/** "Vestar Bay" and "Vestarbay" are one hotel (the admin's hotel profile editor matches the same way). */
const squash = (value: string): string => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

export function isHotelQuestion(text: string): boolean {
  return HOTEL_WORD.test(text) && !NOT_A_HOTEL.test(text);
}

/**
 * [1, 2, 3, 4, 7] → "1–4, 7". An en dash: the reply checker reads "1-2, 4-5-р өдөр"
 * as the departure 1/2, so a dated hotel question got silence (2026-11-05 review).
 */
function formatDayNumbers(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}–${sorted[i]}`);
  }
  return parts.join(", ");
}

/** Only an https link is sent to a customer (the website shows the same ones). */
function httpsUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    return new URL(raw).protocol === "https:" ? raw : null;
  } catch {
    return null;
  }
}

function todayInUb(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Hotel profiles and older hotel links, by squashed name: the name staff wrote and its link. */
function hotelDirectory(trip: TravelTrip): Map<string, { name: string; url: string | null }> {
  const directory = new Map<string, { name: string; url: string | null }>();
  for (const profile of records(trip.extra?.hotel_profiles)) {
    const name = text(profile.name);
    if (squash(name) && !directory.has(squash(name))) directory.set(squash(name), { name, url: httpsUrl(profile.url) });
  }
  for (const link of records(trip.extra?.hotel_links)) {
    const name = text(link.name);
    if (!squash(name)) continue;
    const known = directory.get(squash(name));
    if (!known) directory.set(squash(name), { name, url: httpsUrl(link.url) });
    else if (!known.url) known.url = httpsUrl(link.url);
  }
  return directory;
}

/** "A+B", "A / B" or "A эсвэл B" names several hotels, split exactly as the sync and the website split them. */
const hotelParts = hotelOptionParts;

/**
 * A hotel as the trip's profiles name it, for a row with no profile link: the
 * whole name, else each part of an "A+B" stay, matched by its squashed name. A
 * name no profile matches is kept exactly as written — never matched by a prefix.
 */
function profiled(name: string, directory: Map<string, { name: string; url: string | null }>): Omit<TripHotel, "days"> {
  const whole = directory.get(squash(name));
  if (whole) return { name: whole.name, urls: whole.url ? [whole.url] : [] };
  const parts = hotelParts(name);
  const found = parts.map((part) => directory.get(squash(part)));
  if (parts.length > 1 && found.some(Boolean)) {
    return {
      name: parts.map((part, index) => found[index]?.name || part).join(" + "),
      urls: found.flatMap((entry) => (entry?.url ? [entry.url] : [])),
    };
  }
  return { name, urls: [] };
}

/**
 * A price row linked to its hotel profiles by id (hotel_profile_ids, which the
 * partner sync writes from its own name matching): those profiles' names and
 * links. An "A+B" row is named by its profiles only when every part is linked;
 * otherwise it keeps its own name, with the links that were found.
 */
function linkedHotel(
  trip: TravelTrip,
  offer: { hotel: string | null; hotelId: string | null },
  name: string,
  directory: Map<string, { name: string; url: string | null }>,
): Omit<TripHotel, "days"> | null {
  const extra = (trip.extra || {}) as Row;
  const profiles = new Map(records(extra.hotel_profiles).map((profile) => [text(profile.id) || squash(text(profile.name)), profile]));
  const rows = [...records(extra.price_groups), ...records(extra.departure_date_groups)].filter((row) =>
    offer.hotel ? text(row.hotel) === offer.hotel : Boolean(offer.hotelId) && text(row.hotel_id) === offer.hotelId);
  const ids = [...new Set(rows.flatMap((row) => (Array.isArray(row.hotel_profile_ids) ? row.hotel_profile_ids : []).map(text).filter(Boolean)))];
  const linked = ids.flatMap((id) => {
    const profile = profiles.get(id);
    return profile && text(profile.name) ? [profile] : [];
  });
  if (!linked.length) return null;
  const urls = linked.flatMap((profile) => {
    const url = httpsUrl(profile.url) || directory.get(squash(text(profile.name)))?.url;
    return url ? [url] : [];
  });
  const parts = name ? hotelParts(name) : [];
  const complete = linked.length === ids.length && (!name || linked.length === parts.length);
  const shown = complete ? linked.map((profile) => text(profile.name)).join(" + ") : name;
  return shown ? { name: shown, urls } : null;
}

/** One entry per hotel name; a hotel named on several itinerary days keeps all its days. */
function merge(hotels: TripHotel[]): TripHotel[] {
  const byName = new Map<string, TripHotel>();
  for (const hotel of hotels) {
    const known = byName.get(squash(hotel.name));
    if (known) {
      known.days.push(...hotel.days);
      known.urls = [...new Set([...known.urls, ...hotel.urls])];
    } else byName.set(squash(hotel.name), { ...hotel, days: [...hotel.days], urls: [...hotel.urls] });
  }
  return [...byName.values()];
}

/** Package names the trip sells: its package options and the rows' package ids. */
function packageKeys(trip: TravelTrip, offerPackages: Array<string | null>): Set<string> {
  const keys = new Set<string>();
  for (const option of records(trip.extra?.package_options)) for (const value of [option.id, option.label]) if (squash(text(value))) keys.add(squash(text(value)));
  for (const value of offerPackages) if (value && squash(value)) keys.add(squash(value));
  return keys;
}

/** "Orlin · Хөтөлбөргүй" is the Orlin hotel sold with a package; the package is not a hotel. */
function withoutPackage(name: string, packages: Set<string>): string {
  const at = name.lastIndexOf(" · ");
  return at > 0 && packages.has(squash(name.slice(at + 3))) ? name.slice(0, at).trim() : name;
}

/**
 * The hotels of a trip, from one source (see the file comment). `date` limits
 * price-row hotels to that departure; without one, only rows with an upcoming
 * departure count. `hotel` keeps the one the customer already chose. Null when
 * the data names no hotel for that scope; a trip whose price rows sell hotels
 * never falls back to its trip-level hotel line, and a trip with its own hotel
 * line answers with it even when the itinerary spells a day's hotel otherwise.
 */
const NOT_ON_SALE = new Set(["sold_out", "paused", "cancelled", "unavailable", "departed"]);
const isNotOnSale = (result: TripOfferResult) => result.status === "unavailable" && NOT_ON_SALE.has(result.reason);
/** Every package of the hotel is full (or closed) on that date. The resolver asks the package before it reads seats. */
function hotelFullOn(trip: TravelTrip, date: string, hotel: string, now: Date): boolean {
  const result = resolveTripOffer(trip, { date, hotel }, now);
  if (isNotOnSale(result)) return true;
  return result.status === "needs_selection" && result.fields.includes("package")
    && result.options.every((packageId) => isNotOnSale(resolveTripOffer(trip, { date, hotel, packageId }, now)));
}

export function tripHotels(trip: TravelTrip, scope: { date?: string | null; hotel?: string | null } = {}, now = new Date()): TripHotels | null {
  const directory = hotelDirectory(trip);
  const wanted = squash(scope.hotel || "");
  const offers = normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount");
  const sold = offers.filter((offer) => offer.hotel || offer.hotelId);
  const collect = (entries: Array<{ name: string; days: number[] }>): TripHotel[] =>
    merge(entries.map((entry) => ({ ...profiled(entry.name, directory), days: entry.days })));
  if (sold.length) {
    const packages = packageKeys(trip, offers.map((offer) => offer.packageId));
    const today = todayInUb(now);
    const hotels = merge(sold
      .filter((offer) => (scope.date ? !offer.dateScoped || offer.dates.includes(scope.date) : !offer.dateScoped || offer.dates.some((date) => date >= today)))
      .filter((offer) => !wanted || [offer.hotel, offer.hotelId, withoutPackage(offer.hotel || "", packages)].some((value) => squash(value || "") === wanted))
      // On a given date a hotel that is full there is not offered (the fare card and the website leave it out too).
      .filter((offer) => !scope.date || !offer.hotel || !hotelFullOn(trip, scope.date, offer.hotel, now))
      .flatMap((offer) => {
        const name = offer.hotel ? withoutPackage(offer.hotel, packages) : "";
        const linked = linkedHotel(trip, offer, name, directory);
        if (linked) return [{ ...linked, days: [] }];
        return name ? [{ ...profiled(name, directory), days: [] }] : [];
      }));
    return hotels.length ? { source: "price_rows", hotels } : null;
  }
  // The customer's chosen hotel, as the data or its profile spells it.
  const isWanted = (name: string) => !wanted || squash(name) === wanted || squash(profiled(name, directory).name) === wanted;
  const itinerary = (): TripHotels | null => {
    const days = records(trip.extra?.itinerary_days).flatMap((day, index) => {
      const name = text(day.hotel);
      return name ? [{ name, days: [typeof day.day === "number" ? day.day : index + 1] }] : [];
    });
    const hotels = collect(days.filter((day) => isWanted(day.name)));
    return hotels.length ? { source: "itinerary", hotels } : null;
  };
  const own = text(trip.hotel);
  if (!own) return itinerary();
  if (isWanted(own)) return { source: "trip", hotels: collect([{ name: own, days: [] }]) };
  // The customer named a hotel the itinerary gives for some days, not the trip's own line.
  return itinerary();
}

/** "1–2, 4-р өдөр: Alpha Bay", "Vestar Bay — https://…". */
export function formatTripHotel(hotel: TripHotel): string {
  const name = hotel.days.length ? `${formatDayNumbers(hotel.days)}-р өдөр: ${hotel.name}` : hotel.name;
  return hotel.urls.length ? `${name} — ${[...new Set(hotel.urls)].join(" ")}` : name;
}

export function buildHotelReply(trip: TravelTrip, text: string, now = new Date()): string | null {
  if (!isHotelQuestion(text)) return null;
  const found = tripHotels(trip, {}, now);
  if (!found) return null;
  return [`🏨 ${trip.route_name} — буудал:`, ...found.hotels.map((hotel) => `• ${formatTripHotel(hotel)}`)].join("\n");
}
