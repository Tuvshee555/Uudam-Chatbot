/**
 * A trip the customer NAMES is that trip, whether or not it can be booked. When it is sold out (or
 * paused) the reply says so and lists the open trips of the same destination. It is decided BEFORE
 * the answer plan (which would price a full trip as if it were open) and before the sibling list
 * (which would stand in for it): real case 13, 2026-11-06, where the named trip's only departure was
 * full and the customer got a list of its siblings without ever being told the named trip was full.
 */
import type { FastPathRoute } from "./fastPathRouting";
import { buildSoldOutPrecedenceReply, buildUnavailableReplyForTrip } from "./travelFastPaths";
import type { TravelTrip } from "./travelTypes";

export function soldOutNamedReply(input: { routed: FastPathRoute; text: string; trips: TravelTrip[] }): string | null {
  const { routed, text, trips } = input;
  const chosen = routed.chosenTripId ? trips.find((trip) => trip.id === routed.chosenTripId) : undefined;
  // The router (evidence now includes fully booked trips) identified the customer's trip and it cannot be booked.
  if (chosen && (chosen.status === "sold_out" || chosen.status === "paused")) {
    return buildUnavailableReplyForTrip(chosen, trips, chosen.status);
  }
  // Siblings are about to be listed: when the customer's own words name an unavailable trip more
  // specifically than any open one (full name, or a clear lead), that trip is the answer's subject.
  if (!chosen && routed.scopedClarify?.length && !routed.informationalAlternatives) {
    return buildSoldOutPrecedenceReply(routed.requestText || text, trips);
  }
  return null;
}
