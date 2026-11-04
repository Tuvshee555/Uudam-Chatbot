/**
 * How the admin assistant understands a typed instruction — before any model is asked.
 *
 * The owner wants the assistant to work the way a colleague does: find the trip he
 * means from a loose name, know what "12/27 дүүрсэн" or "хүүхэд 300 мянгаар бага"
 * means, ask one short question with real choices when something is missing, and
 * never guess. Until 2026-11-04 every instruction went to the model as one JSON
 * extraction over a list of 250 trips; it could only patch a few columns, it had no
 * way to mark one departure day sold out, and when a name matched several trips it
 * told the admin to retype the exact name.
 *
 * This module does the common edits in code: it resolves the trip (ids, quoted names,
 * the customer-side matcher that reads aliases, Latin spellings and places, the last
 * trip of the conversation), reads the intent, and builds the exact proposal — or the
 * exact question. Only an instruction it does not understand goes to the model, and
 * then with the trips it most likely concerns.
 *
 * Nothing here writes: a proposal still goes through review, apply and rollback.
 * Trip names in this file are never real — see tests for invented ones.
 */
import { departureAvailability } from "./departureAvailability";
import { findTripMatches } from "./travelFastPathsSearch";
import { parseDepartureDateText } from "./travelDates";
import { keywordTokens, normText, phoneticKeywordTokens } from "./travelTextNorm";
import { applyFareChange, FARE_WORDS, formatMnt, type FareChange, type FareIntent, type FareKind } from "./tripFareChange";
import { addDepartureDates, departureDayOf, removeDepartureDates } from "./tripScheduleChange";
import { upcomingDepartures } from "./tripFareBlock";
import type { AIChangeProposal, AITripAction, DateSeatState, ProposalQuestionOption, TravelTrip, TripMutationFields } from "./travelTypes";

/* ------------------------------------------------------------------ */
/* Tokens an option answer carries back, so an answer is read in code  */
/* ------------------------------------------------------------------ */

export const TRIP_TOKEN = /trip_id=([A-Za-z0-9_.:-]+)/;
const TRIP_TAG = /\s*\[аялал:[^\]]*\]/g;
const DATE_TAG = /\s*\[огноо:\s*([^\]]+)\]/g;
const ALL_DATES_WORD = "бүгд";
const WHOLE_TRIP_WORD = "аялал";

export function tripIdFromText(text: string): string | null {
  const match = TRIP_TOKEN.exec(text);
  return match ? match[1] : null;
}

/** The instruction without the tags an earlier answer added. */
export function stripAnswerTags(text: string): string {
  return text.replace(TRIP_TAG, "").replace(DATE_TAG, "").replace(/trip_id=\S+/g, "").replace(/\s{2,}/g, " ").trim();
}

export function withTripTag(instruction: string, trip: TravelTrip): string {
  return `${instruction.replace(TRIP_TAG, "").trim()} [аялал: «${trip.route_name}» trip_id=${trip.id}]`;
}

export function withDateTag(instruction: string, date: string): string {
  return `${instruction.replace(DATE_TAG, "").trim()} [огноо: ${date}]`;
}

function dateTags(text: string): string[] {
  return [...text.matchAll(DATE_TAG)].map((match) => match[1].trim());
}

/* ------------------------------------------------------------------ */
/* Words                                                               */
/* ------------------------------------------------------------------ */

const FULL = /дүүр(?:сэн|лээ|ч|эв|гэ|нэ|ээ)|суудал\s*(?:байхгүй|алга|дууссан|дуусс)|зарагдаж\s+дууссан|захиалга\s+дууссан|\bsold\s*out\b|\bfull\b|\bduur(?:sen|lee|ssen|ch)\b|\bsuudal\s*(?:baihgui|alga)\b/iu;
const LOW = /цөө(?:н|хөн|рсөн|рч)|сүүлийн\s+(?:\d+\s*)?суудал|\bfew\s+seats?\b|\blow\b|\btsoo(?:n|hon|khon)\b|суудал\s+бага|бага\s+суудал|almost\s*full/iu;
const OPEN = /нээлттэй|(?<!\p{L})нээ(?:х|нэ|е|гээ|лгэ|гээрэй)?(?!\p{L})|дахин\s+нээ|буцааж\s+нээ|\bopen\b|\breopen\b|\bneelttei\b|\bnee\b/iu;
const ALL_DATES = /бүх\s+(?:өдөр|огноо|гаралт)|бүгд(?:ийг|ийн)?(?!\p{L})|бүгдээрээ|\ball\s+dates?\b|\ball\b|бүхэлд\s+нь/iu;

const CANCEL = /цуцал|цуцла|\btsutsal|\bcancel/iu;
const PAUSE = /түр\s+зогсоо|түр\s+хаа|түр\s+зогс|паузл|\bpause|\btur\s+zogsoo/iu;
const RESUME = /идэвхжүүл|сэргээ|идэвхтэй\s+болго|үргэлжлүүл|\bresume|\bactivate|\bidevhjuul|\bsergee|\bunpause/iu;
const ARCHIVE = /архивл|архив\s+(?:руу|уруу)|архив(?!\p{L})|устга|\barchive|\bdelete|\bustga|\bremove\s+(?:the\s+)?trip/iu;
const REMOVE = /хас(?:ах|на|ч|аад|аарай|)?(?!\p{L})|устга|авч\s+хая|болиул|\bremove\b|\bdelete\b|\bhas(?:ah|na)?\b/iu;
const ADD = /нэм(?:эх|нэ|ж|ээрэй|ье|ээд|)?(?!\p{L})|оруул|\badd\b|\bnem(?:eh|ne)?\b|\boruul/iu;
const DATE_WORD = /огноо|өдөр|гаралт|гарах|сарын|\bdate|\bdeparture|\d{1,2}[./-]\d{1,2}/iu;

const ADULT = /том\s*хүн|насанд\s+хүрэгч|\badult|\btom\s*hun|\btomhun/iu;
const CHILD = /хүүхэд|хүүхд|\bchild|\bkids?\b|\bhuuhed|\bhvvhed|\bkhuukhed|\bhuuhd/iu;
const INFANT = /нярай|нялх|\binfant|\bbaby|\bnyarai|\bnyaray|\bnyalh/iu;
const PRICE_WORD = /үнэ|үнийг|үнийн|төгрөг|₮|сая|\bune\b|\buniig\b|\bprice\b|\bmnt\b|мянга|myanga/iu;
const FREE = /үнэгүй|\bfree\b|\bunegui\b/iu;
const PLUS = /нэм(?:эх|нэ|ж|ээд|ье)?(?!\p{L})|өсгө|нэмэгдүүл|өндөрсгө|\+|\bnem(?:eh|ne)?\b|\bincrease|\braise/iu;
const MINUS = /хас(?:ах|на|ч|аад|ье)?(?!\p{L})|бууруул|буулга|хямдруул|багасга|\bdecrease|\breduce|\blower\b|\bhas(?:ah|na)?\b|\bbuuruul/iu;
const BELOW = /доогуур|доош|бага|хямд|\bless\b|\blower\s+than|\bbelow|\bcheaper/iu;
const EVERYONE = /бүх\s+(?:үнэ|аялал|аяллын)|бүгдийг|бүгд|бүх\s+төрөл|\ball\s+(?:prices?|fares?)/iu;

const SEATS = /(\d{1,4})\s*(?:суудал|seats?|suudal)|(?:суудал|seats?|suudal)\D{0,16}?(\d{1,4})(?!\d)/iu;
const SEATS_TOTAL = /нийт|total|багтаамж/iu;
const FOOD_YES = /хоолтой|хоол\s+(?:багтсан|орсон|орно|багтана|байгаа|тэй)|хоол\s*үнэд\s*орсон|\bfood\s+included|\bhooltoi/iu;
const FOOD_NO = /хоолгүй|хоол\s+(?:багтаагүй|ороогүй|орохгүй|байхгүй|тусдаа)|\bno\s+food|\bhoolgui/iu;
const RENAME = /нэр(?:ийг|ийн|ээ|тэй)?(?!\p{L})|\brename|\bname\b|\bner(?:iig)?\b/iu;
const HOTEL = /зочид\s+буудал|буудал|буудлыг|буудлын|\bhotel|\bbuudal/iu;
const PRONOUN = /(?<!\p{L})(?:энэ|үүнийг|үүний|энийг|түүнийг|тэр|мөн|бас|дээрх|сүүлийн|same|this|that|it)(?!\p{L})/iu;

const STATUS_WORDS: Record<string, string> = {
  active: "идэвхтэй", paused: "түр зогссон", cancelled: "цуцлагдсан", sold_out: "дүүрсэн", draft: "ноорог", archived: "архивт",
};
const DATE_STATE_WORDS: Record<DateSeatState, string> = { open: "Нээлттэй", low: "Цөөн суудал", full: "Дүүрсэн" };
const WEEKDAYS = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"];

export function formatDateMn(date: string, withWeekday = false): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return date;
  const text = `${Number(match[2])}-р сарын ${Number(match[3])}`;
  if (!withWeekday) return text;
  const weekday = WEEKDAYS[new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()];
  return `${text} (${weekday})`;
}

/* ------------------------------------------------------------------ */
/* Intent                                                              */
/* ------------------------------------------------------------------ */

export type AssistantIntent =
  | { kind: "date_state"; state: DateSeatState; dates: string[]; allDates: boolean; wholeTrip: boolean }
  | { kind: "price"; change: FareChange; mentioned: boolean }
  | { kind: "status"; status: "cancelled" | "paused" | "active" | "sold_out" }
  | { kind: "archive" }
  | { kind: "seats"; seats_left?: number; seats_total?: number }
  | { kind: "food"; has_food: boolean }
  | { kind: "rename"; name: string }
  | { kind: "dates"; add: string[]; remove: string[] }
  | { kind: "hotel"; hotel: string }
  | { kind: "unknown" };

type Amount = { value: number; index: number; end: number };

/** Tugrug amounts with where they sit in the text: "4,290,000", "4.29 сая", "300k", "300 мянга". */
function amountsIn(text: string): Amount[] {
  const out: Amount[] = [];
  const pattern = /(\d+(?:[.,]\d+)?)\s*(сая|sая|saya|mln|million)|(\d{1,3}(?:[ ,'’]\d{3})+|\d{5,})(?!\s*(?:нас|хүн|сар(?!ын)|он(?!гоц)))|(\d+(?:[.,]\d+)?)\s*(k|мянга|myanga)(?!\p{L})/giu;
  for (const match of text.matchAll(pattern)) {
    let value: number | null = null;
    if (match[1]) value = Math.round(Number.parseFloat(match[1].replace(",", ".")) * 1_000_000);
    else if (match[3]) value = Number(match[3].replace(/[ ,'’]/g, ""));
    else if (match[4]) value = Math.round(Number.parseFloat(match[4].replace(",", ".")) * 1_000);
    if (value == null || !Number.isFinite(value) || value < 10_000 || value > 200_000_000) continue;
    out.push({ value, index: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  return out;
}

/**
 * The text with money and answer tags taken out, so "4,290,000" is never read as a date,
 * and case endings split off a day ("12/27-г", "12/27-ны") so the date parser sees the day.
 */
function textForDates(text: string): string {
  return stripAnswerTags(text)
    .replace(/(\d+(?:[.,]\d+)?)\s*(сая|sая|saya|mln|million|k|мянга|myanga)(?!\p{L})/giu, " ")
    .replace(/\d{1,3}(?:[ ,'’.]\d{3})+|\d{5,}/g, " ")
    .replace(/(\d)\s*-\s*(?:ийг|ыг|г|ийн|ын|ны|ний|нд|д|оос|өөс|аас|ээс|тай|тэй|той|руу|рүү)(?!\p{L})/giu, "$1 ");
}

function datesIn(text: string, now: Date): string[] {
  return [...new Set(parseDepartureDateText(textForDates(text), now))];
}

function relativeOf(text: string, amount: Amount): "plus" | "minus" | "below" | null {
  const before = text.slice(Math.max(0, amount.index - 18), amount.index);
  const after = text.slice(amount.end, amount.end + 22);
  if (/[+]\s*$/.test(before) || /^\s*[+]/.test(after)) return "plus";
  // "-200,000" is a minus; "200,000-аар" is a case ending on the amount.
  if (/(?:^|\s)-\s*$/.test(before) || /^\s*-\s*(?![\p{L}\d])/u.test(after)) return "minus";
  if (BELOW.test(after) || BELOW.test(before)) return "below";
  if (PLUS.test(after)) return "plus";
  if (MINUS.test(after)) return "minus";
  if (PLUS.test(before)) return "plus";
  if (MINUS.test(before)) return "minus";
  return null;
}

function parsePrice(text: string): AssistantIntent | null {
  const amounts = amountsIn(text);
  const mentionsPrice = PRICE_WORD.test(text) || amounts.length > 0 || FREE.test(text);
  const mentionsPassenger = ADULT.test(text) || CHILD.test(text) || INFANT.test(text);
  if (!mentionsPrice && !mentionsPassenger) return null;
  if (!mentionsPrice) return null;

  const change: FareChange = {};
  const keywords: Array<{ kind: FareKind; index: number }> = [];
  for (const [kind, pattern] of [["adult", ADULT], ["child", CHILD], ["infant", INFANT]] as const) {
    for (const match of text.matchAll(new RegExp(pattern.source, "giu"))) keywords.push({ kind, index: match.index ?? 0 });
  }
  keywords.sort((a, b) => a.index - b.index);
  const claimed = new Set<number>();
  const intentFor = (kind: FareKind): FareIntent => (change[kind] ??= {});

  // "хүүхэд үнэгүй" / "нярай үнэгүй": a free fare, no amount needed.
  for (const match of text.matchAll(new RegExp(FREE.source, "giu"))) {
    const at = match.index ?? 0;
    const nearest = keywords.filter((keyword) => Math.abs(keyword.index - at) <= 24).sort((a, b) => Math.abs(a.index - at) - Math.abs(b.index - at))[0];
    if (nearest) intentFor(nearest.kind).set = 0;
  }

  const everyone = EVERYONE.test(text) && !mentionsPassenger;
  const unassigned: Amount[] = [];
  for (const amount of amounts) {
    const relative = relativeOf(text, amount);
    // "том хүн 4,290,000": the passenger word before an amount owns it; "4,290,000 том хүн"
    // only when no unclaimed word stands before it.
    const before = keywords
      .map((keyword, position) => ({ keyword, position, distance: amount.index - keyword.index }))
      .filter((entry) => !claimed.has(entry.position) && entry.distance > 0 && entry.distance <= 48)
      .sort((a, b) => a.distance - b.distance);
    const after = keywords
      .map((keyword, position) => ({ keyword, position, distance: keyword.index - amount.end + 1 }))
      .filter((entry) => !claimed.has(entry.position) && entry.distance >= 0 && entry.distance <= 28)
      .sort((a, b) => a.distance - b.distance);
    const owner = before[0] ?? after[0];
    if (everyone && relative && relative !== "below") {
      change.everyone = (change.everyone ?? 0) + (relative === "plus" ? amount.value : -amount.value);
      continue;
    }
    if (!owner) { unassigned.push(amount); continue; }
    claimed.add(owner.position);
    const intent = intentFor(owner.keyword.kind);
    if (relative === "below") intent.belowAdult = amount.value;
    else if (relative === "plus") intent.delta = amount.value;
    else if (relative === "minus") intent.delta = -amount.value;
    else intent.set = amount.value;
  }
  // Amounts with no passenger word: adult, then child, then infant — the order of every price list.
  const order: FareKind[] = ["adult", "child", "infant"];
  for (const amount of unassigned) {
    const kind = order.find((candidate) => !change[candidate]);
    if (!kind) break;
    const relative = relativeOf(text, amount);
    const intent = intentFor(kind);
    if (relative === "plus") intent.delta = amount.value;
    else if (relative === "minus") intent.delta = -amount.value;
    else intent.set = amount.value;
  }
  return { kind: "price", change, mentioned: Object.keys(change).length > 0 };
}

function quotedStrings(text: string): string[] {
  return [...text.matchAll(/«([^»]+)»|"([^"]+)"|“([^”]+)”/g)].map((match) => (match[1] || match[2] || match[3] || "").trim()).filter(Boolean);
}

/** What the admin wants done, read from the words alone (the trip is resolved separately). */
export function parseIntent(rawText: string, now = new Date()): AssistantIntent {
  const text = stripAnswerTags(rawText);
  const dates = datesIn(rawText, now);
  const taggedDates = dateTags(rawText);
  const allDates = taggedDates.includes(ALL_DATES_WORD) || ALL_DATES.test(text);
  const wholeTrip = taggedDates.includes(WHOLE_TRIP_WORD);
  const explicitDates = [...new Set([...dates, ...taggedDates.filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))])];

  if (explicitDates.length && !FULL.test(text) && !LOW.test(text) && !OPEN.test(text)) {
    if (REMOVE.test(text) || CANCEL.test(text)) return { kind: "dates", add: [], remove: explicitDates };
    if (ADD.test(text) && !PRICE_WORD.test(text)) return { kind: "dates", add: explicitDates, remove: [] };
  }
  if (FULL.test(text)) return { kind: "date_state", state: "full", dates: explicitDates, allDates, wholeTrip };
  if (LOW.test(text)) return { kind: "date_state", state: "low", dates: explicitDates, allDates, wholeTrip };
  if (OPEN.test(text) && (explicitDates.length || taggedDates.length || DATE_WORD.test(text))) {
    return { kind: "date_state", state: "open", dates: explicitDates, allDates, wholeTrip };
  }

  const price = parsePrice(text);
  if (price && price.kind === "price" && (price.mentioned || !SEATS.test(text))) {
    if (price.mentioned || PRICE_WORD.test(text)) return price;
  }

  const seats = SEATS.exec(text);
  if (seats) {
    const value = Number(seats[1] || seats[2]);
    if (Number.isInteger(value)) return SEATS_TOTAL.test(text) ? { kind: "seats", seats_total: value } : { kind: "seats", seats_left: value };
  }
  if (FOOD_NO.test(text)) return { kind: "food", has_food: false };
  if (FOOD_YES.test(text)) return { kind: "food", has_food: true };

  if (RENAME.test(text)) {
    const quoted = quotedStrings(text);
    const captured = /нэр(?:ийг|ийн|ээ)?\s+(.+?)\s+(?:болго|гэж\s+(?:өөрчил|сол)|руу|болгоно)/iu.exec(text)?.[1]
      || /rename\s+(?:to\s+)?(.+)$/iu.exec(text)?.[1];
    const name = (quoted.length >= 2 ? quoted[quoted.length - 1] : quoted.length === 1 && !/(?:аяллыг|аяллын)\s*$/iu.test(text.slice(0, text.indexOf(quoted[0]))) ? quoted[0] : captured || "").trim();
    if (name && name.length >= 3 && name.length <= 160) return { kind: "rename", name: name.replace(/^[«"“]|[»"”]$/g, "") };
  }
  if (HOTEL.test(text)) {
    const hotel = (/(?:зочид\s+)?буудл?(?:ыг|ын|аа|ал)?\s*[:=–—-]\s*(.+)$/iu.exec(text)?.[1]
      || /(?:зочид\s+)?буудл?(?:ыг|ын|аа|ал)?\s+(.+?)\s+(?:болго|гэж)/iu.exec(text)?.[1]
      || /\bhotel\s*[:=]\s*(.+)$/iu.exec(text)?.[1] || "").trim();
    if (hotel && hotel.length >= 2 && hotel.length <= 200) return { kind: "hotel", hotel };
  }

  if (!explicitDates.length) {
    if (CANCEL.test(text)) return { kind: "status", status: "cancelled" };
    if (PAUSE.test(text)) return { kind: "status", status: "paused" };
    if (RESUME.test(text)) return { kind: "status", status: "active" };
    if (ARCHIVE.test(text)) return { kind: "archive" };
  }
  if (explicitDates.length && ADD.test(text)) return { kind: "dates", add: explicitDates, remove: [] };
  return { kind: "unknown" };
}

/* ------------------------------------------------------------------ */
/* Which trip                                                          */
/* ------------------------------------------------------------------ */

export type TripResolution =
  | { kind: "certain"; trip: TravelTrip; how: "id" | "quoted" | "match" | "context" }
  | { kind: "ambiguous"; candidates: TravelTrip[] }
  | { kind: "none" };

const AMBIGUOUS_WINDOW = 60;
const MAX_CANDIDATES = 6;

const norm = (value: string) => value.toLowerCase().replace(/[«»"“”]/g, " ").replace(/[\s\-–—]+/g, " ").trim();

function tripsNamed(name: string, trips: TravelTrip[]): TravelTrip[] {
  const wanted = norm(name);
  if (!wanted) return [];
  return trips.filter((trip) => norm(trip.route_name) === wanted
    || (Array.isArray(trip.extra?.aliases) && (trip.extra.aliases as unknown[]).some((alias) => typeof alias === "string" && norm(alias) === wanted)));
}

/** The last trip named in the conversation so far ("«Name» — …" lines the server logged). */
export function tripFromContext(context: string | undefined, trips: TravelTrip[]): TravelTrip | null {
  if (!context) return null;
  const names = [...context.matchAll(/«([^»]+)»/g)].map((match) => match[1]);
  for (let index = names.length - 1; index >= 0; index -= 1) {
    const found = tripsNamed(names[index], trips);
    if (found.length === 1) return found[0];
  }
  const id = tripIdFromText(context);
  return id ? trips.find((trip) => trip.id === id) ?? null : null;
}

/**
 * The trip an instruction is about. Exact signals first (an id token from a tapped
 * option, a quoted name), then the catalogue matcher over every status, then the trip
 * the conversation was already about.
 */
export function resolveTrip(rawText: string, trips: TravelTrip[], options: { context?: string; now?: Date } = {}): TripResolution {
  const now = options.now ?? new Date();
  const id = tripIdFromText(rawText);
  if (id) {
    const trip = trips.find((entry) => entry.id === id);
    if (trip) return { kind: "certain", trip, how: "id" };
  }
  const text = stripAnswerTags(rawText);
  for (const name of quotedStrings(text)) {
    const found = tripsNamed(name, trips);
    if (found.length === 1) return { kind: "certain", trip: found[0], how: "quoted" };
    if (found.length > 1) return { kind: "ambiguous", candidates: found.slice(0, MAX_CANDIDATES) };
  }
  // The customer matcher skips cancelled, draft and (by default) archived trips; the
  // admin may mean any of them, so every trip is offered as active and mapped back.
  const byId = new Map(trips.map((trip) => [trip.id, trip]));
  const pool = trips.map((trip) => (trip.status === "active" ? trip : { ...trip, status: "active" as const }));
  const matches = findTripMatches(text, pool).map((match) => ({ ...match, trip: byId.get(match.trip.id) ?? match.trip }));
  const contextTrip = tripFromContext(options.context, trips);
  if (!matches.length) {
    return contextTrip ? { kind: "certain", trip: contextTrip, how: "context" } : { kind: "none" };
  }
  const [top] = matches;
  // Close in score, or sharing one of the words that matched the best trip: an alias spelling
  // or a longer name adds points for the customer bot, but does not tell two trips apart.
  const window = matches.filter((match) => top.score - match.score <= AMBIGUOUS_WINDOW
    || match.matchedWords.some((word) => top.matchedWords.includes(word)));
  if (window.length === 1 || normText(text).includes(normText(top.trip.route_name))) return { kind: "certain", trip: top.trip, how: "match" };
  // "бас 12/29-ийг" after a proposal about one of these: the conversation already chose.
  if (contextTrip && window.some((match) => match.trip.id === contextTrip.id) && PRONOUN.test(text)) {
    return { kind: "certain", trip: contextTrip, how: "context" };
  }
  // Several trips share the words typed. The customer matcher's weights (an alias spelling,
  // a longer name) must not decide for the admin: a trip is chosen only when a typed word
  // belongs to it alone, or when the typed date is a departure of exactly one of them.
  const typedPlain = keywordTokens(text);
  const typedPhonetic = phoneticKeywordTokens(text);
  const own = window.map((match) => {
    const aliases = Array.isArray(match.trip.extra?.aliases) ? (match.trip.extra.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string") : [];
    const names = [match.trip.route_name, ...aliases];
    return {
      match,
      plain: new Set(names.flatMap((name) => keywordTokens(name))),
      phonetic: new Set(names.flatMap((name) => phoneticKeywordTokens(name))),
    };
  });
  // A typed word that is in this trip's name or aliases and in no other's: the plain spelling
  // and the phonetic one are compared separately, so a Latin alias ("Norvel") counts as its
  // trip's own word even though every «Норвел» trip sounds the same.
  const distinct = own.filter((entry) =>
    typedPlain.some((token) => entry.plain.has(token) && own.every((other) => other === entry || !other.plain.has(token)))
    || typedPhonetic.some((token) => entry.phonetic.has(token) && own.every((other) => other === entry || !other.phonetic.has(token))));
  if (distinct.length === 1) return { kind: "certain", trip: distinct[0].match.trip, how: "match" };
  const dates = datesIn(text, now);
  if (dates.length) {
    const having = window.filter((match) => knownDepartureDays(match.trip, now).some((day) => dates.includes(day.date)));
    if (having.length === 1) return { kind: "certain", trip: having[0].trip, how: "match" };
  }
  return { kind: "ambiguous", candidates: window.map((match) => match.trip).slice(0, MAX_CANDIDATES) };
}

/* ------------------------------------------------------------------ */
/* Questions and proposals                                             */
/* ------------------------------------------------------------------ */

export type AssistantAskPayload = {
  /** A stable id for the kind of question (trip, date, amount), for logs and tests. */
  id: string;
  text: string;
  options: ProposalQuestionOption[];
  allow_custom?: boolean;
  custom_placeholder?: string;
};

export type BrainOutcome =
  | { kind: "proposal"; proposal: AIChangeProposal; trip: TravelTrip; intent: AssistantIntent }
  | { kind: "ask"; ask: AssistantAskPayload; trip?: TravelTrip; intent: AssistantIntent }
  | { kind: "note"; text: string; trip?: TravelTrip; intent: AssistantIntent }
  | { kind: "defer"; focus: TravelTrip[]; intent: AssistantIntent; resolution: TripResolution };

export type KnownDepartureDay = { date: string; state: DateSeatState | null; onWebsite: boolean };

/** The trip's coming departure days and what the website currently shows for each. */
export function knownDepartureDays(trip: TravelTrip, now = new Date()): KnownDepartureDay[] {
  const today = now.toISOString().slice(0, 10);
  const days = new Map<string, KnownDepartureDay>();
  for (const row of departureAvailability(trip)) {
    if (row.date < today) continue;
    const status = row.status.toUpperCase();
    if (status === "CANCELLED" || status === "DEPARTED") continue;
    const state: DateSeatState = status === "ALMOST_FULL" ? "low" : status === "SOLD_OUT" || row.seatsLeft === 0 ? "full" : "open";
    days.set(row.date, { date: row.date, state, onWebsite: true });
  }
  const listed = (() => { try { return upcomingDepartures(trip, now); } catch { return []; } })();
  for (const date of listed) if (!days.has(date)) days.set(date, { date, state: null, onWebsite: false });
  for (const text of trip.departure_dates) {
    const day = departureDayOf(trip, text, now);
    if (day && day >= today && !days.has(day)) days.set(day, { date: day, state: null, onWebsite: false });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function tripHint(trip: TravelTrip, now: Date): string {
  const parts = [STATUS_WORDS[trip.status] || trip.status];
  const next = knownDepartureDays(trip, now)[0]?.date;
  if (next) parts.push(`дараагийн гаралт ${formatDateMn(next)}`);
  if (typeof trip.adult_price === "number") parts.push(formatMnt(trip.adult_price));
  return parts.join(" · ");
}

export function tripOptions(instruction: string, candidates: TravelTrip[], now = new Date()): ProposalQuestionOption[] {
  return candidates.map((trip) => ({ label: trip.route_name, hint: tripHint(trip, now), answer: withTripTag(instruction, trip) }));
}

function askWhichTrip(instruction: string, candidates: TravelTrip[], intent: AssistantIntent, now: Date, fromAll = false): BrainOutcome {
  return {
    kind: "ask",
    intent,
    ask: {
      id: "trip",
      text: fromAll ? "Аль аяллыг хэлж байна? Нэрийг нь бичээрэй, эсвэл доороос сонгоно уу." : "Аль аяллыг хэлж байна?",
      options: tripOptions(instruction, candidates, now),
      allow_custom: true,
      custom_placeholder: "Аяллын нэрийг бичих…",
    },
  };
}

function baseProposal(summary: string, actions: AITripAction[], extras: Partial<AIChangeProposal> = {}): AIChangeProposal {
  return { summary, needs_confirmation: true, important_reason: "", conflicts: [], conflict_items: [], actions, ...extras };
}

function info(text: string, type: string, route: string) {
  return { text, severity: "info" as const, type, data: { route_name: route } };
}

function buildDateState(trip: TravelTrip, intent: Extract<AssistantIntent, { kind: "date_state" }>, instruction: string, now: Date): BrainOutcome {
  const known = knownDepartureDays(trip, now);
  const label = DATE_STATE_WORDS[intent.state];
  if (intent.wholeTrip) {
    if (intent.state !== "full") return buildStatus(trip, { kind: "status", status: "active" }, instruction);
    return buildStatus(trip, { kind: "status", status: "sold_out" }, instruction);
  }
  let dates = intent.allDates ? known.map((day) => day.date) : intent.dates;
  if (!dates.length) {
    if (known.length === 1) dates = [known[0].date];
    else if (known.length === 0) {
      return {
        kind: "ask", intent, trip,
        ask: {
          id: "date",
          text: `«${trip.route_name}» аялалд ирэх гарах өдөр бүртгэлгүй байна. Аяллыг бүхэлд нь ${intent.state === "full" ? "дүүрсэн" : "идэвхтэй"} болгох уу?`,
          options: [{ label: intent.state === "full" ? "Тийм, аяллыг бүхэлд нь дүүрсэн болго" : "Тийм, аяллыг идэвхжүүл", answer: withDateTag(instruction, WHOLE_TRIP_WORD) }],
          allow_custom: true,
          custom_placeholder: "Эсвэл огноогоо бичнэ үү (ж: 12/27)",
        },
      };
    } else {
      return {
        kind: "ask", intent, trip,
        ask: {
          id: "date",
          text: `«${trip.route_name}» аяллын аль өдрийг «${label}» болгох вэ?`,
          options: [
            ...known.map((day) => ({
              label: formatDateMn(day.date, true),
              hint: day.state ? DATE_STATE_WORDS[day.state] : "вэбсайтад хараахан алга",
              answer: withDateTag(instruction, day.date),
            })),
            { label: "Бүх өдөр", answer: withDateTag(instruction, ALL_DATES_WORD) },
          ],
        },
      };
    }
  }
  const unknown = dates.filter((date) => !known.some((day) => day.date === date));
  if (unknown.length) {
    return {
      kind: "ask", intent, trip,
      ask: {
        id: "date",
        text: `«${trip.route_name}» аялалд ${unknown.map((date) => formatDateMn(date)).join(", ")} гарах өдөр алга. Аль өдрийг хэлж байна?`,
        options: known.map((day) => ({ label: formatDateMn(day.date, true), hint: day.state ? DATE_STATE_WORDS[day.state] : undefined, answer: withDateTag(instruction, day.date) })),
        allow_custom: true,
        custom_placeholder: "Эсвэл зөв огноог бичнэ үү",
      },
    };
  }
  const already = dates.filter((date) => known.find((day) => day.date === date)?.state === intent.state);
  const changing = dates.filter((date) => !already.includes(date));
  if (!changing.length) {
    return { kind: "note", intent, trip, text: `«${trip.route_name}» — ${dates.map((date) => formatDateMn(date)).join(", ")} аль хэдийн «${label}» байна. Өөрчлөх зүйл алга.` };
  }
  const actions: AITripAction[] = changing.map((date) => ({ action: "set_date_state", trip_id: trip.id, date, state: intent.state }));
  const proposal = baseProposal(
    `«${trip.route_name}» — ${changing.map((date) => formatDateMn(date)).join(", ")}-ны өдрийг «${label}» болгоно.`,
    actions,
  );
  if (already.length) proposal.conflict_items!.push(info(`${already.map((date) => formatDateMn(date)).join(", ")} аль хэдийн «${label}» байсан тул хөндөхгүй.`, "date_state_same", trip.route_name));
  const offline = changing.filter((date) => !known.find((day) => day.date === date)?.onWebsite);
  if (offline.length) proposal.conflict_items!.push(info(`${offline.map((date) => formatDateMn(date)).join(", ")} вэбсайтад хараахан нийтлэгдээгүй байна; нийтлэгдсэний дараа төлөв нь орно.`, "date_not_on_website", trip.route_name));
  proposal.conflicts = proposal.conflict_items!.map((item) => item.text);
  return { kind: "proposal", proposal, trip, intent };
}

function buildPrice(trip: TravelTrip, intent: Extract<AssistantIntent, { kind: "price" }>): BrainOutcome {
  const current = `одоо: том хүн ${formatMnt(trip.adult_price)}, хүүхэд ${formatMnt(trip.child_price)}, нярай ${formatMnt(trip.infant_price)}`;
  if (!intent.mentioned) {
    return {
      kind: "ask", intent, trip,
      ask: {
        id: "amount",
        text: `«${trip.route_name}» аяллын шинэ үнэ хэд вэ? (${current})`,
        options: [],
        allow_custom: true,
        custom_placeholder: "Ж: том хүн 4,290,000 / хүүхэд 3,990,000 / нярай 690,000",
      },
    };
  }
  const result = applyFareChange(trip, intent.change);
  if (result.missing.length) {
    const names = result.missing.map((kind) => FARE_WORDS[kind]).join(", ");
    return {
      kind: "ask", intent, trip,
      ask: {
        id: "amount",
        text: `«${trip.route_name}» аялалд ${names} үнэ одоогоор бүртгэлгүй тул харьцангуй өөрчлөлт хийж чадахгүй. Үнийг шууд бичнэ үү. (${current})`,
        options: [],
        allow_custom: true,
        custom_placeholder: `Ж: ${names} 3,990,000`,
      },
    };
  }
  if (!result.changed) return { kind: "note", intent, trip, text: `«${trip.route_name}» аяллын үнэ аль хэдийн ийм байна (${current}).` };
  const proposal = baseProposal(`«${trip.route_name}» — ${result.lines.join(", ")}.`, [{ action: "patch", trip_id: trip.id, fields: result.fields }]);
  for (const note of result.notes) proposal.conflict_items!.push(info(note, "fare_note", trip.route_name));
  proposal.conflicts = proposal.conflict_items!.map((item) => item.text);
  return { kind: "proposal", proposal, trip, intent };
}

function buildStatus(trip: TravelTrip, intent: Extract<AssistantIntent, { kind: "status" }>, instruction: string): BrainOutcome {
  void instruction;
  if (trip.status === intent.status) {
    return { kind: "note", intent, trip, text: `«${trip.route_name}» аль хэдийн ${STATUS_WORDS[intent.status]} байна.` };
  }
  const verb = intent.status === "cancelled" ? "цуцлана" : intent.status === "paused" ? "түр зогсооно" : intent.status === "sold_out" ? "бүхэлд нь дүүрсэн болгоно" : "идэвхжүүлнэ";
  const action: AITripAction = intent.status === "cancelled" ? { action: "cancel", trip_id: trip.id } : { action: "patch", trip_id: trip.id, fields: { status: intent.status } };
  const proposal = baseProposal(`«${trip.route_name}» аяллыг ${verb}.`, [action], {
    important_reason: intent.status === "cancelled" ? "Цуцалсан аялал сайт болон ботоос харагдахаа болино. Хэрэгтэй бол буцааж болно."
      : intent.status === "active" && trip.status === "archived" && !knownDepartureDays(trip).length ? "Ирэх гарах өдөргүй тул идэвхжүүлсэн ч дахин архивт орно — эхлээд огноо нэмээрэй." : "",
  });
  return { kind: "proposal", proposal, trip, intent };
}

function buildArchive(trip: TravelTrip, intent: AssistantIntent): BrainOutcome {
  if (trip.status === "archived") return { kind: "note", intent, trip, text: `«${trip.route_name}» аль хэдийн архивт байна.` };
  const proposal = baseProposal(`«${trip.route_name}» аяллыг архивлана — сайт болон ботоос харагдахаа болино.`, [{ action: "delete", trip_id: trip.id }], {
    important_reason: "Бичлэг, зураг, түүх хадгалагдана; буцаах боломжтой.",
  });
  return { kind: "proposal", proposal, trip, intent };
}

function buildPatch(trip: TravelTrip, intent: AssistantIntent, summary: string, fields: TripMutationFields, notes: string[] = []): BrainOutcome {
  const proposal = baseProposal(summary, [{ action: "patch", trip_id: trip.id, fields }]);
  for (const note of notes) proposal.conflict_items!.push(info(note, "schedule_note", trip.route_name));
  proposal.conflicts = proposal.conflict_items!.map((item) => item.text);
  return { kind: "proposal", proposal, trip, intent };
}

function buildForTrip(trip: TravelTrip, intent: AssistantIntent, instruction: string, now: Date): BrainOutcome {
  switch (intent.kind) {
    case "date_state": return buildDateState(trip, intent, instruction, now);
    case "price": return buildPrice(trip, intent);
    case "status": return buildStatus(trip, intent, instruction);
    case "archive": return buildArchive(trip, intent);
    case "seats": {
      if (intent.seats_total != null) {
        if (trip.seats_total === intent.seats_total) return { kind: "note", intent, trip, text: `«${trip.route_name}» — нийт суудал аль хэдийн ${intent.seats_total}.` };
        return buildPatch(trip, intent, `«${trip.route_name}» — нийт суудал ${trip.seats_total ?? "тодорхойгүй"} → ${intent.seats_total}.`, { seats_total: intent.seats_total });
      }
      if (trip.seats_left === intent.seats_left) return { kind: "note", intent, trip, text: `«${trip.route_name}» — үлдсэн суудал аль хэдийн ${intent.seats_left}.` };
      return buildPatch(trip, intent, `«${trip.route_name}» — үлдсэн суудал ${trip.seats_left ?? "тодорхойгүй"} → ${intent.seats_left}.`, { seats_left: intent.seats_left },
        intent.seats_left === 0 ? ["0 суудал бол энэ аялал дүүрсэн гэж харагдана. Нэг л огноо дүүрсэн бол «12/27 дүүрсэн» гэж бичээрэй."] : []);
    }
    case "food": {
      if (trip.has_food === intent.has_food) return { kind: "note", intent, trip, text: `«${trip.route_name}» — хоол аль хэдийн ${intent.has_food ? "багтсан" : "багтаагүй"} гэж бүртгэлтэй.` };
      return buildPatch(trip, intent, `«${trip.route_name}» — хоол ${intent.has_food ? "багтсан" : "багтаагүй"}.`, { has_food: intent.has_food });
    }
    case "rename": {
      if (norm(trip.route_name) === norm(intent.name)) return { kind: "note", intent, trip, text: `«${trip.route_name}» нэр аль хэдийн ийм байна.` };
      const aliases = (Array.isArray(trip.extra?.aliases) ? (trip.extra.aliases as unknown[]).filter((alias): alias is string => typeof alias === "string") : []);
      const keepOld = aliases.some((alias) => norm(alias) === norm(trip.route_name)) ? aliases : [...aliases, trip.route_name];
      return buildPatch(trip, intent, `«${trip.route_name}» → «${intent.name}».`, { route_name: intent.name, extra: { aliases: keepOld } },
        ["Хуучин нэр өөр нэршил болж үлдэнэ, бот хуучин нэрээр нь ч олно."]);
    }
    case "hotel": {
      if (norm(trip.hotel || "") === norm(intent.hotel)) return { kind: "note", intent, trip, text: `«${trip.route_name}» — буудал аль хэдийн ийм байна.` };
      return buildPatch(trip, intent, `«${trip.route_name}» — буудал: ${trip.hotel ? `${trip.hotel} → ` : ""}${intent.hotel}.`, { hotel: intent.hotel });
    }
    case "dates": {
      const added = intent.add.length ? addDepartureDates(trip, intent.add, now) : null;
      const removed = intent.remove.length ? removeDepartureDates(trip, intent.remove, now) : null;
      const fields: TripMutationFields = {};
      const parts: string[] = [];
      const notes = [...(added?.notes ?? []), ...(removed?.notes ?? [])];
      if (added?.added.length) { Object.assign(fields, added.fields); parts.push(`${added.added.map((date) => formatDateMn(date)).join(", ")} гаралт нэмнэ`); }
      if (removed?.removed.length) {
        // Both in one instruction: the removal is applied to the list the addition produced.
        const base = fields.departure_dates ?? trip.departure_dates;
        const after = removeDepartureDates({ ...trip, departure_dates: base, extra: { ...trip.extra, ...(fields.extra || {}) } }, intent.remove, now);
        Object.assign(fields, after.fields);
        parts.push(`${removed.removed.map((date) => formatDateMn(date)).join(", ")} гаралтыг хасна`);
      }
      if (!parts.length) return { kind: "note", intent, trip, text: `«${trip.route_name}» — ${notes.join(" ") || "огноонд өөрчлөх зүйл алга."}` };
      return buildPatch(trip, intent, `«${trip.route_name}» — ${parts.join("; ")}.`, fields, notes);
    }
    default:
      return { kind: "defer", focus: [trip], intent, resolution: { kind: "certain", trip, how: "match" } };
  }
}

function recentTrips(trips: TravelTrip[]): TravelTrip[] {
  return [...trips]
    .filter((trip) => trip.status !== "archived" && trip.status !== "cancelled")
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, MAX_CANDIDATES);
}

/**
 * The assistant's decision for one typed instruction: an exact proposal, one question
 * with choices, a short note when nothing would change, or "defer" (the model reads it,
 * told which trips it most likely concerns).
 */
export function think(input: { text: string; trips: TravelTrip[]; now?: Date; context?: string }): BrainOutcome {
  const now = input.now ?? new Date();
  const instruction = input.text.trim();
  const intent = parseIntent(instruction, now);
  const resolution = resolveTrip(instruction, input.trips, { context: input.context, now });
  if (intent.kind === "unknown") {
    const focus = resolution.kind === "certain" ? [resolution.trip] : resolution.kind === "ambiguous" ? resolution.candidates.slice(0, 3) : [];
    return { kind: "defer", focus, intent, resolution };
  }
  if (resolution.kind === "ambiguous") return askWhichTrip(stripAnswerTags(instruction), resolution.candidates, intent, now);
  if (resolution.kind === "none") return askWhichTrip(stripAnswerTags(instruction), recentTrips(input.trips), intent, now, true);
  return buildForTrip(resolution.trip, intent, stripAnswerTags(instruction), now);
}

/* ------------------------------------------------------------------ */
/* Model proposals: bind their targets, answer their questions in code */
/* ------------------------------------------------------------------ */

const TRIP_QUESTION = "trip:";

function actionName(action: AITripAction): string {
  return String(action.match?.route_name || action.fields?.route_name || "").trim();
}

/**
 * A model action that names its trip (`match`) instead of identifying it: resolve the
 * name the way the admin's own words are resolved. One clear trip binds the action; several
 * become a question with the candidates as choices (the action waits inside the question);
 * none is left for the validator to report.
 */
export function bindActionTargets(proposal: AIChangeProposal, trips: TravelTrip[], now = new Date()): { bound: number; asked: number } {
  let bound = 0;
  let asked = 0;
  const remaining: AITripAction[] = [];
  const questions = [...(proposal.questions || [])];
  for (const action of proposal.actions) {
    const verb = String(action.action || "").toLowerCase();
    const name = actionName(action);
    if (action.trip_id || !action.match || !name || (verb === "upsert" && !action.match.route_name)) { remaining.push(action); continue; }
    const resolution = resolveTrip(`«${name}»`, trips, { now });
    const byMatch = resolution.kind === "none" ? resolveTrip(name, trips, { now }) : resolution;
    if (byMatch.kind === "certain") {
      remaining.push({ ...action, trip_id: byMatch.trip.id, match: undefined });
      bound += 1;
      continue;
    }
    if (byMatch.kind === "ambiguous" && verb !== "upsert") {
      const id = `${TRIP_QUESTION}${asked + questions.length + 1}`;
      questions.push({
        id,
        prompt: `«${name}» гэж аль аяллыг хэлж байна?`,
        detail: `Ижил төстэй ${byMatch.candidates.length} аялал байна.`,
        options: byMatch.candidates.map((trip) => ({ label: trip.route_name, hint: tripHint(trip, now), answer: `«${trip.route_name}» [аялал: «${trip.route_name}» trip_id=${trip.id}] (${id})` })),
        allow_custom: true,
        custom_placeholder: "Эсвэл аяллын нэрийг яг бичнэ үү",
        data: { action, route_name: name },
      });
      asked += 1;
      continue;
    }
    remaining.push(action);
  }
  if (asked) {
    proposal.actions = remaining;
    proposal.questions = questions;
    proposal.needs_confirmation = true;
    // The validator's own "several trips match" blocker would drop the waiting action; the
    // question replaces it.
    const names = new Set(questions.map((question) => String(question.data?.route_name || "")));
    proposal.conflict_items = (proposal.conflict_items || []).filter((item) => !(item.severity === "blocker" && [...names].some((name) => name && item.text.includes(name))));
    proposal.conflicts = proposal.conflict_items.map((item) => item.text);
  } else if (bound) {
    proposal.actions = remaining;
  }
  return { bound, asked };
}

/**
 * The admin tapped a trip for a "which trip" question: the waiting action gets its id and
 * returns to the proposal, and the question is closed. True when something was resolved.
 */
export function applyTripChoice(clarification: string, proposal: AIChangeProposal, trips: TravelTrip[]): boolean {
  const tripId = tripIdFromText(clarification);
  if (!tripId || !trips.some((trip) => trip.id === tripId)) return false;
  const questions = proposal.questions || [];
  const questionId = /\((trip:\d+)\)/.exec(clarification)?.[1];
  const waiting = questions.filter((question) => question.id.startsWith(TRIP_QUESTION) && (!questionId || question.id === questionId));
  let changed = false;
  for (const question of waiting) {
    const action = question.data?.action as AITripAction | undefined;
    if (action && typeof action === "object") {
      proposal.actions.push({ ...action, trip_id: tripId, match: undefined });
    }
    changed = true;
  }
  if (!changed) {
    // No stashed question: bind every action that still only names its trip.
    for (const action of proposal.actions) {
      if (!action.trip_id && action.match) { action.trip_id = tripId; action.match = undefined; changed = true; }
    }
  }
  if (changed) {
    proposal.questions = questions.filter((question) => !waiting.includes(question));
    if (!proposal.questions.length) delete proposal.questions;
  }
  return changed;
}

/** True when the proposal still waits on an answer the admin has to give. */
export function hasOpenQuestions(proposal: AIChangeProposal): boolean {
  return Boolean(proposal.questions && proposal.questions.length > 0);
}

/** The trips an instruction most likely concerns, for a model prompt (empty when none). */
export function focusTripsFor(text: string, trips: TravelTrip[], context?: string, now = new Date()): TravelTrip[] {
  const resolution = resolveTrip(text, trips, { context, now });
  if (resolution.kind === "certain") return [resolution.trip];
  if (resolution.kind === "ambiguous") return resolution.candidates.slice(0, 3);
  return [];
}
