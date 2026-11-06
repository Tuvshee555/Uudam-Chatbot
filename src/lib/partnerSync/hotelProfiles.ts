// Links a price row's hotel option ("Norvel+Tavrin Bay") to the trip's hotel profiles (name, link,
// photos, description), so every system names the same hotel the same way.
//
// The partner spells one hotel several ways: a profile is "Norvel Grand" while the price table says
// "Norvelgrand" or just "Norvel". No hotel name is written here; names are compared as keys
// (case, spaces and punctuation removed), a whole name first and then the start of a name. A match
// that two profiles could claim is not made: an unlinked hotel is shown by its own name, never as a
// guessed one.
//
// Pure helpers: nothing here reads or writes a database.
import { httpsLink } from "../tripExtraSchema";

export type HotelProfileInput = {
  id?: unknown;
  name?: unknown;
  url?: unknown;
  description?: unknown;
  media?: unknown;
  stars?: unknown;
};

export type HotelOptionLink = {
  /** One stable identity for the hotel option: the linked profile ids, joined by "+" for a stay in several hotels. Null unless every part linked. */
  hotelId: string | null;
  /** The profiles the option stays at, in the option's own order. */
  profileIds: string[];
};

const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** "Norvel Grand", "norvel-grand" and "NORVELGRAND" are one key: letters and digits only, lower case. */
export function hotelKey(name: string): string {
  return name.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** The id a profile is linked by: its own id when it has one, else the key of its name. */
export function hotelProfileId(profile: HotelProfileInput): string {
  return text(profile.id) || hotelKey(text(profile.name));
}

/**
 * What is left of `long` after the words that spell `short` from its start ("Norvel Grand" in
 * "Norvel Grand Hotel" leaves " Hotel"), or null when `short` is not the start of `long`.
 */
function startRemainder(short: string, long: string): string | null {
  const key = hotelKey(short);
  if (!key) return null;
  const source = long.normalize("NFKC");
  let prefix = "";
  for (const word of source.matchAll(/[\p{L}\p{N}]+/gu)) {
    prefix += word[0].toLocaleLowerCase();
    if (prefix === key) return source.slice((word.index ?? 0) + word[0].length);
    if (prefix.length >= key.length) return null;
  }
  return null;
}

const MIN_KEY_LENGTH = 3;

/** Signs and words that join two hotels in one text ("A, B", "A & B", "A эсвэл B", "A болон B"). */
const LIST_JOINER = /[,;&/+＋]|(?:^|[^\p{L}\p{N}])(?:эсвэл|буюу|болон|ба|or|and)(?=$|[^\p{L}\p{N}])/iu;

function namedProfiles<T extends HotelProfileInput>(profiles: T[]): T[] {
  return profiles.filter((profile) => hotelKey(text(profile.name)).length >= MIN_KEY_LENGTH);
}

/**
 * `name` and a profile name start alike: `name` is a shorter spelling of the profile ("Norvel" for
 * "Norvel Grand"), or a longer one ("Norvel Grand Hotel"). A longer text is never a list that only
 * starts with this hotel: what follows the profile's words must hold no joiner ("эсвэл", ",", "&",
 * "/") and must not name another profile ("Norvel Grand Tavrin" is two hotels, not Norvel Grand).
 */
function startsAlike(name: string, profileName: string, others: HotelProfileInput[], longer: boolean): boolean {
  if (startRemainder(name, profileName) !== null) return true;
  if (!longer) return false;
  const rest = startRemainder(profileName, name);
  if (rest === null || LIST_JOINER.test(rest)) return false;
  if (hotelKey(rest).length < MIN_KEY_LENGTH) return true;
  return !others.some((other) => startRemainder(rest, text(other.name)) !== null || startRemainder(text(other.name), rest) !== null);
}

/**
 * The one profile this hotel name means, or null when none (or more than one) could. With
 * `longerSpelling: false` only the whole name or a shorter spelling links (for a text that names
 * several hotels, which never becomes one of them by its start).
 */
export function matchHotelProfile<T extends HotelProfileInput>(name: string, profiles: T[], options: { longerSpelling?: boolean } = {}): T | null {
  const key = hotelKey(name);
  if (key.length < MIN_KEY_LENGTH) return null;
  const named = namedProfiles(profiles);
  const exact = named.filter((profile) => hotelKey(text(profile.name)) === key);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const longer = options.longerSpelling !== false;
  const start = named.filter((profile) => startsAlike(name, text(profile.name), named.filter((other) => other !== profile), longer));
  return start.length === 1 ? start[0] : null;
}

/**
 * "A+B", "A / B" and "A эсвэл B" (or) name several hotels: the website's own split
 * (booking-web hotelLinks.ts splitHotelNames), so both sides show the same hotels. A comma,
 * "&", an unspaced "/", "буюу" and "болон" do not split ("Example Bay, Old Town" and
 * "Altara Resort & Spa" are one name each).
 */
export function hotelOptionParts(option: string): string[] {
  // The same separators as the website's splitHotelNames: "&", an unspaced "/" and "буюу"
  // ("A, i.e. B") are part of real names or aliases ("Altara Resort & Spa"), never two hotels.
  return option.split(/\s*[+＋]\s*|\s+\/\s+|\s+(?:эсвэл|or)\s+/iu).map((part) => part.trim()).filter(Boolean);
}

/** The profiles a price row's hotel option stays at. */
export function linkHotelOption(option: string, profiles: HotelProfileInput[]): HotelOptionLink {
  const parts = hotelOptionParts(option);
  // A stay in two hotels is never one profile by the start of its name ("Norvel+Tavrin" is not "Norvel").
  const whole = matchHotelProfile(option, profiles, { longerSpelling: parts.length < 2 });
  if (whole) return { hotelId: hotelProfileId(whole), profileIds: [hotelProfileId(whole)] };
  if (parts.length < 2) return { hotelId: null, profileIds: [] };
  const matched = parts.map((part) => matchHotelProfile(part, profiles));
  const profileIds = [...new Set(matched.filter((profile): profile is HotelProfileInput => profile !== null).map(hotelProfileId))];
  const complete = matched.every(Boolean) && profileIds.length === parts.length;
  return { hotelId: complete ? profileIds.join("+") : null, profileIds };
}

/**
 * Every hotel option of a trip's price rows, linked once. Two different options sold on the same
 * date that link to one hotel identity ("Bay" and "Bay Resort", both read as one profile) are two
 * products, not one: they keep their profiles but get no `hotel_id`, so the resolver and the
 * validator keep them apart by name instead of merging them (which hid the hotel choice and made
 * the save fail on a fare conflict). One hotel written two ways on different dates keeps its id.
 */
export function linkHotelOptions(rows: Array<{ hotel: string; dates?: readonly string[] }>, profiles: HotelProfileInput[]): Map<string, HotelOptionLink> {
  const links = new Map<string, HotelOptionLink>();
  for (const row of rows) if (row.hotel && !links.has(row.hotel)) links.set(row.hotel, linkHotelOption(row.hotel, profiles));
  const firstOption = new Map<string, string>();
  const shared = new Set<string>();
  for (const row of rows) {
    const id = links.get(row.hotel)?.hotelId;
    if (!id) continue;
    for (const date of row.dates?.length ? row.dates : [""]) {
      const seen = firstOption.get(`${date}|${id}`);
      if (seen === undefined) firstOption.set(`${date}|${id}`, row.hotel);
      else if (seen !== row.hotel) { shared.add(seen); shared.add(row.hotel); }
    }
  }
  for (const option of shared) links.set(option, { ...links.get(option)!, hotelId: null });
  return links;
}

export type TripHotelProfile = {
  id?: string;
  name: string;
  description: string;
  url: string;
  media: Array<{ url: string; caption: string }>;
  stars?: number;
};

export type PartnerHotel = { id?: string | null; name: string; description: string; stars: number | null; url?: string };

/** A trip hotel profile, and whether it holds nothing but the partner's own facts (no staff photo, link or text). */
export type MergedHotelProfile = { profile: TripHotelProfile; partnerOnly: boolean };

type Row = Record<string, unknown>;
const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

/** Photos the website can show (the schema's https rule), each once, in stored order. */
function ownMedia(values: unknown[]): TripHotelProfile["media"] {
  const seen = new Set<string>();
  return values.flatMap((value) => (Array.isArray(value) ? value : [])).flatMap((entry) => {
    const item = typeof entry === "string" ? { url: entry } : record(entry);
    const url = httpsLink(item.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ url, caption: text(item.caption) }];
  });
}

/** A stored profile kept as staff wrote it, in the trip's profile shape. */
function keptProfile(profile: Row): TripHotelProfile {
  const id = text(profile.id);
  const stars = typeof profile.stars === "number" && Number.isFinite(profile.stars) ? profile.stars : null;
  return {
    ...(id ? { id } : {}),
    name: text(profile.name),
    description: text(profile.description),
    url: httpsLink(profile.url),
    media: ownMedia([profile.media]),
    ...(stars != null ? { stars } : {}),
  };
}

/** The same partner hotel in another copy of the partner's list: the same id, else the same whole name. */
function samePartnerHotel(hotel: { id?: unknown; name?: unknown }, list: PartnerHotel[]): PartnerHotel | undefined {
  const id = text(hotel.id);
  const key = hotelKey(text(hotel.name));
  return (id ? list.find((entry) => text(entry.id) === id) : undefined)
    ?? (key ? list.find((entry) => hotelKey(entry.name) === key) : undefined);
}

/**
 * A field staff may correct (the hotel link, the description). `previous` is the partner's value
 * when the stored profiles were written, or undefined when that is unknown. A stored value that
 * differs from it and from the partner's current value was staff's, and stays. Otherwise the
 * partner's current value is used (an empty one keeps the stored value only when `previous` is unknown).
 */
function ownField(partner: string, previous: string | undefined, stored: string[]): string {
  if (previous === undefined) return partner || stored.find(Boolean) || "";
  return stored.find((value) => value && value !== partner && value !== previous) ?? partner;
}

/**
 * The trip's hotel profiles from the partner's hotels, merged with what Uudam's staff stored.
 *
 * The partner owns each hotel's name, id and stars. A stored profile belongs to a partner hotel by
 * id, else by its name (a shorter or longer spelling counts when only one hotel fits, like price
 * rows). Its photos are kept, and so are a link and a description staff wrote: `previousHotels`
 * (the partner's hotels when the stored profiles were written, from the poster's partner_snapshot)
 * tells a staff correction apart from the partner's own older value. A stored profile that is no
 * partner hotel stays as staff wrote it, unless it is a hotel the partner listed before and no
 * longer does, with nothing of staff's on it. Photos follow the schema's https rule.
 */
export function mergePartnerHotelProfiles(hotels: PartnerHotel[], existing: unknown = [], previousHotels: PartnerHotel[] | null = null): MergedHotelProfile[] {
  const stored = (Array.isArray(existing) ? existing : []).map(record).filter((profile) => text(profile.name));
  const partnerProfiles = hotels.map((hotel) => ({ id: text(hotel.id) || undefined, name: hotel.name }));
  const owners = stored.map((profile) => {
    const id = text(profile.id);
    const byId = id ? hotels.findIndex((hotel) => text(hotel.id) === id) : -1;
    if (byId >= 0) return byId;
    const byName = matchHotelProfile(text(profile.name), partnerProfiles);
    return byName ? partnerProfiles.indexOf(byName) : -1;
  });

  const merged: MergedHotelProfile[] = hotels.map((hotel, index) => {
    // The profile with the hotel's own id or whole name first, then other spellings staff saved.
    const own = stored.filter((_, at) => owners[at] === index)
      .sort((a, b) => Number(Boolean(samePartnerHotel(b, [hotel]))) - Number(Boolean(samePartnerHotel(a, [hotel]))));
    const before = previousHotels ? samePartnerHotel(hotel, previousHotels) : undefined;
    const partnerUrl = httpsLink(hotel.url);
    const partnerText = text(hotel.description);
    const url = ownField(partnerUrl, previousHotels ? httpsLink(before?.url) : undefined, own.map((profile) => httpsLink(profile.url)));
    const description = ownField(partnerText, previousHotels ? text(before?.description) : undefined, own.map((profile) => text(profile.description)));
    const media = ownMedia(own.map((profile) => profile.media));
    const id = text(hotel.id);
    return {
      profile: { ...(id ? { id } : {}), name: hotel.name, description, url, media, ...(hotel.stars != null ? { stars: hotel.stars } : {}) },
      partnerOnly: url === partnerUrl && description === partnerText && media.length === 0,
    };
  });

  const kept = stored.flatMap((profile, at) => {
    if (owners[at] >= 0) return [];
    const profileOut = keptProfile(profile);
    const was = previousHotels ? samePartnerHotel(profile, previousHotels) : undefined;
    const staffData = profileOut.media.length > 0
      || (profileOut.url && profileOut.url !== httpsLink(was?.url))
      || (profileOut.description && profileOut.description !== text(was?.description));
    // A hotel the partner dropped from its list goes with it, unless staff added something to it.
    return was && !staffData ? [] : [{ profile: profileOut, partnerOnly: false }];
  });
  return [...merged, ...kept];
}

/** The hotel profiles alone (see mergePartnerHotelProfiles). */
export function partnerHotelProfiles(hotels: PartnerHotel[], existing: unknown = [], previousHotels: PartnerHotel[] | null = null): TripHotelProfile[] {
  return mergePartnerHotelProfiles(hotels, existing, previousHotels).map((entry) => entry.profile);
}

/** The partner's hotels in a stored partner snapshot, or null when there is no snapshot to compare with. */
export function snapshotHotels(snapshot: unknown): PartnerHotel[] | null {
  const tour = record(snapshot);
  if (!Array.isArray(tour.rows) || !Array.isArray(tour.hotels)) return null;
  return tour.hotels.map(record).map((hotel) => ({
    id: text(hotel.id) || null,
    name: text(hotel.name),
    description: text(hotel.description),
    stars: null,
    url: text(hotel.url),
  })).filter((hotel) => hotel.name);
}
