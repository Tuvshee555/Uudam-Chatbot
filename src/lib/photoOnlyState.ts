import { withRedis } from "./redisState";

export type PhotoOnlyState = {
  activeTripId: string | null;
  pendingTripIds: string[];
  lastPromptKind: "generic" | "ambiguous" | "no_photos" | "not_found" | null;
  lastPromptAt: number;
  startedAt: number;
};

const TTL_MS = 10 * 24 * 60 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 24 * 60 * 60;
const memStore = new Map<string, PhotoOnlyState>();

function storeKey(senderId: string) {
  return `photo_only_state:${senderId}`;
}

export async function getPhotoOnlyState(senderId: string): Promise<PhotoOnlyState | null> {
  const redisResult = await withRedis("photo_only_state.get", async (r) => {
    const raw = await r.get(storeKey(senderId));
    return raw ? (JSON.parse(raw) as PhotoOnlyState) : null;
  });
  if (redisResult !== null) return redisResult;

  const mem = memStore.get(senderId);
  if (!mem) return null;
  if (Date.now() - mem.startedAt > TTL_MS) {
    memStore.delete(senderId);
    return null;
  }
  return mem;
}

export async function setPhotoOnlyState(senderId: string, state: PhotoOnlyState): Promise<void> {
  const applied = await withRedis("photo_only_state.set", async (r) => {
    await r.set(storeKey(senderId), JSON.stringify(state), "EX", REDIS_TTL_SEC);
    return true;
  });
  if (!applied) memStore.set(senderId, state);
}

export async function clearPhotoOnlyState(senderId: string): Promise<void> {
  await withRedis("photo_only_state.clear", async (r) => {
    await r.del(storeKey(senderId));
  });
  memStore.delete(senderId);
}

export function createPhotoOnlyState(
  input: Partial<PhotoOnlyState> = {},
): PhotoOnlyState {
  return {
    activeTripId: input.activeTripId ?? null,
    pendingTripIds: input.pendingTripIds ?? [],
    lastPromptKind: input.lastPromptKind ?? null,
    lastPromptAt: input.lastPromptAt ?? 0,
    startedAt: Date.now(),
  };
}
