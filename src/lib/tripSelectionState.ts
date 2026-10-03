import { sharedMap } from "./processState";
import { withRedis } from "./redisState";
import type { TripSelection } from "./tripRequest";

type SelectionState = { selection: TripSelection; updatedAt: number };
const TTL_SEC = 6 * 60 * 60;
const MAX_MEMORY_ENTRIES = 2_000;
const store = sharedMap<string, SelectionState>("trip_selection.mem");

export async function getTripSelection(senderId: string): Promise<TripSelection | null> {
  const state = await withRedis("trip_selection.get", async (redis) => {
    const raw = await redis.get(`trip_selection:${senderId}`);
    return raw ? JSON.parse(raw) as SelectionState : null;
  }) ?? store.get(senderId);
  if (!state || Date.now() - state.updatedAt >= TTL_SEC * 1_000) {
    store.delete(senderId);
    return null;
  }
  return state.selection;
}

export async function setTripSelection(senderId: string, selection: TripSelection | null): Promise<void> {
  store.delete(senderId);
  if (!selection) {
    await withRedis("trip_selection.clear", (redis) => redis.del(`trip_selection:${senderId}`));
    return;
  }
  const state = { selection, updatedAt: Date.now() };
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
