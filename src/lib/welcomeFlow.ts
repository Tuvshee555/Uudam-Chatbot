/**
 * Welcome flow + trip photo auto-send helpers.
 *
 * Feature A — Welcome greeting:
 *   First time a sender messages → ONLY if the message is generic (hi, hello, ?)
 *   send greeting text + 3 quick-reply buttons + optional photo album.
 *   If the first message already asks about a specific trip → skip greeting entirely.
 *
 * Feature B — Trip photo auto-send:
 *   After each AI reply, detect if a specific trip was discussed and send
 *   up to MAX_TRIP_PHOTOS of that trip's photos.
 */

import { dbClaimGreeting, dbClaimSeasonSend } from "./travelDb";
import type { TravelTrip } from "./travelOps";

const MAX_WELCOME_PHOTOS = 5;
const MAX_TRIP_PHOTOS = 3;

// ─── Admin-controlled greeting config (stored in bot_settings.extra.greeting) ──

export type GreetingConfig = {
  enabled: boolean;
  text: string;
  photoUrls: string[];
  usePhotoUrls: boolean;
  defaultPhotoUrls: string[];
};

export function resolveGreetingConfig(extra: unknown): GreetingConfig {
  const raw =
    extra && typeof extra === "object" && !Array.isArray(extra)
      ? ((extra as Record<string, unknown>).greeting as Record<string, unknown> | undefined)
      : undefined;

  if (!raw || typeof raw !== "object") {
    return { enabled: true, text: "", photoUrls: [], usePhotoUrls: false, defaultPhotoUrls: [] };
  }

  const photoUrls = Array.isArray(raw.photoUrls)
    ? (raw.photoUrls as unknown[])
        .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
        .slice(0, 10)
    : [];

  const defaultPhotoUrls = Array.isArray(raw.defaultPhotoUrls)
    ? (raw.defaultPhotoUrls as unknown[])
        .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
        .slice(0, 10)
    : [];

  return {
    enabled: raw.enabled !== false,
    text: typeof raw.text === "string" ? raw.text : "",
    photoUrls,
    usePhotoUrls: raw.usePhotoUrls === true,
    defaultPhotoUrls,
  };
}

// ─── Seasons ─────────────────────────────────────────────────────────────────

export type Season = {
  id: string;
  name: string;
  keywords: string[];
  photoUrls: string[];
  active: boolean;
};

function sanitizeUrls(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[])
        .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
        .slice(0, 10)
    : [];
}

export function resolveSeasons(extra: unknown): Season[] {
  const raw =
    extra && typeof extra === "object" && !Array.isArray(extra)
      ? (extra as Record<string, unknown>).seasons
      : undefined;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : Math.random().toString(36).slice(2),
      name: typeof s.name === "string" ? s.name : "",
      keywords: Array.isArray(s.keywords)
        ? (s.keywords as unknown[]).filter((k): k is string => typeof k === "string")
        : [],
      photoUrls: sanitizeUrls(s.photoUrls),
      active: s.active === true,
    }));
}

export function getActiveSeason(seasons: Season[]): Season | null {
  return seasons.find((s) => s.active) || null;
}

export function matchSeasonByText(text: string, seasons: Season[]): Season | null {
  const norm = text.toLowerCase();
  const active = getActiveSeason(seasons);
  const ordered = active ? [active, ...seasons.filter((s) => s !== active)] : seasons;
  for (const season of ordered) {
    if (
      season.photoUrls.length > 0 &&
      season.keywords.some((k) => {
        const kk = k.trim().toLowerCase();
        return kk.length > 0 && norm.includes(kk);
      })
    ) {
      return season;
    }
  }
  return null;
}

// ─── First-seen detection (Neon-backed, no Redis) ────────────────────────────

/**
 * Returns true the FIRST time this sender's greeting should fire.
 * Atomically claims the greeting slot in travel_senders so no double-send.
 */
export async function isFirstMessage(
  senderId: string,
  _platform: string,
): Promise<boolean> {
  return dbClaimGreeting(senderId);
}

// ─── Generic message detection ───────────────────────────────────────────────

// Short generic openers that should trigger the greeting + buttons.
// Anything more specific (trip names, destinations, questions) skips the greeting.
const GENERIC_OPENERS = [
  "сайн уу", "сайнуу", "сайн", "hi", "hello", "hey", "сайн байна уу",
  "байна уу", "мэнд", "нүүр", "нүүрх", "хэллоу", "хай", "мэндчилье",
  "ассалам", "привет", "өдрийн мэнд", "оюу", "ok", "ок", "ок",
  "👋", "😊", "🙏", "хэрхэн", "юу байна", "та нар",
];

/**
 * Returns true if the message is a generic opener that should trigger the
 * full greeting flow. Returns false if the person already asked something
 * specific — in that case, skip the greeting and just answer.
 */
export function isGenericOpener(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[!?.]/g, "").trim();
  if (!norm || norm.length <= 2) return true; // "?", ".", empty
  return GENERIC_OPENERS.some((w) => norm === w || norm.startsWith(w + " ") || norm.endsWith(" " + w));
}

// ─── Quick-reply button labels ────────────────────────────────────────────────

// These are sent as Messenger quick-reply buttons after the greeting text.
// When tapped, the customer's message arrives as the exact button label text.
export const GREETING_BUTTONS = {
  ALL_TRIPS: "Аяллууд харах",
  SEASONAL: "Наадмын аяллууд",
  SEE_ALL: "Бүгдийг харах",
} as const;

export type GreetingButtonValue = typeof GREETING_BUTTONS[keyof typeof GREETING_BUTTONS];

/** Returns true if the incoming text is one of the greeting quick-reply buttons. */
export function isGreetingButton(text: string): text is GreetingButtonValue {
  const t = text.trim();
  return Object.values(GREETING_BUTTONS).includes(t as GreetingButtonValue);
}

// ─── Season dedupe (Neon-backed) ─────────────────────────────────────────────

/**
 * Returns true if this season album should be sent to this sender now
 * (hasn't been sent yet in their session). Atomically marks it as sent.
 */
export async function claimSeasonSend(senderId: string, seasonId: string): Promise<boolean> {
  return dbClaimSeasonSend(senderId, seasonId);
}

// ─── Welcome photo sampling ───────────────────────────────────────────────────

export function sampleWelcomePhotos(trips: TravelTrip[]): string[] {
  const active = trips.filter(
    (t) => t.status === "active" && t.photo_urls.length > 0,
  );
  const candidates = active.map((t) => t.photo_urls[0]);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, MAX_WELCOME_PHOTOS);
}

// ─── Trip photo detection after AI reply ─────────────────────────────────────

function normText(t: string) {
  return t.toLowerCase().replace(/[^\wа-яөүё\s]/gi, " ");
}

export function extractTripPhotosForReply(
  replyText: string,
  trips: TravelTrip[],
): string[] {
  const norm = normText(replyText);
  const active = trips.filter(
    (t) => t.status === "active" && t.photo_urls.length > 0,
  );

  // Score all trips — collect any that match at least 2 words
  const scored: { trip: TravelTrip; score: number }[] = [];
  for (const trip of active) {
    const words = normText(trip.route_name)
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    const score = words.filter((w) => norm.includes(w)).length;
    if (score > 0) scored.push({ trip, score });
  }

  if (scored.length === 0) return [];

  // Single strong match (score ≥ 2) → send up to MAX_TRIP_PHOTOS from that trip
  const best = scored.sort((a, b) => b.score - a.score)[0];
  if (best.score >= 2 || scored.length === 1) {
    return best.trip.photo_urls.slice(0, MAX_TRIP_PHOTOS);
  }

  // Multiple weak matches (list reply) → one photo per matched trip, up to 5
  return scored
    .slice(0, 5)
    .map(({ trip }) => trip.photo_urls[0])
    .filter(Boolean);
}

export function extractTripBrochureAttachmentId(
  replyText: string,
  trips: TravelTrip[],
): { type: "id"; value: string } | { type: "url"; value: string } | null {
  const norm = normText(replyText);
  const active = trips.filter((t) => t.status === "active");

  let bestScore = 0;
  let bestTrip: TravelTrip | null = null;

  for (const trip of active) {
    const words = normText(trip.route_name)
      .split(/\s+/)
      .filter((w) => w.length >= 3);
    const score = words.filter((w) => norm.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestTrip = trip;
    }
  }

  if (!bestTrip || bestScore === 0) return null;
  const extra = bestTrip.extra as Record<string, unknown> | undefined;

  const id = extra?.source_file_attachment_id;
  if (typeof id === "string" && id.length > 0) return { type: "id", value: id };

  const url = extra?.brochure_pdf_url;
  if (typeof url === "string" && url.startsWith("https://")) return { type: "url", value: url };

  return null;
}

export { MAX_WELCOME_PHOTOS, MAX_TRIP_PHOTOS };
