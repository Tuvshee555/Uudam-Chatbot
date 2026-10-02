/**
 * Which trip is this message about? One AI step answers that the way a person
 * reads it — Cyrillic, Latin spelling, typos, "тэр", "1", a follow-up with no
 * trip name — instead of dozens of keyword rules each taking its own guess.
 * The model can only pick keys from the catalog it is shown, so it cannot
 * invent a trip; code then checks every pick against the trip data (date,
 * date range, month, length, transport) before anything is answered.
 */
import type { TravelTrip } from "./travelTypes";
import {
  getAliases,
  tripDurationDays,
  tripIsCruise,
  tripIsDirectFlight,
  tripIsLandFlightCombo,
  tripMatchesRequestedDuration,
  withFutureDepartureDates,
} from "./travelFastPathsSearch";
import { keywordTokens, normText, phoneticLatinText } from "./travelTextNorm";
import { tripDepartsInMonth, tripMatchesRequestedDate } from "./travelDates";

export type TripIntent = "trip" | "catalog" | "booking" | "human" | "smalltalk" | "other";
export type Transport = "direct_flight" | "land" | "land_flight" | "cruise";

export type Understanding = {
  intent: TripIntent;
  /** The destination / trip words the customer used, if any. */
  place: string | null;
  /** Trips the message is about, after the code checks below. */
  trips: TravelTrip[];
  certainty: "one" | "several" | "none";
  date: string | null;
  range: [string, string] | null;
  month: number | null;
  days: [number, number] | null;
  transport: Transport | null;
  /** A requirement the customer stated that none of the trips meets. */
  unmet: "date" | "range" | "month" | "days" | "transport" | null;
  /** A specific destination the customer asked for that no trip goes to. */
  unknownDestination: string | null;
};

export type UnderstandingHistory = Array<{ role: "user" | "assistant"; text: string }>;

/** The model call, injected so routing stays testable without the network. */
export type AskJson = (systemText: string, userText: string) => Promise<string | null>;

const HISTORY_TURNS = 6;
const HISTORY_CHARS = 350;
const DATES_SHOWN = 8;
const MAX_RANGE_DAYS = 62;
const INTENTS: TripIntent[] = ["trip", "catalog", "booking", "human", "smalltalk", "other"];
const TRANSPORTS: Transport[] = ["direct_flight", "land", "land_flight", "cruise"];

function mongoliaToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

function catalogLine(key: string, trip: TravelTrip, now: Date): string {
  const aliases = getAliases(trip).filter((alias) => alias.trim() && alias.trim() !== trip.route_name.trim());
  const dates = withFutureDepartureDates(trip, now).departure_dates.slice(0, DATES_SHOWN).join(", ");
  return [
    key,
    trip.route_name + (aliases.length ? ` (бас: ${aliases.slice(0, 6).join(", ")})` : ""),
    trip.duration_text || "?",
    `гарах: ${dates || "—"}`,
    trip.status === "sold_out" ? "суудал дууссан" : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

const SYSTEM_RULES = `You read customer messages for a Mongolian travel agency's chat and decide which catalog trip(s) a message is about. Customers write Mongolian in Cyrillic or Latin letters (e.g. "aylal" = аялал, "une" = үнэ, "hutulbur" = хөтөлбөр, "avi" = авъя), with typos, missing spaces and slang. Reply with ONLY this JSON object:
{"place": string|null, "intent": "trip"|"catalog"|"booking"|"human"|"smalltalk"|"other", "trips": ["T1"], "certainty": "one"|"several"|"none", "date": "YYYY-MM-DD"|null, "from": "YYYY-MM-DD"|null, "to": "YYYY-MM-DD"|null, "month": 1-12|null, "days": [min,max]|null, "transport": "direct_flight"|"land"|"land_flight"|"cruise"|null, "unknown_destination": string|null}

place: the destination / trip words the CUSTOMER used in this message (any spelling), or null if they named none.

trips — catalog keys ONLY, never invent one:
1. Match the customer's place words against the trip names and aliases by meaning, across Cyrillic/Latin spellings and typos.
2. If one trip's name matches the customer's words clearly better than every other (they named a combination of places only that trip has, or typed most of its name), that trip alone, certainty "one".
3. If their place word is shared by several trips (a city or landmark several names contain), return ALL of those trips, certainty "several" — then keep only the ones that fit an explicit date, date range, month, length or transport they stated. If none fit, still return them (code reports the mismatch).
4. No place in the message: a follow-up ("үнэ хэд вэ", "хүүхэд хэд вэ", "1.5 настай", "цаг агаар", "тэр", "нь", a date, ages, a head count, a hotel question, a transport wish such as "нэг талдаа нисэх", "авъя"/"avi"/"захиалъя") is about the trip in focus — the one the bot's last reply was about, or ALL trips of the bot's last list — and any requirement it states applies to those trips. A bare number or "2." after the bot listed trips picks that item.
4b. Two destinations joined by "болон", "ба", "bolon", "," or "+" that NO single trip covers together → the trips of BOTH destinations, certainty "several".
5. A question about a KIND of trip with no place ("сурагчдын амралтаар", "далайн эрэг", "хүүхэдтэй") → the trips whose names show that kind, certainty "several", intent "catalog".
6. Generic words never identify a trip: аялал, үнэ, мэдээлэл, хөтөлбөр, зураг, захиалга, greetings. A common word that happens to sit inside a trip name is not a match unless the customer means that trip.
7. The destination is not in the catalog, or nothing is meant: trips [] and certainty "none".

unknown_destination: when the customer asks for a specific city or country that NO catalog trip visits, that place name as they wrote it; otherwise null.

intent:
- "trip": about a trip or destination (price, dates, seats, program, photos, hotel, weather, children, what is included, head count), or continuing about the trip in focus. Use this whenever "place" is not null.
- "catalog": what trips exist in general / in a month / of a kind, with NO place named and no trip in focus.
- "booking": wants to book/register, no trip named or in focus. "human": asks for a person. "smalltalk": greeting, thanks, emoji, ok. "other": anything else.

Requirements — fill ONLY when the customer states them in this message; never infer:
- date: one departure date they ask about, YYYY-MM-DD. A date without a year is the next one on or after today.
- from/to: a span of departure dates they ask about ("10/31-11/4", "10 сарын 20-оос 31") — both ends, YYYY-MM-DD.
- month: a month they ask about (1-12) when no exact date or span.
- days: trip length ONLY when they use хоног / өдөр / шөнө / day with a number ("5-6 хоног" → [5,6]). "од", "одтой", "odtoi" means hotel STARS, never days.
- transport: "шууд нислэг" = direct_flight, "газрын"/"газраар"/"автобус"/"галт тэрэг" = land, a mix such as "газраар явж нислэгээр ирэх" or "хосолсон" = land_flight, "усан онгоц"/"круз" = cruise.`;

export function buildUnderstandingPrompt(input: {
  text: string;
  history: UnderstandingHistory;
  trips: TravelTrip[];
  pendingTripIds?: string[];
  now?: Date;
}): { system: string; user: string; keys: Map<string, TravelTrip> } {
  const now = input.now ?? new Date();
  const catalog = input.trips.filter((trip) => trip.status === "active" || trip.status === "sold_out");
  const keys = new Map<string, TravelTrip>();
  const lines = catalog.map((trip, index) => {
    const key = `T${index + 1}`;
    keys.set(key, trip);
    return catalogLine(key, trip, now);
  });
  const keyOf = new Map([...keys].map(([key, trip]) => [trip.id, key]));
  // Callers differ on whether history already holds the current message.
  const last = input.history[input.history.length - 1];
  const prior =
    last?.role === "user" && last.text.trim() === input.text.trim() ? input.history.slice(0, -1) : input.history;
  const recent = prior.slice(-HISTORY_TURNS).map((message) => {
    const body = message.text.replace(/\s+/g, " ").trim().slice(0, HISTORY_CHARS);
    return `${message.role === "user" ? "Customer" : "Bot"}: ${body}`;
  });
  const pending = (input.pendingTripIds || []).map((id) => keyOf.get(id)).filter(Boolean);
  const user = [
    `Today: ${mongoliaToday(now)}`,
    "",
    "Catalog (key | name | length | next departures):",
    ...lines,
    "",
    "Conversation so far:",
    ...(recent.length ? recent : ["(none)"]),
    ...(pending.length ? ["", `Bot's last numbered trip list, in order: ${pending.map((key, i) => `${i + 1}=${key}`).join(", ")}`] : []),
    "",
    `Customer's new message: ${input.text.trim()}`,
  ].join("\n");
  return { system: SYSTEM_RULES, user, keys };
}

function parseDays(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const nums = value.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n < 60);
  if (nums.length === 0) return null;
  return [Math.min(...nums), Math.max(...nums)];
}

const isYmd = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00Z`);
  const end = new Date(`${to}T00:00:00Z`);
  for (let d = start; d <= end && out.length <= MAX_RANGE_DAYS; d = new Date(d.getTime() + 86_400_000)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function transportFits(trip: TravelTrip, transport: Transport): boolean {
  if (transport === "land_flight") return tripIsLandFlightCombo(trip);
  if (transport === "direct_flight") return tripIsDirectFlight(trip) && !tripIsLandFlightCombo(trip);
  if (transport === "cruise") return tripIsCruise(trip);
  return !tripIsLandFlightCombo(trip) && !tripIsDirectFlight(trip) && !tripIsCruise(trip);
}

/** "жинин" matches "жинин", and a stem matches its suffixed form ("бээжин" ~ "бээжингийн"). */
function wordMatches(word: string, token: string): boolean {
  if (word === token) return true;
  return Math.min(word.length, token.length) >= 4 && (word.startsWith(token) || token.startsWith(word));
}

/**
 * The model sometimes lists several trips when the customer's words name one:
 * "<A>-<B>" when only one trip visits both. Keep the single trip whose name
 * (or alias) contains every place word the customer used — only when they used
 * two or more, so one shared city never narrows to an arbitrary trip.
 */
function narrowByPlaceWords(place: string, trips: TravelTrip[]): TravelTrip[] {
  const tokens = keywordTokens(place).filter((token) => token.length >= 3);
  if (tokens.length < 2) return trips;
  const covering = trips.filter((trip) => {
    const text = [trip.route_name, ...getAliases(trip)].join(" ");
    const words = normText(text).split(/\s+/);
    const phonetic = phoneticLatinText(text).split(/\s+/);
    return tokens.every(
      (token) =>
        words.some((word) => wordMatches(word, token)) ||
        phonetic.some((word) => wordMatches(word, phoneticLatinText(token))),
    );
  });
  return covering.length === 1 ? covering : trips;
}

/**
 * Turns the model's JSON into an Understanding, keeping only real catalog
 * trips and re-checking every stated requirement against the trip data.
 */
export function interpretUnderstanding(raw: string, keys: Map<string, TravelTrip>, now = new Date()): Understanding | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|```\s*$/g, ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const place = typeof parsed.place === "string" && parsed.place.trim() ? parsed.place.trim() : null;
  let intent = INTENTS.includes(parsed.intent as TripIntent) ? (parsed.intent as TripIntent) : "other";
  // A named place is never a general catalog question, whatever the label.
  if (place && intent === "catalog") intent = "trip";
  const picked = (Array.isArray(parsed.trips) ? parsed.trips : [])
    .map((key) => keys.get(String(key).trim()))
    .filter((trip): trip is TravelTrip => Boolean(trip));
  const trips = [...new Map(picked.map((trip) => [trip.id, trip])).values()];
  const date = isYmd(parsed.date) ? parsed.date : null;
  const range: [string, string] | null =
    !date && isYmd(parsed.from) && isYmd(parsed.to) && parsed.from <= parsed.to ? [parsed.from, parsed.to] : null;
  const monthNum = Number(parsed.month);
  const month = Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12 && !date && !range ? monthNum : null;
  const days = parseDays(parsed.days);
  const transport = TRANSPORTS.includes(parsed.transport as Transport) ? (parsed.transport as Transport) : null;
  const unknownRaw = typeof parsed.unknown_destination === "string" ? parsed.unknown_destination.trim() : "";
  const unknownDestination = unknownRaw && trips.length === 0 ? unknownRaw.replace(/[«»"]/g, "").slice(0, 40) : null;

  // The model narrows by the customer's requirements; code confirms each one
  // against the data. A requirement nothing meets keeps the destination's
  // trips and is reported, so the reply says so instead of passing a near
  // miss off as an answer.
  let unmet: Understanding["unmet"] = null;
  let fitting = trips;
  const checks: Array<[NonNullable<Understanding["unmet"]>, (trip: TravelTrip) => boolean]> = [];
  if (transport) checks.push(["transport", (trip) => transportFits(trip, transport)]);
  if (date) checks.push(["date", (trip) => tripMatchesRequestedDate(trip, date, now)]);
  if (range) {
    const span = daysBetween(range[0], range[1]);
    checks.push(["range", (trip) => span.some((ymd) => tripMatchesRequestedDate(trip, ymd, now))]);
  }
  if (month) checks.push(["month", (trip) => tripDepartsInMonth(trip, month, now)]);
  if (days) checks.push(["days", (trip) => tripDurationDays(trip) === null || tripMatchesRequestedDuration(trip, days)]);
  for (const [name, ok] of checks) {
    const kept = fitting.filter(ok);
    if (kept.length === 0 && fitting.length > 0) {
      unmet = name;
      break;
    }
    fitting = kept;
  }
  if (!unmet && place && fitting.length > 1) fitting = narrowByPlaceWords(place, fitting);
  // A sold-out trip is not a real alternative to a bookable one leaving the
  // same way — asking "which of these?" between them is a needless question.
  if (fitting.length > 1) {
    const bookable = fitting.filter((trip) => trip.status !== "sold_out");
    if (bookable.length > 0) fitting = bookable;
  }

  const certainty: Understanding["certainty"] =
    fitting.length === 0 ? "none" : fitting.length === 1 ? "one" : "several";
  return { intent, place, trips: fitting, certainty, date, range, month, days, transport, unmet, unknownDestination };
}

const TRANSPORT_LABEL: Record<Transport, string> = {
  direct_flight: "Шууд нислэгтэй",
  land: "Газрын",
  land_flight: "Газар + нислэг хосолсон",
  cruise: "Усан онгоцны",
};

const mdLabel = (ymd: string) => `${Number(ymd.slice(5, 7))} сарын ${Number(ymd.slice(8, 10))}`;

/**
 * Mongolian note shown above the trip list when a stated requirement has no
 * match. Worded to avoid the no-data silence patterns in reply.ts ("… гарах
 * аялал алга байна"), which would otherwise swallow the whole answer.
 */
export function unmetNote(understanding: Understanding): string | undefined {
  switch (understanding.unmet) {
    case "days": {
      const [a, b] = understanding.days!;
      return `${a === b ? a : `${a}-${b}`} өдрийн аялал одоогоор алга байна. Энэ чиглэлийн аяллууд:`;
    }
    case "date":
      return `${mdLabel(understanding.date!)}-нд гарах хуваарь байхгүй. Энэ чиглэлийн гарах өдрүүд:`;
    case "range":
      return `${mdLabel(understanding.range![0])} – ${mdLabel(understanding.range![1])}-ны хооронд гарах хуваарь байхгүй. Энэ чиглэлийн гарах өдрүүд:`;
    case "month":
      return `${understanding.month} сард гарах хуваарь байхгүй. Энэ чиглэлийн гарах өдрүүд:`;
    case "transport":
      return `${TRANSPORT_LABEL[understanding.transport!]} аялал энэ чиглэлд одоогоор байхгүй. Энэ чиглэлийн аяллууд:`;
    default:
      return undefined;
  }
}

/** Honest answer for a destination no trip goes to. */
export function notInCatalogReply(place: string): string {
  return `Уучлаарай, «${place}» чиглэлийн аялал одоогоор манайд байхгүй байна.`;
}

export async function understandTripMessage(input: {
  text: string;
  history: UnderstandingHistory;
  trips: TravelTrip[];
  pendingTripIds?: string[];
  ask: AskJson;
  now?: Date;
}): Promise<Understanding | null> {
  const { system, user, keys } = buildUnderstandingPrompt(input);
  if (keys.size === 0) return null;
  const raw = await input.ask(system, user).catch(() => null);
  if (!raw) return null;
  return interpretUnderstanding(raw, keys, input.now);
}

/** True when trip understanding should run (it can be switched off without a deploy). */
export function tripUnderstandingEnabled(): boolean {
  return (process.env.TRIP_UNDERSTANDING || "on").toLowerCase() !== "off";
}
