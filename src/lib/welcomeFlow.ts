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
import { resolveTripFromUserMessage } from "./travelFastPaths";

const MAX_WELCOME_PHOTOS = 5;
const MAX_TRIP_PHOTOS = 2;

export function hasTripPhotoIntent(text: string): boolean {
  const normalized = text.normalize("NFKC").toLowerCase();
  return /зураг|зургийг|зургаа|photo|photos|image|images|picture|zurag/.test(normalized);
}

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

// ─── Admin-controlled inactivity goodbye toggle (bot_settings.extra.goodbye) ──

export function resolveGoodbyeEnabled(extra: unknown): boolean {
  const raw =
    extra && typeof extra === "object" && !Array.isArray(extra)
      ? ((extra as Record<string, unknown>).goodbye as Record<string, unknown> | undefined)
      : undefined;
  if (!raw || typeof raw !== "object") return true;
  return raw.enabled !== false;
}

/**
 * Consultant contact message (inactivity goodbye + post-handoff). The default
 * carries the current phone numbers, but bot_settings.extra.goodbye.text lets
 * the admin change a number from the JSON editor without a code deploy —
 * these numbers used to be hardcoded in webhook.ts.
 */
export const DEFAULT_GOODBYE_CONTACT_TEXT =
  "Манай зөвлөхтэй холбогдох бол дараах дугааруудаар залгаарай 📞\n\n" +
  "☎️ 7713-6633\n" +
  "📱 8913-6633\n" +
  "📱 9117-2769\n\n" +
  "Эсвэл та утасны дугаараа үлдээвэл манай зөвлөх удахгүй тантай холбогдох болно 🙌";

export function resolveGoodbyeContactText(extra: unknown): string {
  const raw =
    extra && typeof extra === "object" && !Array.isArray(extra)
      ? ((extra as Record<string, unknown>).goodbye as Record<string, unknown> | undefined)
      : undefined;
  const text = raw && typeof raw.text === "string" ? raw.text.trim() : "";
  return text || DEFAULT_GOODBYE_CONTACT_TEXT;
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
export async function isFirstMessage(senderId: string): Promise<boolean> {
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
  const norm = text.trim().toLowerCase().replace(/[!?.🙏👋😊]/g, "").trim();
  if (!norm || norm.length <= 2) return true;
  // Exact match only — "сайн уу бид явна шүү" is NOT generic even though it starts with "сайн уу"
  return GENERIC_OPENERS.some((w) => norm === w);
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

const MEDIA_MATCH_STOP_WORDS = new Set([
  "trip",
  "tour",
  "travel",
  "price",
  "program",
  "photo",
  "photos",
  "pdf",
  "image",
  "images",
  "\u0430\u044f\u043b\u0430\u043b",
  "\u0430\u044f\u043b\u043b\u044b\u043d",
  "\u0430\u044f\u043b\u043b\u0443\u0443\u0434",
  "\u04af\u043d\u044d",
  "\u0445\u04e9\u0442\u04e9\u043b\u0431\u04e9\u0440",
  "\u0437\u0443\u0440\u0430\u0433",
  "\u0437\u0443\u0440\u0433\u0443\u0443\u0434",
  "\u0434\u044d\u043b\u0433\u044d\u0440\u044d\u043d\u0433\u04af\u0439",
  "\u0448\u0443\u0443\u0434",
  "\u043d\u0438\u0441\u043b\u044d\u0433\u0442\u044d\u0439",
]);

type TripMediaMatch = {
  trip: TravelTrip;
  score: number;
  replyScore: number;
  userScore: number;
  phraseHits: number;
  tokenHits: number;
};

function mediaNormText(text: string) {
  return text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ");
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function tripAliases(trip: TravelTrip): string[] {
  const extraAliases = Array.isArray((trip.extra as Record<string, unknown>)?.aliases)
    ? ((trip.extra as Record<string, unknown>).aliases as unknown[])
    : [];
  const topLevelAliases = Array.isArray((trip as unknown as { aliases?: unknown }).aliases)
    ? ((trip as unknown as { aliases?: unknown[] }).aliases as unknown[])
    : [];

  return uniqueStrings([...extraAliases, ...topLevelAliases].filter((value): value is string => (
    typeof value === "string" && value.trim().length > 0
  )));
}

function tripNames(trip: TravelTrip): string[] {
  return uniqueStrings([trip.route_name, ...tripAliases(trip)].filter(Boolean));
}

function mediaKeywordTokens(text: string): string[] {
  return uniqueStrings(
    mediaNormText(text)
      .split(/\s+/)
      .map((word) => word.trim())
      .filter((word) => word.length >= 3 && !MEDIA_MATCH_STOP_WORDS.has(word)),
  );
}

function scoreTripAgainstText(text: string, trip: TravelTrip) {
  const normalizedText = mediaNormText(text);
  const textTokens = new Set(mediaKeywordTokens(text));
  let score = 0;
  let phraseHits = 0;
  const matchedTokens = new Set<string>();

  for (const name of tripNames(trip)) {
    const normalizedName = mediaNormText(name).trim();
    if (normalizedName.length >= 3 && normalizedText.includes(normalizedName)) {
      phraseHits++;
      score += name === trip.route_name ? 12 : 10;
    }

    for (const token of mediaKeywordTokens(name)) {
      if (textTokens.has(token)) {
        matchedTokens.add(token);
      }
    }
  }

  score += matchedTokens.size * 3;
  if (phraseHits > 0) score += Math.min(matchedTokens.size, 3);

  return {
    score,
    phraseHits,
    tokenHits: matchedTokens.size,
  };
}

function hasStrongEvidence(evidence: { phraseHits: number; tokenHits: number }) {
  return evidence.phraseHits > 0 || evidence.tokenHits >= 2;
}

function selectVerifiedTripForMedia(input: {
  replyText: string;
  userText?: string;
  trips: TravelTrip[];
}): TripMediaMatch | null {
  const matches = input.trips
    .map((trip) => {
      const reply = scoreTripAgainstText(input.replyText, trip);
      const user = input.userText ? scoreTripAgainstText(input.userText, trip) : null;
      const score = reply.score * (input.userText ? 2 : 1) + (user?.score || 0);
      return {
        trip,
        score,
        replyScore: reply.score,
        userScore: user?.score || 0,
        phraseHits: reply.phraseHits + (user?.phraseHits || 0),
        tokenHits: reply.tokenHits + (user?.tokenHits || 0),
        replyEvidence: reply,
        userEvidence: user,
      };
    })
    .filter((match) => {
      if (input.userText) {
        return hasStrongEvidence(match.replyEvidence) && hasStrongEvidence(match.userEvidence || { phraseHits: 0, tokenHits: 0 });
      }
      return hasStrongEvidence(match.replyEvidence);
    })
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) return null;

  const best = matches[0];
  const second = matches[1];
  const minimumScore = input.userText ? 18 : 8;
  if (best.score < minimumScore) return null;
  if (second && best.score - second.score < 6) return null;

  return best;
}

export function extractTripPhotosForReply(
  replyText: string,
  trips: TravelTrip[],
  options: { userText?: string } = {},
): string[] {
  const active = trips.filter(
    (t) => t.status === "active" && t.photo_urls.length > 0,
  );
  const verifiedMatch = selectVerifiedTripForMedia({
    replyText,
    userText: options.userText,
    trips: active,
  });
  return verifiedMatch ? verifiedMatch.trip.photo_urls.slice(0, MAX_TRIP_PHOTOS) : [];
}

export function extractTripPhotosForUserMessage(
  userText: string,
  trips: TravelTrip[],
): string[] {
  const active = trips.filter(
    (t) => t.status === "active" && t.photo_urls.length > 0,
  );
  const resolution = resolveTripFromUserMessage(userText, active, {
    allowLooseFallback: false,
  });
  if (resolution.status === "verified") {
    return resolution.trip.photo_urls.slice(0, MAX_TRIP_PHOTOS);
  }
  return extractTripPhotosForReply(userText, active);
}

export function extractTripBrochureAttachmentId(
  replyText: string,
  trips: TravelTrip[],
  options: { userText?: string } = {},
): { type: "id"; value: string } | { type: "url"; value: string } | null {
  const active = trips.filter((t) => t.status === "active");
  const verifiedMatch = selectVerifiedTripForMedia({
    replyText,
    userText: options.userText,
    trips: active,
  });
  if (!verifiedMatch) return null;
  const verifiedExtra = verifiedMatch.trip.extra as Record<string, unknown> | undefined;

  const verifiedId = verifiedExtra?.source_file_attachment_id;
  if (typeof verifiedId === "string" && verifiedId.length > 0) return { type: "id", value: verifiedId };

  const verifiedUrl = verifiedExtra?.brochure_pdf_url;
  if (typeof verifiedUrl === "string" && verifiedUrl.startsWith("https://")) return { type: "url", value: verifiedUrl };

  return null;
}

export { MAX_WELCOME_PHOTOS, MAX_TRIP_PHOTOS };
