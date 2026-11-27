/**
 * "Эдгээр зургийг буудлын зураг болгож нэм": photos added to ONE hotel of a trip (its hotel profile,
 * `extra.hotel_profiles[].media`), everything already there kept.
 *
 * Why (2026-11-25): the assistant had a verb for a trip's gallery and for a program day's photo, none for a
 * hotel. Ten hotel pictures sent with a trip link came back as "which trip?" and nothing could be saved.
 * The website shows these photos on the hotel's card (uudam-booking-web hotel cards read `hotelMedia`).
 *
 * The hotel is matched by name against the trip's own hotels (its profiles, its hotel line, its days' hotels),
 * never invented; a hotel the trip names but has no profile for gets one. A photo already on the hotel is
 * not added twice. The new photos must be on our Cloudinary (hostImage), like every photo the assistant stores.
 *
 * Pure: the caller reads the trip and saves `plan.fields` through patchTrip.
 */
import type { TravelTrip, TripMutationFields } from "./travelTypes";
import { hotelNamesOf, squashHotelName } from "./tripHotelNames";
import { isHostedPhotoUrl } from "./tripPhotoEdit";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The most photos one hotel keeps. */
export const MAX_HOTEL_PHOTOS = 24;

export type HotelPhotosInput = { hotel?: unknown; new_urls?: unknown };
export type HotelPhotosPlan = { fields: TripMutationFields; posterKeys: string[]; lines: string[]; warnings: string[]; hotel: string; added: string[] };
export type HotelPhotosOutcome = { ok: true; plan: HotelPhotosPlan } | { ok: false; reason: string };

type Media = { url: string; caption: string };
type Profile = { name: string; url: string; description: string; media: Media[]; [key: string]: unknown };

const profilesOf = (trip: TravelTrip): Profile[] => (Array.isArray(trip.extra?.hotel_profiles) ? trip.extra.hotel_profiles : []).map((entry) => {
  const row = record(entry);
  return { ...row, name: text(row.name), url: text(row.url), description: text(row.description),
    media: (Array.isArray(row.media) ? row.media : []).map(record).filter((item) => text(item.url)).map((item) => ({ ...item, url: text(item.url), caption: text(item.caption) })) };
});

/**
 * Every hotel the trip names. The hotel of each program day and price row comes first (one hotel per entry, its city
 * written before a slash or colon is dropped); a trip without them falls back to its hotel profiles and hotel line.
 */
export function tripHotelChoices(trip: TravelTrip): string[] {
  const noCity = (value: string) => value.replace(/^[^/:;]+[/:]\s*/u, "");
  const days = (Array.isArray(trip.extra?.itinerary_days) ? trip.extra.itinerary_days : []).map((day) => ({ hotel: noCity(text(record(day).hotel)) }));
  const rows = (Array.isArray(trip.extra?.price_groups) ? trip.extra.price_groups : []).map((row) => ({ hotel: text(record(row).hotel) }));
  const clean = hotelNamesOf([...days, ...rows], "").filter((name) => !isCombined(name));
  if (clean.length) return clean;
  const line = text(trip.hotel).split(";").map(noCity).join(" + ");
  return hotelNamesOf([...profilesOf(trip).filter((profile) => !isCombined(profile.name)).map((profile) => ({ hotel: profile.name }))], line);
}

/** A profile that names several hotels at once ("Бангкок: A; Паттайя: B"): never the home of one hotel's photos. */
const isCombined = (name: string) => /[;]/u.test(name) || /^[^:]+:/u.test(name);

/** The words of a hotel name that tell it from another ("Bay Beach Resort Jomtien" and "Bay Beach Resort hotel" share "bay", "beach"). */
const FILLER = new Set(["hotel", "resort", "spa", "the", "and", "inn", "зочид", "буудал", "хотел"]);
const wordsOf = (value: string) => value.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 2 && !FILLER.has(word));

function sameHotel(wanted: string, name: string): boolean {
  const a = squashHotelName(wanted);
  const b = squashHotelName(name);
  if (!a || !b) return false;
  if (a === b || b.includes(a) || a.includes(b)) return true;
  const own = wordsOf(wanted);
  const other = new Set(wordsOf(name));
  return own.length >= 2 && own.filter((word) => other.has(word)).length >= Math.min(2, own.length);
}

/** The trip's hotel an admin's name points to, or null when none (or several different ones) do. */
export function hotelOfTrip(trip: TravelTrip, wanted: string): string | null {
  const hits = tripHotelChoices(trip).filter((name) => sameHotel(wanted, name));
  return hits.length === 1 ? hits[0] : null;
}

export function planHotelPhotos(trip: TravelTrip, input: HotelPhotosInput): HotelPhotosOutcome {
  const wanted = text(input.hotel);
  const urls = [...new Set((Array.isArray(input.new_urls) ? input.new_urls : []).map(text).filter(Boolean))];
  if (!wanted) return { ok: false, reason: "Аль буудлын зураг болохыг заагаагүй байна." };
  if (!urls.length) return { ok: false, reason: "Нэмэх зураг алга." };
  const unhosted = urls.filter((url) => !isHostedPhotoUrl(url));
  if (unhosted.length) return { ok: false, reason: "Зураг манай сервер дээр байршаагүй байна (эхлээд host_image)." };
  const name = hotelOfTrip(trip, wanted);
  if (!name) {
    const choices = tripHotelChoices(trip);
    return { ok: false, reason: choices.length ? `«${wanted}» буудал энэ аялалд алга. Аяллын буудлууд: ${choices.join("; ")}.` : `Энэ аялалд буудал бичигдээгүй тул «${wanted}»-д зураг нэмэхгүй.` };
  }
  const profiles = profilesOf(trip);
  const index = profiles.findIndex((profile) => !isCombined(profile.name) && sameHotel(name, profile.name));
  const current = index >= 0 ? profiles[index] : { name, url: "", description: "", media: [] as Media[] };
  const have = new Set(current.media.map((item) => item.url));
  const added = urls.filter((url) => !have.has(url));
  if (!added.length) return { ok: false, reason: `«${name}» буудалд эдгээр зураг аль хэдийн байна.` };
  const media = [...current.media, ...added.map((url) => ({ url, caption: "" }))].slice(0, MAX_HOTEL_PHOTOS);
  const next = { ...current, media };
  const hotel_profiles = index >= 0 ? profiles.map((profile, at) => (at === index ? next : profile)) : [...profiles, next];
  const warnings = media.length < current.media.length + added.length ? [`Нэг буудал ${MAX_HOTEL_PHOTOS} хүртэл зурагтай байна; илүүг нэмсэнгүй.`] : [];
  return {
    ok: true,
    plan: {
      fields: { extra: { hotel_profiles } }, posterKeys: [], warnings, hotel: name, added,
      lines: [`${name}: ${added.length} зураг нэмнэ (нийт ${media.length})`],
    },
  };
}
