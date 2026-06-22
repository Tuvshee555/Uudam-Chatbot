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
const SEEN_SENDER_TTL_SEC = 30 * 24 * 60 * 60; // 30 days

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

export { MAX_WELCOME_PHOTOS, MAX_TRIP_PHOTOS };
