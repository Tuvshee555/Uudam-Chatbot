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
  formatTripListCard,
  tripChoiceFooter,
  filterTripsByTransportIntent,
  formatPassengerMoney,
  getTripNameHaystack,
  keywordTokens,
  normText,
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

/** Customer words that start a word in some trip's name — the places they named. */
function namedDestinations(intentText: string, trips: TravelTrip[]): string[] {
  const nameWords = new Set(trips.flatMap((trip) => getTripNameHaystack(trip).split(" ")));
  // A holiday or "шинэ" inside a trip title ("… ШИНЭ ЖИЛИЙН АЯЛАЛ") is not a place the customer named.
  return keywordTokens(withoutHolidayNames(intentText)).filter((token) => {
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

function todayInUb(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
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

/** Dates a customer can still book: open or unknown, today or later, never a closed one. */
function bookableDates(trip: TravelTrip, now: Date): string[] {
  const today = todayInUb(now);
  const availability = normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount").flatMap((offer) => offer.availability);
  const open = new Set(availability.filter((row) => row.date >= today && ["open", "unknown"].includes(row.status)).map((row) => row.date));
  for (const row of availability) if (!["open", "unknown"].includes(row.status)) open.delete(row.date);
  return [...open].sort();
}

function inMonths(dates: string[], months: number[], now: Date): string[] {
  const today = todayInUb(now);
  const thisYear = Number(today.slice(0, 4));
  const thisMonth = Number(today.slice(5, 7));
  const wanted = new Set(months.map((month) => `${month >= thisMonth ? thisYear : thisYear + 1}-${String(month).padStart(2, "0")}`));
  return dates.filter((date) => wanted.has(date.slice(0, 7)));
}

function whenListing(pool: TravelTrip[], when: When, now: Date, limit = MAX_COMPACT): Listing | null {
  const rows = pool.map((trip) => {
    const all = bookableDates(trip, now);
    const dates = when.scope ? all.filter(date => departureMatchesScope(date, when.scope!))
      : when.span ? all.filter((date) => date >= when.span![0] && date <= when.span![1]) : when.soonest ? all : inMonths(all, when.months, now);
    return { trip, dates };
  }).filter((row) => row.dates.length > 0).sort((a, b) => a.dates[0].localeCompare(b.dates[0]));
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

function tripDays(trip: TravelTrip): number | null {
  const text = trip.duration_text || "";
  const days = /(\d{1,2})\s*өдөр/iu.exec(text);
  if (days) return Number(days[1]);
  const nights = /(\d{1,2})\s*шөнө/iu.exec(text);
  return nights ? Number(nights[1]) + 1 : null;
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

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/**
 * "Цагаан сарын үеэр ямар аялал байна", "наадмаар Тайланд явж болох уу", "цагаан сарын
 * дараа": the trips that travel over the holiday, from the catalogue. A trip whose days
 * overlap the holiday comes first, then those leaving within a week of it (holidayCalendar.ts
 * sets the window). Nothing then: say so, and show the departures closest to the holiday as
 * nearby dates — never as holiday departures.
 */
function holidayReply(intentText: string, normalized: string, ask: HolidayAsk | "unspecified", active: TravelTrip[], now: Date, full: boolean): Listing | null {
  if (ask === "unspecified") {
    // "Баярын өдрүүдээр аялмаар байна": which holiday is not said. Ask, with the dates.
    const upcoming = upcomingHolidays(now);
    if (!upcoming.length) return null;
    return { reply: ["Аль баярын үеэр аялахыг хүсэж байна вэ? 😊", "", ...upcoming.map((h) => `${h.emoji} ${h.name} — ${h.label}`)].join("\n"), listed: [], authoritative: true };
  }
  const withoutHoliday = intentText.replace(new RegExp(ask.holiday.re.source, `${ask.holiday.re.flags.replace("g", "")}g`), " ");
  const destinations = namedDestinations(withoutHoliday, active);
  // New Year with no place named keeps its own listing (askedWhen below).
  if (ask.holiday.key === "new_year" && destinations.length === 0) return null;
  const resolution = resolveHoliday(normalized, now);
  // That year's dates are not published: staff answer, the bot never guesses.
  if (!resolution || resolution.status === "unknown") return { reply: "REFER", listed: [], authoritative: true };
  const wantsCategory = CRUISE_RE.test(normalized) || queryWantsDirectFlight(intentText) || queryWantsLandFlightCombo(intentText) || queryWantsLandOnlyEnhanced(intentText);
  const kindPool = wantsCategory ? (CRUISE_RE.test(normalized) ? active.filter(tripIsCruise) : filterTripsByTransportIntent(intentText, active)) : active;
  const pool = destinations.length ? kindPool.filter((trip) => nameHasAny(trip, destinations)) : kindPool;
  if (!pool.length) return null;
  const { period, window, phrase } = resolution;
  const limit = full ? MAX_DETAILED : MAX_COMPACT;
  const where = destinations.length ? `${destinations.map(titleCase).join(", ")} чиглэлд ` : "";
  const rows = pool.map((trip) => {
    const all = bookableDates(trip, now);
    const length = tripDays(trip) ?? 1;
    // Named for the holiday ("Цагаан сарын аялал"): its departures are the holiday's.
    const namedFor = ask.holiday.re.test(getTripNameHaystack(trip));
    const overlap = resolution.ask.relation === "around"
      ? all.filter((date) => namedFor || (date <= period.endYmd && addDays(date, length - 1) >= period.startYmd)) : [];
    const near = all.filter((date) => date >= window[0] && date <= window[1]);
    return { trip, all, overlaps: overlap.length > 0, dates: [...new Set([...overlap, ...near])].sort() };
  });
  const matching = rows.filter((row) => row.dates.length > 0)
    .sort((a, b) => Number(b.overlaps) - Number(a.overlaps) || a.dates[0].localeCompare(b.dates[0]));
  const cards = (list: Array<{ trip: TravelTrip; dates: string[] }>, heading: string[], footerLead: string[] = []) => {
    const lines = [...heading];
    const listed: TravelTrip[] = [];
    const footer = (count: number) => [...(list.length > count ? ["", `Өөр ${list.length - count} сонголт бий.`] : []), ...footerLead, "", ...tripChoiceFooter(count)];
    for (const { trip, dates } of list.slice(0, limit)) {
      const price = priceDetail(trip, now, dates.length === 1 ? dates[0] : undefined);
      const card = formatTripListCard(listed.length + 1, trip, {
        duration: trip.duration_text, fare: price ? price[0].toUpperCase() + price.slice(1) : "", dates: dates.slice(0, limit > MAX_COMPACT ? 4 : 2),
      }, now);
      if ([...lines, "", card, ...footer(listed.length + 1)].join("\n").length > MAX_MESSAGE_CHARS) break;
      lines.push("", card);
      listed.push(trip);
    }
    return { reply: [...lines, ...footer(listed.length)].join("\n"), listed };
  };
  // A holiday trip question stands on its own; "…гарах уу / хэдэнд" may be about the trip on screen,
  // so then the conversation's trip (if any) wins and the date path answers for it.
  const authoritative = destinations.length > 0 || CATALOG_WIDE_RE.test(normalized) || !HOLIDAY_FOLLOWUP_RE.test(normalized);
  const emoji = ask.holiday.emoji;
  if (matching.length) {
    const verb = resolution.ask.relation === "around" ? "аялах боломжтой" : "гарах";
    return { ...cards(matching, [`${emoji} ${phrase} ${where}${verb} аяллууд:`]), authoritative };
  }
  // Nothing over the holiday: the departures closest to it, labelled as nearby dates.
  const anchor = resolution.ask.relation === "after" ? period.endYmd : period.startYmd;
  const nearest = rows.filter((row) => row.all.length > 0).map((row) => {
    const dates = [...row.all].sort((a, b) => daysApart(a, anchor) - daysApart(b, anchor)).slice(0, 2).sort();
    return { trip: row.trip, dates, distance: daysApart(dates[0], anchor) };
  }).sort((a, b) => a.distance - b.distance).slice(0, MAX_COMPACT);
  if (!nearest.length) return { reply: "REFER", listed: [], authoritative: true };
  // Months away is not "nearby": that season's schedule is simply not out yet.
  const close = nearest[0].distance <= HOLIDAY_NEARBY_DAYS;
  const heading = close
    ? [`Одоогоор ${phrase} ${where}гарах аялал хуваарьт алга байна.`, "", "Гэхдээ ойролцоо өдрүүдэд гарах аяллууд:"]
    : [`${phrase} ${where}гарах аяллын хуваарь одоогоор гараагүй байна 🙏 Шинэ хуваарийг эндээс харна уу: ${BOOKING_WEBSITE_URL}`, "",
      "Одоогийн хуваарьт хамгийн ойр гарах аяллууд:"];
  return { ...cards(nearest, heading), authoritative };
}

/** How far from the holiday a departure may be and still be offered as "nearby dates". */
const HOLIDAY_NEARBY_DAYS = 21;

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
  if (hasCalendarWeekWindow(rawIntentText)) return null;
  const intentText = withFlightIntent(rawIntentText);
  const normalized = normText(intentText);
  if (!normalized) return null;
  const active = trips.filter((trip) => trip.status === "active");
  const full = FULL_LIST_RE.test(normalized);
  const holiday = detectHoliday(normalized);
  if (holiday && (TRIP_WORD_RE.test(normalized) || HOLIDAY_ASK_RE.test(normalized))) {
    const answer = holidayReply(intentText, normalized, holiday, active, now, full);
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
    const pool = wantsCategory ? (wantsCruise ? active.filter(tripIsCruise) : filterTripsByTransportIntent(intentText, active)) : active;
    return whenListing(pool, when, now, full ? MAX_DETAILED : MAX_COMPACT);
  }
  // A discount asked with no trip named: nothing is advertised to quote, and a group or family price is
  // agreed with staff (one ad promises it). Ask for the trip and head count instead of going silent.
  // "Далайтай аялал байна уу", "халуун газар": the trips whose own text says sea or beach.
  if (quiet && queryWantsSeaBeach(intentText) && !wantsCategory) {
    const sea = active.filter((trip) => tripHasSeaBeach(trip) && bookableDates(trip, now).length > 0).sort((a, b) => soonestKey(a, now).localeCompare(soonestKey(b, now)));
    if (sea.length) return { ...renderListing(sea, "✈️ Далайн амралтын аяллууд", MAX_COMPACT, now), authoritative: true };
  }
  // "10 хоногийн аялал байна уу" (a length, no month, no place).
  const length = DURATION_ASK_RE.exec(normalized);
  if (quiet && length && TRIP_WORD_RE.test(normalized) && !/сар/u.test(normalized)) {
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
    const heading = `${destinations.map(titleCase).join(", ")} чиглэлд ${requestedKind} одоогоор алга байна.`;
    return renderListing(destinationPool, heading, full ? MAX_DETAILED : MAX_COMPACT, now);
  }
  const pool = destinations.length === 0
    ? categoryPool
    : destinationCategoryPool;
  const listed = [...pool].sort((a, b) => soonestKey(a, now).localeCompare(soonestKey(b, now)));
  if (listed.length === 0 && wantsCruise && destinations.length === 0) {
    return { reply: `Одоогоор усан онгоцны (круз) аялал нээлттэй байхгүй байна. Бусад аяллыг эндээс харна уу: ${BOOKING_WEBSITE_URL}`, listed: [], authoritative: true };
  }
  if (listed.length === 0) return null;

  if (!full || wantsCategory || listed.length <= MAX_DETAILED) {
    const heading = destinations.length > 0 && destinationCategoryPool.length === 0
      ? `${destinations.map(titleCase).join(", ")} чиглэлийн аяллууд`
      : wantsCategory ? categoryHeading(intentText) : "Манай аяллууд";
    return renderListing(listed, `✈️ ${heading}`, full ? MAX_DETAILED : MAX_COMPACT, now);
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
