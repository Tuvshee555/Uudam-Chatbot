import { sharedMap } from "./processState";
import { withRedis } from "./redisState";
import type { TripSelection } from "./tripRequest";

/**
 * `recent` is a short stack of the trips the customer was on BEFORE the selected one (most recent
 * first, never the selected trip). "Not that one, the other", "go back to the first" resolve to them
 * (tripContrast.ts); without it a switch left no trace of where the customer had been.
 */
type SelectionState = { selection: TripSelection; updatedAt: number; recent?: string[] };
const TTL_SEC = 6 * 60 * 60;
const MAX_MEMORY_ENTRIES = 2_000;
export const RECENT_TRIPS_MAX = 3;
const store = sharedMap<string, SelectionState>("trip_selection.mem");

async function loadState(senderId: string): Promise<SelectionState | null> {
  const state = await withRedis("trip_selection.get", async (redis) => {
    const raw = await redis.get(`trip_selection:${senderId}`);
    return raw ? JSON.parse(raw) as SelectionState : null;
  }) ?? store.get(senderId);
  if (!state || Date.now() - state.updatedAt >= TTL_SEC * 1_000) {
    store.delete(senderId);
    return null;
  }
  return state;
}

export async function getTripSelection(senderId: string): Promise<TripSelection | null> {
  return (await loadState(senderId))?.selection ?? null;
}

/** The trips the customer was on before the selected one, most recent first (at most three). */
export async function getRecentTripIds(senderId: string): Promise<string[]> {
  const state = await loadState(senderId);
  return state ? (state.recent || []).filter((id) => id !== state.selection.tripId).slice(0, RECENT_TRIPS_MAX) : [];
}

/**
 * `offeredTripIds` = the list the customer picked this trip from. Its other members were SHOWN to the
 * customer, so "the other one" can mean them; the first listed is the oldest entry of the stack.
 */
export async function setTripSelection(senderId: string, selection: TripSelection | null, offeredTripIds: string[] = []): Promise<void> {
  const previous = selection ? await loadState(senderId) : null;
  store.delete(senderId);
  if (!selection) {
    await withRedis("trip_selection.clear", (redis) => redis.del(`trip_selection:${senderId}`));
    return;
  }
  const chain = previous ? [previous.selection.tripId, ...(previous.recent || [])] : [];
  const recent = [...chain, ...[...offeredTripIds].reverse()]
    .filter((id, index, all) => id !== selection.tripId && all.indexOf(id) === index)
    .slice(0, RECENT_TRIPS_MAX);
  const state: SelectionState = { selection, updatedAt: Date.now(), ...(recent.length ? { recent } : {}) };
  const saved = await withRedis("trip_selection.set", async (redis) => {
    await redis.set(`trip_selection:${senderId}`, JSON.stringify(state), "EX", TTL_SEC);
    return true;
  });
  if (!saved) {
    for (const [key, value] of store) if (state.updatedAt - value.updatedAt >= TTL_SEC * 1_000) store.delete(key);
    if (store.size >= MAX_MEMORY_ENTRIES) store.delete(store.keys().next().value!);
    store.set(senderId, state);
  }
}
