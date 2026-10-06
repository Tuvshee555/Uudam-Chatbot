import type { TravelTrip } from "./travelTypes";
import { tripDepartsInMonth, tripMatchesRequestedDate } from "./travelDates";
import { departureAvailability } from "./departureAvailability";
import { normalizeTripOffers as canonicalOffers, resolveTripOffer, type OfferFare, type PassengerKind, type TripOfferSelection } from "./tripOffers";
import {
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
  const structured = trip.extra?.transport_type;
  if (["direct_flight", "land", "land_flight", "cruise"].includes(String(structured))) return structured as TripTransport;
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
  // A closed departure is still scheduled; booking eligibility is resolved
  // separately by tripOffers, even after a caller strips bookable dates.
  const schedule = { ...trip, departure_dates: [...new Set([
    ...(trip.departure_dates || []), ...departureAvailability(trip).map((entry) => entry.date),
  ])] };
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
      if (schedule.departure_dates.length === 0) return "unknown";
      return tripMatchesRequestedDate(schedule, requirement.date, now) ? "match" : "contradiction";
    case "range":
      if (schedule.departure_dates.length === 0) return "unknown";
      return requirement.dates.some((date) => tripMatchesRequestedDate(schedule, date, now))
        ? "match"
        : "contradiction";
    case "month":
      if (schedule.departure_dates.length === 0) return "unknown";
      return tripDepartsInMonth(schedule, requirement.month, now) ? "match" : "contradiction";
  }
}

function fareAmounts(fare: OfferFare): number[] {
  if (fare.kind === "unknown") return [];
  return fare.kind === "range" ? [fare.min, fare.max] : [fare.amount];
}

/** Compatibility view; passenger identity remains available in tripOffers. */
export function normalizeTripOffers(trip: TravelTrip, now = new Date()): NormalizedOffer[] {
  return canonicalOffers(trip, now).filter((offer) => !offer.discount || offer.discount.active).map((offer) => ({
    source: offer.source === "legacy" ? "price_group" : offer.source,
    dates: offer.source === "base" ? [] : offer.dates,
    hotel: offer.hotel,
    prices: new Set([
      ...offer.fares.filter((fare) => fare.issues.length === 0).flatMap((fare) => fareAmounts(fare.fare)),
      ...offer.supplementalFares.flatMap((fare) => fareAmounts(fare.fare)),
    ]),
  }));
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
  const selected = resolveTripOffer(trip, { date, hotel }, now);
  const selectedPrices = (result: ReturnType<typeof resolveTripOffer>): number[] => {
    if (result.status !== "ready") return [];
    const sourceIds = new Set([...result.offer.sourceOfferIds, result.offer.id]);
    return [
      ...result.offer.fares.flatMap((fare) => fareAmounts(fare.fare)),
      ...canonicalOffers(trip, now).filter((offer) => sourceIds.has(offer.id)).flatMap((offer) => offer.supplementalFares.flatMap((fare) => fareAmounts(fare.fare))),
    ];
  };
  if (selected.status === "ready") return new Set(selectedPrices(selected));
  if (selected.status === "needs_selection" && selected.fields.includes("hotel")) {
    return new Set(selected.options.flatMap((option) => {
      const named = resolveTripOffer(trip, { date, hotel: option }, now);
      return selectedPrices(named.status === "unavailable" ? resolveTripOffer(trip, { date, hotelId: option }, now) : named);
    }));
  }
  return new Set();
}

/** Category-aware validator: an adult amount cannot validate a child claim. */
export function isTripOfferPrice(
  trip: TravelTrip,
  selection: TripOfferSelection,
  kind: PassengerKind,
  amount: number,
  now = new Date(),
): boolean {
  if (!Number.isFinite(amount)) return false;
  const result = resolveTripOffer(trip, selection, now);
  // No hotel named on a date that sells several: a price is true when one of
  // those hotel options sells at it. Rejecting it silenced whole answers.
  if (result.status === "needs_selection" && result.fields.includes("hotel") && !selection.hotel && !selection.hotelId) {
    return result.options.some((option) => isTripOfferPrice(trip, { ...selection, hotel: option }, kind, amount, now));
  }
  if (result.status !== "ready") return false;
  const fares = selection.passengers?.length
    ? result.offer.passengerPrices.filter((p) => p.kind === kind).map((p) => p.fare)
    : result.offer.fares.filter((f) => f.kind === kind).map((f) => f.fare);
  return fares.some((fare) => fare.kind === "range" ? amount >= fare.min && amount <= fare.max : fare.kind !== "unknown" && fare.amount === amount);
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
