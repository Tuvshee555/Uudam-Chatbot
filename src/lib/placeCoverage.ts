/**
 * Every place the customer names must be in the trip the bot answers about.
 *
 * Live 2026-11-07: "Shanghai Janjiaje 2 hotiin aylal ni 1 sard garah" (a two-city trip: Shanghai AND
 * Zhangjiajie) picked a Beijing trip through a look-alike of the second city and ignored "Shanghai";
 * the next "Vne" quoted that trip's price. Live 2026-11-11: "жухай хайлины хөтөлбөр" (a city AND an
 * island of a trip that has ended) got the card of another trip that only shares the city.
 *
 * A trip is chosen from the customer's words only if none of the place words in those words is
 * missing from it. A place word is a word that names some OTHER catalogue trip on its own: an active
 * one, or one that has ended. An ordinary word the catalogue does not hold ("хувцас", "нөгөө") is not
 * a place here: only the catalogue decides what a place is. When a place is missing the bot does not
 * know the answer: the caller hands the turn to staff and remembers no trip.
 *
 * No place, trip or price lives here: places come from the catalogue only.
 */

import { isVerbOrFunctionWord } from "./placeLikeTokens";
import { isAttributeWord } from "./travelModeWords";
import { getTripNameHaystack, resolveTripFromUserMessage } from "./travelFastPathsSearch";
import { isHomeCityWord, phoneticLatinText } from "./travelTextNorm";
import type { TravelTrip } from "./travelTypes";

const MIN_PLACE_WORD = 4;

function stemOf(word: string): string {
  return word.slice(0, Math.max(4, word.length - 3));
}

/** Is `word` (any script) one of the trip's own name / alias / destination words, case endings allowed? */
function tripHasWord(trip: TravelTrip, word: string): boolean {
  const haystack = getTripNameHaystack(trip);
  if (haystack.includes(stemOf(word))) return true;
  const latin = phoneticLatinText(word);
  if (latin.length < MIN_PLACE_WORD) return false;
  return phoneticLatinText(haystack).includes(stemOf(latin));
}

/** Does `word` alone name a trip of `pool` other than `trip`? */
function namesAnotherTrip(word: string, trip: TravelTrip, pool: TravelTrip[]): boolean {
  if (!pool.length) return false;
  const alone = resolveTripFromUserMessage(word, pool, { allowLooseFallback: false, includeSoldOut: true } as never);
  if (alone.status === "verified") return alone.trip?.id !== trip.id;
  if (alone.status === "ambiguous") return alone.candidates.length > 0 && !alone.candidates.some((candidate) => candidate.id === trip.id);
  return false;
}

/**
 * The place words of `text` the trip does not have. Empty = the trip covers every place named.
 * `trips` is the active catalogue; `endedTrips` (archived, loaded only when a word is left unexplained)
 * lets a place that only an ended trip holds count too.
 */
export async function placesMissingFromTrip(text: string, trip: TravelTrip, trips: TravelTrip[],
  endedTrips?: () => Promise<TravelTrip[]>): Promise<string[]> {
  const words = [...new Set(String(text || "")
    .split(/[^\p{L}]+/u)
    .map((word) => word.toLowerCase())
    // A travel mode or trip kind ("газраар", "нислэгтэй", "хосолсон") is how a trip travels, never where it
    // goes: an ended trip's own text holding "газраар" made every "<city> газраар ..." question silence.
    .filter((word) => word.length >= MIN_PLACE_WORD && !isHomeCityWord(word) && !isVerbOrFunctionWord(word) && !isAttributeWord(word)))]
    .filter((word) => !tripHasWord(trip, word));
  if (!words.length) return [];
  const missing = words.filter((word) => namesAnotherTrip(word, trip, trips));
  const unexplained = words.filter((word) => !missing.includes(word) && !trips.some((other) => tripHasWord(other, word)));
  if (unexplained.length && endedTrips) {
    const ended = await endedTrips().catch(() => [] as TravelTrip[]);
    for (const word of unexplained) if (ended.some((other) => other.id !== trip.id && tripHasWord(other, word))) missing.push(word);
  }
  return missing;
}
