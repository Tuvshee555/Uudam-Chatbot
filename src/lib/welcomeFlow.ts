/**
 * Welcome flow + trip photo auto-send helpers.
 *
 * Feature A — Welcome greeting:
 *   First time a sender messages → send a greeting text, then send up to
 *   MAX_WELCOME_PHOTOS images sampled from trips that have photo_urls.
 *
 * Feature B — Trip photo auto-send:
 *   After each AI reply, detect if a specific trip was discussed and send
 *   up to MAX_TRIP_PHOTOS of that trip's photos.
 */

import { withRedis } from "./redisState";
import type { TravelTrip } from "./travelOps";

const MAX_WELCOME_PHOTOS = 5;
const MAX_TRIP_PHOTOS = 3;
const SEEN_SENDER_TTL_SEC = 14 * 24 * 60 * 60; // 14 days — re-greet returning customers after 2 weeks

// ─── Admin-controlled greeting config (stored in bot_settings.extra.greeting) ──

export type GreetingConfig = {
  enabled: boolean; // master on/off for the first-message welcome
  text: string; // owner's welcome message (overrides quick_info_reply)
  photoUrls: string[]; // hand-picked welcome photos
  usePhotoUrls: boolean; // true = send photoUrls; false = auto-sample from trips
  defaultPhotoUrls: string[]; // fixed default album sent first on every greeting
};

/**
 * Reads the greeting config out of bot_settings.extra. Tolerates missing/partial
 * data. Default = enabled, auto-sample photos (the historical behavior), no
 * custom text — so existing deployments behave exactly as before until the
 * owner customizes it in the admin.
 */
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
    enabled: raw.enabled !== false, // default ON
    text: typeof raw.text === "string" ? raw.text : "",
    photoUrls,
    usePhotoUrls: raw.usePhotoUrls === true,
    defaultPhotoUrls,
  };
}

// ─── Seasons (stored in bot_settings.extra.seasons) ──────────────────────────

export type Season = {
  id: string;
  name: string; // e.g. "Наадам", "Өвлийн аялал"
  keywords: string[]; // trigger words customers might type
  photoUrls: string[]; // this season's album
  active: boolean; // exactly one season should be active at a time
};

function sanitizeUrls(value: unknown): string[] {
  return Array.isArray(value)
    ? (value as unknown[])
        .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
        .slice(0, 10)
    : [];
}

/** Reads the seasons array from bot_settings.extra. Tolerant of partial data. */
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

/** The single active season (first one flagged active), or null. */
export function getActiveSeason(seasons: Season[]): Season | null {
  return seasons.find((s) => s.active) || null;
}

/**
 * If the customer's message matches any season's keywords, return that season.
 * Checks the active season first, then others (so a customer asking about an
 * off-season trip still gets its photos). Returns null if no match.
 */
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

// ─── First-seen detection ────────────────────────────────────────────────────

function seenKey(senderId: string, platform: string) {
  return `welcome_seen:${platform}:${senderId}`;
}

/**
 * Returns true the first time this sender is seen, false on repeat visits.
 * Uses Redis SETNX so it's atomic — no double-welcomes even under concurrency.
 * Falls back to false (no welcome) if Redis unavailable — safe degradation.
 */
export async function isFirstMessage(
  senderId: string,
  platform: string,
): Promise<boolean> {
  const result = await withRedis("welcome.is_first_message", async (r) => {
    const key = seenKey(senderId, platform);
    const set = await r.set(key, "1", "EX", SEEN_SENDER_TTL_SEC, "NX");
    return set === "OK"; // "OK" = was newly set (first time)
  });
  return result === true;
}

// ─── Welcome photo sampling ──────────────────────────────────────────────────

/**
 * Returns up to MAX_WELCOME_PHOTOS image URLs sampled across active trips that
 * have photos. Prefers variety — one photo per trip, shuffled.
 */
export function sampleWelcomePhotos(trips: TravelTrip[]): string[] {
  const active = trips.filter(
    (t) => t.status === "active" && t.photo_urls.length > 0,
  );
  // Take the first photo of each trip (most representative), then shuffle
  const candidates = active.map((t) => t.photo_urls[0]);
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }
  return candidates.slice(0, MAX_WELCOME_PHOTOS);
}

// ─── Trip photo detection after AI reply ────────────────────────────────────

function normText(t: string) {
  return t.toLowerCase().replace(/[^\wа-яөүё\s]/gi, " ");
}

/**
 * Given the AI reply text and the trip list, find trips that the reply is
 * clearly talking about (route name appears in the reply). Returns up to
 * MAX_TRIP_PHOTOS photo URLs from the best-matched trip.
 *
 * Returns empty array if no match or matched trip has no photos.
 */
export function extractTripPhotosForReply(
  replyText: string,
  trips: TravelTrip[],
): string[] {
  const norm = normText(replyText);
  const active = trips.filter(
    (t) => t.status === "active" && t.photo_urls.length > 0,
  );

  // Score trips by how many route-name words appear in the reply
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

  if (!bestTrip || bestScore === 0) return [];
  return bestTrip.photo_urls.slice(0, MAX_TRIP_PHOTOS);
}

/**
 * Same trip-matching logic as extractTripPhotosForReply, but returns the
 * Facebook reusable attachment_id stored in extra.source_file_attachment_id.
 * Used to send the PDF brochure to the customer alongside the text reply.
 */
export function extractTripBrochureAttachmentId(
  replyText: string,
  trips: TravelTrip[],
): string | null {
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
  return typeof id === "string" && id.length > 0 ? id : null;
}

export { MAX_WELCOME_PHOTOS, MAX_TRIP_PHOTOS };
