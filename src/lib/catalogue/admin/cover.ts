/**
 * Candidates for the book's COVER photograph: the best approved photos that no trip page uses.
 *
 * Staff pick one in «Зураг ба гарчиг»; it is stored as config.coverPhoto (a staff choice, never a trip
 * fact). The pool is built from each trip's own photo candidates (the DATA port's listPhotoCandidates),
 * so only photos that already belong to a trip can be offered, and the PUT re-checks the choice against
 * its trip's candidates. The search is BOUNDED: a trip cap, a per-trip cap, small concurrency and a time
 * budget, because listing candidates measures real image sizes over the network.
 *
 * "Used by a page" = a trip's hero (staff choice, else the best ranked photo) or one of its two gallery
 * photos: the same selectHero() the snapshot builder runs, so the answer matches what the book prints.
 */

import type { TravelTrip } from "../../travelTypes";
import { assessHero, photoKey, selectHero } from "../photos";
import type { CatalogueConfig, CatalogueHeroChoice, CataloguePhotoCandidate, IsoDay } from "../types";
import type { CatalogueDataPort } from "./deps";
import type { CatalogueCoverCandidate } from "./types";

export const COVER_MAX_TRIPS = 14;
export const COVER_PER_TRIP = 3;
export const COVER_MAX_CANDIDATES = 30;
export const COVER_CONCURRENCY = 3;
export const COVER_BUDGET_MS = 45_000;

export type CoverTripPool = {
  tripId: string;
  code: string | null;
  title: string;
  candidates: CataloguePhotoCandidate[];
  chosen: CatalogueHeroChoice | null;
};

/** Pure. The best approved photos nobody prints, best first, at most COVER_PER_TRIP per trip. */
export function rankCoverCandidates(pools: readonly CoverTripPool[], config: Pick<CatalogueConfig, "heroByTripId" | "coverPhoto">): CatalogueCoverCandidate[] {
  const used = new Set<string>();
  for (const pool of pools) {
    const selection = selectHero(pool.candidates, config.heroByTripId?.[pool.tripId] ?? pool.chosen);
    if (selection.hero) used.add(photoKey(selection.hero.url));
    for (const photo of selection.gallery) used.add(photoKey(photo.url));
  }
  const seen = new Set<string>();
  const out: CatalogueCoverCandidate[] = [];
  for (const pool of pools) {
    const fresh = pool.candidates
      // Poster layouts carry text and prices; a cover is a clean photograph. Weak files never open a book.
      .filter((candidate) => candidate.source !== "poster_hero" && assessHero(candidate) !== "weak" && !used.has(photoKey(candidate.url)))
      .sort((a, b) => b.score - a.score)
      .slice(0, COVER_PER_TRIP);
    for (const candidate of fresh) {
      const key = photoKey(candidate.url);
      if (seen.has(key)) continue; // the same picture stored under two trips is offered once
      seen.add(key);
      out.push({ ...candidate, tripId: pool.tripId, code: pool.code, tripTitle: pool.title });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, COVER_MAX_CANDIDATES);
}

/** Which trips to look at first: the Quick selection, then the other eligible trips, newest first, bounded. */
export function coverSearchOrder(activeTrips: readonly TravelTrip[], quickTripIds: readonly string[], eligible: (trip: TravelTrip) => boolean): TravelTrip[] {
  const byId = new Map(activeTrips.map((trip) => [trip.id, trip]));
  const first = quickTripIds.map((id) => byId.get(id)).filter((trip): trip is TravelTrip => Boolean(trip));
  const firstIds = new Set(first.map((trip) => trip.id));
  const rest = activeTrips.filter((trip) => !firstIds.has(trip.id)).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id));
  return [...first, ...rest].filter(eligible).slice(0, COVER_MAX_TRIPS);
}

/** Impure: reads trip photo candidates through the DATA port. Never writes. */
export async function loadCoverPools(params: {
  data: CatalogueDataPort;
  activeTrips: readonly TravelTrip[];
  config: CatalogueConfig;
  today: IsoDay;
  codes: Record<string, string>;
  now: () => number;
  budgetMs?: number;
}): Promise<{ pools: CoverTripPool[]; truncated: boolean; searched: number }> {
  const { data, config, today } = params;
  const order = coverSearchOrder(params.activeTrips, config.quick.tripIds, (trip) => data.isTripEligible(trip, today).eligible);
  const deadline = params.now() + (params.budgetMs ?? COVER_BUDGET_MS);
  const pools: CoverTripPool[] = new Array(order.length);
  let next = 0;
  let stoppedEarly = false;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= order.length) return;
      if (params.now() > deadline) {
        stoppedEarly = true;
        return;
      }
      const trip = order[index]!;
      try {
        const found = await data.listPhotoCandidates(trip.id);
        pools[index] = { tripId: trip.id, code: params.codes[trip.id] ?? null, title: trip.route_name, candidates: found.candidates, chosen: found.chosen };
      } catch {
        // One trip whose photos cannot be read must not hide the others.
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COVER_CONCURRENCY, order.length) }, worker));
  const done = pools.filter(Boolean);
  return { pools: done, truncated: stoppedEarly, searched: done.length };
}
