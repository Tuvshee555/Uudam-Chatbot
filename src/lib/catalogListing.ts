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
} from "./travelFastPaths";
import { normalizeTripOffers, summarizeTripOfferPrices } from "./tripOffers";
import type { TravelTrip } from "./travelTypes";

const WHOLE_CATALOG_RE =
  /(?:^|\s)(?:бүх|bvh|buh|bukh|нийт)\s+(?:аял|ayl|ayal)|ямар\s+ямар\s+аял|yamar\s*yamar|(?:^|\s)(?:аяллууд|аялалууд|aylaluud|ayaluud)(?:\s|$)|аяллын\s+жагсаалт|all\s+(?:trips|tours)/i;
const CRUISE_RE = /круз|усан\s+онгоц|cruise/i;
const LUNAR_NEW_YEAR_RE = /сар\s*шин|sar\s*shin/i;
const MAX_DETAILED = 8;
const MAX_COMPACT = 3;
// Keep this detector local: reply policy imports the reply/fast-path graph.
const FULL_LIST_RE = /(?:^|\s)(?:бүх|бүгд\S*|нийт|bvh|buh|bukh|bugd\S*|all|full)(?:\s|$)|бүтэн|дэлгэрэнгүй|buten|delgerengui|complete\s+list/i;
const MAX_MESSAGE_CHARS = 1800;

type Listing = { reply: string; listed: TravelTrip[]; authoritative?: boolean };

function nextDepartures(trip: TravelTrip, now: Date): string[] {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const availability = normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount").flatMap((offer) => offer.availability);
  const allowed = new Set(availability.filter((row) => row.date >= today && ["open", "unknown"].includes(row.status)).map((row) => row.date));
  for (const row of availability) if (!["open", "unknown"].includes(row.status)) allowed.delete(row.date);
  return [...allowed].sort().slice(0, 2);
}

function soonestKey(trip: TravelTrip, now: Date): string {
  return nextDepartures(trip, now)[0] || "9999";
}

function priceDetail(trip: TravelTrip, now: Date): string {
  if (!nextDepartures(trip, now).length) return "";
  const result = summarizeTripOfferPrices(trip, {}, now);
  if (result.status !== "ready") return "";
  const { summary } = result;
  const fare = summary.prices.adult;
  if (!fare || fare.kind === "unknown") return "";
  const money = (value: number) => formatPassengerMoney(value, summary.currency);
  const price = fare.kind === "free" ? "Үнэгүй" : fare.kind === "range"
    ? money(fare.min) && money(fare.max) ? `${money(fare.min)} - ${money(fare.max)}` : null
    : money(fare.amount);
  if (!price) return "";
  const ages = [...new Set(summary.fares.filter((row) => row.kind === "adult").map((row) => row.ageRange).filter(Boolean))];
  const qualified = [
    `том хүн${ages.length ? ` (${ages.join(", ")})` : ""} ${price}`,
    summary.hotel || summary.hotelId,
    summary.packageId,
    ...summary.conditions,
  ].filter(Boolean).join(" · ");
  // Omit the entire fare rather than dropping an essential qualification.
  return qualified.length <= 220 ? qualified : "";
}

function detailLine(trip: TravelTrip, now: Date): string {
  const price = priceDetail(trip, now);
  const dates = nextDepartures(trip, now);
  const details = [
    trip.duration_text?.trim() || "",
    price,
    dates.length ? `гарах: ${dates.join(", ")}` : "",
  ].filter(Boolean);
  return `• ${trip.route_name}${details.length ? ` — ${details.join(" · ")}` : ""}`;
}

function renderListing(pool: TravelTrip[], heading: string, limit: number, now: Date, grouped = false): Listing {
  const lines = [heading], listed: TravelTrip[] = [];
  const footer = (count: number) => [
    ...(pool.length > count ? ["", `Өөр ${pool.length - count} сонголт бий. Бүгдийг эндээс харна уу: ${BOOKING_WEBSITE_URL}`] : []),
    "", AMBIGUOUS_REPLY_MARKER,
  ];
  let previousCategory = "";
  for (const trip of pool.slice(0, limit)) {
    const category = trip.category?.trim() || "Бусад аялал";
    const dates = nextDepartures(trip, now);
    const additions = grouped
      ? [...(category !== previousCategory ? ["", `${category}:`] : []), `• ${trip.route_name}${dates.length ? ` — ${dates[0]}` : ""}`]
      : [detailLine(trip, now)];
    if ([...lines, ...additions, ...footer(listed.length + 1)].join("\n").length > MAX_MESSAGE_CHARS) break;
    lines.push(...additions);
    listed.push(trip);
    previousCategory = category;
  }
  return { reply: [...lines, ...footer(listed.length)].join("\n"), listed };
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

function shortestTripsListing(intentText: string, active: TravelTrip[], now: Date): Listing | null {
  const destinations = namedDestinations(intentText, active);
  const pool = destinations.length > 0 ? active.filter((trip) => nameHasAny(trip, destinations)) : active;
  const sorted = pool
    .filter((trip) => Number.isFinite(durationDays(trip)))
    .sort((a, b) => durationDays(a) - durationDays(b) || soonestKey(a, now).localeCompare(soonestKey(b, now)));
  if (sorted.length === 0) return null;
  return renderListing(sorted, "Хамгийн цөөн хоногтой аяллууд 😊", FULL_LIST_RE.test(normText(intentText)) ? MAX_SHORTEST : 2, now);
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
export function buildCatalogListingReply(intentText: string, trips: TravelTrip[], now = new Date()): Listing | null {
  const normalized = normText(intentText);
  if (!normalized) return null;
  const active = trips.filter((trip) => trip.status === "active");
  const full = FULL_LIST_RE.test(normalized);
  if (LUNAR_NEW_YEAR_RE.test(normalized)) {
    const listed = active.filter((trip) =>
      LUNAR_NEW_YEAR_RE.test([trip.route_name, ...(Array.isArray(trip.extra?.aliases) ? trip.extra.aliases : [])].join(" ")),
    );
    if (listed.length === 0) {
      return {
        reply: "Сар шинийн тусгай аялал одоогоор аяллын жагсаалтад бүртгэгдээгүй байна. Шинэ хуваарь нэмэгдэхэд аяллын зөвлөхөөс тодруулж өгье.",
        listed: [],
        authoritative: true,
      };
    }
    return { ...renderListing(listed, "Сар шинийн аяллууд 😊", full ? MAX_DETAILED : MAX_COMPACT, now), authoritative: true };
  }
  const wantsAll = WHOLE_CATALOG_RE.test(normalized);
  const wantsCruise = CRUISE_RE.test(normalized);
  if (SHORT_TRIP_RE.test(normalized)) return shortestTripsListing(intentText, active, now);
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
  if (destinations.length > 0 && wantsCategory && destinationCategoryPool.length === 0) {
    const requestedKind = categoryHeading(intentText).toLowerCase();
    const heading = `${destinations.map(titleCase).join(", ")} чиглэлд ${requestedKind} одоогоор алга байна.`;
    return renderListing(destinationPool, heading, full ? MAX_DETAILED : MAX_COMPACT, now);
  }
  const pool = destinations.length === 0
    ? categoryPool
    : destinationCategoryPool;
  const listed = [...pool].sort((a, b) => soonestKey(a, now).localeCompare(soonestKey(b, now)));
  if (listed.length === 0) return null;

  if (!full || wantsCategory || listed.length <= MAX_DETAILED) {
    const heading = destinations.length > 0 && destinationCategoryPool.length === 0
      ? `${destinations.map(titleCase).join(", ")} чиглэлийн аяллууд`
      : wantsCategory ? categoryHeading(intentText) : "Манай аяллууд";
    return renderListing(listed, `${heading} 😊`, full ? MAX_DETAILED : MAX_COMPACT, now);
  }

  // The whole catalog does not fit one message with prices: names grouped by
  // category, soonest first, and the website for the full price list.
  const groups = new Map<string, TravelTrip[]>();
  for (const trip of listed) {
    const key = trip.category?.trim() || "Бусад аялал";
    groups.set(key, [...(groups.get(key) || []), trip]);
  }
  return renderListing([...groups.values()].flat(), "Манай аяллууд 😊", MAX_DETAILED, now, true);
}
