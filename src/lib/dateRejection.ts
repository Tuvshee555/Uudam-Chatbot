/**
 * "Өдөр нь таарахгүй байна" — the customer turns down the departure date(s) just discussed.
 *
 * Live 2026-11-13: after the bot offered one departure, the customer wrote "өдөр нь таарахгүй байна аа";
 * replayed on the same shape the bot re-sent the SAME dates, the rejected one first, and with the model
 * unavailable it said the system was down. A consultant hears "the date is the problem, not the trip or
 * the destination": the rejected date is dropped and the nearest OTHER departures of the same kind of trip
 * in the same direction are offered, with the question which date works.
 *
 * Deterministic and model-free. Only real, bookable, upcoming departures (dateAlternatives.ts). With nothing
 * else to offer the caller hands the turn to staff (no data, no answer).
 *
 * The detector is deliberately narrow (independent review, 2026-11-13): a question about the NEXT departure, a
 * conditional ("if the date does not suit, can I get a refund?"), a policy or payment question, a time of day
 * ("does it leave early in the morning?") and a DURATION that does not suit are all ordinary messages and keep
 * their ordinary paths.
 */
import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";
import { parseDepartureDateText } from "./travelDates";
import { upcomingDepartures } from "./tripFareBlock";
import { customerDate } from "./customerDate";
import { tripTransport } from "./tripFacts";
import { directionTripsNamedIn } from "./tripIdentity";
import { dateAlternativeRadiusDays, departuresNearestTo } from "./dateAlternatives";

/** Heading of the reply; later turns recognise it (a date picked under it is a follow-up to these trips). */
export const DATE_REJECTION_MARKER = "гарах өөр өдрүүд:";

// "хугацаа" (duration / period) is not here: "хугацаа нь тохирохгүй" is about the length of the trip.
const DATE_WORD = String.raw`(?:өдөр|өдрүүд|огноо|гаралт|үед|udur|odor|ognoo|garalt|ued)\p{L}*`;
const DOES_NOT_SUIT = String.raw`(?:тохирох\s*н?\s*гүй|таарах\s*н?\s*гүй|болох\s*н?\s*гүй|тохиромж\s*гүй|зохихгүй|бүтэхгүй|завгүй|чадахгүй|боломжгүй|амжихгүй|ажилтай|`
  + String.raw`tohiroh\s*n?\s*gui|taarah\s*n?\s*gui|bolo?h\s*n?\s*gui|tohiromjgui|butehgui|zavgui|chadahgui|bolomjgui|amjihgui|ajiltai)`;
// A conditional ("хэрэв ... бол"), money or policy: the customer asks something else.
const NOT_A_REJECTION = /(?:^|\s)(?:хэрэв|хэрвээ|herev|heree)(?!\p{L})|буцаа|мөнгө|төлбөр|урьдчилгаа|цуцл|солих|солиул|торгууль|даатга|refund|butsaa|mungu|tulbur|urdchilgaa|tsutsl|solih/iu;
// A time of day or a flight time: "does it leave early in the morning?" is not about the date.
const TIME_OF_DAY = /өглөө|оройн|орой|үдээс|үдийн|шөнө|цагт|цаг(?!\p{L})|нислэг|ugluu|oroi|tsagt|nisleg/iu;

const PATTERNS: RegExp[] = [
  // "өдөр нь таарахгүй байна", "огноо тохирохгүй", "udur ni taarahgui bn", "тэр өдөр болохгүй", "тэр өдөр боломжгүй",
  // "тэр өдөр би завгүй", "тэр үед боломжгүй байна"
  new RegExp(String.raw`${DATE_WORD}\s*(?:нь|ni|n)?\s*(?:би\s*|bi\s*|явж\s*)?(?:бол\s*)?${DOES_NOT_SUIT}`, "iu"),
  // "өөр өдөр байгаа юу", "өөр огноо бий юу", "oor udur bga yu", "өөр гаралт"
  new RegExp(String.raw`(?:^|\s)(?:өөр|oor|uur)\s+${DATE_WORD}`, "iu"),
  // "арай эрт гарах нь байна уу", "арай хожуу" — only with a comparative: a bare "эрт гарах уу" is a time question
  new RegExp(String.raw`(?:арай|илүү|arai|ilvv)\s+(?:эрт|хожуу|ert|hojuu|hozhuu)(?!\p{L})`, "iu"),
];

function narrow(text: string): string | null {
  const said = normText(text);
  if (!said || said.length > 160 || NOT_A_REJECTION.test(said) || TIME_OF_DAY.test(said)) return null;
  return said;
}

/** The customer turns down the date(s) on the table (and names no new date: a new date is a date question). */
export function isDateRejection(text: string): boolean {
  const said = narrow(text);
  return said !== null && PATTERNS.some((pattern) => pattern.test(said));
}

/** A short message that says a date does not suit, with or without the word "date": "2/19 тохирохгүй", "19 нь таарахгүй". */
export function doesNotSuit(text: string): boolean {
  const said = narrow(text);
  return said !== null && said.length <= 80 && new RegExp(DOES_NOT_SUIT, "iu").test(said);
}

/** "19 нь таарахгүй байна": the day of the month the customer turned down, when no month is typed. */
export function rejectedDayOfMonth(text: string): number | null {
  const said = narrow(text);
  if (!said) return null;
  const match = new RegExp(String.raw`(?<![\d.,/-])(\d{1,2})\s*(?:-?\s*(?:нь|ны|ний|ni|n))?\s*(?:өдөр\s*)?(?:нь\s*)?${DOES_NOT_SUIT}`, "iu").exec(said);
  const day = match ? Number(match[1]) : NaN;
  return day >= 1 && day <= 31 ? day : null;
}

/** "Арай эрт", "өмнө" → earlier; "хожуу", "дараа", "оройтож" → later; otherwise either side. */
export function rejectionPreference(text: string): "earlier" | "later" | null {
  const said = normText(text);
  if (/(?:эрт|өмнө|ert|omno|umnu)(?!\p{L})/iu.test(said)) return "earlier";
  if (/(?:хожуу|оройтож|hojuu|hozhuu|дараа(?!гийн\s+(?:гаралт|удаа))|daraa(?!giin))(?!\p{L})/iu.test(said)) return "later";
  return null;
}

/**
 * The dates being turned down: a date the customer typed ("2/19 тохирохгүй", or the bare day "19 нь ...", matched
 * against the focus trips' departures), else the date selected for the trip in focus, else the trip's dates the
 * bot just listed (all of them were on the table).
 */
export function rejectedDates(input: { focus: TravelTrip[]; typedDates?: string[]; typedDay?: number | null; selectionDate?: string | null; lastReply?: string; now?: Date }): string[] {
  if (input.typedDates?.length) return [...input.typedDates].sort();
  const now = input.now ?? new Date();
  const departures = [...new Set(input.focus.flatMap((trip) => upcomingDepartures(trip, now)))];
  if (input.typedDay) {
    const withDay = departures.filter((date) => Number(date.slice(8, 10)) === input.typedDay).sort();
    if (withDay.length) return withDay;
  }
  if (input.selectionDate) return [input.selectionDate];
  const listed = new Set(parseDepartureDateText(input.lastReply || "", now));
  return departures.filter((date) => listed.has(date)).sort();
}

/**
 * Every date an earlier "other dates" reply of this conversation already offered: never offered again as an
 * alternative (a second "another date?" must not bring back the first rejected date).
 */
export function datesAlreadyOffered(history: Array<{ role: string; text: string }>, now = new Date()): string[] {
  const dates = history.filter((message) => message.role === "assistant" && message.text.includes(DATE_REJECTION_MARKER))
    .flatMap((message) => parseDepartureDateText(message.text, now));
  return [...new Set(dates)];
}

/**
 * Where to look for other dates: the same kind of trip in the customer's direction (the trips their own
 * place words name, now or earlier — directionTripsNamedIn), always including the trip(s) in focus.
 */
export function rejectionPool(input: { focus: TravelTrip[]; history: Array<{ role: string; text: string }>; catalog: TravelTrip[] }): TravelTrip[] {
  const focusIds = new Set(input.focus.map((trip) => trip.id));
  const texts = input.history.filter((message) => message.role === "user").map((message) => message.text).reverse().slice(0, 6);
  let direction: TravelTrip[] = [];
  for (const text of texts) {
    const found = directionTripsNamedIn(text, input.catalog);
    if (found && found.some((trip) => focusIds.has(trip.id))) { direction = found; break; }
  }
  const kinds = new Set(input.focus.map((trip) => tripTransport(trip)).filter(Boolean));
  const sameKind = direction.filter((trip) => focusIds.has(trip.id) || !kinds.size || kinds.has(tripTransport(trip)));
  return [...input.focus, ...sameKind.filter((trip) => !focusIds.has(trip.id))];
}

export function buildDateRejectionReply(input: {
  pool: TravelTrip[]; rejected: string[]; preference: "earlier" | "later" | null; now?: Date;
  /** Dates earlier replies already offered: never offered again. */
  exclude?: string[];
}): { reply: string; tripIds: string[] } | null {
  const now = input.now ?? new Date();
  if (!input.rejected.length) return null;
  const first = [...input.rejected].sort()[0];
  const last = [...input.rejected].sort().at(-1)!;
  const single = input.rejected.length === 1;
  const radius = dateAlternativeRadiusDays();
  const excluded = new Set(input.exclude ?? []);
  const ranked = departuresNearestTo(input.pool, input.rejected, now, { max: 12, perTrip: 3, exclude: excluded })
    .filter((row) => input.preference === "earlier" ? row.date < first : input.preference === "later" ? row.date > last : true);
  if (!ranked.length) return null;
  // One rejected date: the departures closest to it (only the close ones when any exist), each said as "N days
  // before/after". Several dates were on the table (a list): there is no single date to measure from, so the
  // remaining departures are listed soonest first with no offset words.
  const close = ranked.filter((row) => Math.abs(row.offsetDays) <= radius);
  const ordered = single ? (close.length ? close : ranked) : [...ranked].sort((a, b) => a.date.localeCompare(b.date));
  const shown = ordered.slice(0, 5);
  const offset = (days: number) => ` (${Math.abs(days)} хоногийн ${days < 0 ? "өмнө" : "дараа"})`;
  // The rejected date itself is not printed: a date with no trip on its line is not one the reply checker
  // (verifyTripReply) can bind to a trip.
  const heading = `Ойр ${DATE_REJECTION_MARKER.replace(/^ойр /, "")}`;
  return {
    reply: [
      "Ойлголоо 😊",
      heading,
      ...shown.map((row) => `• ${row.trip.route_name}: ${customerDate(row.date, now)}${single ? offset(row.offsetDays) : ""}`),
      "",
      shown.length === 1 ? "Энэ өдөр танд тохирох уу? Өөр өдөр хэрэгтэй бол бичээрэй 😊" : "Хүссэн өдрөө бичвэл ойролцоо гаралтыг шалгаад хэлье. Аль өдөр танд тохирох вэ?",
    ].join("\n"),
    tripIds: [...new Set(shown.map((row) => row.trip.id))],
  };
}
