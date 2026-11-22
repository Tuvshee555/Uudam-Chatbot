/**
 * A trip whose departures are all behind it is still a trip the customer can ask about.
 *
 * The system archives a trip once every departure has passed (tripScheduleMaintenance.ts), but customers keep
 * asking about it from old posts and shared links. Until 2026-11-22 the bot spoke about an ended trip only when
 * NO open trip shared a word with the message. A name whose words each belong to a different open trip
 * ("Шанхай" + "Тэнгэрийн хаалга") therefore got another trip's "this trip is full", a list of unrelated trips, or
 * silence. A real customer asked about one shared post seven times and was never answered about it.
 *
 * Owner's rule (2026-11-22): the trip stays, in the chatbot and on the website. The bot says its dates have ended,
 * that a group of 10 or more (a company, an organisation) can still go on it on a date they choose, and only after
 * that offers the open trips of the same direction, the ones leaving in the asked time first.
 *
 * Pure: the caller passes the ended trips, the open catalogue and the time.
 */
import { holidayWindowOf } from "./askedWindow";
import { storedWebsiteTripSlug, websiteTripLinksInText } from "./bookingWebsite";
import { customerDate } from "./customerDate";
import { askedWindowOf, type AskedWindow } from "./dateAlternatives";
import { safeDurationText } from "./quotedPriceReply";
import { adultFaresOf, dateIsOnSale, upcomingDepartures } from "./tripFareBlock";
import { verifyTripReply } from "./tripReplyVerification";
import { requestedDepartureScope } from "./travelDates";
import { formatPassengerMoney } from "./travelFastPathsPricing";
import { keywordTokens, normText } from "./travelTextNorm";
import { isAttributeWord } from "./travelModeWords";
import type { TravelTrip } from "./travelTypes";
import { ENDED_TRIP_GROUP_LINE, ENDED_TRIP_MARKER, NEVER_DATED_LINE } from "./endedTripWording";

export { ENDED_TRIP_GROUP_LINE, ENDED_TRIP_MARKER, NEVER_DATED_LINE } from "./endedTripWording";

/** Archived by the system because its time ran out, not by staff for another reason. */
const ENDED_REASONS = new Set(["all_departure_dates_passed", "request_window_passed", "no_departure_dates"]);
const MAX_ALTERNATIVES = 3;
const DATES_PER_ALTERNATIVE = 2;
const DAY_MS = 86_400_000;

export function isEndedTrip(trip: TravelTrip): boolean {
  return trip.status === "archived" && ENDED_REASONS.has(String(trip.extra?.archived_reason ?? ""))
    && trip.extra?.customer_visible !== false;
}

const unique = <T>(values: T[]) => [...new Set(values)];
/** "хаалгын" is "хаалга", "шанхайд" is "шанхай": a shared start of four letters or more. */
const sameWord = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));
// Asking words, time words and occasions ("сурагчдын амралт", "хамт олон", greetings) are never part of a trip's
// name: "Сурагчдын амралтаар шанхай…" is a time, not the ended students' trip (real messages, 60 days to 2026-11-22).
const NOT_A_NAME = /^(?:сар|өдр|шөн|байн|байга|бол|хүс|яв|мэдээл|үнэ|хэзээ|хэд|аял|тур|энэ|тэр|шинэ|жил|баяр|үеэр|хамт|олон|амралт|сурагч|хүүхд|мэнд|компани)/u;

/** The words of the message that could be part of a trip's name (four letters or more, no number, no travel kind). */
export function typedNameWords(text: string): string[] {
  const clean = websiteTripLinksInText(text).textWithoutUrls;
  return unique(keywordTokens(clean).filter((word) => word.length >= 4 && !/\d/.test(word) && !isAttributeWord(word) && !NOT_A_NAME.test(word)));
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function nameWords(trip: TravelTrip): string[] {
  return unique(normText([trip.route_name, ...stringList(trip.extra?.aliases), ...stringList(trip.extra?.destinations)].join(" ")).split(/\s+/).filter(Boolean));
}

/** The places a trip lists (destinations, aliases): the words that make a typed phrase a trip's name. */
function listedPlaceWords(trip: TravelTrip): string[] {
  return unique(normText([...stringList(trip.extra?.destinations), ...stringList(trip.extra?.aliases)].join(" ")).split(/\s+/)
    .filter((word) => word.length >= 4 && !/\d/.test(word) && !isAttributeWord(word)));
}

/** How many of the trip's own words the customer typed (each counted once), and whether one of them is a listed place. */
function coverage(typed: string[], trip: TravelTrip): { hits: number; place: boolean } {
  const words = nameWords(trip);
  const places = listedPlaceWords(trip);
  const matched = new Set<string>();
  for (const said of typed) {
    const word = words.find((own) => sameWord(said, own));
    if (word) matched.add(word);
  }
  return { hits: matched.size, place: [...matched].some((word) => places.some((place) => sameWord(place, word))) };
}

/**
 * The ended trip the customer's words name better than any single open trip: it holds more of the typed name
 * words than every open (or full) trip does, one of them is a place it lists, and no other ended trip holds as
 * many. "Шанхай тэнгэрийн хаалгын аялал" is the ended "Шанхай + Тэнгэрийн хаалга …" trip even though an open
 * Shanghai trip and an open Tianmen trip each hold one of the words. A single word ties with the open trips that
 * hold it, so it names none; a trip that lists no place is left to the name resolver (buildArchivedTripNotice).
 */
export function endedTripNamedIn(text: string, ended: TravelTrip[], open: TravelTrip[]): TravelTrip | null {
  const typed = typedNameWords(text);
  if (typed.length < 2) return null;
  const ranked = ended.filter(isEndedTrip).map((trip) => ({ trip, ...coverage(typed, trip) })).filter((row) => row.place)
    .sort((a, b) => b.hits - a.hits);
  const [best, second] = ranked;
  if (!best || best.hits < 2 || (second && second.hits === best.hits)) return null;
  const openBest = Math.max(0, ...open.filter((trip) => trip.status !== "archived").map((trip) => coverage(typed, trip).hits));
  return best.hits > openBest ? best.trip : null;
}

/** A shared website page (or post with its link) of a trip that has ended. */
export function endedTripFromLink(text: string, ended: TravelTrip[]): TravelTrip | null {
  const { slugs } = websiteTripLinksInText(text);
  if (slugs.length !== 1) return null;
  const linked = ended.filter((trip) => isEndedTrip(trip) && storedWebsiteTripSlug(trip)?.toLowerCase() === slugs[0].toLowerCase());
  return linked.length === 1 ? linked[0] : null;
}

/** "энэ аялал", "тэр аялалд", "ene aylal": the customer points at the trip being talked about. */
export function refersToThisTrip(text: string): boolean {
  return /(?:^|[\s,.!?])(?:энэ|тэр|ene|ter)\s+(?:аял\p{L}*|тур\p{L}*|хөтөлбөр\p{L}*|ayal\p{L}*|aylal\p{L}*|tour\p{L}*)/iu.test(text)
    || /^(?:энэ|тэр|ene|ter)\s+(?:нь|ni)(?:\s|$)/iu.test(text.trim());
}

/** The ended trip the bot's last reply was about (its notice names the trip on the first line). */
export function endedTripOfReply(reply: string | undefined, ended: TravelTrip[]): TravelTrip | null {
  if (!reply || !(reply.includes(ENDED_TRIP_MARKER) || reply.includes(NEVER_DATED_LINE))) return null;
  const firstLine = reply.split("\n")[0];
  const named = ended.filter((trip) => isEndedTrip(trip) && firstLine.includes(trip.route_name));
  return named.length ? named.sort((a, b) => b.route_name.length - a.route_name.length)[0] : null;
}

/** The last day the trip left on, from its own resolved dates (never a guessed year). */
function lastDeparture(trip: TravelTrip): string | null {
  const resolved = Array.isArray(trip.extra?.departure_dates_resolved) ? trip.extra.departure_dates_resolved as Array<{ ymd?: unknown }> : [];
  const days = [...resolved.map((row) => row?.ymd), ...(trip.departure_dates || [])]
    .filter((value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)).sort();
  return days.at(-1) ?? null;
}

/**
 * "2026 оны 11 сарын 19": always with the year. A past "11 сарын 19" reads as next year's 11/19, which the reply
 * checker (rightly) refuses as a departure the trip does not have.
 */
function pastDate(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return `${year} оны ${month} сарын ${day}`;
}

/**
 * What the website shows for a trip whose dates have passed (owner, 2026-11-22: "the trip stays on the web"): the
 * sync keeps its page as an ended programme (`publicInfoOnly`), not bookable and not listed, with the last date and
 * fares it was sold at. The website's InformationOnlyTrip reads it from `connectedSource.poster.public_archive`.
 * Null for any other trip, including one archived by staff or one that never had a date.
 */
export function websiteEndedProgramme(trip: TravelTrip): Record<string, unknown> | null {
  if (!isEndedTrip(trip) || trip.extra?.archived_reason === "no_departure_dates") return null;
  const last = lastDeparture(trip);
  const fare = (value: unknown) => (typeof value === "number" && value > 0 ? value : null);
  const child = fare(trip.child_price);
  return {
    ended: true,
    departure_date: last ? pastDate(last) : null,
    adult_price: fare(trip.adult_price),
    child_price_min: child,
    child_price_max: child,
    group_note: ENDED_TRIP_GROUP_LINE.replace(/^👥\s*/u, ""),
  };
}

/** The place words of a trip: its listed destinations, otherwise the place words of its name. */
function placeWordsOf(trip: TravelTrip): string[] {
  const destinations = stringList(trip.extra?.destinations);
  const source = destinations.length ? destinations.join(" ") : [trip.route_name, ...stringList(trip.extra?.aliases)].join(" ");
  return unique(keywordTokens(source).filter((word) => word.length >= 4 && !/\d/.test(word) && !isAttributeWord(word)));
}

const distanceDays = (date: string, window: AskedWindow) =>
  date < window.start ? (Date.parse(window.start) - Date.parse(date)) / DAY_MS : date > window.end ? (Date.parse(date) - Date.parse(window.end)) / DAY_MS : 0;

export type DirectionAlternative = { trip: TravelTrip; dates: string[]; inWindow: boolean };

/**
 * Open trips that go where `focus` goes (they share one of its destinations), each with the bookable dates to show:
 * those in the asked window, otherwise the ones nearest to it, otherwise the next ones. Trips leaving in the window
 * come first, then the ones sharing more places, then the soonest.
 */
export function sameDirectionTrips(focus: TravelTrip, catalogue: TravelTrip[], window: AskedWindow | null, now = new Date()): DirectionAlternative[] {
  const places = placeWordsOf(focus);
  if (!places.length) return [];
  const rows = catalogue.flatMap((trip) => {
    if (trip.id === focus.id || trip.status !== "active") return [];
    const words = nameWords(trip);
    const shared = places.filter((place) => words.some((word) => sameWord(place, word))).length;
    if (!shared) return [];
    const onSale = upcomingDepartures(trip, now).filter((date) => dateIsOnSale(trip, date, now));
    if (!onSale.length) return [];
    const inside = window ? onSale.filter((date) => distanceDays(date, window) === 0) : [];
    const dates = inside.length ? inside.slice(0, DATES_PER_ALTERNATIVE)
      : window ? [...onSale].sort((a, b) => distanceDays(a, window) - distanceDays(b, window) || a.localeCompare(b)).slice(0, DATES_PER_ALTERNATIVE).sort()
        : onSale.slice(0, DATES_PER_ALTERNATIVE);
    return [{ trip, dates, inWindow: inside.length > 0, shared, nearest: window ? Math.min(...dates.map((date) => distanceDays(date, window))) : 0 }];
  });
  rows.sort((a, b) => Number(b.inWindow) - Number(a.inWindow) || a.nearest - b.nearest || b.shared - a.shared || a.dates[0].localeCompare(b.dates[0]));
  return rows.slice(0, MAX_ALTERNATIVES).map(({ trip, dates, inWindow }) => ({ trip, dates, inWindow }));
}

/** The adult fare of the shown dates when it is one amount; otherwise nothing (the card has the detail). */
function adultFareOf(trip: TravelTrip, dates: string[], now: Date): string {
  const fares = adultFaresOf(trip, now).filter((fare) => !fare.dates.length || fare.dates.some((date) => dates.includes(date)));
  const amounts = unique(fares.map((fare) => fare.amount));
  return amounts.length === 1 ? formatPassengerMoney(amounts[0], trip.currency || "MNT") || "" : "";
}

/** "• <trip>: 2 сарын 18 (6 өдөр 5 шөнө — Том хүн: 3,590,000₮)", checked by the reply checker; plainer when it objects. */
export function directionLines(rows: DirectionAlternative[], now = new Date()): string[] {
  const line = (row: DirectionAlternative, detail: boolean) => {
    const dates = row.dates.map((date) => customerDate(date, now)).join(", ");
    const facts = detail ? [safeDurationText(row.trip.duration_text), adultFareOf(row.trip, row.dates, now) && `Том хүн: ${adultFareOf(row.trip, row.dates, now)}`].filter(Boolean).join(" — ") : "";
    return `• ${row.trip.route_name}: ${dates}${facts ? ` (${facts})` : ""}`;
  };
  return rows.map((row) => {
    const full = line(row, true);
    if (verifyTripReply({ reply: full, trips: [row.trip], now }) === full) return full;
    const plain = line(row, false);
    return verifyTripReply({ reply: plain, trips: [row.trip], now }) === plain ? plain : `• ${row.trip.route_name}`;
  });
}

/** The time the customer asked about, with the words the reply uses for it ("2 сард", "Цагаан сарын үеэр (…)"). */
export function askedTimeOf(askText: string | undefined, now = new Date()): AskedWindow | null {
  if (!askText) return null;
  const holiday = holidayWindowOf(askText, now);
  if (holiday) return { start: holiday.window[0], end: holiday.window[1], label: holiday.phrase };
  return askedWindowOf(requestedDepartureScope(askText, now), now);
}

/**
 * What the customer is told about an ended trip: the trip and that its dates have ended (with the time they asked
 * about, when they asked one), the group line, and last the open trips of the same direction.
 */
export function buildEndedTripReply(input: { trip: TravelTrip; catalogue: TravelTrip[]; askText?: string; now?: Date }): { reply: string; alternativeIds: string[] } {
  const { trip, catalogue } = input;
  const now = input.now || new Date();
  const window = askedTimeOf(input.askText, now);
  const last = lastDeparture(trip);
  const neverDated = trip.extra?.archived_reason === "no_departure_dates";
  const status = neverDated ? NEVER_DATED_LINE
    : `Энэ ${ENDED_TRIP_MARKER}${last ? ` (сүүлийн гарах өдөр: ${pastDate(last)})` : ""}.`;
  const alternatives = sameDirectionTrips(trip, catalogue, window, now);
  const inWindow = alternatives.filter((row) => row.inWindow);
  const shown = window && inWindow.length ? inWindow : alternatives;
  const heading = !shown.length ? null
    : window && inWindow.length ? `${window.label} ижил чиглэлд гарах аялал:`
      : window ? `${window.label} ижил чиглэлд гарах аялал алга. Нээлттэй аяллууд:` : "Ижил чиглэлд нээлттэй аяллууд:";
  const reply = [
    `✈️ ${trip.route_name}`,
    `${status}${window ? ` ${window.label} гарах өдөр товлогдоогүй.` : ""}`,
    "",
    ENDED_TRIP_GROUP_LINE,
    ...(heading ? ["", heading, ...directionLines(shown, now), "", shown.length === 1 ? "Энэ аялал танд тохирох уу? 😊" : "Аль нь сонирхол татаж байна вэ? 😊"] : []),
  ].join("\n");
  return { reply, alternativeIds: shown.map((row) => row.trip.id) };
}
