/**
 * "Which direct-flight trips do you have?", "бүх аяллын хуваарь үнэ",
 * "Aylaluud" — questions about the CATALOG rather than one trip.
 *
 * They named no trip, so the structured path found nothing and handed the
 * customer to staff in silence (bot paused), or the model said REFER. Real
 * examples: "Эхлээд шууд нислэгтэй газрын аялалын талаар хариу өгнө үү"
 * (2026-09-21) and "бүх аяллын хуваарь үнийн мэдээлэл авья" (2026-07-29) both
 * got no reply at all. The catalog IS the answer; list it from the database.
 */

import { BOOKING_WEBSITE_URL } from "./bookingCollect";
import {
  AMBIGUOUS_REPLY_MARKER,
  filterTripsByTransportIntent,
  formatPassengerMoney,
  getTripNameHaystack,
  keywordTokens,
  normText,
  queryWantsDirectFlight,
  queryWantsLandFlightCombo,
  queryWantsLandOnlyEnhanced,
  tripIsCruise,
  withFutureDepartureDates,
} from "./travelFastPaths";
import { parseTripDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelTypes";

const WHOLE_CATALOG_RE =
  /(?:^|\s)(?:бүх|bvh|buh|bukh|нийт)\s+(?:аял|ayl|ayal)|ямар\s+ямар\s+аял|yamar\s*yamar|(?:^|\s)(?:аяллууд|аялалууд|aylaluud|ayaluud)(?:\s|$)|аяллын\s+жагсаалт|all\s+(?:trips|tours)/i;
const CRUISE_RE = /круз|усан\s+онгоц|cruise/i;
const MAX_DETAILED = 8;
const MAX_MESSAGE_CHARS = 1800;

type Listing = { reply: string; listed: TravelTrip[] };

function nextDepartures(trip: TravelTrip): string[] {
  return withFutureDepartureDates(trip).departure_dates.slice(0, 2);
}

function soonestKey(trip: TravelTrip): string {
  for (const text of withFutureDepartureDates(trip).departure_dates) {
    const ymd = parseTripDepartureDateText(text)[0];
    if (ymd) return ymd;
  }
  return "9999";
}

function detailLine(trip: TravelTrip): string {
  const price = formatPassengerMoney(trip.adult_price, trip.currency || "MNT");
  const dates = nextDepartures(trip);
  const details = [
    trip.duration_text?.trim() || "",
    price ? `том хүн ${price}` : "",
    dates.length ? `гарах: ${dates.join(", ")}` : "",
  ].filter(Boolean);
  return `• ${trip.route_name}${details.length ? ` — ${details.join(" · ")}` : ""}`;
}

// Words that describe a KIND of trip and also appear inside trip names
// ("…шууд нислэг…", "…газар нислэг хосолсон…"): never a destination.
const CATEGORY_WORD_RE =
  /^(?:шууд|нисл|газа|газр|хосл|хосол|круз|усан|онгоц|сурагч|амралт|сар|өдөр|шөнө|хоно|хөтөлб|аял|хот|хүүх|үнэ|shuud|nisl|gazar|gazr|hosol|direct|flight|cruise|sar|\d)/;

function stem(word: string): string {
  return word.slice(0, Math.max(4, word.length - 2));
}

/** Customer words that start a word in some trip's name — the places they named. */
function namedDestinations(intentText: string, trips: TravelTrip[]): string[] {
  const nameWords = new Set(trips.flatMap((trip) => getTripNameHaystack(trip).split(" ")));
  return keywordTokens(intentText).filter((token) => {
    if (token.length < 4 || CATEGORY_WORD_RE.test(token)) return false;
    const prefix = stem(token);
    return Array.from(nameWords).some((word) => word.startsWith(prefix));
  });
}

function nameHasAny(trip: TravelTrip, destinations: string[]): boolean {
  const words = getTripNameHaystack(trip).split(" ");
  return destinations.some((token) => words.some((word) => word.startsWith(stem(token))));
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

// "арай бага хоногтой нь байхгүй юу": the model answered with whichever trip
// it liked (a 6-day one while 5-day trips existed). Sort the catalog instead.
const SHORT_TRIP_RE =
  /(?:бага|цөөн|богино\S*)\s*(?:хоног|өдөр|хугацаа)|(?:baga|tsuun|bogino)\s*(?:honog|udur|hugatsaa)/i;
const MAX_SHORTEST = 5;

function durationDays(trip: TravelTrip): number {
  const text = trip.duration_text || "";
  const days = /(\d{1,2})\s*өдөр/i.exec(text);
  if (days) return Number(days[1]);
  const nights = /(\d{1,2})\s*шөнө/i.exec(text);
  return nights ? Number(nights[1]) + 1 : Number.POSITIVE_INFINITY;
}

function shortestTripsListing(intentText: string, active: TravelTrip[]): Listing | null {
  const destinations = namedDestinations(intentText, active);
  const pool = destinations.length > 0 ? active.filter((trip) => nameHasAny(trip, destinations)) : active;
  const listed = pool
    .filter((trip) => Number.isFinite(durationDays(trip)))
    .sort((a, b) => durationDays(a) - durationDays(b) || soonestKey(a).localeCompare(soonestKey(b)))
    .slice(0, MAX_SHORTEST);
  if (listed.length === 0) return null;
  const reply = ["Хамгийн цөөн хоногтой аяллууд 😊", ...listed.map(detailLine), "", AMBIGUOUS_REPLY_MARKER].join("\n");
  return { reply, listed };
}

function categoryHeading(text: string): string {
  if (queryWantsLandFlightCombo(text)) return "Газар + нислэг хосолсон аяллууд";
  if (queryWantsDirectFlight(text)) return "Шууд нислэгтэй аяллууд";
  if (CRUISE_RE.test(text)) return "Круз аяллууд";
  return "Газрын аяллууд";
}

/**
 * The catalog answer, or null when the message is not a catalog question.
 * The caller must also check that the conversation context does not already
 * identify one trip ("шууд нислэгтэй юу?" after a trip card asks about THAT trip).
 */
export function buildCatalogListingReply(intentText: string, trips: TravelTrip[]): Listing | null {
  const normalized = normText(intentText);
  if (!normalized) return null;
  const active = trips.filter((trip) => trip.status === "active");
  const wantsAll = WHOLE_CATALOG_RE.test(normalized);
  const wantsCruise = CRUISE_RE.test(normalized);
  if (SHORT_TRIP_RE.test(normalized)) return shortestTripsListing(intentText, active);
  const wantsCategory =
    wantsCruise ||
    queryWantsDirectFlight(intentText) ||
    queryWantsLandFlightCombo(intentText) ||
    queryWantsLandOnlyEnhanced(intentText);
  if (!wantsAll && !wantsCategory) return null;

  const categoryPool = wantsCategory
    ? wantsCruise
      ? active.filter(tripIsCruise)
      : filterTripsByTransportIntent(intentText, active)
    : active;
  // "<хот> болон <хот> хосолсон аялал байна уу" names destinations: list
  // THOSE trips. It used to list every land+flight combo trip in the catalog —
  // none of them to either city.
  const destinations = namedDestinations(intentText, active);
  const destinationPool = destinations.length > 0 ? active.filter((trip) => nameHasAny(trip, destinations)) : [];
  const destinationCategoryPool = destinationPool.filter((trip) => categoryPool.includes(trip));
  const pool = destinations.length === 0
    ? categoryPool
    : destinationCategoryPool.length > 0 ? destinationCategoryPool : destinationPool;
  const listed = [...pool].sort((a, b) => soonestKey(a).localeCompare(soonestKey(b)));
  if (listed.length === 0) return null;

  if (wantsCategory || listed.length <= MAX_DETAILED) {
    const heading = destinations.length > 0 && destinationCategoryPool.length === 0
      ? `${destinations.map(titleCase).join(", ")} чиглэлийн аяллууд`
      : wantsCategory ? categoryHeading(intentText) : "Манай аяллууд";
    const lines = [`${heading} 😊`, ...listed.slice(0, MAX_DETAILED).map(detailLine)];
    if (listed.length > MAX_DETAILED) lines.push("", `Бүгдийг нь эндээс харна уу 👉 ${BOOKING_WEBSITE_URL}`);
    lines.push("", AMBIGUOUS_REPLY_MARKER);
    return { reply: lines.join("\n"), listed: listed.slice(0, 10) };
  }

  // The whole catalog does not fit one message with prices: names grouped by
  // category, soonest first, and the website for the full price list.
  const groups = new Map<string, TravelTrip[]>();
  for (const trip of listed) {
    const key = trip.category?.trim() || "Бусад аялал";
    groups.set(key, [...(groups.get(key) || []), trip]);
  }
  const lines = ["Одоо захиалга авч байгаа аяллууд 😊"];
  for (const [category, group] of groups) {
    lines.push("", `${category}:`);
    for (const trip of group) {
      const dates = nextDepartures(trip);
      lines.push(`• ${trip.route_name}${dates.length ? ` — ${dates[0]}` : ""}`);
    }
  }
  const footer = ["", `Үнэ, хөтөлбөрийг нь эндээс харна уу 👉 ${BOOKING_WEBSITE_URL}`, AMBIGUOUS_REPLY_MARKER];
  let reply = [...lines, ...footer].join("\n");
  while (reply.length > MAX_MESSAGE_CHARS && lines.length > 2) {
    lines.pop();
    reply = [...lines, "…", ...footer].join("\n");
  }
  return { reply, listed: listed.slice(0, 10) };
}
