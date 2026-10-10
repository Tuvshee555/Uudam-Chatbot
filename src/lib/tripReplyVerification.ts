import type { TravelTrip } from "./travelTypes";
import type { TripSelection } from "./tripRequest";
import { guardInventedBookingTerms, guardUnverifiedDates, guardUnverifiedPrices, isReferReply } from "./reply";
import { tripDurationDays } from "./travelFastPathsSearch";
import { tripTransport, isTripOfferPrice } from "./tripFacts";
import { normalizeTripOffers, resolveTripOffer, resolveTripOfferFareCard } from "./tripOffers";
import { parseDepartureDateText } from "./travelDates";
import { departureAvailability, departureIsClosed } from "./departureAvailability";

const AMOUNT = /(\d{1,3}(?:[.,]\d{3})+|\d{4,})\s*(?:₮|төгрөг|MNT)/giu;

/** "2-12 нас" / "2 – 12 нас" → "2-12нас"; "" when there is no band. */
function bandKey(text: string): string {
  const match = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*(нас|сар|years?|months?)?/i.exec(text);
  return match ? `${match[1]}-${match[2]}${/сар|month/i.test(match[3] || "") ? "сар" : "нас"}` : "";
}

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
  // A header listing several departures ("12/19, 12/22:") scopes the fare lines under it.
  let dateSet: string[] = [];
  for (const line of reply.split(/\r?\n|[|;]/)) {
    const named = trips.filter((trip) => line.includes(trip.route_name));
    if (named.length) { active = named; date = selection?.tripId === named[0].id ? selection.date : null; hotel = selection?.tripId === named[0].id ? selection.hotel : null; }
    const dates = parseDepartureDateText(line, now);
    if (dates.length === 1) { date = dates[0]; dateSet = []; } else if (dates.length > 1) { date = null; dateSet = dates; }
    // Longest name first: "Lotus + Pearl" must not be read as "Lotus" (same rule as mentionedOfferHotel).
    const hotels = active.flatMap((trip) => normalizeTripOffers(trip, now).map((offer) => offer.hotel))
      .filter((value): value is string => Boolean(value)).sort((a, b) => b.length - a.length);
    const mentioned = hotels.find((value) => line.toLowerCase().includes(value.toLowerCase()));
    if (mentioned) hotel = mentioned;
    for (const fragment of line.split(/(?=том\s*хүн|насанд\s*хүрэгч|adult|нярай|infant|хүүх(?:эд|дийн)|child)/i)) {
      const kind = /том\s*хүн|насанд\s*хүрэгч|adult/i.test(fragment) ? "adult" : /нярай|infant/i.test(fragment) ? "infant" : /хүүх(?:эд|дийн)|child/i.test(fragment) ? "child" : null;
      const amounts = [...fragment.matchAll(AMOUNT)].map((match) => Number(match[1].replace(/[.,]/g, "")));
      // "10 сарын 26" is a date ("the 26th of month 10"), never a 10-month-old.
      const ageMatch = /(?<![\d.,])(\d{1,2}(?:\.\d+)?)\s*(?:[-–]\s*(\d{1,2})\s*)?(?:нас|настай|years?\s*old|сар(?!ын)|months?)/i.exec(fragment);
      // "Хүүхэд /2-11 нас/" labels the fare's band. Its LOWER end read as a
      // 2-year-old made the infant rule reject the real child fare, and the
      // customer who tapped that trip got silence (2026-10-09). The upper end
      // still sits inside the band, so a 2-5 band quoted at the 6-11 fare fails.
      const age = ageMatch ? [ageMatch[0], ageMatch[2] ?? ageMatch[1]] as const : null;
      // A band printed exactly as one of the trip's own fares ("Хүүхэд /2-12 нас/:
      // 3,250,000₮") is that fare. Turning the band into one age broke wherever a
      // trip's bands touch ("2-12" next to "12+", "0-2" next to "2-8").
      const printedBand = ageMatch?.[2] ? bandKey(ageMatch[0]) : null;
      if (kind && amounts.length) {
        for (const amount of amounts) {
          // Asked of the resolver, so a hotel row that inherits the trip's infant
          // fare is judged exactly as the card that printed it was built.
          const ownFare = printedBand !== null && active.some((trip) => {
            const departures = date ? [date] : dateSet.length ? dateSet : [...new Set(normalizeTripOffers(trip, now).flatMap((offer) => offer.dates))];
            return departures.some((departure) => {
              const card = resolveTripOfferFareCard(trip, { date: departure, ...(hotel ? { hotel } : {}) }, now);
              return card.status === "ready" && card.offer.fares.some((fare) => fare.kind === kind && bandKey(fare.ageRange || "") === printedBand
                && (fare.fare.kind === "exact" || fare.fare.kind === "free") && fare.fare.amount === amount);
            });
          });
          if (ownFare) continue;
          const supported = active.some((trip) => {
            const possibleDates = date ? [date] : dateSet.length ? dateSet : [...new Set(normalizeTripOffers(trip, now).flatMap((offer) => offer.dates))];
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
