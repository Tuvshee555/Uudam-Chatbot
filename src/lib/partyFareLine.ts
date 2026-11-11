/**
 * One line under a listed trip's card with the fare for the customer's own party: "Цагаан сараар
 * Солвера 2 том 2 хүүхэдтэй" got the holiday list with the adult fare only, and the family had to ask
 * again for what they had already said (MC-01 shape).
 *
 * Read only from the resolver (tripOffers.ts) for the date printed on the card, in the format the
 * reply checker adds up (tripReplyVerification.ts withoutAddedUpTotals): "👥 Нийт: 19,000,000₮
 * (2 том хүн x 5,000,000₮ + 2 хүүхэд x 4,500,000₮)". A party with no adult has no "total" (it reads
 * as the family's price, live 2026-10-30): each person's fare is listed instead. A fare the data
 * does not hold is said to be unknown for that trip — never estimated, never left as a bare name.
 */

import { formatMoney } from "./travelFastPathsSearch";
import { shortDate } from "./tripFareBlock";
import { resolveTripOffer, type OfferFare, type ResolvedTripOffer } from "./tripOffers";
import type { RequestedPassenger } from "./tripRequest";
import type { TravelTrip } from "./travelTypes";

const LABEL = { adult: "том хүн", child: "хүүхэд", infant: "нярай" } as const;

/** Said when the trip has no fare for one of the people asked about. */
// Not "тодорхойгүй": "үнэ тодорхойгүй" is a no-data reply (reply.ts) and would silence the whole answer.
export const PARTY_FARE_UNKNOWN = "энэ насны үнэ бүртгэгдээгүй";
/** Resolver reasons that mean the trip holds no fare for one of the people asked about. */
const PASSENGER_FARE_GAP = /^passenger_(?:fare_missing|age_band_missing)$/;

/** "• <trip> — энэ насны үнэ бүртгэгдээгүй" under a list, instead of the trip's bare name; null for any other reason. */
export function unknownPartyFareLine(trip: TravelTrip, reason: string): string | null {
  return PASSENGER_FARE_GAP.test(reason) ? `• ${trip.route_name} — ${PARTY_FARE_UNKNOWN}` : null;
}

/**
 * Under a list, a trip whose party fare depends on a choice still to make (the departure date, a hotel):
 * "• <trip> — үнэ нь гарах өдрөөс хамаарна" instead of its bare name (live 2026-11-11: ages 4 and 7 fell in
 * two child bands whose fares change by date). Never an estimate.
 */
export function partyFareChoiceLine(trip: TravelTrip): string {
  return `• ${trip.route_name} — үнэ нь гарах өдрөөс хамаарна`;
}

export function isUnknownPartyFareLine(line: string): boolean {
  return line.endsWith(` — ${PARTY_FARE_UNKNOWN}`);
}

function money(fare: OfferFare, currency: string): string | null {
  return fare.kind === "exact" ? formatMoney(fare.amount, currency) : fare.kind === "free" ? "Үнэгүй" : null;
}

function terms(offer: ResolvedTripOffer): string[] | null {
  // Same kind, band and fare together: "2 хүүхэд /2-11 нас/ x 4,500,000₮", not one term per child.
  const grouped = new Map<string, { kind: keyof typeof LABEL; count: number; band: string; fare: OfferFare }>();
  for (const passenger of offer.passengerPrices) {
    const band = passenger.age !== null ? `${passenger.age} ${passenger.ageUnit === "month" ? "сар" : "нас"}` : "";
    const key = `${passenger.kind}|${band}|${JSON.stringify(passenger.fare)}`;
    const row = grouped.get(key);
    if (row) row.count += passenger.count;
    else grouped.set(key, { kind: passenger.kind, count: passenger.count, band, fare: passenger.fare });
  }
  const out: string[] = [];
  for (const row of grouped.values()) {
    const amount = money(row.fare, offer.currency);
    if (!amount) return null;
    out.push(`${row.count} ${LABEL[row.kind]}${row.band ? ` /${row.band}/` : ""} x ${amount}`);
  }
  return out;
}

function lineFor(offer: ResolvedTripOffer, party: RequestedPassenger[], label: string): string | null {
  const parts = terms(offer);
  if (!parts?.length) return null;
  if (!party.some((passenger) => passenger.kind === "adult")) return `👥${label} ${parts.join(" · ")}`;
  const total = offer.total ? money(offer.total, offer.currency) : null;
  return total ? `👥 Нийт${label}: ${total} (${parts.join(" + ")})` : null;
}

/**
 * The party's fare on the given departures of one trip, or null when no party was given. One line
 * when every date has the same fares; a line per date when they differ.
 */
export function partyFareLine(trip: TravelTrip, dates: string[], party: RequestedPassenger[], now = new Date()): string | null {
  if (!party.length || !dates.length) return null;
  const offers: ResolvedTripOffer[] = [];
  for (const date of dates) {
    const result = resolveTripOffer(trip, { date, passengers: party }, now);
    if (result.status !== "ready") return PASSENGER_FARE_GAP.test(result.reason) ? `👥 ${PARTY_FARE_UNKNOWN}` : null;
    offers.push(result.offer);
  }
  const signature = (offer: ResolvedTripOffer) => JSON.stringify(offer.passengerPrices.map((p) => [p.kind, p.age, p.count, p.fare]));
  const same = offers.every((offer) => signature(offer) === signature(offers[0]));
  const lines = same ? [lineFor(offers[0], party, "")]
    : offers.map((offer) => lineFor(offer, party, ` (${shortDate(offer.date, now)})`));
  return lines.every(Boolean) ? lines.join("\n") : null;
}
