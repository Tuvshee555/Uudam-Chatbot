/**
 * "Change this photo to that one" / "remove the 3rd photo" / "day 2's photo" as an EXACT edit
 * of every place the photo lives (operations.md §3):
 * - the gallery `photo_urls` (the old photo is swapped in place, or removed — never merged);
 * - the program day's photo `extra.itinerary_days[].photo`;
 * - the poster, which is the gallery's real home: `hero_image` and `days[].photo`. A Poster-tab
 *   save rebuilds photo_urls from the poster, so the poster must hold the new photo and not the
 *   old one, or the next poster save brings the old photo back.
 * The new photo must already be on our Cloudinary (hostImage); a raw outside link is refused,
 * because every unguarded fetcher downstream would download it.
 *
 * Pure: the caller reads the trip and the poster and saves the result through patchTrip.
 */
import type { TravelTrip, TripMutationFields } from "./travelTypes";

/** The most photos one trip keeps (the editor, the bulk import, the write and the read caps agree). */
export const MAX_TRIP_PHOTOS = 50;

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const isPhoto = (value: unknown): value is string => typeof value === "string" && /^(https:\/\/|data:image\/)/.test(value);

/**
 * True for a photo on our own Cloudinary account (res.cloudinary.com/<CLOUDINARY_CLOUD_NAME>/
 * image/upload/…). Without a configured cloud name any Cloudinary upload URL counts.
 */
export function isHostedPhotoUrl(url: unknown, cloudName: string | null | undefined = process.env.CLOUDINARY_CLOUD_NAME): boolean {
  const value = typeof url === "string" ? url.trim() : "";
  const match = value.match(/^https:\/\/res\.cloudinary\.com\/([^/\s?#]+)\/image\/upload\/\S+$/i);
  if (!match) return false;
  const cloud = String(cloudName || "").trim().toLowerCase();
  return !cloud || match[1].toLowerCase() === cloud;
}

export type PhotoEditInput = { old_url?: string; position?: number; day?: number; new_url?: string; remove?: boolean };

export type PhotoEditPlan = {
  fields: TripMutationFields;
  /** The poster with the photo swapped, when the trip has a poster. */
  poster?: Row;
  posterKeys: string[];
  lines: string[];
  warnings: string[];
  thumbs: { before?: string; after?: string };
  old_url: string | null;
};

export type PlanOutcome<T> = { ok: true; plan: T } | { ok: false; reason: string };

/** A poster day that is a program day (has a route, summary or hotel), not a photo-only slot. */
export function isProgramPosterDay(day: Row): boolean {
  return Boolean(day.route || day.summary || day.hotel);
}

/** Index (in poster.days) of the n-th program day, the one chatbot day n was copied from. */
export function posterProgramDayIndex(days: Row[], dayNumber: number): number {
  let seen = 0;
  for (let index = 0; index < days.length; index++) {
    if (!isProgramPosterDay(days[index])) continue;
    seen += 1;
    if (seen === dayNumber) return index;
  }
  return -1;
}

function posterPhotoList(poster: Row): string[] {
  return [...new Set([poster.hero_image, ...records(poster.days).map((day) => day.photo)].filter(isPhoto))];
}

function selectorCount(input: PhotoEditInput): number {
  return [text(input.old_url) !== "", input.position !== undefined && input.position !== null, input.day !== undefined && input.day !== null].filter(Boolean).length;
}

/** Which photo the action means, with no guessing: exactly one of old_url, position, day. */
function targetPhoto(trip: TravelTrip, input: PhotoEditInput, poster: Row | null): { ok: true; old: string | null; day: number | null; where: string } | { ok: false; reason: string } {
  const photos = trip.photo_urls || [];
  const chatDays = records(trip.extra?.itinerary_days);
  if (selectorCount(input) !== 1) return { ok: false, reason: "Аль зургийг өөрчлөхийг нэг л байдлаар заана уу: зургийн холбоос, дугаар эсвэл өдөр." };
  if (input.position !== undefined && input.position !== null) {
    const position = Number(input.position);
    if (!Number.isInteger(position) || position < 1 || position > photos.length) {
      return { ok: false, reason: photos.length ? `Зургийн дугаар 1-${photos.length} хооронд байна.` : "Энэ аялалд зураг алга." };
    }
    return { ok: true, old: photos[position - 1], day: null, where: `${position}-р зураг` };
  }
  if (input.day !== undefined && input.day !== null) {
    const day = Number(input.day);
    const posterDays = poster ? records(poster.days) : [];
    const posterIndex = poster ? posterProgramDayIndex(posterDays, day) : -1;
    if (!Number.isInteger(day) || day < 1 || (day > chatDays.length && posterIndex < 0)) {
      return { ok: false, reason: chatDays.length ? `Хөтөлбөрт ${chatDays.length} өдөр байна; ${day}-р өдөр алга.` : "Энэ аялалд өдрийн хөтөлбөр алга." };
    }
    const old = text(chatDays[day - 1]?.photo) || (posterIndex >= 0 ? text(posterDays[posterIndex].photo) : "");
    return { ok: true, old: old || null, day, where: `${day}-р өдрийн зураг` };
  }
  const old = text(input.old_url);
  const known = new Set([...photos, ...chatDays.map((day) => text(day.photo)), ...(poster ? posterPhotoList(poster) : [])].filter(Boolean));
  if (!known.has(old)) return { ok: false, reason: "Энэ зураг аялалд алга." };
  const position = photos.indexOf(old);
  return { ok: true, old, day: null, where: position >= 0 ? `${position + 1}-р зураг` : "Зураг" };
}

export function planPhotoEdit(trip: TravelTrip, input: PhotoEditInput, posterData: unknown | null): PlanOutcome<PhotoEditPlan> {
  const poster = posterData && typeof posterData === "object" ? { ...record(posterData) } : null;
  const remove = input.remove === true;
  const newUrl = remove ? "" : text(input.new_url);
  if (!remove && !isHostedPhotoUrl(newUrl)) {
    return { ok: false, reason: "Шинэ зураг манай Cloudinary дээр байх ёстой — эхлээд зургийг байршуулна (host_image)." };
  }
  const target = targetPhoto(trip, input, poster);
  if (!target.ok) return target;
  const old = target.old;
  if (remove && !old) return { ok: false, reason: `${target.where} алга тул хасах зүйл байхгүй.` };
  if (!remove && old === newUrl) return { ok: false, reason: "Шинэ зураг одоогийнхтой яг ижил байна." };

  // The gallery: the old photo swapped in its place (or removed); a day photo the gallery did
  // not hold yet is added at the end. One photo is never listed twice.
  const photos = [...(trip.photo_urls || [])];
  const index = old ? photos.indexOf(old) : -1;
  if (index >= 0) {
    if (remove) photos.splice(index, 1);
    else photos[index] = newUrl;
  } else if (!remove) {
    photos.push(newUrl);
  }
  const nextPhotos = photos.filter((url, at) => photos.indexOf(url) === at);
  if (nextPhotos.length > MAX_TRIP_PHOTOS) return { ok: false, reason: `Нэг аялалд ${MAX_TRIP_PHOTOS}-аас олон зураг хадгалахгүй.` };

  // The program days that show the photo (or the one day named).
  const chatDays = records(trip.extra?.itinerary_days);
  let daysChanged = false;
  const nextDays = chatDays.map((day, at) => {
    const hit = target.day ? at === target.day - 1 : Boolean(old) && text(day.photo) === old;
    if (!hit) return day;
    daysChanged = true;
    const next = { ...day };
    if (remove) delete next.photo;
    else next.photo = newUrl;
    return next;
  });

  const extra: Row = {};
  if (daysChanged) extra.itinerary_days = nextDays;
  const credits = record(trip.extra?.photo_credits);
  if (old && credits[old]) {
    // The old photo's credit leaves with it. An empty credit map cannot be written through
    // patchTrip (normalizeExtraPatch drops it), so the last credit stays behind, keyed by a
    // photo no page shows any more.
    const kept = { ...credits };
    delete kept[old];
    if (Object.keys(kept).length) extra.photo_credits = kept;
  }
  const fields: TripMutationFields = { photo_urls: nextPhotos, ...(Object.keys(extra).length ? { extra } : {}) };

  let nextPoster: Row | undefined;
  const posterKeys: string[] = [];
  if (poster) {
    const days = records(poster.days).map((day) => ({ ...day }));
    const posterIndex = target.day ? posterProgramDayIndex(days, target.day) : -1;
    days.forEach((day, at) => {
      const hit = target.day ? at === posterIndex : Boolean(old) && day.photo === old;
      if (hit) day.photo = remove ? null : newUrl;
    });
    let hero = poster.hero_image;
    if (old && hero === old) hero = remove ? nextPhotos[0] || null : newUrl;
    // Every gallery photo must stay on the poster (a Poster-tab save rebuilds the gallery from
    // it); one the poster does not show yet becomes a photo-only slot after the program, as
    // tripToPoster's own photosOntoDays does.
    const shown = new Set(posterPhotoList({ hero_image: hero, days }));
    const lastDay = days.reduce((max, day, at) => Math.max(max, Number(day.day) || at + 1), 0);
    nextPhotos.filter((url) => !shown.has(url)).forEach((url, at) => days.push({ day: lastDay + at + 1, route: "", summary: "", photo: url }));
    if (JSON.stringify(days) !== JSON.stringify(poster.days ?? [])) posterKeys.push("days");
    if (hero !== poster.hero_image) posterKeys.push("hero_image");
    nextPoster = { ...poster, days, hero_image: hero ?? null };
    if (!posterKeys.length) nextPoster = undefined;
  }

  const line = remove ? `${target.where} хасагдана` : old ? `${target.where} солигдоно` : `${target.where} нэмэгдэнэ`;
  return {
    ok: true,
    plan: {
      fields,
      ...(nextPoster ? { poster: nextPoster } : {}),
      posterKeys,
      lines: [line, `Зургийн тоо: ${(trip.photo_urls || []).length} → ${nextPhotos.length}`],
      warnings: remove && nextPhotos.length === 0 ? ["Аялалд нэг ч зураг үлдэхгүй."] : [],
      thumbs: { ...(old ? { before: old } : {}), ...(newUrl ? { after: newUrl } : {}) },
      old_url: old,
    },
  };
}
