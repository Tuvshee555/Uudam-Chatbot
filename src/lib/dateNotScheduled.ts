/**
 * "Nothing of these trips leaves in the time you asked": what the customer is told.
 *
 * The plain case (a month or a date) lists each trip's own next departures. A HOLIDAY ask names a
 * window the customer cares about, so the answer names it too: "Цагаан сарын үеэр (2027 оны 2 сарын
 * 6–9 орчим)", then the departures nearest to THAT window, or "the schedule is not out yet" when
 * the nearest is months away. It used to be the plain case's "Тэр хугацаанд гарах аялал алга"
 * followed by dates three months before the holiday (live 2026-11-05, 2026-11-06).
 */

import { holidayWindowOf } from "./askedWindow";
import { holidayWindowListing } from "./catalogListing";
import { DATE_NOT_SCHEDULED_HEADING, OTHER_TRIPS_LINK_LINE, buildDateNotScheduledReply } from "./travelFastPathsPricing";
import { NEAREST_DATES_MARKER, buildNearestDatesReply } from "./dateAlternatives";
import { filterTripsByTransportIntent } from "./travelFastPathsSearch";
import { requestedPassengersFromText } from "./tripRequest";
import type { TravelTrip } from "./travelTypes";

/**
 * @param trips the trips the question is about (the ones on screen, or the ones it named)
 * @param askText what the customer asked, to read the window from
 */
export function buildScopedNotScheduledReply(trips: TravelTrip[], askText: string, now = new Date(),
  /** The customer-visible catalogue: other trips leaving around the asked date are offered too (2026-11-14). */
  catalogue: TravelTrip[] = []): string | null {
  const holiday = holidayWindowOf(askText, now);
  if (holiday) {
    const listing = holidayWindowListing({ pool: trips.filter((trip) => trip.status === "active"), resolution: holiday, now, choice: trips.length > 1,
      party: requestedPassengersFromText(askText) });
    if (listing) return listing.reply;
  }
  // The departures closest to the asked date first (dateAlternatives.ts); the old "each trip's soonest
  // dates" list stays only for an asked time the parser cannot place.
  // A travel kind the customer named ("газраар", "шууд нислэгтэй") narrows the search: a flight departing that day is
  // not "a ground trip on that date" (found by review: the reply said "no trip" and listed a wrong-kind trip).
  const ofKind = filterTripsByTransportIntent(askText, trips);
  // Other trips of the catalogue, of the kind the customer named if they named one (never a flight for "газраар").
  const others = filterTripsByTransportIntent(askText, catalogue.filter((trip) => trip.status === "active"));
  return buildNearestDatesReply(ofKind.length ? ofKind : trips, askText, now, [OTHER_TRIPS_LINK_LINE], { others })
    ?? buildDateNotScheduledReply(trips, now);
}

/** A reply that told the customer the asked time is off the schedule (either wording): a window it names is not carried on. */
export function isNotScheduledReply(reply: string): boolean {
  return reply.startsWith(DATE_NOT_SCHEDULED_HEADING) || reply.includes(NEAREST_DATES_MARKER)
    || /гарах аялал хуваарьт алга байна|гарах аяллын хуваарь одоогоор гараагүй/u.test(reply);
}
