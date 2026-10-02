import type { TravelTrip } from "./travelTypes";
import { parseDepartureDateText, tripDepartsInMonth, tripMatchesRequestedDate } from "./travelDates";
import { getGroupDateTexts } from "./travelFastPathsPricing";
import {
  getPriceGroups,
  getStructuredDiscounts,
  getStructuredPriceGroups,
  normText,
  tripDurationDays,
  tripIsCruise,
  tripIsDirectFlight,
  tripIsLandFlightCombo,
  tripMatchesRequestedDuration,
} from "./travelFastPathsSearch";

export type FactState = "match" | "contradiction" | "unknown";
export type RequirementKind = "date" | "range" | "month" | "days" | "transport";
export type TripTransport = "direct_flight" | "land" | "land_flight" | "cruise";

export type TripRequirement =
  | { kind: "date"; date: string }
  | { kind: "range"; dates: string[] }
  | { kind: "month"; month: number }
  | { kind: "days"; days: [number, number] }
  | { kind: "transport"; transport: TripTransport };

export type NormalizedOffer = {
  source: "base" | "price_group" | "discount";
  dates: string[];
  hotel: string | null;
  prices: Set<number>;
};

function tripText(trip: TravelTrip): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const aliases = Array.isArray(extra.aliases) ? extra.aliases : [];
  return normText([
    trip.category,
    trip.route_name,
    trip.source_description,
    trip.notes,
    ...aliases.filter((value): value is string => typeof value === "string"),
  ].join(" "));
}

/** Transport is unknown unless the catalog contains affirmative evidence. */
export function tripTransport(trip: TravelTrip): TripTransport | null {
  const text = tripText(trip);
  const combo = tripIsLandFlightCombo(trip);
  const cruise = tripIsCruise(trip);
  const direct = tripIsDirectFlight(trip);
  const land = /газрын аялал|газраар|автобус|галт тэрэг|нислэггүй/.test(text);
  if (combo) return "land_flight";
  if (cruise) return "cruise";
  if (direct && land) return null;
  if (direct) return "direct_flight";
  if (land) return "land";
  return null;
}

export function evaluateTripRequirement(
  trip: TravelTrip,
  requirement: TripRequirement,
  now = new Date(),
): FactState {
  switch (requirement.kind) {
    case "transport": {
      const actual = tripTransport(trip);
      return actual === null ? "unknown" : actual === requirement.transport ? "match" : "contradiction";
    }
    case "days": {
      if (tripDurationDays(trip) === null) return "unknown";
      return tripMatchesRequestedDuration(trip, requirement.days) ? "match" : "contradiction";
    }
    case "date":
      if ((trip.departure_dates || []).length === 0) return "unknown";
      return tripMatchesRequestedDate(trip, requirement.date, now) ? "match" : "contradiction";
    case "range":
      if ((trip.departure_dates || []).length === 0) return "unknown";
      return requirement.dates.some((date) => tripMatchesRequestedDate(trip, date, now))
        ? "match"
        : "contradiction";
    case "month":
      if ((trip.departure_dates || []).length === 0) return "unknown";
      return tripDepartsInMonth(trip, requirement.month, now) ? "match" : "contradiction";
  }
}

function addPrice(target: Set<number>, value: unknown) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 1_000) {
    target.add(Math.round(value));
  }
}

function pricesFromRecord(record: Record<string, unknown>): Set<number> {
  const prices = new Set<number>();
  for (const key of ["adult_price", "child_price", "infant_price", "single_price", "price", "amount"]) {
    addPrice(prices, record[key]);
  }
  const range = record.adult_price_range;
  if (range && typeof range === "object") {
    addPrice(prices, (range as Record<string, unknown>).min);
    addPrice(prices, (range as Record<string, unknown>).max);
  }
  for (const key of ["passenger_prices", "child_rules", "child_price_rules"]) {
    const entries = record[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (entry && typeof entry === "object") {
        for (const price of pricesFromRecord(entry as Record<string, unknown>)) prices.add(price);
      }
    }
  }
  return prices;
}

function groupDates(group: Record<string, unknown>, now: Date): string[] {
  const dates = new Set<string>();
  for (const text of getGroupDateTexts(group)) {
    for (const ymd of parseDepartureDateText(text, now)) dates.add(ymd);
  }
  return [...dates];
}

function groupOffer(
  group: Record<string, unknown>,
  source: NormalizedOffer["source"],
  now: Date,
): NormalizedOffer {
  return {
    source,
    dates: groupDates(group, now),
    hotel: typeof group.hotel === "string" && group.hotel.trim() ? group.hotel.trim() : null,
    prices: pricesFromRecord(group),
  };
}

/** One normalized view over all current price representations. */
export function normalizeTripOffers(trip: TravelTrip, now = new Date()): NormalizedOffer[] {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const base = new Set<number>();
  addPrice(base, trip.adult_price);
  addPrice(base, trip.child_price);
  addPrice(base, trip.infant_price);
  const range = extra.adult_price_range;
  if (range && typeof range === "object") {
    addPrice(base, (range as Record<string, unknown>).min);
    addPrice(base, (range as Record<string, unknown>).max);
  }
  for (const key of ["child_rules", "child_price_rules", "room_prices"]) {
    const entries = extra[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      for (const price of pricesFromRecord(entry as Record<string, unknown>)) base.add(price);
    }
  }

  const offers: NormalizedOffer[] = [{ source: "base", dates: [], hotel: trip.hotel || null, prices: base }];
  const priceGroups = [
    ...getStructuredPriceGroups(trip),
    ...(getPriceGroups(trip) as Array<Record<string, unknown>>),
  ];
  for (const group of priceGroups) offers.push(groupOffer(group, "price_group", now));
  const legacyDiscounts = Array.isArray(extra.discount_groups)
    ? (extra.discount_groups as Array<Record<string, unknown>>)
    : [];
  for (const group of [...getStructuredDiscounts(trip), ...legacyDiscounts]) {
    offers.push(groupOffer(group, "discount", now));
  }
  return offers;
}

function sameMonthDay(left: string, right: string): boolean {
  return left.length >= 10 && right.length >= 10 && left.slice(5) === right.slice(5);
}

/** Prices valid for a specific departure, or all quotable prices without one. */
export function quotablePrices(
  trip: TravelTrip,
  date?: string,
  now = new Date(),
  hotel?: string | null,
): Set<number> {
  const offers = normalizeTripOffers(trip, now);
  const normalizedHotel = hotel ? normText(hotel) : "";
  const hotelScoped = normalizedHotel
    ? offers.filter((offer) => offer.hotel && normText(offer.hotel) === normalizedHotel)
    : offers;
  if (normalizedHotel && hotelScoped.length === 0) return new Set();
  if (!date) {
    return new Set(hotelScoped.flatMap((offer) => [...offer.prices]));
  }
  const dated = hotelScoped.filter(
    (offer) => offer.dates.length > 0 && offer.dates.some((ymd) => sameMonthDay(ymd, date)),
  );
  if (dated.length === 0) return new Set(offers[0]?.prices || []);

  const prices = new Set<number>();
  for (const offer of dated) for (const price of offer.prices) prices.add(price);
  // Infant/age/room tiers are often trip-wide and omitted from each date row.
  const extra = (trip.extra || {}) as Record<string, unknown>;
  for (const key of ["child_rules", "child_price_rules", "room_prices"]) {
    const entries = extra[key];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      for (const price of pricesFromRecord(entry as Record<string, unknown>)) prices.add(price);
    }
  }
  if (![...dated].some((offer) => [...offer.prices].includes(trip.infant_price || -1))) {
    addPrice(prices, trip.infant_price);
  }
  return prices;
}

export function mentionedOfferHotel(trip: TravelTrip, text: string, now = new Date()): string | null {
  const normalized = normText(text);
  if (!normalized) return null;
  const hotels = normalizeTripOffers(trip, now)
    .map((offer) => offer.hotel)
    .filter((hotel): hotel is string => Boolean(hotel));
  return hotels.find((hotel) => {
    const value = normText(hotel);
    return value.length >= 3 && normalized.includes(value);
  }) || null;
}

export function tripSupportsDate(trip: TravelTrip, date: string, now = new Date()): FactState {
  return evaluateTripRequirement(trip, { kind: "date", date }, now);
}

export function tripBookingFacts(trip: TravelTrip): string {
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const rawTerms = extra.booking_terms && typeof extra.booking_terms === "object"
    ? (extra.booking_terms as Record<string, unknown>)
    : {};
  const terms = [
    rawTerms.deposit ? `Урьдчилгаа: ${String(rawTerms.deposit)}` : "",
    rawTerms.payment ? `Төлбөрийн нөхцөл: ${String(rawTerms.payment)}` : "",
    rawTerms.documents ? `Бичиг баримт: ${String(rawTerms.documents)}` : "",
    rawTerms.visa ? `Виз: ${String(rawTerms.visa)}` : "",
    rawTerms.cancellation ? `Цуцлалт буцаалт: ${String(rawTerms.cancellation)}` : "",
  ].filter(Boolean).join(" ");
  return [terms, trip.notes, trip.source_description].filter(Boolean).join(" ");
}
