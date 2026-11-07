/**
 * Input validation for the tester pairing and photo-picker routes of the catalogue admin API.
 * Same rules as validation.ts: strict keys, bounded values, Mongolian messages.
 */

import { isPlainObject, isValidTesterId, isValidTripId, readBody, type Parsed } from "./validation";

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

function unknownKeys(body: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(body).filter((key) => !allowed.includes(key));
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

// ── Tester pairing ───────────────────────────────────────────────────────────────────────────────

export const TESTER_LABEL_MAX_LENGTH = 40;

/** POST /testers body: { label? } — a short name for the device ("Миний утас"); never an id. */
export function parsePairingBody(raw: unknown): Parsed<{ label: string }> {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: { label: "" } };
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["label"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  if (body.label === undefined || body.label === null) return { ok: true, value: { label: "" } };
  if (typeof body.label !== "string") return fail('"label" текст байх ёстой.');
  const label = body.label.replace(/[\u0000-\u001f\u007f<>]+/g, " ").replace(/\s+/g, " ").trim();
  if (label.length > TESTER_LABEL_MAX_LENGTH) return fail(`Нэр ${TESTER_LABEL_MAX_LENGTH} тэмдэгтээс урт байж болохгүй.`);
  return { ok: true, value: { label } };
}

export function parseRevokeBody(raw: unknown): Parsed<{ testerId: string }> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["testerId"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  if (!isValidTesterId(body.testerId)) return fail("Туршигчийн дугаар буруу байна.");
  return { ok: true, value: { testerId: body.testerId } };
}

// ── Hero photo and display title ─────────────────────────────────────────────────────────────────

export const TITLE_OVERRIDE_MAX_LENGTH = 80;
export const HERO_URL_MAX_LENGTH = 2000;
export const HERO_ZOOM_MIN = 1;
export const HERO_ZOOM_MAX = 3;

export type PhotoUpdate = {
  tripId: string;
  /** undefined = leave the hero alone, null = clear the staff choice, object = choose this photo. */
  hero: { url: string; focal: { x: number; y: number } | null; zoom: number | null } | null | undefined;
  /** undefined = leave alone, null = clear, string = display title (<= 80 characters). */
  titleOverride: string | null | undefined;
  expectedUpdatedAt: string | null | undefined;
};

/**
 * PUT /photos body: { tripId, hero?, titleOverride?, expectedUpdatedAt? }.
 * hero = { url, focal?: {x,y} (0..1), zoom?: number (1..3) } or null to clear. Whether the url really is one of
 * the trip's photos is checked by the route against the live candidates. Nothing here can touch a price, a date
 * or the trip's own title: only the picture and the printed display title.
 */
export function parsePhotoUpdate(raw: unknown): Parsed<PhotoUpdate> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["tripId", "hero", "titleOverride", "expectedUpdatedAt"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  if (!isValidTripId(body.tripId)) return fail("Аяллын код буруу байна.");
  if (body.hero === undefined && body.titleOverride === undefined) return fail("Зураг эсвэл гарчгийн өөрчлөлт алга.");

  let hero: PhotoUpdate["hero"];
  if (body.hero === undefined) hero = undefined;
  else if (body.hero === null) hero = null;
  else {
    if (!isPlainObject(body.hero)) return fail('"hero" объект эсвэл null байх ёстой.');
    const heroExtra = unknownKeys(body.hero, ["url", "focal", "zoom"]);
    if (heroExtra.length) return fail(`Үл мэдэгдэх талбар: ${heroExtra.join(", ")}.`);
    const url = body.hero.url;
    if (typeof url !== "string" || url.length > HERO_URL_MAX_LENGTH || !/^https:\/\/[^\s<>"']+$/i.test(url)) {
      return fail("Зургийн хаяг буруу байна (https холбоос байх ёстой).");
    }
    let focal: { x: number; y: number } | null = null;
    if (body.hero.focal !== undefined && body.hero.focal !== null) {
      const f = body.hero.focal;
      if (!isPlainObject(f) || unknownKeys(f, ["x", "y"]).length) return fail('"focal" нь {x, y} байх ёстой.');
      const { x, y } = f;
      if (typeof x !== "number" || typeof y !== "number" || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        return fail("Төвлөрөх цэгийн x, y нь 0-ээс 1 хүртэл байх ёстой.");
      }
      focal = { x: round(x, 3), y: round(y, 3) };
    }
    let zoom: number | null = null;
    if (body.hero.zoom !== undefined && body.hero.zoom !== null) {
      const z = body.hero.zoom;
      if (typeof z !== "number" || !Number.isFinite(z) || z < HERO_ZOOM_MIN || z > HERO_ZOOM_MAX) {
        return fail(`Томруулалт ${HERO_ZOOM_MIN}-ээс ${HERO_ZOOM_MAX} хүртэл байх ёстой.`);
      }
      zoom = round(z, 2);
    }
    hero = { url, focal, zoom };
  }

  let titleOverride: PhotoUpdate["titleOverride"];
  if (body.titleOverride === undefined) titleOverride = undefined;
  else if (body.titleOverride === null) titleOverride = null;
  else {
    if (typeof body.titleOverride !== "string") return fail('"titleOverride" текст байх ёстой.');
    const cleaned = body.titleOverride.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (cleaned.length > TITLE_OVERRIDE_MAX_LENGTH) return fail(`Гарчиг ${TITLE_OVERRIDE_MAX_LENGTH} тэмдэгтээс урт байж болохгүй.`);
    titleOverride = cleaned === "" ? null : cleaned;
  }

  let expectedUpdatedAt: string | null | undefined;
  if (body.expectedUpdatedAt !== undefined) {
    if (body.expectedUpdatedAt === null) expectedUpdatedAt = null;
    else if (typeof body.expectedUpdatedAt === "string" && !Number.isNaN(Date.parse(body.expectedUpdatedAt)) && body.expectedUpdatedAt.length <= 40) {
      expectedUpdatedAt = body.expectedUpdatedAt;
    } else return fail('"expectedUpdatedAt" огноо байх ёстой.');
  }
  return { ok: true, value: { tripId: body.tripId, hero, titleOverride, expectedUpdatedAt } };
}

// ── Cover photo ──────────────────────────────────────────────────────────────────────────────────

export type CoverUpdate = {
  /** null = back to the automatic cover photo. */
  coverPhoto: { url: string; tripId: string; focal: { x: number; y: number } | null; zoom: number | null } | null;
  expectedUpdatedAt: string | null | undefined;
};

/** True when a config PUT body is a cover update ({ coverPhoto, ... }) instead of an edition curation. */
export function isCoverUpdateBody(raw: unknown): boolean {
  return isPlainObject(raw) && "coverPhoto" in raw;
}

/**
 * PUT /config body for the cover: { coverPhoto: { url, tripId, focal?, zoom? } | null, expectedUpdatedAt? }.
 * `tripId` names the trip whose own photos contain the url; the route checks that against the live candidates, so a
 * cover can only ever be a photo that already belongs to a trip.
 */
export function parseCoverUpdate(raw: unknown): Parsed<CoverUpdate> {
  const body = readBody(raw);
  if (!body) return fail("Хүсэлтийн бүтэц буруу байна.");
  const extra = unknownKeys(body, ["coverPhoto", "expectedUpdatedAt"]);
  if (extra.length) return fail(`Үл мэдэгдэх талбар: ${extra.join(", ")}.`);
  let expectedUpdatedAt: string | null | undefined;
  if (body.expectedUpdatedAt !== undefined) {
    if (body.expectedUpdatedAt === null) expectedUpdatedAt = null;
    else if (typeof body.expectedUpdatedAt === "string" && !Number.isNaN(Date.parse(body.expectedUpdatedAt)) && body.expectedUpdatedAt.length <= 40) {
      expectedUpdatedAt = body.expectedUpdatedAt;
    } else return fail('"expectedUpdatedAt" огноо байх ёстой.');
  }
  if (body.coverPhoto === null) return { ok: true, value: { coverPhoto: null, expectedUpdatedAt } };
  if (!isPlainObject(body.coverPhoto)) return fail('"coverPhoto" объект эсвэл null байх ёстой.');
  const photo = body.coverPhoto;
  const photoExtra = unknownKeys(photo, ["url", "tripId", "focal", "zoom"]);
  if (photoExtra.length) return fail(`Үл мэдэгдэх талбар: ${photoExtra.join(", ")}.`);
  // Reuse the hero parser for url / focal / zoom so both pickers obey the same bounds.
  const hero = parsePhotoUpdate({ tripId: photo.tripId, hero: { url: photo.url, focal: photo.focal, zoom: photo.zoom } });
  if (!hero.ok) return hero;
  if (!hero.value.hero) return fail("Зургийн хаяг буруу байна.");
  return { ok: true, value: { coverPhoto: { url: hero.value.hero.url, tripId: hero.value.tripId, focal: hero.value.hero.focal, zoom: hero.value.hero.zoom }, expectedUpdatedAt } };
}
