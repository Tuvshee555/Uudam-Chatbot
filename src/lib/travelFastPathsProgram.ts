/**
 * Program/itinerary fast-path replies: brochure lookup, media URLs, and the
 * "send me the program" reply builder.
 */

import { filterFutureDepartureDates, type ResolvedDepartureDate } from "./travelDates";
import { TRIP_MEDIA_UNAVAILABLE_SILENT } from "./reply";
import type { TravelTrip } from "./travelOps";
import {
  findTripMatches,
  getAliases,
  getTripBrochureAsset,
  hasProgramIntent,
  isGenericConfirmationText,
  keywordTokens,
  normText,
  queryWantsFlight,
  queryWantsLandFlightCombo,
  queryWantsLandOnlyEnhanced,
  resolveTripFromUserMessage,
  tripIsLandFlightCombo,
  type ProgramAsset,
  type TripProgramReplyResult,
} from "./travelFastPathsSearch";
import { buildAmbiguousTripReply } from "./travelFastPathsPricing";

const PROGRAM_ONLY_QUERY_WORDS = new Set([
  "хөтөлбөр",
  "program",
  "pdf",
  "зураг",
  "өдөр",
  "үзэх",
  "үзье",
  "medeelel",
  "мэдээлэл",
  "itinerary",
]);

// Matches MAX_TRIP_PHOTOS in welcomeFlow.ts. Kept local so this module stays a
// leaf (importing welcomeFlow would drag in its DB/env chain).
const MAX_PROGRAM_PHOTOS = 5;

/**
 * Trips that share a DESTINATION the customer named without naming the full
 * route (e.g. one city that appears in both a land tour and a flight combo).
 *
 * The destination vocabulary is derived from the catalog itself — keywordTokens
 * strips generic travel words, so what is left is the identifying part of a
 * route name. This used to be hardcoded to one specific destination, which
 * meant every OTHER destination silently behaved differently and a renamed or
 * removed trip turned the branch into dead code.
 */
function findDestinationMentionedTrips(query: string, trips: TravelTrip[]): TravelTrip[] {
  const queryTokens = new Set(keywordTokens(query).filter((token) => token.length >= 5));
  if (queryTokens.size === 0) return [];
  return trips.filter((trip) =>
    keywordTokens([trip.route_name, ...getAliases(trip)].join(" ")).some(
      (token) => token.length >= 5 && queryTokens.has(token),
    ),
  );
}

function tripGeneralPhotoUrls(trip: TravelTrip): string[] {
  return (trip.photo_urls || [])
    .filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
    .slice(0, MAX_PROGRAM_PHOTOS);
}

function uniqueTripsByRouteName(trips: TravelTrip[]) {
  const seen = new Set<string>();
  return trips.filter((trip) => {
    const key = normText(trip.route_name);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tripHasFlightSignal(trip: TravelTrip) {
  const haystack = normText(
    [trip.route_name, trip.category, trip.source_description, trip.notes].filter(Boolean).join(" "),
  );
  return (
    haystack.includes("нислэг") ||
    haystack.includes("шууд") ||
    haystack.includes("онгоц") ||
    tripIsLandFlightCombo(trip)
  );
}

export function pushMediaUrl(target: string[], value: unknown) {
  if (typeof value === "string" && value.startsWith("https://") && !target.includes(value)) {
    target.push(value);
  }
}

export function getTripProgramMediaUrls(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const urls: string[] = [];

  const directKeys = [
    "program_images",
    "program_image_urls",
    "itinerary_images",
    "itinerary_image_urls",
  ];
  for (const key of directKeys) {
    const value = extra[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) pushMediaUrl(urls, item);
  }

  const mediaAssets = extra.media_assets;
  const visit = (value: unknown, path = "") => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path);
      return;
    }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const metaText = [
      path,
      typeof record.kind === "string" ? record.kind : "",
      typeof record.type === "string" ? record.type : "",
      typeof record.category === "string" ? record.category : "",
      typeof record.purpose === "string" ? record.purpose : "",
      typeof record.label === "string" ? record.label : "",
    ]
      .join(" ")
      .toLowerCase();
    const isProgramLike =
      metaText.includes("program") ||
      metaText.includes("itinerary") ||
      metaText.includes("хөтөлбөр") ||
      metaText.includes("өдөр");

    if (isProgramLike) {
      pushMediaUrl(urls, record.url);
      pushMediaUrl(urls, record.src);
      pushMediaUrl(urls, record.image_url);
      pushMediaUrl(urls, record.imageUrl);
    }

    for (const [key, nested] of Object.entries(record)) {
      visit(nested, `${path} ${key}`);
    }
  };

  visit(mediaAssets, "media_assets");
  return urls.slice(0, 6);
}

export function getTripItineraryLines(trip: TravelTrip): string[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const rawDays = Array.isArray(extra.itinerary_days) ? extra.itinerary_days : [];
  const lines: string[] = [];

  for (const [index, item] of rawDays.entries()) {
    if (typeof item === "string" && item.trim()) {
      lines.push(`• Өдөр ${index + 1}: ${item.trim()}`);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const dayValue =
      typeof record.day === "number"
        ? record.day
        : typeof record.day_number === "number"
          ? record.day_number
          : index + 1;
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const description = typeof record.description === "string" ? record.description.trim() : "";
    const summary = [title, description].filter(Boolean).join(" — ");
    if (summary) {
      lines.push(`• Өдөр ${dayValue}: ${summary}`);
    }
  }

  return lines;
}

function formatPrice(amount: number | null | undefined): string {
  if (!amount) return "";
  return amount.toLocaleString("mn-MN") + "₮";
}

function buildTripSummaryLines(trip: TravelTrip): string {
  const lines: string[] = [];
  if (trip.duration_text && !isGenericConfirmationText(trip.duration_text)) {
    lines.push(`⏱ ${trip.duration_text}`);
  }
  const adult = formatPrice(trip.adult_price);
  const child = formatPrice(trip.child_price);
  if (adult && child) lines.push(`💰 Насанд хүрэгч: ${adult} | Хүүхэд: ${child}`);
  else if (adult) lines.push(`💰 Үнэ: ${adult}`);
  const dates = filterFutureDepartureDates(
    trip.departure_dates?.filter(Boolean) ?? [],
    new Date(),
    ((trip.extra || {}) as Record<string, unknown>).departure_dates_resolved as ResolvedDepartureDate[] | undefined,
  );
  if (dates.length > 0) lines.push(`📅 Гарах өдрүүд: ${dates.slice(0, 5).join(", ")}${dates.length > 5 ? "…" : ""}`);
  return lines.join("\n");
}

function buildShortMediaReply(trip: TravelTrip): string {
  return `✈️ ${trip.route_name}\n\nПостер зургуудыг нь хавсаргалаа.`;
}

export function buildTripProgramReply(
  text: string,
  trips: TravelTrip[],
): TripProgramReplyResult | null {
  if (!hasProgramIntent(text)) return null;

  const query = normText(text);
  const wantsCombo = queryWantsLandFlightCombo(text);
  const wantsLandOnly = queryWantsLandOnlyEnhanced(text) && !queryWantsFlight(text);
  const wantsFlight = queryWantsFlight(text);
  const exactMentionedTrips = trips.filter((trip) => {
    if (query.includes(normText(trip.route_name))) return true;
    return getAliases(trip).some((alias) => query.includes(normText(alias)));
  });
  // A shared destination word is NOT the same as naming a trip. When several
  // tours visit the destination the customer said, that is precisely when the
  // bot must ask which one — so the expansion only counts as a "mention" if it
  // lands on exactly one trip. Otherwise it is used purely to SCOPE the
  // fallback pools below, which is what keeps a destination question from
  // falling back to the entire catalog.
  const destinationTrips = findDestinationMentionedTrips(query, trips);
  const destinationPool = destinationTrips.length > 0 ? destinationTrips : trips;
  const mentionedTrips = uniqueTripsByRouteName([
    ...exactMentionedTrips,
    ...(destinationTrips.length === 1 ? destinationTrips : []),
  ]);
  const exactMentionedComboTrips = mentionedTrips.filter((trip) => tripIsLandFlightCombo(trip));
  const exactMentionedLandTrips = mentionedTrips.filter((trip) => !tripIsLandFlightCombo(trip));
  const scopedTrips = wantsCombo
    ? exactMentionedComboTrips.length > 0
      ? exactMentionedComboTrips
      : destinationPool.filter((trip) => tripIsLandFlightCombo(trip))
    : wantsLandOnly
      ? exactMentionedLandTrips.length > 0
        ? exactMentionedLandTrips
        : destinationPool.filter((trip) => !tripIsLandFlightCombo(trip))
      : wantsFlight
        ? mentionedTrips.length > 0
          ? mentionedTrips
          : destinationPool.filter((trip) => tripHasFlightSignal(trip))
      : mentionedTrips.length > 0
        ? mentionedTrips
        : destinationPool;
  const candidateTrips = scopedTrips.length > 0 ? scopedTrips : trips;
  const routeQueryWords = keywordTokens(text).filter((word) => !PROGRAM_ONLY_QUERY_WORDS.has(word));
  const directResolution = trips.length === 1
    ? { status: "verified" as const, trip: trips[0], candidates: [] }
    : resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
  // The customer's words fit several tours. A single alias mention must not
  // override that: "Тэнгэрийн хаалга" is registered as an alias of ONE tour but
  // is equally the name of two others, so narrowing to the alias holder is how a
  // customer asking for "Тэнгэрийн хаалга" photos received the wrong tour's
  // poster — quoting a price 670,000₮ off. Ask, exactly as the price path does.
  // …unless the customer typed exactly one tour's full ROUTE NAME, which settles
  // it — that is a naming, not a guess. Deliberately NOT exactMentionedTrips:
  // that set also counts alias hits, and "Тэнгэрийн хаалга" is registered as an
  // alias of one tour while being equally the name of two others, which is what
  // sent the wrong poster in the first place.
  const exactRouteNameTrips = trips.filter((trip) => {
    const name = normText(trip.route_name);
    return name.length >= 8 && query.includes(name);
  });
  if (directResolution.status === "ambiguous" && exactRouteNameTrips.length !== 1) {
    return {
      reply: buildAmbiguousTripReply(uniqueTripsByRouteName(directResolution.candidates)),
      trip: null,
      brochure: null,
      mediaUrls: [],
    };
  }
  const canTrustDirectResolution =
    directResolution.status === "verified" &&
    (trips.length === 1 || routeQueryWords.length >= 2 || mentionedTrips.length > 0);
  const genericProgramMatches =
    !canTrustDirectResolution && mentionedTrips.length === 0 && candidateTrips.length > 1
      ? findTripMatches(text, candidateTrips)
      : [];
  if (genericProgramMatches.length > 1 && routeQueryWords.length <= 1) {
    return {
      reply: buildAmbiguousTripReply(uniqueTripsByRouteName(genericProgramMatches.map((match) => match.trip)).slice(0, 3)),
      trip: null,
      brochure: null,
      mediaUrls: [],
    };
  }
  const resolution = canTrustDirectResolution
    ? directResolution
    : resolveTripFromUserMessage(text, candidateTrips, { allowLooseFallback: false });
  if (resolution.status === "ambiguous") {
    return {
      reply: buildAmbiguousTripReply(uniqueTripsByRouteName(resolution.candidates)),
      trip: null,
      brochure: null,
      mediaUrls: [],
    };
  }
  if (resolution.status !== "verified") return null;
  const best = resolution.trip;

  const summary = buildTripSummaryLines(best);
  const summaryBlock = summary ? `\n\n${summary}` : "";

  const wantsPicturesOnly =
    /зураг|zurag|photo|picture|пост(?:ер)?/i.test(text) &&
    !/хөтөлбөр|hutulbur|program|itinerary|өдөр\s*өдөр|day\s*by\s*day/i.test(text);
  if (wantsPicturesOnly) {
    const photoUrls = tripGeneralPhotoUrls(best);
    if (photoUrls.length > 0) {
      return {
        reply: buildShortMediaReply(best),
        trip: best,
        brochure: null,
        mediaUrls: photoUrls,
      };
    }
    return {
      reply: TRIP_MEDIA_UNAVAILABLE_SILENT,
      trip: best,
      brochure: null,
      mediaUrls: [],
    };
  }

  const brochure = getTripBrochureAsset(best);
  if (brochure) {
    return {
      reply: `✈️ ${best.route_name}${summaryBlock}\n\nPDF хөтөлбөрийг хавсаргалаа.`,
      trip: best,
      brochure,
      mediaUrls: [],
    };
  }

  const mediaUrls = getTripProgramMediaUrls(best);
  const itineraryLines = mediaUrls.length > 0 ? [] : getTripItineraryLines(best);

  if (mediaUrls.length > 0) {
    return {
      reply: `✈️ ${best.route_name}${summaryBlock}\n\nДэлгэрэнгүй хөтөлбөрийн зургуудыг хавсаргалаа.`,
      trip: best,
      brochure: null,
      mediaUrls,
    };
  }

  if (itineraryLines.length > 0) {
    return {
      reply: [`✈️ ${best.route_name}`, summary, "", "Өдөр өдрийн хөтөлбөр:", ...itineraryLines].filter(s => s !== "").join("\n"),
      trip: best,
      brochure: null,
      mediaUrls: [],
    };
  }

  // The customer asked SPECIFICALLY for pictures. Every active trip stores its
  // photos in the top-level photo_urls column, NOT in the extra.program_images
  // that getTripProgramMediaUrls reads above — so send those. Bug (found
  // 2026-07-22 probing the live demo/webhook): without this, "X аяллын зураг"
  // for a trip that HAS photos fell straight through to the silent branch
  // below, so a customer asking for pictures of a trip that has pictures got
  // silence + a staff handoff on all 14 photo trips.
  const wantsPicturesOnlyFallback =
    /зураг|zurag|photo|picture|пост(?:ер)?/i.test(text) &&
    !/хөтөлбөр|hutulbur|program|itinerary|өдөр\s*өдөр|day\s*by\s*day/i.test(text);
  if (wantsPicturesOnlyFallback) {
    const photoUrls = tripGeneralPhotoUrls(best);
    if (photoUrls.length > 0) {
      return {
        reply: `✈️ ${best.route_name}${summaryBlock}\n\nАяллын зургуудыг хавсаргалаа.`,
        trip: best,
        brochure: null,
        mediaUrls: photoUrls,
      };
    }
    // Genuinely no photos AND no brochure. Policy (owner): what the bot cannot
    // provide, it does not talk around — stay silent, staff answers from the
    // Meta inbox. The token below matches the no-data silence patterns, so both
    // the webhook and the demo suppress it and log the handoff identically.
    return {
      reply: TRIP_MEDIA_UNAVAILABLE_SILENT,
      trip: best,
      brochure: null,
      mediaUrls: [],
    };
  }

  // A PROGRAM question without stored assets still gets answered with what IS
  // known, and says nothing about pictures. The old "зураг системд ороогүй"
  // footnote was noise for the customer and, worse, pattern-matched the
  // no-data silence rule, which suppressed the entire correct answer.
  return {
    reply: `✈️ ${best.route_name}${summaryBlock}`,
    trip: best,
    brochure: null,
    mediaUrls: [],
  };
}

// Re-exported so travelFastPaths.ts (and any consumer importing straight
// from this module) can still reach the brochure-asset type/helper that
// conceptually belongs to "program" but physically lives in the search
// module to avoid a circular import (findLooseTripMatch also needs it).
export { getTripBrochureAsset };
export type { ProgramAsset };
