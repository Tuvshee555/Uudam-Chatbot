import {
  sendImageCarousel,
  sendImageMessage,
  sendTextMessage,
  sendTypingOn,
} from "./messenger";
import { sendTextMessage as sendIgTextMessage } from "./instagram";
import { appendMessage } from "./conversation";
import { storeSenderName } from "./pause";
import { listTrips } from "./travelOps";
import { extractTripPhotosForReply, MAX_TRIP_PHOTOS } from "./welcomeFlow";
import type { TravelTrip } from "./travelTypes";
import { getEnv } from "./env";
import {
  classifyError,
  hashIdentifier,
  logError,
  logInfo,
  logWarn,
  recordCounter,
} from "./observability";
import type { Platform } from "./webhookDedup";

const FALLBACK_SEND_ERROR_MESSAGE = "Уучлаарай, мессеж илгээхэд алдаа гарлаа.";
const MAX_PHOTO_ONLY_PHOTOS = MAX_TRIP_PHOTOS;

export async function sendPlatformMessage(
  platform: Platform,
  senderId: string,
  text: string,
  token: string | undefined,
  pageId: string,
  igUserId?: string | null,
  trace?: { requestId: string; correlationId: string; source: string },
  options?: { allowFallback?: boolean },
) {
  const allowFallback = options?.allowFallback ?? true;
  if (!token) {
    logError("webhook.send.missing_token", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
    });
    return false;
  }
  try {
    if (platform === "facebook") {
      await sendTextMessage(senderId, text, token, trace);
    } else {
      await sendIgTextMessage(igUserId || "", senderId, text, token, trace);
    }
    recordCounter("webhook.send.success_total", 1, { platform });
    return true;
  } catch (error) {
    recordCounter("webhook.send.failed_total", 1, { platform });
    logError("webhook.send.primary_failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
      bodySnippet:
        error && typeof error === "object" && "bodySnippet" in error
          ? String((error as { bodySnippet?: unknown }).bodySnippet || "")
          : undefined,
    });
    if (!allowFallback || text === FALLBACK_SEND_ERROR_MESSAGE) {
      return false;
    }
    try {
      if (platform === "facebook") {
        await sendTextMessage(senderId, FALLBACK_SEND_ERROR_MESSAGE, token, trace);
      } else {
        await sendIgTextMessage(
          igUserId || "",
          senderId,
          FALLBACK_SEND_ERROR_MESSAGE,
          token,
          trace,
        );
      }
      recordCounter("webhook.send.fallback_success_total", 1, { platform });
    } catch (fallbackError) {
      logError("webhook.send.fallback_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        pageId,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(fallbackError),
        message:
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError),
        bodySnippet:
          fallbackError &&
          typeof fallbackError === "object" &&
          "bodySnippet" in fallbackError
            ? String(
                (fallbackError as { bodySnippet?: unknown }).bodySnippet || "",
              )
            : undefined,
      });
    }
    return false;
  }
}
function imageAttachment(url: string): { type: "image"; url: string } {
  return { type: "image", url };
}

export async function recordImageMessage(senderId: string, photoUrls: string[]) {
  if (photoUrls.length === 0) return;
  await appendMessage(
    senderId,
    "assistant",
    "",
    photoUrls.map(imageAttachment),
  ).catch(() => {});
}

export function getTripPhotoUrls(trip: TravelTrip | null | undefined): string[] {
  if (!trip || !Array.isArray(trip.photo_urls)) return [];
  return trip.photo_urls
    .filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
    .slice(0, MAX_PHOTO_ONLY_PHOTOS);
}

export function normalizePhotoOnlyText(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPhotoOnlyFollowup(text: string) {
  const normalized = normalizePhotoOnlyText(text);
  return [
    "again",
    "more",
    "photo",
    "photos",
    "zurag",
    "zurguud",
    "дахин",
    "дахиад",
    "дахиад зураг",
    "дахин зураг",
    "зураг",
    "зургууд",
    "өөр зураг",
    "more photo",
    "more photos",
  ].includes(normalized);
}

export function pickTripsByIds(trips: TravelTrip[], ids: string[]) {
  const byId = new Map(trips.map((trip) => [trip.id, trip] as const));
  return ids.map((id) => byId.get(id)).filter((trip): trip is TravelTrip => Boolean(trip));
}

export function pickNumberedTripChoice(text: string, trips: TravelTrip[]) {
  const normalized = normalizePhotoOnlyText(text);
  if (!/^[1-9]$/.test(normalized)) return null;
  const index = Number.parseInt(normalized, 10) - 1;
  return index >= 0 && index < trips.length ? trips[index] : null;
}

export function buildPhotoOnlyAmbiguousPrompt(trips: TravelTrip[]) {
  return [
    "Яг аль аяллын зураг үзэх вэ?",
    ...trips.slice(0, 3).map((trip, index) => `${index + 1}. ${trip.route_name}`),
  ].join("\n");
}

export async function sendPhotoAlbum(
  senderId: string,
  photoUrls: string[],
  token: string | undefined,
  trace?: { requestId: string; correlationId: string },
): Promise<void> {
  if (!token || photoUrls.length === 0) return;
  const traceOpts = {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: "api.webhook.album",
  };
  try {
    await sendImageCarousel(
      senderId,
      photoUrls.map((url) => ({ imageUrl: url })),
      token,
      traceOpts,
    );
  } catch {
    for (const url of photoUrls) {
      try {
        await sendImageMessage(senderId, url, token, traceOpts);
      } catch {
      }
    }
  }
  await recordImageMessage(senderId, photoUrls);
}

export async function sendTripMediaForReply(
  platform: Platform,
  senderId: string,
  replyText: string,
  userText: string,
  token: string | undefined,
  pageId: string,
  igUserId?: string | null,
  trace?: { requestId: string; correlationId: string; source: string },
) {
  if (platform !== "facebook" || !token) return;
  try {
    const tripsForPhotos = await listTrips({ limit: 5000 });
    const tripPhotos = extractTripPhotosForReply(replyText, tripsForPhotos, { userText });
    logInfo("webhook.trip_photos_selected", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
      matchedCount: tripPhotos.length,
      selectedHosts: tripPhotos.map((url) => {
        try {
          return new URL(url).host;
        } catch {
          return "invalid_url";
        }
      }),
    });
    for (const url of tripPhotos) {
      try {
        await sendImageMessage(senderId, url, token, {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          source: "api.webhook.trip_photo",
        });
      } catch (error) {
        logWarn("webhook.trip_photo_send_failed", {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          platform,
          pageId,
          senderHash: hashIdentifier(senderId),
          photoHost:
            (() => {
              try {
                return new URL(url).host;
              } catch {
                return "invalid_url";
              }
            })(),
          classification: classifyError(error),
          message: error instanceof Error ? error.message : String(error),
          bodySnippet:
            error && typeof error === "object" && "bodySnippet" in error
              ? String((error as { bodySnippet?: unknown }).bodySnippet || "")
              : undefined,
        });
      }
    }
    if (tripPhotos.length > 0) {
      await recordImageMessage(senderId, tripPhotos);
      recordCounter("webhook.trip_photos_sent_total", 1, {
        platform,
        photoCount: String(tripPhotos.length),
      });
    }
  } catch (error) {
    logWarn("webhook.trip_media_stage_failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function fetchAndStoreFbName(senderId: string, token: string): Promise<void> {
  // Conversations API: page reads its OWN conversations — allowed with pages_messaging.
  // This avoids the blocked /{psid}?fields=name endpoint (needs Advanced Access).
  try {
    const pageId = getEnv().facebookPages[0]?.pageId ?? "";
    if (!pageId) return;
    const url =
      `https://graph.facebook.com/v19.0/${encodeURIComponent(pageId)}/conversations` +
      `?user_id=${encodeURIComponent(senderId)}&fields=participants&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return;
    const data = (await res.json()) as {
      data?: Array<{ participants?: { data?: Array<{ name?: string; id?: string }> } }>;
    };
    const participants = data.data?.[0]?.participants?.data ?? [];
    const person = participants.find(
      (p) => p.id !== pageId && typeof p.name === "string" && p.name.trim(),
    );
    if (person?.name?.trim()) {
      await storeSenderName(senderId, person.name.trim());
    }
  } catch {
    // non-critical
  }
}
export async function sendFacebookTypingIndicator(
  recipientId: string,
  token: string | undefined,
  pageId: string,
  trace?: { requestId: string; correlationId: string; source: string },
) {
  if (!token) {
    logWarn("webhook.typing.missing_token", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform: "facebook",
      pageId,
      recipientHash: hashIdentifier(recipientId),
    });
    return;
  }
  try {
    await sendTypingOn(recipientId, token, trace);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("2018048")) return;
    logWarn("webhook.typing.failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      pageId,
      recipientHash: hashIdentifier(recipientId),
      classification: classifyError(error),
      message: msg,
      bodySnippet:
        error && typeof error === "object" && "bodySnippet" in error
          ? String((error as { bodySnippet?: unknown }).bodySnippet || "")
          : undefined,
    });
  }
}
export function normalizeLowerText(value: string): string {
  return value.trim().toLowerCase();
}
export function isQuickInfoKeyword(text: string, keywords: string[]): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  for (const keyword of keywords) {
    if (normalizeLowerText(keyword) === normalized) return true;
  }
  return false;
}
export function isHandoffRequest(text: string, keywords: string[]): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  for (const keyword of keywords) {
    const token = normalizeLowerText(keyword);
    if (token && normalized.includes(token)) return true;
  }
  return false;
}
export const CONTACT_OPERATOR_LABEL = "Зөвлөхтэй холбогдох";
// Sent when the bot would repeat its previous reply word-for-word. Must never
// scold ("өмнө нь хэлсэн") and never fake an error.
export const DUPLICATE_REPLY_NUDGE =
  "Өөр асуух зүйл байвал бичээрэй 😊 Утасны дугаараа үлдээвэл манай аяллын зөвлөх тан руу шууд холбогдоно.";
const BOOKING_INTENT_KEYWORDS = [
  "захиал",
  "бүртгүүл",
  "суудал ав",
  "тийз ав",
  "book",
  "booking",
];
export function isBookingIntent(text: string): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  return BOOKING_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
// Mongolian mobile numbers are 8 digits starting with 6, 8, or 9. A 7-prefix
// 8-digit number is an Ulaanbaatar LANDLINE (e.g. the agency's own 7713-6633),
// which must never be captured as a customer lead phone; 5 is not a mobile
// prefix either.
const MONGOLIAN_MOBILE_RE = /(?<!\d)[689]\d{7}(?!\d)/;
export function extractPhoneNumber(text: string): string {
  const compact = text.replace(/[\s\-()]/g, "");
  const match = compact.match(MONGOLIAN_MOBILE_RE);
  return match ? match[0] : "";
}
/**
 * True when the message is essentially JUST a phone number (the customer
 * answering the bot's "утасны дугаараа үлдээгээрэй" ask). Such messages get
 * a deterministic thank-you instead of an AI round-trip; a phone bundled
 * with a real question ("99119911 Бээжин явмаар байна") continues to the AI.
 */
export function isPhoneOnlyMessage(text: string): boolean {
  const compact = text.replace(/[\s\-()+.]/g, "");
  const withoutPhone = compact.replace(MONGOLIAN_MOBILE_RE, "");
  return withoutPhone.replace(/[^\p{L}\p{N}]+/gu, "").length <= 3;
}
export function isCommentTriggerMatch(commentText: string, patterns: string[]): boolean {
  const normalized = normalizeLowerText(commentText);
  if (!normalized) return false;
  for (const pattern of patterns) {
    const token = normalizeLowerText(pattern);
    if (!token) continue;
    if (token.startsWith("/") && token.endsWith("/") && token.length > 2) {
      try {
        const regex = new RegExp(token.slice(1, -1), "i");
        if (regex.test(commentText)) return true;
      } catch {
      }
      continue;
    }
    if (normalized.includes(token)) return true;
  }
  return false;
}
