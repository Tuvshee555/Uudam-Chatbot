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
import { DATE_NOT_SCHEDULED_HEADING, buildDateNotScheduledReply } from "./travelFastPathsPricing";
import { requestedPassengersFromText } from "./tripRequest";
import type { TravelTrip } from "./travelTypes";

/**
 * @param trips the trips the question is about (the ones on screen, or the ones it named)
 * @param askText what the customer asked, to read the window from
 */
export function buildScopedNotScheduledReply(trips: TravelTrip[], askText: string, now = new Date()): string | null {
  const holiday = holidayWindowOf(askText, now);
  if (holiday) {
    const listing = holidayWindowListing({ pool: trips.filter((trip) => trip.status === "active"), resolution: holiday, now, choice: trips.length > 1,
      party: requestedPassengersFromText(askText) });
    if (listing) return listing.reply;
  }
  return buildDateNotScheduledReply(trips, now);
}

/** A reply that told the customer the asked time is off the schedule (either wording): a window it names is not carried on. */
export function isNotScheduledReply(reply: string): boolean {
  return reply.startsWith(DATE_NOT_SCHEDULED_HEADING)
    || /гарах аялал хуваарьт алга байна|гарах аяллын хуваарь одоогоор гараагүй/u.test(reply);
}
