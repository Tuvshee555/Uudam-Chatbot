/**
 * A trip the customer NAMES is that trip, whether or not it can be booked. When it is sold out (or
 * paused) the reply says so and lists the open trips of the same destination. It is decided BEFORE
 * the answer plan (which would price a full trip as if it were open) and before the sibling list
 * (which would stand in for it): real case 13, 2026-11-06, where the named trip's only departure was
 * full and the customer got a list of its siblings without ever being told the named trip was full.
 */
import type { FastPathRoute } from "./fastPathRouting";
import { buildSoldOutPrecedenceReply, buildUnavailableReplyForTrip } from "./travelFastPaths";
import { findTripMatches } from "./travelFastPathsSearch";
import type { TravelTrip } from "./travelTypes";

/** The score lead an open trip needs over a full one before the customer's words count as naming it alone. */
const CLEAR_LEAD = 5;

/**
 * The customer's own words fit an unavailable trip at least as well as the open trip the router
 * chose: a nickname both trips carry ("<landmark>" on a full direct-flight trip and on an open
 * land+flight sibling). Naming the open sibling alone quoted ITS price as the answer to a question
 * about the full trip, and never said the trip the customer saw was full. Only on the turn the trip
 * enters the conversation, so a customer who already chose the open trip is not told again.
 */
function unavailableTripSharingTheWords(text: string, chosen: TravelTrip, trips: TravelTrip[]): TravelTrip | null {
  const matches = findTripMatches(text, trips, { includeSoldOut: true, includePaused: true });
  const chosenScore = matches.find((match) => match.trip.id === chosen.id)?.score;
  if (chosenScore === undefined) return null;
  const unavailable = matches.find((match) => match.trip.status === "sold_out" || match.trip.status === "paused");
  if (!unavailable) return null;
  // A date or a number is not a name (see buildSoldOutPrecedenceReply).
  if (!unavailable.matchedWords.some((word) => /\p{L}{4,}/u.test(word))) return null;
  return chosenScore > unavailable.score + CLEAR_LEAD ? null : unavailable.trip;
}

export function soldOutNamedReply(input: { routed: FastPathRoute; text: string; trips: TravelTrip[] }): string | null {
  const { routed, text, trips } = input;
  const chosen = routed.chosenTripId ? trips.find((trip) => trip.id === routed.chosenTripId) : undefined;
  // The router (evidence now includes fully booked trips) identified the customer's trip and it cannot be booked.
  if (chosen && (chosen.status === "sold_out" || chosen.status === "paused")) {
    return buildUnavailableReplyForTrip(chosen, trips, chosen.status);
  }
  // The router chose an open trip, but the same words name a full one just as well: "one is full,
  // these are open", with the chosen trip among the open ones (otherwise the old answer stands).
  if (chosen && chosen.status === "active" && routed.newTrip && !routed.requestText) {
    const unavailable = unavailableTripSharingTheWords(text, chosen, trips);
    if (unavailable && (unavailable.status === "sold_out" || unavailable.status === "paused")) {
      const reply = buildUnavailableReplyForTrip(unavailable, trips, unavailable.status);
      if (reply.includes(chosen.route_name)) return reply;
    }
  }
  // Siblings are about to be listed: when the customer's own words name an unavailable trip more
  // specifically than any open one (full name, or a clear lead), that trip is the answer's subject.
  if (!chosen && routed.scopedClarify?.length && !routed.informationalAlternatives) {
    return buildSoldOutPrecedenceReply(routed.requestText || text, trips);
  }
  return null;
}
