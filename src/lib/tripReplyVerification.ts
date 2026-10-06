import type { TravelTrip } from "./travelTypes";
import type { TripSelection } from "./tripRequest";
import { guardInventedBookingTerms, guardUnverifiedDates, guardUnverifiedPrices, isReferReply } from "./reply";
import { tripDurationDays } from "./travelFastPathsSearch";
import { tripTransport, isTripOfferPrice } from "./tripFacts";
import { normalizeTripOffers, resolveTripOffer } from "./tripOffers";
import { parseDepartureDateText } from "./travelDates";
import { departureAvailability, departureIsClosed } from "./departureAvailability";

const AMOUNT = /(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(?:₮|төгрөг|MNT)/giu;

/** Shared final check for AI and code-generated replies in both channels. */
export function verifyTripReply(input: {
  reply: string; trips: TravelTrip[]; selection?: TripSelection | null; now?: Date;
}): string {
  const { reply, trips, selection } = input;
  const now = input.now || new Date();
  if (isReferReply(reply)) return reply;
  if (!trips.length) return [...reply.matchAll(AMOUNT)].length ? "REFER" : reply;
  const priceChecked = guardUnverifiedPrices(reply, trips, now);
  if (isReferReply(priceChecked)) return "REFER";
  const datesChecked = guardUnverifiedDates(reply, trips, undefined, now);
  if (isReferReply(datesChecked)) return "REFER";
  if (isReferReply(guardInventedBookingTerms(reply, "", trips))) return "REFER";
  let active = trips;
  let date = selection?.date || null;
  let hotel = selection?.hotel || null;
  for (const line of reply.split(/\r?\n|[|;]/)) {
    const named = trips.filter((trip) => line.includes(trip.route_name));
    if (named.length) { active = named; date = selection?.tripId === named[0].id ? selection.date : null; hotel = selection?.tripId === named[0].id ? selection.hotel : null; }
    const dates = parseDepartureDateText(line, now);
    if (dates.length === 1) date = dates[0];
    const hotels = active.flatMap((trip) => normalizeTripOffers(trip, now).map((offer) => offer.hotel)).filter((value): value is string => Boolean(value));
    const mentioned = hotels.find((value) => line.toLowerCase().includes(value.toLowerCase()));
    if (mentioned) hotel = mentioned;
    for (const fragment of line.split(/(?=том\s*хүн|насанд\s*хүрэгч|adult|нярай|infant|хүүх(?:эд|дийн)|child)/i)) {
      const kind = /том\s*хүн|насанд\s*хүрэгч|adult/i.test(fragment) ? "adult" : /нярай|infant/i.test(fragment) ? "infant" : /хүүх(?:эд|дийн)|child/i.test(fragment) ? "child" : null;
      const amounts = [...fragment.matchAll(AMOUNT)].map((match) => Number(match[1].replace(/[.,]/g, "")));
      // "10 сарын 26" is a date ("the 26th of month 10"), never a 10-month-old.
      const age = /(?<![\d.,])(\d{1,2}(?:\.\d+)?)\s*(?:[-–]\s*\d{1,2}\s*)?(?:нас|настай|years?\s*old|сар(?!ын)|months?)/i.exec(fragment);
      if (kind && amounts.length) {
        for (const amount of amounts) {
          const supported = active.some((trip) => {
            const possibleDates = date ? [date] : [...new Set(normalizeTripOffers(trip, now).flatMap((offer) => offer.dates))];
            if (!possibleDates.length) {
              return normalizeTripOffers(trip, now).some((offer) => (!hotel || offer.hotel === hotel) && offer.fares.some((fare) => fare.kind === kind && (fare.fare.kind === "exact" || fare.fare.kind === "free") && fare.fare.amount === amount));
            }
            return possibleDates.some((departure) => isTripOfferPrice(trip, { date: departure, hotel,
              ...(age ? { passengers: [{ kind, age: Number(age[1]), ageUnit: /сар|month/i.test(age[0]) ? "month" : "year", count: 1 }] } : {}),
            }, kind, amount, now));
          });
          if (!supported) return "REFER";
        }
      }
    }
    if (!/байхгүй|биш|гарахгүй|таарахгүй|хүссэн|хүсэлт|асууж|хуваарьгүй/i.test(line)) {
      const duration = /(?:хугацаа\s*:|үргэлжлэх(?:\s+хугацаа)?\s*:?)\s*(\d{1,2})\s*(?:өдөр|хоног)/i.exec(line);
      if (duration && !active.some((trip) => tripDurationDays(trip) === Number(duration[1]))) return "REFER";
      if (/шууд\s+нислэгтэй/i.test(line) && !named.length && !active.some((trip) => tripTransport(trip) === "direct_flight")) return "REFER";
      if (date && /захиалга\s+нээлттэй|суудал\s+байгаа|суудал\s+байна/i.test(line)) {
        const supported = active.some((trip) => {
          const row = departureAvailability(trip).find((entry) => entry.date === date);
          if (row && departureIsClosed(row)) return false;
          const result = resolveTripOffer(trip, { date, hotel }, now);
          return result.status === "ready" && result.offer.availability.status === "open";
        });
        if (!supported) return "REFER";
      }
    }
  }
  return reply;
}
