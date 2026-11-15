/**
 * The time window an earlier turn asked for, which a later turn still means.
 *
 * "Цагаан сараар явмаар байна" is answered with a list or with "which destination?", and the
 * customer's next message ("Паттаяа", "хүүхдийн үнэ хэд вэ") names a trip or a party but no time. The
 * window is still the one asked for: dropping it showed the trip's earliest departures instead of
 * the holiday's (live 2026-11-04, 2026-11-05).
 *
 * This is the SEAM for a sender-level constraint ledger (months, holidays, passengers, exclusions
 * kept across turns). Today the only source is the last user turn before the bot's last reply;
 * every caller asks this one function, so the ledger can replace the body without touching them.
 */

import { isNotScheduledReply } from "./dateNotScheduled";
import { unknownPlaceTokens } from "./placeLikeTokens";
import { requestedDepartureScope, type RequestedDepartureScope } from "./travelDates";
import type { TravelTrip } from "./travelTypes";

export type InheritedDateScope = {
  /** The earlier user message that carried the window (its words, to be read like a typed date). */
  text: string;
  scope: RequestedDepartureScope;
};

function looseNorm(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/**
 * The window of the user turn the bot's last reply answered, when that reply was a list of trips or
 * a "which trip / destination?" question and the turn asked for a time. Null otherwise: after "that
 * time has no departure" the customer was told the window is off the schedule, so a pick drops it.
 */
export function getInheritedDateScope(input: {
  history?: Array<{ role: "user" | "assistant"; text: string }>;
  trips: TravelTrip[];
  now: Date;
}): InheritedDateScope | null {
  const history = input.history;
  if (!history?.length) return null;
  const lastReplyIndex = history.findLastIndex((message) => message.role === "assistant");
  if (lastReplyIndex < 0) return null;
  const reply = history[lastReplyIndex].text;
  const original = history.slice(0, lastReplyIndex).findLast((message) => message.role === "user");
  if (!original || isNotScheduledReply(reply)) return null;
  const shownTrips = input.trips.filter((trip) => looseNorm(reply).includes(looseNorm(trip.route_name))).length;
  const displaysTripList = /(?:^|\n)\s*(?:[•*-]|\d{1,2}\.)\s+/u.test(reply) && shownTrips > 1;
  const asksWhich = /(?:аль|ямар)\s+(?:аялл?|чиглэл)|which\s+(?:trip|destination)/iu.test(reply);
  if (!displaysTripList && !asksWhich) return null;
  const scope = requestedDepartureScope(original.text, input.now);
  if (!scope || scope.kind === "unsupported") return null;
  // A message that named a place nothing holds was not answered with a list: nothing to continue.
  if (unknownPlaceTokens(original.text, input.trips).length > 0) return null;
  return { text: original.text, scope };
}
