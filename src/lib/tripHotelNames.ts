/**
 * The hotels a trip names, read from its price rows and its hotel line. Pure, so
 * the admin's hotel editor (one-click suggestions) and the file reader (a new
 * trip's hotel profiles, filled in without a click) read them the same way.
 *
 * Hotels are split by the project's own rule (partnerSync/hotelProfiles.ts
 * hotelOptionParts, the website's splitHotelNames): "A + B", "A / B" and "A эсвэл B"
 * are several hotels; a comma, "&" and an unspaced "/" are part of one name. A part that
 * names no hotel ("адил зэрэглэлийн буудал", "similar") is dropped.
 */
import { hotelOptionParts } from "./partnerSync/hotelProfiles";

export const squashHotelName = (value: string) => value.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}]+/gu, "");

/** Accents off, lower case: the same folding the website uses for its word list ("й" is "и" plus a mark in NFKD). */
const foldName = (value: string) => value.normalize("NFKD").replace(/\p{M}+/gu, "").toLocaleLowerCase();

// Words every hotel name may carry and the words of "or a similar hotel" (the website's
// GENERIC_HOTEL_WORDS, hotelLinks.ts): a part made only of them names no hotel.
const FILLER_WORDS = new Set([
  "hotel", "hotels", "resort", "resorts", "spa", "inn", "the", "and", "by", "of", "a", "an",
  "similar", "same", "equivalent", "or",
  "зочид", "буудал", "буудлын", "буудалд", "буудлууд", "ба", "болон", "адил", "зэрэглэлийн", "эсвэл",
  "түүнтэй", "үүнтэй", "ижил", "төстэй", "төсөөтэй", "зэрэглэл", "зэргийн", "ангиллын", "түвшний",
].map(foldName));

/** "Норвел хотын буудал, 4 од": the tail after the comma is the hotel's stars, not part of its name. */
const STARS_TAIL = /\s*,\s*(?:\d+\s*(?:од(?:той)?|\*|star)s?)\s*$/iu;
/** A part that is only stars: "5*", "4 од", "4 одтой". */
const ONLY_STARS = /^(?:\d+\s*(?:од(?:той)?|\*|star)s?)$/iu;

function namesAHotel(name: string): boolean {
  if (name.length < 2 || ONLY_STARS.test(name) || !/\p{L}{3,}/u.test(name)) return false;
  return foldName(name).split(/[^\p{L}\p{N}]+/u).some((word) => word && !FILLER_WORDS.has(word));
}

/** Hotel names a trip mentions: price rows ("Hotel · Package" keeps the hotel part) and the trip's hotel line. */
export function hotelNamesOf(priceGroups: Array<{ hotel?: string | null }>, tripHotel: string): string[] {
  const names = [
    ...priceGroups.map((group) => String(group.hotel || "").split(" · ")[0]),
    String(tripHotel || ""),
  ].flatMap((option) => hotelOptionParts(option))
    .map((part) => part.replace(STARS_TAIL, "").trim())
    .filter(namesAHotel);
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = squashHotelName(name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});

/**
 * A new trip read from a file, with the hotels it names already listed as hotel profiles
 * (name only), so they are saved without a click; the admin can still remove them. A trip
 * that already has hotel profiles is returned unchanged.
 */
export function withSuggestedHotelProfiles(fields: Row): Row {
  const extra = record(fields.extra);
  if (Array.isArray(extra.hotel_profiles) && extra.hotel_profiles.length) return fields;
  const groups = (Array.isArray(extra.price_groups) && extra.price_groups.length ? extra.price_groups
    : Array.isArray(extra.departure_date_groups) ? extra.departure_date_groups : []).map(record)
    .map((group) => ({ hotel: typeof group.hotel === "string" ? group.hotel : "" }));
  const names = hotelNamesOf(groups, typeof fields.hotel === "string" ? fields.hotel : "");
  if (!names.length) return fields;
  return { ...fields, extra: { ...extra, hotel_profiles: names.map((name) => ({ name, url: "", description: "", media: [] })) } };
}

/**
 * A partner program's «Буудал» column often names the CITY of the night ("Шанхай"), not a hotel. Read as the
 * trip's hotel it became a hotel card «Шанхай · холбоосгүй» and the bot's «Буудал: Шанхай» (2026-11-25).
 * The trip without a hotel (line or profile) that is only one of its own places; the days keep their city.
 */
export function withoutPlaceOnlyHotels(fields: Row): Row {
  const extra = record(fields.extra);
  const places = new Set([
    ...(Array.isArray(extra.destinations) ? extra.destinations : []),
    ...(Array.isArray(extra.itinerary_days) ? extra.itinerary_days.flatMap((day) => String(record(day).title ?? "").split(/\s*[-–—+,/]\s*/u)) : []),
  ].map((place) => squashHotelName(String(place ?? ""))).filter((place) => place.length >= 3));
  if (!places.size) return fields;
  const placeOnly = (name: unknown) => {
    const key = squashHotelName(String(name ?? "").replace(/\s+(?:хот|хотод|хотын)$/iu, ""));
    return Boolean(key) && places.has(key);
  };
  const profiles = Array.isArray(extra.hotel_profiles) ? extra.hotel_profiles : [];
  const keptProfiles = profiles.filter((profile) => !placeOnly(record(profile).name));
  const hotelLine = typeof fields.hotel === "string" ? fields.hotel : "";
  // A price row's «hotel» that is only the city too: the website showed it as the row's hotel option.
  const rowKeys = ["price_groups", "departure_date_groups"].filter((key) => Array.isArray(extra[key]) && (extra[key] as unknown[]).some((row) => placeOnly(record(row).hotel)));
  if (keptProfiles.length === profiles.length && !placeOnly(hotelLine) && !rowKeys.length) return fields;
  const rows = Object.fromEntries(rowKeys.map((key) => [key, (extra[key] as unknown[]).map((row) => (placeOnly(record(row).hotel) ? { ...record(row), hotel: "" } : row))]));
  return { ...fields, hotel: placeOnly(hotelLine) ? "" : hotelLine, extra: { ...extra, hotel_profiles: keptProfiles, ...rows } };
}
