import type { Understanding } from "./tripUnderstanding";
import type { TravelTrip } from "./travelTypes";
import { stripTripNamesForIntent } from "./customerTurn";
import { resolveRequestedDate, resolveRequestedMonth, resolveRequestedRange } from "./travelDates";
import { hasDurationIntent, hasIncludedInPriceIntent, hasPriceIntent, hasScheduleIntent } from "./travelFastPathsPricing";
import { queryRequestsDurationDays, queryWantsDirectFlight, queryWantsLandFlightCombo, queryWantsLandOnlyEnhanced } from "./travelFastPathsSearch";
import { normalizeTripOffers } from "./tripOffers";
import { normText, phoneticLatinText } from "./travelTextNorm";
import type { TripTransport } from "./tripFacts";
import { parseRequestedFacts, requestedFactsFromText, type RequestedFact } from "./requestedFacts";

export const TRIP_TOPICS = ["price", "availability", "dates", "hotel", "duration", "transport", "program", "includes", "booking_terms", "weather", "photos", "comparison", "budget", "discount"] as const;
export type TripTopic = typeof TRIP_TOPICS[number];
export type RequestedPassenger = { kind: "adult" | "child" | "infant"; count: number; age?: number; ageUnit?: "year" | "month" };
export type TripSelection = { tripId: string; date: string | null; hotel: string | null; package: string | null; passengers: RequestedPassenger[] };
export type TripRequest = {
  topics: TripTopic[];
  date: string | null;
  hotel: string | null;
  package: string | null;
  passengers: RequestedPassenger[];
  days: [number, number] | null;
  month: number | null;
  year: number | null;
  range?: [string, string] | null;
  transport?: TripTransport | null;
  unsupportedDateWindow?: boolean;
  requestedFacts?: RequestedFact[];
};

export function parseRequestedPassengers(value: unknown): RequestedPassenger[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Record<string, unknown>;
    const count = Number(row.count);
    const age = row.age === null || row.age === undefined ? undefined : Number(row.age);
    const ageUnit = row.ageUnit;
    if (ageUnit !== undefined && ageUnit !== "year" && ageUnit !== "month") return [];
    if (!Number.isInteger(count) || count < 1 || count > 100 || (age !== undefined && (!Number.isFinite(age) || age < 0 || age > (ageUnit === "month" ? 1440 : 120)))) return [];
    const kind = row.kind;
    if (kind !== "adult" && kind !== "child" && kind !== "infant") return [];
    return [{ kind, count, ...(age === undefined ? {} : { age }), ...(ageUnit ? { ageUnit } : {}) }];
  });
}

export function requestedPassengersFromText(text: string): RequestedPassenger[] {
  const result: RequestedPassenger[] = [];
  for (const match of text.matchAll(/(\d{1,2})\s*(том\s*хүн|том|adult(?:s)?|tom\s*hun|хүүхэд|huuhed|child(?:ren)?|нярай|nyarai|infant(?:s)?)/gi)) {
    const kind = /том|adult|tom/i.test(match[2]) ? "adult" : /нярай|nyarai|infant/i.test(match[2]) ? "infant" : "child";
    if (Number(match[1]) > 0) result.push({ kind, count: Number(match[1]) });
  }
  const ages: Array<{ age: number; ageUnit: "year" | "month" }> = [];
  for (const match of text.matchAll(/(\d{1,2}(?:\.\d+)?(?:\s*[,/]\s*\d{1,2}(?:\.\d+)?)*)\s*(настай|nas(?:tai)?|years?\s*old|сартай|months?\s*old)/gi)) {
    const parts = match[1].split(/\s*[,/]\s*/);
    // An unspaced comma may mean a decimal age. Do not guess without a count.
    const childCount = result.filter((row) => row.kind !== "adult").reduce((sum, row) => sum + row.count, 0);
    if (/\d,\d/.test(match[1]) && childCount !== parts.length) continue;
    for (const part of parts) if (Number.isFinite(Number(part))) ages.push({ age: Number(part), ageUnit: /сартай|month/i.test(match[2]) ? "month" : "year" });
  }
  // Explicit ages replace an unqualified child count, never silently invent ages.
  if (ages.length) {
    const adults = result.filter((row) => row.kind === "adult");
    const childCount = result.filter((row) => row.kind !== "adult").reduce((sum, row) => sum + row.count, 0);
    if (childCount > ages.length) return result;
    return [...adults, ...ages.map(({ age, ageUnit }) => {
      const years = ageUnit === "month" ? age / 12 : age;
      return { kind: (years < 2 ? "infant" : years < 12 ? "child" : "adult") as RequestedPassenger["kind"], count: 1, age, ...(ageUnit === "month" ? { ageUnit } : {}) };
    })];
  }
  return result;
}

/** One topic set is reused by the answer planner and legacy fallbacks. */
export function buildTripRequest(text: string, trips: TravelTrip[], understanding?: Partial<Understanding>, now = new Date()): TripRequest {
  const turn = stripTripNamesForIntent(text, trips);
  const topics = new Set<TripTopic>(understanding?.topics || []);
  const asksIncludes = hasIncludedInPriceIntent(turn);
  const priceTurn = turn.replace(/(?<!\d)\d{1,2}\s*(?:-?р\s*)?сар(?:ын|д)(?!\p{L})/giu, " ");
  if (hasPriceIntent(priceTurn) && (!asksIncludes || /үнэ.{0,12}хэд|хэд.{0,12}үнэ|хэдэн\s*төг|(?:price|cost|une).{0,12}(?:how|hed)/i.test(turn))) topics.add("price");
  // "Урьдчилгаа хэд вэ" asks the deposit, not the trip price; "хэд вэ" alone made it a price question
  // and the customer got the full fare card instead of an answer about the deposit.
  if (/урьдчилгаа|deposit|uridchilgaa/i.test(turn) && !/үнэ|une|price|төгрөг/i.test(turn)) topics.delete("price");
  if (hasDurationIntent(turn)) topics.add("duration");
  if (hasScheduleIntent(turn)) topics.add("dates");
  if (asksIncludes) topics.add("includes");
  const patterns: Array<[TripTopic, RegExp]> = [
    ["availability", /суудал|дүүрсэн|сул|боломжтой|байгаа\s*юу|байна\s*уу|available|seat|suudal/i],
    ["hotel", /буудал|hotel|buudal|\d\s*(?:од|od)|одтой/i],
    ["transport", /нислэг|онгоц|газраар|автобус|галт\s*тэрэг|nisleg|flight|transport/i],
    ["program", /хөтөлбөр|hutulbur|program|itinerary/i],
    ["booking_terms", /виз|паспорт|урьдчилгаа|цуцл|буцаалт|бичиг\s*баримт|visa|deposit|cancel/i],
    ["weather", /цаг\s*агаар|weather|tsag\s*agaar|хүйтэн|дулаан/i],
    ["photos", /зураг|photo|zurag/i],
    ["comparison", /харьцуул|ялгаа|compare/i],
    ["budget", /хамгийн\s*хямд|төсөв|budget|cheapest/i],
    ["discount", /хямдрал|discount|promo/i],
    // Latin-typed follow-ups ("hezee garah ve", "hool bagtsan uu") and the meeting point / solo
    // traveller questions found no topic and fell to silence when the model was not consulted.
    ["dates", /hezee|garah\s*(?:udur|odor|ognoo)|ogno|хэзээ|огноо/i],
    ["duration", /hed\s*honog|honog|hugatsaa/i],
    ["includes", /bagts|hool|orson\s*(?:uu|yu)|ганцаараа|ganz?aaraa|single/i],
    ["program", /hotolbor|xutulbur|hutulbr|цуглах|уулзах|tsuglah|uulzah|marshrut|маршрут/i],
    ["availability", /\b(?:bga|bgaa|bn\s*uu|bnu|baigaa)\b/i],
  ];
  for (const [topic, pattern] of patterns) if (pattern.test(turn)) topics.add(topic);
  // "бээжин шууд нислэгтэй аялал" names the trip by its kind; it does not ask how one
  // travels. Read as a transport question it got only "Шууд нислэгтэй аялал." (2026-10-18).
  // Transport is the question only when the message asks something.
  if (!/[?？]|(?:^|[^\p{L}])(?:уу|үү|юу|юү|вэ|бэ|yu|uu|ve|be|vee|ямар|хэд\p{L}*|хэзээ|яаж|хэрхэн|эсэх|how|what|which|when|does|is)(?:[^\p{L}]|$)/iu.test(turn)) topics.delete("transport");
  // Model fields supplement the customer's words; they never replace an
  // independently readable constraint or turn a span into one departure.
  const requestedRange = resolveRequestedRange(turn, now);
  const explicitDate = requestedRange ? null : resolveRequestedDate(turn, now)?.ymd || null;
  const requestedMonth = requestedRange || explicitDate ? null : resolveRequestedMonth(turn, now);
  const date = explicitDate;
  const range: [string, string] | null = requestedRange && requestedRange !== "unsupported"
    ? [requestedRange.startYmd, requestedRange.endYmd]
    : null;
  if (date) topics.add("availability");
  const explicitPassengers = requestedPassengersFromText(turn);
  const passengerLanguage = /том\s*хүн|хүүх|нярай|настай|сартай|tom\s*hun|huuhe|nyarai|nas(?:tai)?|adult|child|infant|years?\s*old|months?\s*old/i.test(turn);
  const passengers = explicitPassengers.length ? explicitPassengers : passengerLanguage ? parseRequestedPassengers(understanding?.passengers) : [];
  if (passengers.length) topics.add("price");
  const hotels = [...new Set(trips.flatMap((trip) => [trip.hotel, ...normalizeTripOffers(trip, now).map((offer) => offer.hotel)]).filter((hotel): hotel is string => Boolean(hotel && hotel.length >= 3)))];
  const mentions = (value: string) => {
    const normalized = normText(value);
    const phonetic = phoneticLatinText(value);
    return normalized.length >= 3 && (normText(turn).includes(normalized)
      || phonetic.length >= 3 && phoneticLatinText(turn).includes(phonetic));
  };
  const namedHotels = hotels.filter(mentions).sort((a, b) => b.length - a.length);
  const distinctHotels = namedHotels.filter(hotel => !namedHotels.some(other => other !== hotel && normText(other).includes(normText(hotel))));
  const hotel = distinctHotels.length === 1 ? distinctHotels[0] : distinctHotels.length ? null
    : understanding?.hotel && mentions(understanding.hotel) ? understanding.hotel : null;
  if (hotel) { topics.add("hotel"); topics.add("price"); }
  const month = requestedMonth?.month || null;
  const clock = new Date(now.getTime() + 8 * 3_600_000);
  const explicitYear = /(?<!\d)(20\d{2})(?!\d)/.exec(turn);
  const year = explicitYear ? Number(explicitYear[1]) : requestedMonth?.year
    || (month ? clock.getUTCFullYear() + (month < clock.getUTCMonth() + 1 ? 1 : 0) : null);
  const requestedFacts = [...new Map([
    ...parseRequestedFacts(understanding?.requestedFacts, text),
    ...requestedFactsFromText(text, { ignoredPhrases: [...trips.map(trip => trip.route_name), ...hotels], hotelContext: topics.has("hotel") || Boolean(hotel) }),
  ].map(fact => [`${fact.field}:${normText(fact.evidence)}`, fact])).values()];
  return {
    topics: [...topics], date, range, hotel,
    package: understanding?.package && mentions(understanding.package) ? understanding.package : null,
    passengers, days: queryRequestsDurationDays(turn), month, year, requestedFacts,
    transport: queryWantsLandFlightCombo(turn) ? "land_flight" : queryWantsDirectFlight(turn) ? "direct_flight"
      : queryWantsLandOnlyEnhanced(turn) ? "land" : /усан\s*онгоц|круз|cruise/i.test(turn) ? "cruise" : null,
    ...(requestedRange === "unsupported" ? { unsupportedDateWindow: true } : {}),
  };
}

export function mergeTripSelection(tripId: string, request: TripRequest, previous: TripSelection | null): TripSelection {
  const same = previous?.tripId === tripId ? previous : null;
  const suppliedKinds = new Set(request.passengers.map((passenger) => passenger.kind));
  const passengers = request.passengers.length
    ? request.passengers.some((passenger) => passenger.kind === "adult") ? request.passengers
      : [...(same?.passengers || []).filter((passenger) => !suppliedKinds.has(passenger.kind)), ...request.passengers]
    : same?.passengers || [];
  return {
    tripId, date: request.date || (request.range || request.month && same?.date
      && (Number(same.date.slice(5, 7)) !== request.month || request.year && Number(same.date.slice(0, 4)) !== request.year)
      ? null : same?.date || null),
    hotel: request.hotel || same?.hotel || null,
    package: request.package || (request.hotel && request.hotel !== same?.hotel ? null : same?.package || null),
    passengers,
  };
}
