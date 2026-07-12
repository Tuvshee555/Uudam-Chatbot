/**
 * Photo-only mode — extracted from webhook.ts (over the 2,000-line cap).
 *
 * When the admin flips the bot to photo-only, the webhook answers trip
 * signals with photo albums and stays silent otherwise. The only text sent
 * here is a true disambiguation prompt when the user is clearly talking
 * about one of several matching trips.
 */
import { sendImageMessage, sendTextMessage } from "./messenger";
import { appendMessage } from "./conversation";
import { listTrips } from "./travelOps";
import { resolveTripFromUserMessage } from "./travelFastPaths";
import { isGenericOpener } from "./welcomeFlow";
import { createPhotoOnlyState, getPhotoOnlyState, setPhotoOnlyState } from "./photoOnlyState";
import {
  buildPhotoOnlyAmbiguousPrompt,
  getTripPhotoUrls,
  isPhotoOnlyFollowup,
  pickNumberedTripChoice,
  pickTripsByIds,
  recordImageMessage,
} from "./webhookMedia";
import type { TravelTrip } from "./travelTypes";
import type { Platform } from "./webhookDedup";
import { classifyError, hashIdentifier, logInfo, logWarn } from "./observability";

export async function handlePhotoOnlyMode(input: {
  platform: Platform;
  senderId: string;
  pageId: string;
  token: string;
  text: string;
  contextualUserText: string;
  trace?: { requestId: string; correlationId: string; source: string };
  rememberTurn: (source: string) => Promise<unknown> | unknown;
}): Promise<void> {
  const { platform, senderId, pageId, token, text, contextualUserText, trace, rememberTurn } =
    input;
  const trips = await listTrips({ status: "active" });
  const photoOnlyState = await getPhotoOnlyState(senderId);
  const pendingTrips = photoOnlyState ? pickTripsByIds(trips, photoOnlyState.pendingTripIds) : [];
  const activeTrip = photoOnlyState?.activeTripId
    ? trips.find((trip) => trip.id === photoOnlyState.activeTripId) || null
    : null;

  let promptKind: "generic" | "ambiguous" | "no_photos" | "not_found" | null = null;
  let clarification: string | null = null;
  let photos: string[] = [];

  if (isGenericOpener(text)) {
    logInfo("webhook.photo_only_mode", {
      requestId: trace?.requestId,
      senderHash: hashIdentifier(senderId),
      photosCount: 0,
      promptKind: "generic_silent",
    });
    return;
  } else {
    // Record the customer's message: photo-only replies used to leave a
    // hole in history (and memory never learned what was asked).
    await appendMessage(senderId, "user", text).catch(() => {});
    let resolvedTrip: TravelTrip | null = null;
    let ambiguousTrips: TravelTrip[] = [];

    if (pendingTrips.length > 0) {
      const numberedChoice = pickNumberedTripChoice(text, pendingTrips);
      if (numberedChoice) {
        resolvedTrip = numberedChoice;
      } else {
        const pendingResolution = resolveTripFromUserMessage(contextualUserText, pendingTrips, {
          allowLooseFallback: false,
        });
        const fullResolution = resolveTripFromUserMessage(contextualUserText, trips, {
          allowLooseFallback: false,
        });
        if (fullResolution.status === "verified") {
          resolvedTrip = fullResolution.trip;
        } else if (pendingResolution.status === "verified") {
          resolvedTrip = pendingResolution.trip;
        } else if (fullResolution.status === "ambiguous") {
          ambiguousTrips = fullResolution.candidates;
        } else if (pendingResolution.status === "ambiguous") {
          ambiguousTrips = pendingResolution.candidates;
        }
      }
    }

    if (!resolvedTrip && ambiguousTrips.length === 0 && activeTrip && isPhotoOnlyFollowup(text)) {
      resolvedTrip = activeTrip;
    }

    if (!resolvedTrip && ambiguousTrips.length === 0) {
      const resolution = resolveTripFromUserMessage(contextualUserText, trips, {
        allowLooseFallback: false,
      });
      if (resolution.status === "verified") resolvedTrip = resolution.trip;
      else if (resolution.status === "ambiguous") ambiguousTrips = resolution.candidates;
    }

    if (resolvedTrip) {
      photos = getTripPhotoUrls(resolvedTrip);
      if (photos.length > 0) {
        for (const url of photos) {
          try {
            await sendImageMessage(senderId, url, token, {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook.photo_only",
            });
          } catch (error) {
            logWarn("webhook.photo_only_send_failed", {
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
            });
          }
        }
        await recordImageMessage(senderId, photos);
        await rememberTurn("api.webhook.photo_only_send");
        await setPhotoOnlyState(senderId, createPhotoOnlyState({
          activeTripId: resolvedTrip.id,
          pendingTripIds: [],
          lastPromptKind: null,
          lastPromptAt: 0,
        }));
      } else {
        clarification = `Одоогоор ${resolvedTrip.route_name} аяллын зураг системд ороогүй байна. Хүсвэл хөтөлбөр, үнэ, гарах өдрийг нь бичиж өгье.`;
        promptKind = "no_photos";
      }
    } else if (ambiguousTrips.length > 0) {
      clarification = buildPhotoOnlyAmbiguousPrompt(ambiguousTrips);
      promptKind = "ambiguous";
      await setPhotoOnlyState(senderId, createPhotoOnlyState({
        activeTripId: activeTrip?.id ?? null,
        pendingTripIds: ambiguousTrips.slice(0, 3).map((trip) => trip.id),
        lastPromptKind: promptKind,
        lastPromptAt: Date.now(),
      }));
    }
  }

  if (clarification) {
    try {
      await sendTextMessage(senderId, clarification, token, {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        source: "api.webhook.photo_only_clarify",
      });
      await appendMessage(senderId, "assistant", clarification);
      await rememberTurn("api.webhook.photo_only_clarify");
    } catch (error) {
      logWarn("webhook.photo_only_clarify_failed", {
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
  logInfo("webhook.photo_only_mode", {
    requestId: trace?.requestId,
    senderHash: hashIdentifier(senderId),
    photosCount: photos.length,
    promptKind,
  });
}
