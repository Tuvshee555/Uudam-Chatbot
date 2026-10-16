/**
 * The one check every reply passes before it is sent: a reply about ONE trip must be
 * about a trip the conversation actually points to.
 *
 * Why it exists: 26 reply branches and some 56 call sites each pick a trip their own
 * way (strict and loose name matching, date scoping, place words, the model, ad links).
 * Each wrong-trip bug was fixed in the branch it came through, and the next one came
 * through another: Hainan quoted to a customer who wrote only "1", "vne" (model door),
 * the Ordos trip for "any trip Oct 20–23?" ("хооронд" read as an alias — date door).
 * Checking at the exit covers every door at once. The owner's rule decides the outcome:
 * a reply the conversation does not support is not sent; staff take the question.
 */
import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";
import { queryNamedPlaces, resolveTripFromUserMessage, tripMentionsAllPlaces } from "./travelFastPathsSearch";

export type GroundingContext = {
  /** The customer's message this turn. */
  customerText: string;
  /** Earlier turns, oldest first (without this turn). */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** Trips of the bot's last "which trip?" list, when one is open. */
  pendingTripIds?: string[];
  /** The trip the customer is on (picked earlier, or opened from an ad / the website). */
  selectionTripId?: string | null;
  /** Trips the router settled on this turn from a sound basis. */
  routedTripIds?: string[];
  trips: TravelTrip[];
};

const RECENT_TURNS = 12;

/** Trips whose full name appears in the text, longest names first so a name inside another does not count twice. */
export function tripsNamedIn(text: string, trips: TravelTrip[]): TravelTrip[] {
  let rest = normText(text);
  const named: TravelTrip[] = [];
  for (const trip of [...trips].sort((a, b) => b.route_name.length - a.route_name.length)) {
    const name = normText(trip.route_name);
    if (name.length < 6 || !rest.includes(name)) continue;
    named.push(trip);
    rest = rest.split(name).join(" ");
  }
  return named;
}

/** Trips the customer's own words name or narrow to (a trip name, an alias, a place). */
function tripsFromWords(text: string, trips: TravelTrip[]): TravelTrip[] {
  if (!text.trim()) return [];
  const resolution = resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
  const resolved = resolution.status === "verified" && resolution.trip ? [resolution.trip]
    : resolution.status === "ambiguous" ? resolution.candidates : [];
  const places = queryNamedPlaces(text, trips).places;
  const byPlace = places.length ? trips.filter((trip) => tripMentionsAllPlaces(trip, places)) : [];
  return [...resolved, ...byPlace, ...tripsNamedIn(text, trips), ...tripsSharingNameWords(text, trips)];
}

const nameWords = (text: string) => normText(text).split(/[^\p{L}]+/u).filter((word) => word.length >= 4);
const sameStem = (a: string, b: string) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** "Жининь, Хөх хот Мини Аватар Ордос": two or more words of a trip's own name, in any order and spelling of the ending. */
function tripsSharingNameWords(text: string, trips: TravelTrip[]): TravelTrip[] {
  const said = nameWords(text);
  const scored = trips.map((trip) => {
    const own = [...new Set(nameWords(trip.route_name))].filter((word) => !/^(?:аялал|аялл|хотын|нислэг|газар|хосолсон|шууд)/u.test(word));
    return { trip, hits: own.filter((word) => said.some((typed) => sameStem(typed, word))).length };
  });
  // Only the trip(s) the words fit BEST: sibling trips share words ("<A> <B>" inside "<C>-<A> <B>").
  const best = Math.max(0, ...scored.map((row) => row.hits));
  return best >= 2 ? scored.filter((row) => row.hits === best).map((row) => row.trip) : [];
}

/** Every trip this conversation gives the bot a reason to talk about. */
export function groundedTripIds(context: GroundingContext): Set<string> {
  const ids = new Set<string>([
    ...(context.pendingTripIds || []),
    ...(context.selectionTripId ? [context.selectionTripId] : []),
    ...(context.routedTripIds || []),
  ]);
  for (const trip of tripsFromWords(context.customerText, context.trips)) ids.add(trip.id);
  for (const message of context.history.slice(-RECENT_TURNS)) {
    const trips = message.role === "user" ? tripsFromWords(message.text, context.trips) : tripsNamedIn(message.text, context.trips);
    for (const trip of trips) ids.add(trip.id);
  }
  return ids;
}

/**
 * The trip a single-trip reply is about when nothing in the conversation points to it,
 * else null. A reply naming several trips is a list the customer asked for (a month, a
 * kind, a "which one?") and is judged by the other checks.
 */
export function ungroundedTripInReply(reply: string, context: GroundingContext): TravelTrip | null {
  const named = tripsNamedIn(reply, context.trips);
  if (named.length !== 1) return null;
  // A bullet or numbered line is an item of a list the customer asked for ("which trips leave on
  // the 8th?", "the cheapest", "trips to <place>") even when the list has one item.
  const name = normText(named[0].route_name);
  const listed = reply.split(/\r?\n/).some((line) => /^\s*(?:[•*\-]|\d{1,2}[.)])\s*/.test(line) && normText(line).includes(name));
  if (listed) return null;
  return groundedTripIds(context).has(named[0].id) ? null : named[0];
}
