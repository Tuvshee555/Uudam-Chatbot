import type { Understanding } from "./tripUnderstanding";
import type { TravelTrip } from "./travelTypes";
import { stripTripNamesForIntent } from "./customerTurn";
import { parseDepartureDateText, resolveRequestedMonth } from "./travelDates";
import { hasDurationIntent, hasIncludedInPriceIntent, hasPriceIntent, hasScheduleIntent } from "./travelFastPathsPricing";
import { queryRequestsDurationDays } from "./travelFastPathsSearch";
import { normalizeTripOffers } from "./tripOffers";

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
export function buildTripRequest(text: string, trips: TravelTrip[], understanding?: Understanding, now = new Date()): TripRequest {
  const turn = stripTripNamesForIntent(text, trips);
  const topics = new Set<TripTopic>(understanding?.topics || []);
  const asksIncludes = hasIncludedInPriceIntent(turn);
  if (hasPriceIntent(turn) && (!asksIncludes || /үнэ.{0,12}хэд|хэд.{0,12}үнэ|хэдэн\s*төг|(?:price|cost|une).{0,12}(?:how|hed)/i.test(turn))) topics.add("price");
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
  ];
  for (const [topic, pattern] of patterns) if (pattern.test(turn)) topics.add(topic);
  const dates = parseDepartureDateText(turn, now);
  const date = understanding?.date || (dates.length === 1 ? dates[0] : null);
  if (date) topics.add("availability");
  const passengers = understanding?.passengers?.length ? understanding.passengers : requestedPassengersFromText(turn);
  if (passengers.length) topics.add("price");
  const hotels = [...new Set(trips.flatMap((trip) => normalizeTripOffers(trip, now).map((offer) => offer.hotel)).filter((hotel): hotel is string => Boolean(hotel && hotel.length >= 3)))];
  const namedHotels = hotels.filter((hotel) => turn.toLowerCase().includes(hotel.toLowerCase()));
  const hotel = understanding?.hotel || (namedHotels.length === 1 ? namedHotels[0] : null);
  if (hotel) { topics.add("hotel"); topics.add("price"); }
  return {
    topics: [...topics], date, hotel, package: understanding?.package || null,
    passengers, days: understanding?.days || queryRequestsDurationDays(turn), month: understanding?.month || resolveRequestedMonth(turn)?.month || null,
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
    tripId, date: request.date || same?.date || null,
    hotel: request.hotel || same?.hotel || null, package: request.package || same?.package || null,
    passengers,
  };
}
