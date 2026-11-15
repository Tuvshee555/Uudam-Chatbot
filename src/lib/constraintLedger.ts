/**
 * The customer's own constraints, kept across turns independently of any one trip: where (destination
 * words), when (a month, a range, a holiday window), who (passengers with ages), how many (a group size)
 * and why (a purpose). The trip selection (tripSelectionState.ts) only holds what belongs to ONE trip, so
 * a family that said "2 том 2 хүүхэдтэй явна" before naming any trip lost the party when the trip came
 * (CTX-05), and a switch to another trip carried only what that one selection held.
 *
 * Written after routing from the turn's request (buildTripRequest + the understanding); read when a trip
 * is chosen (fastPathRouting.ts → mergeTripSelection): a different trip starts from the ledger's party and
 * window. A stated value always replaces the stored one; a destination the catalogue does not hold leaves
 * it as it was. An exact date belongs to one trip's departure and is never carried to another trip; it
 * replaces the stored window (the customer has moved past "some time in December").
 *
 * Storage: the same pattern as tripSelectionState.ts — a Redis key with a process-memory fallback, 6 h.
 * An empty ledger changes nothing anywhere.
 */
import { sharedMap } from "./processState";
import { withRedis } from "./redisState";
import { mergeTripSelection, type RequestedPassenger, type TripDateScope, type TripRequest } from "./tripRequest";
import type { TravelTrip } from "./travelTypes";
import { getTripNameHaystack } from "./travelFastPathsSearch";
import { GENERIC_ROUTE_WORDS, normText } from "./travelTextNorm";
import { upcomingDepartures } from "./tripFareBlock";

export type ConstraintLedger = {
  destinations: string[];
  dateScope: TripDateScope | null;
  passengers: RequestedPassenger[];
  groupSize: number | null;
  purpose: string | null;
  updatedAt: number;
};

const TTL_SEC = 6 * 60 * 60;
const MAX_MEMORY_ENTRIES = 2_000;
const store = sharedMap<string, ConstraintLedger>("constraint_ledger.mem");
const key = (senderId: string) => `constraint_ledger:${senderId}`;

export async function getConstraintLedger(senderId: string): Promise<ConstraintLedger | null> {
  const state = await withRedis("constraint_ledger.get", async (redis) => {
    const raw = await redis.get(key(senderId));
    return raw ? JSON.parse(raw) as ConstraintLedger : null;
  }) ?? store.get(senderId);
  if (!state || Date.now() - state.updatedAt >= TTL_SEC * 1_000) {
    store.delete(senderId);
    return null;
  }
  return state;
}

async function saveConstraintLedger(senderId: string, ledger: ConstraintLedger): Promise<void> {
  store.delete(senderId);
  const saved = await withRedis("constraint_ledger.set", async (redis) => {
    await redis.set(key(senderId), JSON.stringify(ledger), "EX", TTL_SEC);
    return true;
  });
  if (!saved) {
    for (const [id, value] of store) if (ledger.updatedAt - value.updatedAt >= TTL_SEC * 1_000) store.delete(id);
    if (store.size >= MAX_MEMORY_ENTRIES) store.delete(store.keys().next().value!);
    store.set(senderId, ledger);
  }
}

export async function clearConstraintLedger(senderId: string): Promise<void> {
  store.delete(senderId);
  await withRedis("constraint_ledger.clear", (redis) => redis.del(key(senderId)));
}

// "20 хүн", "60 хүний баг", "45 ажилтан", "25 сурагч": a head count, not a fare party.
const GROUP_SIZE = /(?<![\d.,/-])(\d{1,3})\s*(?:хүн(?:ий|тэй)?|ажилтан\p{L}*|сурагч\p{L}*|оюутан\p{L}*|hun(?:ii|tei)?|ajiltan\w*|suragch\w*)(?!\p{L})/iu;
const PURPOSES: Array<[string, RegExp]> = [
  ["medical", /шинжилгээ|эмчилгээ|эмнэлэг|checkup|shinjilgee|emchilgee|emneleg/iu],
  ["honeymoon", /бал\s*сар|bal\s*sar|honeymoon/iu],
  ["competition", /тэмцээн|temtseen|temcen/iu],
  ["business", /бизнес|үзэсгэлэн|biznes|business|uzesgelen/iu],
  ["study", /сургалт|surgalt|хэлний\s+бэлтгэл/iu],
  ["shopping", /худалдаа|бараа\s+авах|hudaldaa|shopping/iu],
  ["rest", /амралт|амрах|amralt|amrah/iu],
];

/** Destination words of the message that the catalogue holds (an unknown place is not stored). */
function destinationWords(text: string, trips: TravelTrip[]): string[] {
  const names = new Set(trips.flatMap((trip) => getTripNameHaystack(trip).split(/\s+/)).filter((word) => word.length >= 4));
  return [...new Set(normText(text).split(/\s+/).filter((word) => word.length >= 4 && !GENERIC_ROUTE_WORDS.has(word)
    && [...names].some((name) => name === word || (word.length >= 5 && name.startsWith(word.slice(0, 5))))))];
}

const LEDGER_TRIP = "constraint-ledger";

/** The ledger after this turn: every value the turn states replaces the stored one. */
export function nextConstraintLedger(previous: ConstraintLedger | null, input: {
  text: string; request: TripRequest; trips: TravelTrip[]; now?: number;
}): ConstraintLedger {
  const { request } = input;
  // Party and window merge by the trip selection's own rules ("Одоо 3 том хүн" changes one count,
  // "2 том 2 хүүхэд" restates the party), against the ledger as if it were one trip.
  const merged = mergeTripSelection(LEDGER_TRIP, request, previous
    ? { tripId: LEDGER_TRIP, date: null, hotel: null, package: null, passengers: previous.passengers, ...(previous.dateScope ? { dateScope: previous.dateScope } : {}) }
    : null);
  const destinations = destinationWords(input.text, input.trips);
  const group = GROUP_SIZE.exec(input.text);
  const purpose = PURPOSES.find(([, pattern]) => pattern.test(input.text))?.[0] ?? null;
  return {
    destinations: destinations.length ? destinations : previous?.destinations || [],
    dateScope: request.date ? null : merged.dateScope || null,
    passengers: merged.passengers,
    groupSize: group ? Number(group[1]) : previous?.groupSize ?? null,
    purpose: purpose ?? previous?.purpose ?? null,
    updatedAt: input.now ?? Date.now(),
  };
}

const isEmpty = (ledger: ConstraintLedger) => !ledger.destinations.length && !ledger.dateScope && !ledger.passengers.length && ledger.groupSize === null && ledger.purpose === null;

/** Records the turn's constraints. Nothing stated and nothing stored: nothing is written. */
export async function recordConstraints(senderId: string, input: { text: string; request: TripRequest; trips: TravelTrip[] }): Promise<void> {
  const previous = await getConstraintLedger(senderId);
  const next = nextConstraintLedger(previous, input);
  if (!previous && isEmpty(next)) return;
  await saveConstraintLedger(senderId, next);
}

/**
 * What a newly chosen trip inherits: the party, and the window only when the trip departs in it (a
 * window the trip has no departure in would make its answer empty, not narrower).
 */
export function ledgerCarryFor(ledger: ConstraintLedger | null, trip: TravelTrip, now = new Date()): { passengers: RequestedPassenger[]; dateScope: TripDateScope | null } | null {
  if (!ledger || (!ledger.passengers.length && !ledger.dateScope)) return null;
  const scope = ledger.dateScope;
  const fits = scope && upcomingDepartures(trip, now).some((date) => (!scope.month || Number(date.slice(5, 7)) === scope.month)
    && (!scope.year || Number(date.slice(0, 4)) === scope.year)
    && (!scope.range || (date >= scope.range[0] && date <= scope.range[1]))
    && (!scope.dates || scope.dates.includes(date)));
  return { passengers: ledger.passengers, dateScope: fits ? scope : null };
}
