import { hasProgramIntent } from "./travelFastPathsSearch";
import { AMBIGUOUS_REPLY_MARKER } from "./travelFastPathsPricing";
import {
  extractTripPhotosForReply,
  extractTripPhotosForUserMessage,
  hasTripPhotoIntent,
  MAX_TRIP_PHOTOS,
} from "./welcomeFlow";
import type { TravelTrip } from "./travelTypes";
import { recordCounter } from "./observability";
import { isReferReply, shouldSilenceNoDataReply } from "./reply";

export function getReplyMediaPolicy(userText: string, replyText: string) {
  const reason = !replyText.trim() || isReferReply(replyText) || shouldSilenceNoDataReply(replyText)
    ? "silent_reply"
    : replyText.includes(AMBIGUOUS_REPLY_MARKER) || /аль\s+аялл/i.test(replyText)
      ? "ambiguous_reply"
      : !hasProgramIntent(userText) && !hasTripPhotoIntent(userText) && !/\b(?:gallery|album)\b|цомог|галерей/i.test(userText)
        ? "no_media_intent"
        : "explicit_media";
  const fullGallery = /\b(?:all|full|entire)\s+(?:(?:the|trip)\s+)?(?:photos?|images?|pictures?|gallery|album)\b|\b(?:photos?|images?|pictures?)\s+all\b|\b(?:buh|bugd)\s+zurag|бүх\s+зур(?:аг|г)|зур(?:аг|г)\S*\s+бүгд|бүтэн\s+(?:цомог|галерей)/i.test(userText.normalize("NFKC"));
  return { allowed: reason === "explicit_media", reason, photoLimit: fullGallery ? MAX_TRIP_PHOTOS : 3 };
}

export function limitReplyPhotos(urls: string[], limit: number): string[] {
  return Array.from(new Set(urls)).filter((url) => {
    try { return new URL(url).protocol === "https:"; } catch { return false; }
  }).slice(0, limit);
}

// The route must omit this call for a silent handoff, or pass its empty reply.
// Explicit assets still require user intent; they cannot bypass the policy.
export function buildReplyMedia(input: {
  reply: string;
  userText: string;
  trips: TravelTrip[];
  explicitMediaUrls?: string[];
  brochureUrl?: string | null;
}) {
  const policy = getReplyMediaPolicy(input.userText, input.reply);
  if (!policy.allowed) return { mediaUrls: [], brochureUrl: null };
  const inferred = input.explicitMediaUrls?.length
    ? input.explicitMediaUrls
    : extractTripPhotosForReply(input.reply, input.trips, { userText: input.userText });
  const photos = inferred.length ? inferred : extractTripPhotosForUserMessage(input.userText, input.trips);
  return {
    mediaUrls: limitReplyPhotos(photos, policy.photoLimit),
    brochureUrl: limitReplyPhotos(input.brochureUrl ? [input.brochureUrl] : [], 1)[0] ?? null,
  };
}

export function recordReplyMediaDelivery(
  kind: "photo" | "pdf" | "trip_link",
  outcome: "attempted" | "sent" | "failed",
  count = 1,
) {
  if (count > 0) recordCounter("webhook.trip_media_delivery_total", count, { platform: "facebook", kind, outcome });
}
