/**
 * Contrast and reference cues: "not the previous one, the other one with the sea", "not this one",
 * "go back to the first". They mean NOT the trip the customer is on, so the trip on screen must
 * never be the answer. The trips they can mean are found without a model: the catalogue minus the
 * selected trip, narrowed by the deterministic kind words in the message (sea, transport kind), and
 * preferring trips the customer was already shown (a short stack kept in tripSelectionState.ts).
 */
import type { TravelTrip } from "./travelTypes";
import { normText } from "./travelTextNorm";
import { filterTripsByTransportIntent, queryWantsSeaBeach, tripHasSeaBeach } from "./travelFastPathsSearch";

export type ContrastCue = "previous" | "other" | "first" | "not_this";

// Whole words only: "нөгөөдөр" (the day after tomorrow) is a date, not "the other one".
const OTHER_WORDS = /(?:^|\s)(?:нөгөө|нөгөөх|нөгөөгийн|нөгөөг|нөгөөгөө|nugu|nuguu|nugui|nogoo)(?=\s|$)/u;
const PREVIOUS_WORDS = /(?:^|\s)(?:өмнөх|өмнөхөө|өмнөхийг|omnoh|umnuh|omnoh\p{L}*)(?=\s|$)/u;
const FIRST_WORDS = /(?:^|\s)(?:эхнийх\p{L}*|эхний\s+(?:аял\p{L}*|нь|хувилбар\p{L}*|нэг)|ehniih\p{L}*|ehnii\s+(?:ayl\p{L}*|ayal\p{L}*|ni))(?=\s|$)/u;
const NOT_THIS_WORDS = /(?:^|\s)(?:энэ|тэр|энэхүү|энийг|тэрийг|ene|ter)\s+(?:аялал\p{L}*\s+|aylal\p{L}*\s+)?(?:биш|хэрэггүй|болохгүй|bish|hereggui)(?=\s|$)/u;

const TRIP_WORD = /(?:^|\s)(?:аял\p{L}*|aylal\p{L}*|ayalal\p{L}*|хувилбар\p{L}*)(?=\s|$)/u;

export function detectContrastCue(text: string): ContrastCue | null {
  const said = normText(text);
  if (NOT_THIS_WORDS.test(said)) return "not_this";
  if (PREVIOUS_WORDS.test(said)) return "previous";
  if (FIRST_WORDS.test(said)) return "first";
  if (OTHER_WORDS.test(said)) return "other";
  return null;
}

/** The kinds the message names with deterministic words; `applied` is false when it names none. */
export function narrowByKind(text: string, pool: TravelTrip[]): { trips: TravelTrip[]; applied: boolean } {
  let trips = pool;
  let applied = false;
  const byTransport = filterTripsByTransportIntent(text, trips);
  if (byTransport !== trips) { trips = byTransport; applied = true; }
  if (queryWantsSeaBeach(text)) { trips = trips.filter(tripHasSeaBeach); applied = true; }
  return { trips, applied };
}

/**
 * The trips a contrast message can mean, in answer order, or null when it cannot be resolved (the
 * caller then keeps its ordinary evidence). `stack` holds the trips the customer was shown, most
 * recent first; the selected trip is excluded here.
 */
export function contrastCandidates(input: {
  text: string; catalog: TravelTrip[]; selectedIds: string[]; stack: string[];
}): { cue: ContrastCue; tripIds: string[] } | null {
  const cue = detectContrastCue(input.text);
  if (!cue) return null;
  const selected = new Set(input.selectedIds);
  const bookable = input.catalog.filter((trip) => !selected.has(trip.id) && (trip.status === "active" || trip.status === "sold_out"));
  const seen = input.stack.filter((id, index, all) => !selected.has(id) && all.indexOf(id) === index && bookable.some((trip) => trip.id === id));
  const { trips: ofKind, applied } = narrowByKind(input.text, bookable);
  // "нөгөө", "өмнөх" and "эхний" are everyday words ("нөгөө 2 хүн"). They mean another TRIP only when the
  // message is about trips (it says аялал or names a kind of trip) or says outright "not this one".
  if (cue !== "not_this" && !applied && !TRIP_WORD.test(normText(input.text))) return null;
  if (applied) {
    const seenOfKind = seen.filter((id) => ofKind.some((trip) => trip.id === id));
    if (seenOfKind.length) return { cue, tripIds: [cue === "first" ? seenOfKind[seenOfKind.length - 1] : seenOfKind[0]] };
    return ofKind.length ? { cue, tripIds: ofKind.map((trip) => trip.id) } : null;
  }
  if (!seen.length) return null;
  return { cue, tripIds: [cue === "first" ? seen[seen.length - 1] : seen[0]] };
}
