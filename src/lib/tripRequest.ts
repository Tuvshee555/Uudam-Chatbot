import type { Understanding } from "./tripUnderstanding";
import type { TravelTrip } from "./travelTypes";
import { stripTripNamesForIntent } from "./customerTurn";
import { requestedDepartureScope, resolveRequestedDate, resolveRequestedMonth, resolveRequestedRange } from "./travelDates";
import { hasDurationIntent, hasIncludedInPriceIntent, hasPriceIntent, hasScheduleIntent } from "./travelFastPathsPricing";
import { queryRequestsDurationDays, queryWantsDirectFlight, queryWantsLandFlightCombo, queryWantsLandOnlyEnhanced } from "./travelFastPathsSearch";
import { normalizeTripOffers } from "./tripOffers";
import { normText, phoneticLatinText } from "./travelTextNorm";
import type { TripTransport } from "./tripFacts";
import { parseRequestedFacts, requestedFactsFromText, type RequestedFact } from "./requestedFacts";

export const TRIP_TOPICS = ["price", "availability", "dates", "hotel", "duration", "transport", "program", "includes", "booking_terms", "weather", "photos", "comparison", "budget", "discount"] as const;
export type TripTopic = typeof TRIP_TOPICS[number];
export type RequestedPassenger = { kind: "adult" | "child" | "infant"; count: number; age?: number; ageUnit?: "year" | "month" };
export type TripDateScope = { month: number | null; year: number | null; range: [string, string] | null; dates?: string[] };
export type TripSelection = { tripId: string; date: string | null; hotel: string | null; package: string | null; passengers: RequestedPassenger[]; dateScope?: TripDateScope };
export type TripRequest = {
  topics: TripTopic[];
  date: string | null;
  hotel: string | null;
  package: string | null;
  packagePreference?: "with_program" | "without_program";
  passengers: RequestedPassenger[];
  days: [number, number] | null;
  month: number | null;
  year: number | null;
  range?: [string, string] | null;
  dates?: string[];
  transport?: TripTransport | null;
  unsupportedDateWindow?: boolean;
  unsupportedPassengerSelection?: boolean;
  passengerAgeFollowup?: boolean;
  /** "зөвхөн 3 том хүн", "хүүхэдгүй": the stated people are the whole party. */
  passengersExclusive?: boolean;
  /** "Одоо 3 том хүн": a change to the stated kind only; the rest of the party stays. */
  passengersUpdate?: boolean;
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

function parsePassengerText(text: string): { passengers: RequestedPassenger[]; unsupported: boolean } {
  const result: RequestedPassenger[] = [];
  let unsupported = false;
  for (const match of text.matchAll(/(?<![\d.,-])(-?\d+(?:[.,]\d+)?)\s*(том\s*хүн|том|adult(?:s)?|tom\s*hun|хүүхэд|huuhed|child(?:ren)?|нярай|nyarai|infant(?:s)?)/gi)) {
    const kind = /том|adult|tom/i.test(match[2]) ? "adult" : /нярай|nyarai|infant/i.test(match[2]) ? "infant" : "child";
    const count = Number(match[1]);
    if (!Number.isInteger(count) || count < 1 || count > 100) unsupported = true;
    else result.push({ kind, count });
  }
  const ages: Array<{ age: number; ageUnit: "year" | "month" }> = [];
  for (const match of text.matchAll(/(?<![\d.,/-])(-?\d+(?:\.\d+)?(?:\s*[,/]\s*\d+(?:\.\d+)?)*)\s*(настай|nas(?:tai)?|years?\s*old|сартай|months?\s*old)/gi)) {
    const parts = match[1].split(/\s*[,/]\s*/);
    // An unspaced comma may mean a decimal age. Do not guess without a count.
    const childCount = result.filter((row) => row.kind !== "adult").reduce((sum, row) => sum + row.count, 0);
    const hasCountedAdults = result.some(row => row.kind === "adult");
    const beforeAge = text.slice(0, match.index);
    const afterAge = text.slice((match.index || 0) + match[0].length);
    const childAfterAge = /^\s*(?:(?:\d+|нэг|one)\s+)?(?:хүүх|huuhe|child|нярай|nyarai|infant)/iu.test(afterAge);
    const ageUnit = /сартай|month/i.test(match[2]) ? "month" : "year";
    const hasAdultAge = parts.some(part => Number(part) / (ageUnit === "month" ? 12 : 1) >= 12);
    const adultAge = /^\s*(?:том\s*хүн|том|adult(?:s)?|tom\s*hun)(?!\p{L})/iu.test(afterAge)
      || hasAdultAge && !childAfterAge && /(?:том\s*хүн|том|adult(?:s)?|tom\s*hun)\s*[,;:]?\s*(?:(?:нь|is|are|aged|and|болон|ба)\s*)?$/iu.test(beforeAge);
    // A counted adult's age does not establish an additional traveler. The
    // parser cannot bind a shared age to counted adults without guessing.
    if (hasCountedAdults && (adultAge || hasAdultAge && !/хүүх|huuhe|child|нярай|nyarai|infant/iu.test(text))) unsupported = true;
    if (/\d,\d/.test(match[1]) && childCount !== parts.length) { unsupported = true; continue; }
    for (const part of parts) {
      const age = Number(part);
      if (!Number.isFinite(age) || age < 0 || age > (ageUnit === "month" ? 1440 : 120)) unsupported = true;
      else ages.push({ age, ageUnit });
    }
  }
  // Explicit ages replace an unqualified child count, never silently invent ages.
  if (ages.length) {
    const adults = result.filter((row) => row.kind === "adult");
    const childCount = result.filter((row) => row.kind !== "adult").reduce((sum, row) => sum + row.count, 0);
    if (childCount > ages.length) return { passengers: result, unsupported };
    return { passengers: [...adults, ...ages.map(({ age, ageUnit }) => {
      const years = ageUnit === "month" ? age / 12 : age;
      return { kind: (years < 2 ? "infant" : years < 12 ? "child" : "adult") as RequestedPassenger["kind"], count: 1, age, ...(ageUnit === "month" ? { ageUnit } : {}) };
    })], unsupported };
  }
  return { passengers: result, unsupported };
}

export function requestedPassengersFromText(text: string): RequestedPassenger[] {
  const parsed = parsePassengerText(text);
  return parsed.unsupported ? [] : parsed.passengers;
}

function programPreference(text: string): TripRequest["packagePreference"] {
  const normalized = normText(text);
  if (/хөтөлбөргүй|чөлөөт\s+аялал|hutulburgui|hotolborgui|chuluut\s+aylal|without\s+(?:a\s+)?(?:program|itinerary)/i.test(normalized)) return "without_program";
  if (/хөтөлбөртэй|hutulburtei|hotolbortei|with\s+(?:a\s+)?(?:program|itinerary)/i.test(normalized)) return "with_program";
  return undefined;
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
  const calendarScope = requestedDepartureScope(turn, now);
  const requestedDates = calendarScope?.kind === "dates" && calendarScope.dates.length > 1 ? calendarScope.dates : undefined;
  // "11 сарын 1-ээс хойш": a start date, not that single day (travelDates fromDateOnward).
  const onward = !requestedRange && calendarScope?.kind === "range" ? calendarScope : null;
  const explicitDate = requestedRange || requestedDates || onward ? null : resolveRequestedDate(turn, now)?.ymd || null;
  const requestedMonth = requestedRange || explicitDate || onward ? null : resolveRequestedMonth(turn, now);
  const date = explicitDate;
  const range: [string, string] | null = requestedRange && requestedRange !== "unsupported"
    ? [requestedRange.startYmd, requestedRange.endYmd]
    : onward ? [onward.startYmd, onward.endYmd] : null;
  if (date) topics.add("availability");
  const passengerText = parsePassengerText(turn);
  const explicitPassengers = passengerText.unsupported ? [] : passengerText.passengers;
  const passengerLanguage = /том\s*хүн|хүүх|нярай|настай|сартай|tom\s*hun|huuhe|nyarai|nas(?:tai)?|adult|child|infant|years?\s*old|months?\s*old/i.test(turn);
  const passengers = explicitPassengers.length ? explicitPassengers : passengerLanguage && !passengerText.unsupported ? parseRequestedPassengers(understanding?.passengers) : [];
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
  // A date window is itself the question when nothing else is asked ("Хүүхдийн амралт
  // 11.1-с эхлэх гээд бдаг"): answer with the departures inside it.
  if (!topics.size && (range || requestedDates || month)) topics.add("dates");
  const packagePreference = programPreference(turn);
  if (packagePreference) {
    topics.add("price");
    if (!/явуул|үзэх|бүтэн|өдөр\s*бүр|send|show|full|day.by.day/i.test(turn)) topics.delete("program");
  }
  const packages = [...new Set(trips.flatMap(trip => normalizeTripOffers(trip, now).map(offer => offer.packageId)).filter((value): value is string => Boolean(value)))];
  const namedPackages = packages.filter(mentions);
  const matchingPackages = packagePreference ? packages.filter(value => programPreference(value) === packagePreference) : [];
  const selectedPackage = namedPackages.length === 1 ? namedPackages[0]
    : matchingPackages.length === 1 ? matchingPackages[0]
      : understanding?.package && mentions(understanding.package) ? understanding.package : null;
  return {
    topics: [...topics], date, range, hotel,
    package: selectedPackage, ...(packagePreference ? { packagePreference } : {}),
    passengers, days: queryRequestsDurationDays(turn), month, year, requestedFacts,
    ...(requestedDates ? { dates: requestedDates } : {}),
    transport: queryWantsLandFlightCombo(turn) ? "land_flight" : queryWantsDirectFlight(turn) ? "direct_flight"
      : queryWantsLandOnlyEnhanced(turn) ? "land" : /усан\s*онгоц|круз|cruise/i.test(turn) ? "cruise" : null,
    ...(requestedRange === "unsupported" || calendarScope?.kind === "unsupported" ? { unsupportedDateWindow: true } : {}),
    ...(passengerText.unsupported ? { unsupportedPassengerSelection: true } : {}),
    ...(passengers.length && passengers.every(passenger => passenger.age !== undefined)
      && !/том\s*хүн|(?:^|[^\p{L}])том(?:[^\p{L}]|$)|adult|tom\s*hun/iu.test(turn) ? { passengerAgeFollowup: true } : {}),
    ...(passengers.length && /зөвхөн|zuvhun|zovhon|хүүхэдгүй|huuhedgui|\bonly\b|\bjust\b/iu.test(turn) ? { passengersExclusive: true } : {}),
    ...(passengers.length && /одоо|odoo|болсон|bolson|нэмэгд|nemegd|хасагд|hasagd|\bnow\b|instead/iu.test(turn) ? { passengersUpdate: true } : {}),
  };
}

export function mergeTripSelection(tripId: string, request: TripRequest, previous: TripSelection | null): TripSelection {
  const same = previous?.tripId === tripId ? previous : null;
  const suppliedKinds = new Set(request.passengers.map((passenger) => passenger.kind));
  // Several groups ("2 том хүн 1 хүүхэд") or "зөвхөн" restate the party. Adults are kept
  // with the earlier children when they complete a party of minors (the answer to "Хэдэн
  // том хүн явах вэ?") or the message says it changes one count ("Одоо 3 том хүн"); both
  // used to drop the children (live replay 2026-10-30). Otherwise adults restate it.
  const previousHasAdults = Boolean(same?.passengers.some((passenger) => passenger.kind === "adult"));
  const keepsOthers = !request.passengersExclusive && (!suppliedKinds.has("adult")
    || (request.passengers.length === 1 && (Boolean(request.passengersUpdate) || !previousHasAdults)));
  // Routing and the answer plan both merge the same turn: a selection that already holds
  // this single update is that merge, not an earlier party to restate.
  const alreadyMerged = request.passengers.length === 1 && !request.passengersExclusive && Boolean(same?.passengers.some((passenger) =>
    passenger.kind === request.passengers[0].kind && passenger.count === request.passengers[0].count && passenger.age === request.passengers[0].age));
  let passengers = request.passengers.length
    ? alreadyMerged ? same!.passengers
    : keepsOthers
      ? [...(same?.passengers || []).filter((passenger) => !suppliedKinds.has(passenger.kind)), ...request.passengers]
      : request.passengers
    : same?.passengers || [];
  // An answer to the child-age question refines the existing people even if
  // the supplied age moves them into another fare category.
  if (same && request.passengerAgeFollowup && request.passengers.length && request.passengers.every(passenger => passenger.age !== undefined)) {
    const waiting = same.passengers.filter(passenger => passenger.kind !== "adult" && passenger.age === undefined);
    const waitingCount = waiting.reduce((count, passenger) => count + passenger.count, 0);
    const suppliedCount = request.passengers.reduce((count, passenger) => count + passenger.count, 0);
    if (waitingCount >= suppliedCount) {
      const slots = same.passengers.map(passenger => ({ passenger, remaining: passenger.count }));
      for (const supplied of request.passengers) {
        let remaining = supplied.count;
        const preferredKind = supplied.kind === "adult" ? "child" : supplied.kind;
        const candidates = slots.filter(slot => slot.passenger.kind !== "adult" && slot.passenger.age === undefined)
          .sort((left, right) => Number(right.passenger.kind === preferredKind) - Number(left.passenger.kind === preferredKind));
        for (const slot of candidates) {
          const filled = Math.min(remaining, slot.remaining);
          slot.remaining -= filled;
          remaining -= filled;
        }
      }
      const retained = slots.flatMap(slot => slot.remaining ? [{ ...slot.passenger, count: slot.remaining }] : []);
      passengers = [...retained, ...request.passengers];
    }
  }
  const dateScope = request.date ? undefined : request.range || request.month || request.year || request.dates
    ? { month: request.month, year: request.year, range: request.range || null, ...(request.dates ? { dates: request.dates } : {}) } : same?.dateScope;
  return {
    tripId, date: request.date || (request.range || request.dates && same?.date && !request.dates.includes(same.date) || request.month && same?.date
      && (Number(same.date.slice(5, 7)) !== request.month || request.year && Number(same.date.slice(0, 4)) !== request.year)
      ? null : same?.date || null),
    hotel: request.hotel || same?.hotel || null,
    package: request.package || (request.packagePreference || request.hotel && request.hotel !== same?.hotel ? null : same?.package || null),
    passengers,
    ...(dateScope ? { dateScope } : {}),
  };
}
