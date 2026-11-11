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
  buildArchivedTripNotice,
  formatTripListCard,
  tripChoiceFooter,
  filterTripsByTransportIntent,
  formatPassengerMoney,
  getTripNameHaystack,
  keywordTokens,
  normText,
  phoneticLatinText,
  queryWantsDirectFlight,
  queryWantsSeaBeach,
  tripHasSeaBeach,
  queryWantsLandFlightCombo,
  queryWantsLandOnlyEnhanced,
  tripIsCruise,
} from "./travelFastPaths";
import { normalizeTripOffers, resolveTripOfferFareCard, summarizeTripOfferPrices } from "./tripOffers";
import { customerDate } from "./customerDate";
import { departureMatchesScope, hasCalendarWeekWindow, requestedDepartureScope, type RequestedDepartureScope } from "./travelDates";
import { detectHoliday, NEW_YEAR_RE, resolveHoliday, upcomingHolidays, withoutHolidayNames, type HolidayAsk } from "./holidayCalendar";
import { holidayWindowOf } from "./askedWindow";
import { addDays, bookableDates, daysApart, holidayDatesFor, holidayDatesToShow, todayInUb, tripDays, type ResolvedHoliday } from "./holidayDepartures";
import { isVerbOrFunctionWord, reportedPlaceIsInMessage, unknownPlaceTokens } from "./placeLikeTokens";
import type { TravelTrip } from "./travelTypes";

const WHOLE_CATALOG_RE =
  /(?:^|\s)(?:бүх|bvh|buh|bukh|нийт)\s+(?:аял|ayl|ayal)|ямар\s+ямар\s+аял|yamar\s*yamar|(?:^|\s)(?:аяллууд|аялалууд|aylaluud|ayaluud)(?:\s|$)|аяллын\s+жагсаалт|all\s+(?:trips|tours)/i;
const CRUISE_RE = /круз|усан\s+онгоц|cruise/i;
// "Шинэ жилийн аялал хаашаа вэ", "shine jiliin ayalal", "шинэ оны амралт", "new year trip": the
// agency's own post advertises company New Year trips, so customers ask for "the New Year trip"
// as if it were one named trip. No trip carries that name; the answer is the trips leaving over
// New Year (December to the first days of January). Live 2026-11-04 this reached the free-text
// model, which said no trip has that special name and asked for a country.
// (NEW_YEAR_RE lives in holidayCalendar.ts with the other holidays.)
// A holiday named with a trip question ("цагаан сарын үеэр ямар аялал", "наадмаар хаашаа
// явах вэ"). Never the bare "байна уу": "Сар шинэдээ сайхан шинэлж байна уу" is the holiday
// greeting, not a question about trips.
const HOLIDAY_ASK_RE = /мэдээл|үнэ|хуваар|хаашаа|хаана|хэзээ|хэдэнд|ямар|гадагш|явж|medeel|une|huvaar|haashaa|haana|hezee|yamar|gadagsh|yavj|trips?|tours?/iu;
// The customer asks what the catalogue holds, so the answer does not depend on a trip on screen.
const CATALOG_WIDE_RE = /ямар|хаашаа|хаана|аяллууд|аялалууд|бүх|гадагш|yamar|haashaa|haana|aylaluud|ayaluud|gadagsh/iu;
/** The customer asks what the catalogue holds ("ямар аялал байна", "хаашаа явж болох вэ"), not about the trip on screen. */
export function asksWhatExists(text: string): boolean {
  return CATALOG_WIDE_RE.test(normText(text));
}
const HOLIDAY_FOLLOWUP_RE = /гарах|гарна|гардаг|хэдэнд|хэзээ|garah|garna|hedend|hezee/iu;
// Words that, with "шинэ жил", make it a question about the trips even without a trip word
// ("шинэ жилийн мэдээлэл авъя", "shine jil haashaa"); a greeting ("шинэ жилийн мэнд") is not one.
const NEW_YEAR_ASK_RE = /мэдээл|үнэ|хуваар|хаашаа|хаана|хэзээ|байна|байгаа|бна|(?:^|\s)(?:юу|уу|вэ|бэ|medeel\S*|une|unetei|huvaar\S*|haashaa|haana|hezee|bain\S*|bga|bna|bn|yu|ve|be|uu|awii|avii|avya|avy|trips?|tours?|info|price)(?=\s|$)/iu;
const NEW_YEAR_WINDOW = { from: "12-01", to: "01-10" } as const;
const MAX_DETAILED = 8;
const MAX_COMPACT = 3;
// Keep this detector local: reply policy imports the reply/fast-path graph.
const FULL_LIST_RE = /(?:^|\s)(?:бүх|бүгд\S*|нийт|bvh|buh|bukh|bugd\S*|all|full)(?:\s|$)|бүтэн|дэлгэрэнгүй|buten|delgerengui|complete\s+list/i;
const MAX_MESSAGE_CHARS = 1800;

export type Listing = {
  reply: string;
  listed: TravelTrip[];
  authoritative?: boolean;
  /**
   * What the list is made of. "category": a KIND of trip (sea, direct flight, cruise), which a place
   * the model could not read must not silence. "time": only the customer's dates, which never
   * stand in for a place that was named.
   */
  kind?: "category" | "time";
  /** The message names a place no catalogue trip goes to (the reply is then REFER). */
  unknownPlace?: string[];
};

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

/**
 * "Хамгийн хямд" (cheapest) asks for the list in price order (live 2026-11-07: "Хамгийн хямд аялалыг санал
 * болгооч шинэ жилийн" got the New Year list in date order, the dearest first). Set for one synchronous
 * buildCatalogListingReply call; every listing sort below puts the lowest adult fare first while it is on.
 */
const CHEAPEST_RE = /хамгийн\s+хямд|хямдхан|хямд\s+(?:нь|аялал|аяллыг|аялалыг)|hamgiin\s+hya?md|hyamdhan|cheapest|cheap/u;
let cheapestFirst = false;

/** The lowest adult fare the trip is sold at (per-date fares, as the cards print them). Unknown = last. */
function lowestAdultFare(trip: TravelTrip, now: Date): number {
  const result = summarizeTripOfferPrices(trip, {}, now);
  if (result.status !== "ready") return Number.POSITIVE_INFINITY;
  const fare = result.summary.prices.adult;
  if (!fare || fare.kind === "unknown") return Number.POSITIVE_INFINITY;
  return fare.kind === "free" ? 0 : fare.kind === "range" ? fare.min : fare.amount;
}

/** 0 when no price order is asked; otherwise the cheaper trip first. */
function byPrice(a: TravelTrip, b: TravelTrip, now: Date): number {
  return cheapestFirst ? lowestAdultFare(a, now) - lowestAdultFare(b, now) : 0;
}

function priceDetail(trip: TravelTrip, now: Date, date?: string): string {
  if (!nextDepartures(trip, now).length) return "";
  const result = date ? resolveTripOfferFareCard(trip, { date, passengers: [] }, now) : summarizeTripOfferPrices(trip, {}, now);
  if (result.status !== "ready") return "";
  const summary = "summary" in result ? result.summary : result.offer;
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

function detailCard(number: number, trip: TravelTrip, now: Date): string {
  const price = priceDetail(trip, now);
  return formatTripListCard(number, trip, {
    duration: trip.duration_text, fare: price ? price[0].toUpperCase() + price.slice(1) : "", dates: nextDepartures(trip, now),
  }, now);
}

function renderListing(pool: TravelTrip[], heading: string, limit: number, now: Date, grouped = false): Listing {
  const lines = [heading], listed: TravelTrip[] = [];
  const footer = (count: number) => [
    ...(pool.length > count ? ["", `Өөр ${pool.length - count} сонголт бий.${limit > MAX_COMPACT ? ` ${BOOKING_WEBSITE_URL}` : ""}`] : []),
    "", ...(grouped ? [AMBIGUOUS_REPLY_MARKER] : tripChoiceFooter(count)),
  ];
  let previousCategory = "";
  for (const trip of pool.slice(0, limit)) {
    const category = trip.category?.trim() || "Бусад аялал";
    const dates = nextDepartures(trip, now);
    // A long grouped catalogue stays one row per trip; a short list gets a card per trip.
    const additions = grouped
      ? [...(category !== previousCategory ? ["", `${category}:`] : []), `• ${trip.route_name}${dates.length ? ` — ${customerDate(dates[0], now)}` : ""}`]
      : ["", detailCard(listed.length + 1, trip, now)];
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

/** A word typed in Latin letters ("Pekara"): compared with a trip's Cyrillic name by sound. */
const LATIN_WORD_RE = /^[a-z]+$/;

function wordMatchesName(token: string, word: string): boolean {
  if (word.startsWith(stem(token))) return true;
  if (!LATIN_WORD_RE.test(token)) return false;
  const sound = phoneticLatinText(token);
  return sound.length >= 4 && phoneticLatinText(word).startsWith(stem(sound));
}

/**
 * Customer words that start a word in some trip's name — the places they named. A place typed in Latin
 * letters counts too (by sound); an ordinary Latin word (a question, a verb, "aylal") never does.
 */
function namedDestinations(intentText: string, trips: TravelTrip[]): string[] {
  const nameWords = new Set(trips.flatMap((trip) => getTripNameHaystack(trip).split(" ")));
  // A holiday or "шинэ" inside a trip title ("… ШИНЭ ЖИЛИЙН АЯЛАЛ") is not a place the customer named.
  return keywordTokens(withoutHolidayNames(intentText)).filter((token) => {
    if (token.length < 4 || CATEGORY_WORD_RE.test(token)) return false;
    if (LATIN_WORD_RE.test(token) && isVerbOrFunctionWord(token)) return false;
    return Array.from(nameWords).some((word) => wordMatchesName(token, word));
  });
}

function nameHasAny(trip: TravelTrip, destinations: string[]): boolean {
  const words = getTripNameHaystack(trip).split(" ");
  return destinations.some((token) => words.some((word) => wordMatchesName(token, word)));
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** The place as the catalogue spells it: a name typed in Latin letters ("Pekara") is shown in its Cyrillic form. */
function placeNames(destinations: string[], trips: TravelTrip[]): string {
  const nameWords = [...new Set(trips.flatMap((trip) => getTripNameHaystack(trip).split(" ")))];
  return destinations.map((token) => titleCase(LATIN_WORD_RE.test(token) ? nameWords.find((word) => wordMatchesName(token, word)) ?? token : token)).join(", ");
}

// "11 сард гарах аялал", "ойрын аялал", "өвлийн аялал", "10 хоногийн аялал", "өөр аялал": a question
// about WHEN or HOW LONG, naming no trip. None of these reached a fast path or the model, and
// the customer got silence; the catalogue answers every one of them.
const MONTH_ASK_RE = /(?:^|[^\d])(\d{1,2})\s*[-.]?\s*(?:р\s*)?(?:сар(?:ын|д|аас|аар|ийн)?|sar(?:d|iin|yn|aas)?)(?=[^\p{L}\d]|$)/u;
const TRIP_WORD_RE = /аял|гарах|гарна|маршрут|хөтөлбөр|явах|явмаар|явдаг|yavdag|yawdag|ayal|aylal|garah|gardag|garsan|garsn|huwi|marshrut/iu;
const SOONEST_RE = /ойр(?:ын|хон|доо)|удахгүй|одоо\s+гарах|энэ\s+(?:долоо\s+хоног|сар)/u;
const NEXT_MONTH_RE = /ирэх\s+сар|дараа(?:х|гийн)?\s+сар/u;
const OTHER_TRIPS_RE = /^(?:өөр|бусад|дахиад)(?:\s+(?:аялал|юу|байна|уу|байгаа|вэ|байдаг))*\s*[?.!]*$/u;
const DURATION_ASK_RE = /(\d{1,2})\s*(?:хоног|өдөр)/u;
const SEASONS: Array<{ re: RegExp; months: number[]; heading: string }> = [
  { re: /өвөл|өвлийн|өвлөө/u, months: [12, 1, 2], heading: "Өвлийн улиралд гарах аяллууд" },
  { re: /хавар|хаврын/u, months: [3, 4, 5], heading: "Хаврын улиралд гарах аяллууд" },
  { re: /зун(?!\p{L})|зуны|зуслан/u, months: [6, 7, 8], heading: "Зуны улиралд гарах аяллууд" },
  { re: /намар|намрын/u, months: [9, 10, 11], heading: "Намрын улиралд гарах аяллууд" },
];

type When = { months: number[]; heading: string; soonest?: boolean; span?: [string, string]; scope?: RequestedDepartureScope;
  /** The New Year window: the website is always offered, and an empty window shows the nearest departures instead. */
  newYear?: boolean };

/** December 1 to January 10 around the next New Year (or the current one while it is still on). */
export function newYearWindow(now: Date): [string, string] {
  const today = todayInUb(now);
  const year = Number(today.slice(0, 4));
  const endThisYear = `${year}-${NEW_YEAR_WINDOW.to}`;
  return today <= endThisYear ? [`${year - 1}-${NEW_YEAR_WINDOW.from}`, endThisYear] : [`${year}-${NEW_YEAR_WINDOW.from}`, `${year + 1}-${NEW_YEAR_WINDOW.to}`];
}

function askedNewYear(normalized: string, now: Date): When | null {
  if (!NEW_YEAR_RE.test(normalized) || !(TRIP_WORD_RE.test(normalized) || NEW_YEAR_ASK_RE.test(normalized))) return null;
  return { months: [], heading: "🎄 Шинэ жилийн үеэр гарах аяллууд (12 сар – 1 сарын эхээр):", span: newYearWindow(now), newYear: true };
}

function askedWhen(normalized: string, now: Date, raw = normalized): When | null {
  const newYear = askedNewYear(normalized, now);
  if (newYear) return newYear;
  const span = askedSpan(raw, now);
  if (span && (TRIP_WORD_RE.test(normalized) || /^[0-9\s/.,-]+$/.test(raw.trim()) || AFTER_RE.test(raw))) {
    return { months: [], heading: `${customerDate(span[0], now)} – ${customerDate(span[1], now)}-ны хооронд гарах аяллууд`, span };
  }
  const month = askedMonth(normalized);
  if (month) return { months: [month], heading: `${month} сард гарах аяллууд`, scope: requestedDepartureScope(raw, now) || undefined };
  if (!TRIP_WORD_RE.test(normalized)) return null;
  if (NEXT_MONTH_RE.test(normalized)) {
    const next = (Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", month: "2-digit" }).format(now)) % 12) + 1;
    return { months: [next], heading: `Ирэх сард (${next} сард) гарах аяллууд` };
  }
  const season = SEASONS.find((entry) => entry.re.test(normalized));
  if (season) return { months: season.months, heading: season.heading };
  if (SOONEST_RE.test(normalized)) return { months: [], heading: "Ойрын гарах аяллууд", soonest: true };
  return null;
}

function askedMonth(normalized: string): number | null {
  const match = MONTH_ASK_RE.exec(normalized);
  if (!match || !TRIP_WORD_RE.test(normalized)) return null;
  // A day after the month ("11 сарын 25") is a date question, answered elsewhere.
  if (/(?:сар(?:ын|ийн)?|sar(?:iin|yn)?)\s*\d/u.test(normalized) || /\d{1,2}\s*[./]\s*\d{1,2}/.test(normalized)) return null;
  const month = Number(match[1]);
  return month >= 1 && month <= 12 ? month : null;
}

// "11/1-ээс 11/6", "10/31-11-04", "1/4-5нд", "10-р сарын 10-аас 10-р сарын 12-ны хооронд", "11сарын 6-с хойш":
// a span of departure days with no trip named. The date parser read one end at most, so these got
// silence; the answer is the trips leaving inside the span.
const AFTER_RE = /хойш|hoish|hoishoo|after|since/iu;

function nextOccurrence(month: number, day: number, now: Date): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const today = todayInUb(now);
  const year = Number(today.slice(0, 4));
  const ymd = (y: number) => `${y}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const probe = new Date(`${ymd(year)}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.getUTCDate() !== day) return null;
  return ymd(year) >= today ? ymd(year) : ymd(year + 1);
}

function askedSpan(raw: string, now: Date): [string, string] | null {
  const text = raw.replace(/[–—]/g, "-");
  const found: Array<{ at: number; date: string }> = [];
  const add = (at: number, month: number, day: number) => {
    const date = nextOccurrence(month, day, now);
    if (date && !found.some((entry) => entry.at === at)) found.push({ at, date });
  };
  // "11/1", "11.1" — never part of a price ("2.890.000") or a longer number.
  for (const match of text.matchAll(/(?<![\d.,])(\d{1,2})\s*[/.]\s*(\d{1,2})(?![\d.,]\d)(?:\s*-\s*(\d{1,2})(?!\d|[/.-]\d))?/g)) {
    add(match.index!, Number(match[1]), Number(match[2]));
    if (match[3]) add(match.index! + match[0].length, Number(match[1]), Number(match[3]));
  }
  // "10/31-11-04": the second end written month-day with a hyphen.
  for (const match of text.matchAll(/-\s*(\d{1,2})-(\d{1,2})(?![\d])/g)) add(match.index!, Number(match[1]), Number(match[2]));
  // "10-р сарын 10", "11сарын 6", "12 sariin 20".
  for (const match of text.matchAll(/(\d{1,2})\s*-?\s*(?:р\s*)?(?:сар(?:ын)?|sar(?:iin|yn)?)\s*(\d{1,2})/giu)) add(match.index!, Number(match[1]), Number(match[2]));
  const dates = found.sort((a, b) => a.at - b.at).map((entry) => entry.date);
  if (dates.length >= 2) {
    const [from, to] = [dates[0], dates[dates.length - 1]].sort();
    return from === to ? null : [from, to];
  }
  if (dates.length === 1 && AFTER_RE.test(text)) {
    const end = new Date(`${dates[0]}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 30);
    return [dates[0], end.toISOString().slice(0, 10)];
  }
  return null;
}

function inMonths(dates: string[], months: number[], now: Date): string[] {
  const today = todayInUb(now);
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  const wanted = new Set(months.map((month) => `${month >= thisMonth ? thisYear : thisYear + 1}-${String(month).padStart(2, "0")}`));
  return dates.filter((date) => wanted.has(date.slice(0, 7)));
}

function whenListing(pool: TravelTrip[], when: When, now: Date, limit = MAX_COMPACT, keep?: (trip: TravelTrip, date: string) => boolean): Listing | null {
  const rows = pool.map((trip) => {
    const all = bookableDates(trip, now).filter((date) => !keep || keep(trip, date));
    const dates = when.scope ? all.filter(date => departureMatchesScope(date, when.scope!))
      : when.span ? all.filter((date) => date >= when.span![0] && date <= when.span![1]) : when.soonest ? all : inMonths(all, when.months, now);
    return { trip, dates };
  }).filter((row) => row.dates.length > 0).sort((a, b) => byPrice(a.trip, b.trip, now) || a.dates[0].localeCompare(b.dates[0]));
  if (!rows.length) {
    if (when.scope && when.scope.kind !== "month") return { reply: "REFER", listed: [], authoritative: true };
    if (when.newYear) {
      // Nothing leaves over New Year yet: say so, send the customer to the website for the
      // whole schedule, and show the nearest departures so they can still pick a trip.
      const notice = `Шинэ жилийн үеэр (12 сар – 1 сарын эхээр) гарах аялал одоогоор хуваарьт алга байна. Бүх аяллыг эндээс харна уу: ${BOOKING_WEBSITE_URL}`;
      const nearest = whenListing(pool, { months: [], heading: "Ойрын гарах аяллууд:", soonest: true }, now, limit);
      if (!nearest || !nearest.listed.length) return { reply: notice, listed: [], authoritative: true };
      return { ...nearest, reply: `${notice}\n\n${nearest.reply}` };
    }
    return { reply: `${when.heading.replace(/ гарах аяллууд$/, " гарах аялал")} одоогоор алга байна. Бусад хуваарийг эндээс харна уу: ${BOOKING_WEBSITE_URL}`, listed: [], authoritative: true };
  }
  const listed: TravelTrip[] = [];
  const lines = [when.heading];
  const website = when.newYear ? ["", `Бүх аяллыг эндээс харна уу: ${BOOKING_WEBSITE_URL}`] : [];
  const footer = (count: number) => [...(rows.length > count ? ["", `Өөр ${rows.length - count} аялал бий.${limit > MAX_COMPACT && !when.newYear ? ` ${BOOKING_WEBSITE_URL}` : ""}`] : []),
    ...website, "", ...tripChoiceFooter(count)];
  for (const { trip, dates } of rows.slice(0, limit)) {
    const price = priceDetail(trip, now, when.scope && dates.length === 1 ? dates[0] : undefined);
    const shownDates = dates.slice(0, when.scope?.kind === "dates" ? when.scope.dates.length : limit > MAX_COMPACT ? 4 : 2);
    const card = formatTripListCard(listed.length + 1, trip, {
      duration: trip.duration_text, fare: price ? price[0].toUpperCase() + price.slice(1) : "", dates: shownDates,
    }, now);
    if ([...lines, "", card, ...footer(listed.length + 1)].join("\n").length > MAX_MESSAGE_CHARS) break;
    lines.push("", card);
    listed.push(trip);
  }
  return { reply: [...lines, ...footer(listed.length)].join("\n"), listed, authoritative: true };
}

/** "10 хоногийн аялал байна уу": the trips of that length, or the nearest lengths when none is. */
function durationListing(active: TravelTrip[], wanted: number, now: Date, full = false): Listing | null {
  const sized = active.map((trip) => ({ trip, days: tripDays(trip) })).filter((row): row is { trip: TravelTrip; days: number } => row.days !== null && bookableDates(row.trip, now).length > 0);
  const exact = sized.filter((row) => row.days === wanted).map((row) => row.trip);
  if (exact.length) return { ...renderListing(exact, `${wanted} өдрийн аяллууд`, full ? MAX_DETAILED : MAX_COMPACT, now), authoritative: true };
  const nearest = [...sized].sort((a, b) => Math.abs(a.days - wanted) - Math.abs(b.days - wanted) || a.days - b.days).slice(0, MAX_COMPACT).map((row) => row.trip);
  if (!nearest.length) return null;
  return { ...renderListing(nearest, `${wanted} өдрийн аялал одоогоор алга байна. Хамгийн ойрын хугацаатай аяллууд:`, MAX_COMPACT, now), authoritative: true };
}

/**
 * "Аяллыг 12 сарын 30-нд эхлээд шинэ он гарсны дараа буцахаар": a date or span the customer typed is
 * the window; the holiday only says what the trip is around. "…дараа буцах" keeps the trips that
 * are back after the holiday's last day. Null when the holiday's own window is the only one.
 */
function explicitDateWithHoliday(raw: string, normalized: string, ask: HolidayAsk, intentText: string, active: TravelTrip[], trips: TravelTrip[], now: Date, full: boolean): Listing | null {
  const scope = requestedDepartureScope(raw, now);
  if (!scope || scope.kind === "unsupported" || holidayWindowOf(raw, now)) return null;
  // The place the customer names narrows the list, and one no trip goes to is part of the question
  // (holidayReply does the same for the holiday's own window).
  const withoutHoliday = intentText.replace(new RegExp(ask.holiday.re.source, `${ask.holiday.re.flags.replace("g", "")}g`), " ");
  const destinations = namedDestinations(withoutHoliday, active);
  const unknown = destinations.length === 0 ? unknownPlaceTokens(withoutHoliday, trips) : [];
  if (unknown.length) return unknownPlaceListing(unknown);
  const pool = destinations.length ? active.filter((trip) => nameHasAny(trip, destinations)) : active;
  const resolved = resolveHoliday(normalized, now);
  const backAfter = resolved?.status === "resolved" && resolved.ask.relation === "after" ? resolved.period.endYmd : null;
  const heading = scope.kind === "dates" ? `${scope.dates.map((date) => customerDate(date, now)).join(", ")}-нд гарах аяллууд`
    : scope.kind === "range" ? `${customerDate(scope.startYmd, now)} – ${customerDate(scope.endYmd, now)}-ны хооронд гарах аяллууд`
      : `${scope.month} сард гарах аяллууд`;
  const keep = backAfter ? (trip: TravelTrip, date: string) => addDays(date, (tripDays(trip) ?? 1) - 1) > backAfter : undefined;
  const listing = whenListing(pool, { months: [], heading: destinations.length ? `${placeNames(destinations, active)} чиглэлд ${heading}` : heading, scope }, now, full ? MAX_DETAILED : MAX_COMPACT, keep);
  return listing && { ...listing, kind: "time" };
}

/** How far from the holiday a departure may be and still be offered as "nearby dates". */
const HOLIDAY_NEARBY_DAYS = 21;

/**
 * A medical check-up trip is not what a family asking for "a trip over the holidays" means. It is
 * left out of a holiday list that names no place, unless the customer asked for check-ups.
 */
const CHECKUP_RE = /шинжилгээ|эрүүл\s*мэнд|үзлэг|checkup|check-up|shinjilgee|jinjilgee/iu;
function isCheckupTrip(trip: TravelTrip): boolean {
  return CHECKUP_RE.test(`${trip.route_name} ${trip.category || ""}`);
}

export type HolidayWindowListing = Listing & { matched: boolean };

/**
 * The trips of `pool` that travel over a holiday's window, as numbered cards: a trip whose days
 * overlap the holiday first (labelled), then those leaving within the search window around it
 * (labelled before / after). Nothing in the window: said plainly, and the departures NEAREST TO THE
 * WINDOW (not the soonest) are shown as nearby dates, or as "the schedule is not out yet" when the
 * nearest is months away. Null when the pool has no bookable departure at all.
 *
 * One function for every holiday question: with or without a place, a catalogue-wide ask, or a
 * follow-up about the trip(s) on screen (`choice: false` drops the "which one?" footer).
 */
export function holidayWindowListing(input: { pool: TravelTrip[]; resolution: ResolvedHoliday; now: Date; where?: string; full?: boolean; choice?: boolean;
  /** New Year with no place keeps its own heading and points to the website. */
  seasonHeading?: boolean }): HolidayWindowListing | null {
  const { pool, resolution, now } = input;
  const { period, window, phrase, ask } = resolution;
  const around = ask.relation === "around";
  const limit = input.full ? MAX_DETAILED : MAX_COMPACT;
  const where = input.where || "";
  const genitive = ask.holiday.genitive;
  const rows = pool.map((trip) => {
    const found = holidayDatesFor(trip, resolution, now);
    const shown = holidayDatesToShow(found, limit > MAX_COMPACT ? 4 : 2);
    return { trip, ...found, shown, ranked: shown };
  });
  // A trip on the road over the holiday comes first, the one whose own title names the holiday before
  // the others; then the trips that only leave near it; each group by its first shown date.
  const tier = (row: typeof rows[number]) => (row.hits.length ? 0 : row.namedFor && row.ranked.length ? 1 : 2) * 2 + (row.namedFor ? 0 : 1);
  const matching = rows.filter((row) => row.ranked.length > 0)
    .sort((a, b) => byPrice(a.trip, b.trip, now) || tier(a) - tier(b) || a.shown[0].localeCompare(b.shown[0]) || a.trip.route_name.localeCompare(b.trip.route_name, "mn"));
  const note = (row: typeof rows[number]): string => {
    if (!around) return "";
    if (row.hits.length) return `✅ ${genitive} өдрүүдийг хамарна`;
    if (!row.near.length) return "";
    const before = row.near.every((date) => date < period.startYmd);
    const after = row.near.every((date) => date > period.endYmd);
    return `↔ ${genitive} өдрүүдээс ${before ? "өмнө гарна" : after ? "хойш гарна" : "ойролцоо гарна"}`;
  };
  const cards = (list: Array<{ trip: TravelTrip; dates: string[]; note?: string }>, heading: string[], footerLead: string[] = []) => {
    const lines = [...heading];
    const listed: TravelTrip[] = [];
    const footer = (count: number) => [...(list.length > count ? ["", `Өөр ${list.length - count} сонголт бий.`] : []), ...footerLead,
      ...(input.choice === false ? [] : ["", ...tripChoiceFooter(count)])];
    for (const { trip, dates, note: line } of list.slice(0, limit)) {
      const price = priceDetail(trip, now, dates.length === 1 ? dates[0] : undefined);
      const card = formatTripListCard(listed.length + 1, trip, {
        duration: trip.duration_text, fare: price ? price[0].toUpperCase() + price.slice(1) : "", dates: dates.slice(0, limit > MAX_COMPACT ? 4 : 2), note: line || "",
      }, now);
      if ([...lines, "", card, ...footer(listed.length + 1)].join("\n").length > MAX_MESSAGE_CHARS) break;
      lines.push("", card);
      listed.push(trip);
    }
    return { reply: [...lines, ...footer(listed.length)].join("\n"), listed };
  };
  if (matching.length) {
    const verb = around ? "аялах боломжтой" : "гарах";
    const heading = input.seasonHeading ? ["🎄 Шинэ жилийн үеэр гарах аяллууд (12 сар – 1 сарын эхээр):"] : [`${ask.holiday.emoji} ${phrase} ${where}${verb} аяллууд:`];
    const footerLead = input.seasonHeading ? ["", `Бүх аяллыг эндээс харна уу: ${BOOKING_WEBSITE_URL}`] : [];
    // Dates shown: the holiday-touching ones first, then the rest of the window, in calendar order.
    const list = matching.map((row) => ({ trip: row.trip, dates: row.shown, note: note(row) }));
    return { ...cards(list, heading, footerLead), authoritative: true, matched: true };
  }
  // Nothing over the holiday: the departures closest to it, labelled as nearby dates.
  const anchor = ask.relation === "after" ? period.endYmd : period.startYmd;
  const nearest = rows.filter((row) => row.all.length > 0).map((row) => {
    const byDistance = [...row.all].sort((a, b) => daysApart(a, anchor) - daysApart(b, anchor));
    // The trip is as far from the holiday as its NEAREST departure (not its earliest of the two shown).
    return { trip: row.trip, dates: byDistance.slice(0, 2).sort(), distance: daysApart(byDistance[0], anchor) };
  }).sort((a, b) => a.distance - b.distance).slice(0, MAX_COMPACT);
  if (!nearest.length) return null;
  // Months away is not "nearby": that season's schedule is simply not out yet.
  const close = nearest[0].distance <= HOLIDAY_NEARBY_DAYS;
  const heading = close
    ? [`Одоогоор ${phrase} ${where}гарах аялал хуваарьт алга байна.`, "", "Гэхдээ ойролцоо өдрүүдэд гарах аяллууд:"]
    : [`${phrase} ${where}гарах аяллын хуваарь одоогоор гараагүй байна 🙏 Шинэ хуваарийг эндээс харна уу: ${BOOKING_WEBSITE_URL}`, "",
      "Одоогийн хуваарьт хамгийн ойр гарах аяллууд:"];
  return { ...cards(nearest, heading), authoritative: true, matched: false };
}

/**
 * "Цагаан сарын үеэр ямар аялал байна", "наадмаар Тайланд явж болох уу", "цагаан сарын
 * дараа": the trips that travel over the holiday, from the catalogue (holidayWindowListing).
 * A place the catalogue does not hold is a constraint, not a word to drop: that is REFER.
 */
function holidayReply(intentText: string, normalized: string, ask: HolidayAsk | "unspecified", active: TravelTrip[], trips: TravelTrip[], now: Date, full: boolean): Listing | null {
  if (ask === "unspecified") {
    // "Баярын өдрүүдээр аялмаар байна": which holiday is not said. Ask, with the dates.
    const upcoming = upcomingHolidays(now);
    if (!upcoming.length) return null;
    return { reply: ["Аль баярын үеэр аялахыг хүсэж байна вэ? 😊", "", ...upcoming.map((h) => `${h.emoji} ${h.name} — ${h.label}`)].join("\n"), listed: [], authoritative: true };
  }
  const withoutHoliday = intentText.replace(new RegExp(ask.holiday.re.source, `${ask.holiday.re.flags.replace("g", "")}g`), " ");
  const destinations = namedDestinations(withoutHoliday, active);
  const noPlace = destinations.length === 0;
  const resolution = resolveHoliday(normalized, now);
  // That year's dates are not published: staff answer, the bot never guesses.
  if (!resolution || resolution.status === "unknown") return { reply: "REFER", listed: [], authoritative: true };
  // A place no trip goes to is part of the question: no list of other places' trips.
  const unknown = noPlace ? unknownPlaceTokens(withoutHoliday, trips) : [];
  if (unknown.length) return unknownPlaceListing(unknown);
  const wantsCategory = CRUISE_RE.test(normalized) || queryWantsDirectFlight(intentText) || queryWantsLandFlightCombo(intentText) || queryWantsLandOnlyEnhanced(intentText);
  const kindPool = wantsCategory ? (CRUISE_RE.test(normalized) ? active.filter(tripIsCruise) : filterTripsByTransportIntent(intentText, active)) : active;
  const askedCheckup = CHECKUP_RE.test(intentText);
  const seaPool = queryWantsSeaBeach(intentText) && !wantsCategory ? kindPool.filter(tripHasSeaBeach) : kindPool;
  const pool = noPlace ? seaPool.filter((trip) => askedCheckup || !isCheckupTrip(trip)) : seaPool.filter((trip) => nameHasAny(trip, destinations));
  if (!pool.length) return noPlace && seaPool !== kindPool ? { reply: "REFER", listed: [], authoritative: true } : null;
  const where = noPlace ? "" : `${placeNames(destinations, active)} чиглэлд `;
  const newYearSeason = ask.holiday.key === "new_year" && noPlace && resolution.ask.relation === "around";
  const listing = holidayWindowListing({ pool, resolution, now, where, full, choice: true, seasonHeading: newYearSeason });
  // New Year with nothing leaving in its window keeps its own notice (whenListing, below).
  if (!listing) return newYearSeason ? null : { reply: "REFER", listed: [], authoritative: true };
  if (newYearSeason && !listing.matched) return null;
  // A holiday trip question stands on its own; "…гарах уу / хэдэнд" may be about the trip on screen,
  // so then the conversation's trip (if any) wins and the date path answers for it.
  const authoritative = newYearSeason || destinations.length > 0 || CATALOG_WIDE_RE.test(normalized) || !HOLIDAY_FOLLOWUP_RE.test(normalized);
  return { reply: listing.reply, listed: listing.listed, authoritative, kind: wantsCategory ? "category" : "time" };
}

/**
 * The model read a place the catalogue does not hold. A list of a KIND of trip (sea, direct flight,
 * cruise) still answers: "далайтай нь" is not a place. A list made only of the customer's dates
 * never stands in for a place they named, unless that "place" is no word of the message beyond its
 * time words (a model once read "шинэ жил" as a destination).
 */
export function listingAnswersDespitePlace(listing: Listing | null, place: string, intentText: string, trips: TravelTrip[]): boolean {
  if (!listing?.authoritative || listing.listed.length === 0) return false;
  return listing.kind === "category" || !reportedPlaceIsInMessage(place, intentText, trips);
}

/**
 * A place no active trip goes to may still be the name of a trip that has ended: then the customer
 * is told that (travelFastPathsProgram.ts buildArchivedTripNotice), otherwise the listing stays REFER.
 */
export function withEndedTripNotice(listing: Listing, intentText: string, archived: TravelTrip[]): Listing {
  const notice = listing.unknownPlace ? buildArchivedTripNotice(intentText, archived) : null;
  return notice ? { reply: notice.reply, listed: [], authoritative: true, kind: "time" } : listing;
}

/** A place the catalogue does not hold: the listing says nothing (REFER = silence and a staff lead). */
function unknownPlaceListing(tokens: string[]): Listing {
  return { reply: "REFER", listed: [], authoritative: true, unknownPlace: tokens, kind: "time" };
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
  return renderListing(sorted, "Хамгийн цөөн хоногтой аяллууд", FULL_LIST_RE.test(normText(intentText)) ? MAX_SHORTEST : 2, now);
}

function categoryHeading(text: string): string {
  if (queryWantsLandFlightCombo(text)) return "Газар + нислэг хосолсон аяллууд";
  if (queryWantsDirectFlight(text)) return "Шууд нислэгтэй аяллууд";
  if (CRUISE_RE.test(text)) return "Круз аяллууд";
  return "Газрын аяллууд";
}

// "Уб-аас нислэгтэй аялал бн уу": a customer who says only "нислэгтэй" (with a
// flight from Ulaanbaatar in mind) wants the trips that fly. Without this the
// question reached the model, which listed 3 of the 11 direct-flight trips.
const PLAIN_FLIGHT_RE = /(?:^|\s)(?:нислэгтэй|nislegtei|nisleg\s*tei)(?:\s|$)/i;
function withFlightIntent(text: string): string {
  if (queryWantsDirectFlight(text) || queryWantsLandFlightCombo(text) || queryWantsLandOnlyEnhanced(text)) return text;
  return PLAIN_FLIGHT_RE.test(normText(text)) ? `шууд нислэгтэй ${text}` : text;
}

/**
 * The catalog answer, or null when the message is not a catalog question.
 * The caller must also check that the conversation context does not already
 * identify one trip ("шууд нислэгтэй юу?" after a trip card asks about THAT trip).
 */
export function buildCatalogListingReply(rawIntentText: string, trips: TravelTrip[], now = new Date()): Listing | null {
  cheapestFirst = CHEAPEST_RE.test(normText(rawIntentText || ""));
  try {
    return catalogListingReply(rawIntentText, trips, now);
  } finally {
    cheapestFirst = false;
  }
}

function catalogListingReply(rawIntentText: string, trips: TravelTrip[], now: Date): Listing | null {
  if (hasCalendarWeekWindow(rawIntentText)) return null;
  const intentText = withFlightIntent(rawIntentText);
  const normalized = normText(intentText);
  if (!normalized) return null;
  const active = trips.filter((trip) => trip.status === "active");
  const full = FULL_LIST_RE.test(normalized);
  const holiday = detectHoliday(normalized);
  // A holiday beside a place of the catalogue is a trip question whatever else is (not) said:
  // "Цагаан сараар Пекара", "tsagaan saraar Pekara yavmaar bna".
  const asksTrips = TRIP_WORD_RE.test(normalized) || HOLIDAY_ASK_RE.test(normalized)
    || (holiday !== null && holiday !== "unspecified" && holiday.holiday.key === "new_year" && NEW_YEAR_ASK_RE.test(normalized))
    || (holiday !== null && holiday !== "unspecified" && namedDestinations(intentText, active).length > 0);
  if (holiday && asksTrips) {
    // A date or span typed beside the holiday is the window; the holiday only says what it is around.
    const explicit = holiday === "unspecified" ? null : explicitDateWithHoliday(rawIntentText, normalized, holiday, intentText, active, trips, now, full);
    if (explicit) return explicit;
    const answer = holidayReply(intentText, normalized, holiday, active, trips, now, full);
    if (answer) return answer;
  }
  const wantsAll = WHOLE_CATALOG_RE.test(normalized);
  const wantsCruise = CRUISE_RE.test(normalized);
  if (SHORT_TRIP_RE.test(normalized)) return shortestTripsListing(intentText, active, now);
  const wantsCategory =
    wantsCruise ||
    queryWantsDirectFlight(intentText) ||
    queryWantsLandFlightCombo(intentText) ||
    queryWantsLandOnlyEnhanced(intentText);
  // A category request can also name exact departure days. Apply the shared
  // calendar scope before limiting options, and print only those departures.
  const departureScope = requestedDepartureScope(rawIntentText, now);
  if (departureScope && (wantsCategory || wantsAll)) {
    const categoryPool = wantsCategory
      ? wantsCruise ? active.filter(tripIsCruise) : filterTripsByTransportIntent(intentText, active)
      : active;
    const destinations = namedDestinations(intentText, active);
    const pool = destinations.length ? categoryPool.filter(trip => nameHasAny(trip, destinations)) : categoryPool;
    return whenListing(pool, { months: [], heading: wantsCategory ? categoryHeading(intentText) : "Манай аяллууд", scope: departureScope },
      now, full ? MAX_DETAILED : MAX_COMPACT);
  }
  const quiet = namedDestinations(intentText, active).length === 0;
  const when = quiet ? askedWhen(normalized, now, rawIntentText) : null;
  if (when) {
    // "12 сард Лондон явах аялал байна уу": a place no trip goes to is a constraint, not a word to drop.
    const unknown = unknownPlaceTokens(intentText, trips);
    if (unknown.length) return unknownPlaceListing(unknown);
    const pool = wantsCategory ? (wantsCruise ? active.filter(tripIsCruise) : filterTripsByTransportIntent(intentText, active)) : active;
    const listing = whenListing(pool, when, now, full ? MAX_DETAILED : MAX_COMPACT);
    return listing && { ...listing, kind: wantsCategory ? "category" : "time" };
  }
  // A discount asked with no trip named: nothing is advertised to quote, and a group or family price is
  // agreed with staff (one ad promises it). Ask for the trip and head count instead of going silent.
  // "Далайтай аялал байна уу", "халуун газар": the trips whose own text says sea or beach.
  if (quiet && queryWantsSeaBeach(intentText) && !wantsCategory) {
    const sea = active.filter((trip) => tripHasSeaBeach(trip) && bookableDates(trip, now).length > 0).sort((a, b) => soonestKey(a, now).localeCompare(soonestKey(b, now)));
    if (sea.length) return { ...renderListing(sea, "✈️ Далайн амралтын аяллууд", MAX_COMPACT, now), authoritative: true, kind: "category" };
  }
  // "10 хоногийн аялал байна уу" (a length, no month, no place).
  const length = DURATION_ASK_RE.exec(normalized);
  if (quiet && length && TRIP_WORD_RE.test(normalized) && !/сар/u.test(normalized)) {
    const unknown = unknownPlaceTokens(intentText, trips);
    if (unknown.length) return unknownPlaceListing(unknown);
    return durationListing(active, Number(length[1]), now, full);
  }
  // "Өөр аялал байна уу": the customer wants to see more of what exists.
  if (OTHER_TRIPS_RE.test(normalized)) return renderListing(active.filter((trip) => bookableDates(trip, now).length > 0).sort((a, b) => soonestKey(a, now).localeCompare(soonestKey(b, now))), "✈️ Манай аяллууд", MAX_COMPACT, now);
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
    const heading = `${placeNames(destinations, active)} чиглэлд ${requestedKind} одоогоор алга байна.`;
    return renderListing(destinationPool, heading, full ? MAX_DETAILED : MAX_COMPACT, now);
  }
  const pool = destinations.length === 0
    ? categoryPool
    : destinationCategoryPool;
  const listed = [...pool].sort((a, b) => byPrice(a, b, now) || soonestKey(a, now).localeCompare(soonestKey(b, now)));
  if (listed.length === 0 && wantsCruise && destinations.length === 0) {
    return { reply: `Одоогоор усан онгоцны (круз) аялал нээлттэй байхгүй байна. Бусад аяллыг эндээс харна уу: ${BOOKING_WEBSITE_URL}`, listed: [], authoritative: true };
  }
  if (listed.length === 0) return null;

  if (!full || wantsCategory || listed.length <= MAX_DETAILED) {
    const heading = destinations.length > 0 && destinationCategoryPool.length === 0
      ? `${placeNames(destinations, active)} чиглэлийн аяллууд`
      : wantsCategory ? categoryHeading(intentText) : "Манай аяллууд";
    return { ...renderListing(listed, `✈️ ${heading}`, full ? MAX_DETAILED : MAX_COMPACT, now), ...(wantsCategory ? { kind: "category" as const } : {}) };
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
