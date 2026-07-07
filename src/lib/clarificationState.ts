/**
 * Short-lived "which trip did you mean?" state.
 *
 * When the bot asks a disambiguation question ("Таны асууж байгаа аялал 2-3
 * өөр хувилбартай байна: …"), the candidates it OFFERED must scope the
 * customer's next answer. Without this state the follow-up was matched
 * against the whole catalog plus recent turns — a distinctive trip name from
 * an older, unrelated turn could hijack the match and the bot would answer
 * about a trip it never offered (observed live: "шууд нислэгтэй" after a
 * two-Shanghai-trips clarification was answered with the Beidaihe combo from
 * a stale turn).
 *
 * Redis-backed with in-memory fallback, mirroring photoOnlyState.ts.
 */

import { withRedis } from "./redisState";

export type ClarificationState = {
  candidateTripIds: string[];
  createdAt: number;
};

// A clarification is a live back-and-forth — minutes, not days.
const TTL_MS = 10 * 60 * 1000;
const REDIS_TTL_SEC = 10 * 60;
const memStore = new Map<string, ClarificationState>();

function storeKey(senderId: string) {
  return `clarification_state:${senderId}`;
}

export async function getClarificationState(
  senderId: string,
): Promise<ClarificationState | null> {
  const redisResult = await withRedis("clarification_state.get", async (r) => {
    const raw = await r.get(storeKey(senderId));
    return raw ? (JSON.parse(raw) as ClarificationState) : null;
  });
  const state = redisResult ?? memStore.get(senderId) ?? null;
  if (!state) return null;
  if (Date.now() - state.createdAt > TTL_MS) {
    memStore.delete(senderId);
    return null;
  }
  return state;
}

export async function setClarificationState(
  senderId: string,
  candidateTripIds: string[],
): Promise<void> {
  const state: ClarificationState = {
    candidateTripIds: candidateTripIds.slice(0, 5),
    createdAt: Date.now(),
  };
  const applied = await withRedis("clarification_state.set", async (r) => {
    await r.set(storeKey(senderId), JSON.stringify(state), "EX", REDIS_TTL_SEC);
    return true;
  });
  if (!applied) memStore.set(senderId, state);
}

export async function clearClarificationState(senderId: string): Promise<void> {
  await withRedis("clarification_state.clear", async (r) => {
    await r.del(storeKey(senderId));
  });
  memStore.delete(senderId);
}
