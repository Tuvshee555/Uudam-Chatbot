/** Customer evidence at the delivery boundary must predate the answer's selection. */
import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";
import { queryNamedPlaces, resolveTripFromUserMessage, tripMentionsAllPlaces } from "./travelFastPathsSearch";
import { websiteTripLinksInText } from "./bookingWebsite";
import { tripFromRecentMenu, tripMenuQuestionIndex } from "./tripMenuChoice";

export type GroundingContext = {
  /** The customer's message this turn. */
  customerText: string;
  /** Earlier turns, oldest first (without this turn). */
  history: Array<{ role: "user" | "assistant"; text: string }>;
  /** Trips of the bot's last "which trip?" list, when one is open. */
  pendingTripIds?: string[];
  /** The trip the customer is on (picked earlier, or opened from an ad / the website). */
  selectionTripId?: string | null;
  /** Legacy caller field. A router's newly selected IDs cannot authorize themselves. */
  routedTripIds?: string[];
  /** Explicit alternatives produced by a deterministic catalog/clarification builder. */
  catalogTripIds?: string[];
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
  const website = websiteTripLinksInText(text);
  const resolution = resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
  const resolved = resolution.status === "verified" && resolution.trip ? [resolution.trip]
    : resolution.status === "ambiguous" ? resolution.candidates : [];
  if (website.slugs.length > 0) return resolved;
  const words = website.textWithoutUrls;
  const named = tripsNamedIn(words, trips);
  if (named.length) return named;
  if (resolved.length) return resolved;
  const shared = tripsSharingNameWords(words, trips);
  if (shared.length) return shared;
  const places = queryNamedPlaces(words, trips).places;
  const byPlace = places.length ? trips.filter((trip) => tripMentionsAllPlaces(trip, places)) : [];
  return byPlace;
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
  const current = tripsFromWords(context.customerText, context.trips).map(trip => trip.id);
  const catalog = context.catalogTripIds || [];
  if (websiteTripLinksInText(context.customerText).slugs.length > 0) {
    // A newly shared page replaces prior chat context, including a stale
    // selection. An unknown page gives no permission to answer about an old trip.
    return new Set(current);
  }
  if (current.length) return new Set([...current, ...catalog]);
  if (tripMenuQuestionIndex(context.customerText) !== null) {
    const trip = tripFromRecentMenu(context.customerText, context.history, context.trips);
    return new Set(trip ? [trip.id] : []);
  }
  if (context.pendingTripIds?.length) return new Set([...context.pendingTripIds, ...catalog]);
  if (context.selectionTripId) return new Set([context.selectionTripId, ...catalog]);
  const recent = context.history.slice(-RECENT_TURNS).reverse();
  for (const role of ["user", "assistant"] as const) {
    for (const message of recent) {
      if (message.role !== role) continue;
      const trips = role === "user" ? tripsFromWords(message.text, context.trips) : tripsNamedIn(message.text, context.trips);
      if (trips.length) return new Set([...trips.map(trip => trip.id), ...catalog]);
    }
  }
  return new Set(catalog);
}

/**
 * Formatting and the number of named trips confer no authority. Catalog builders
 * supply their explicit result IDs; model prose must use existing customer scope.
 */
export function ungroundedTripInReply(reply: string, context: GroundingContext): TravelTrip | null {
  const named = tripsNamedIn(reply, context.trips);
  const allowed = groundedTripIds(context);
  return named.find(trip => !allowed.has(trip.id)) || null;
}
