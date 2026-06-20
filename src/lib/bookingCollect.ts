/**
 * Booking info collector — multi-step mini-flow that runs BEFORE handoff.
 *
 * Flow: booking intent detected → ask name → ask phone → ask trip → create
 * full lead → hand off to human. State is stored in Redis (with in-memory
 * fallback) keyed by sender so it survives between webhook invocations.
 *
 * If Redis is unavailable the flow degrades gracefully: the bot falls back
 * to the old direct-handoff behaviour (no collection).
 */

import { withRedis } from "./redisState";
import { logInfo } from "./observability";

export type CollectStep = "name" | "phone" | "trip" | "done";

export type CollectState = {
  step: CollectStep;
  name: string;
  phone: string;
  trip: string;
  originalMessage: string;
  startedAt: number;
};

const TTL_MS = 10 * 60 * 1000; // 10 min — abandon stale flows
const REDIS_TTL_SEC = 600;

// In-process fallback for when Redis is down
const memStore = new Map<string, CollectState>();

function storeKey(senderId: string) {
  return `booking_collect:${senderId}`;
}

export async function getCollectState(senderId: string): Promise<CollectState | null> {
  const redisResult = await withRedis("booking_collect.get", async (r) => {
    const raw = await r.get(storeKey(senderId));
    return raw ? (JSON.parse(raw) as CollectState) : null;
  });
  if (redisResult !== null) return redisResult;

  // Fallback to in-memory
  const mem = memStore.get(senderId);
  if (!mem) return null;
  if (Date.now() - mem.startedAt > TTL_MS) {
    memStore.delete(senderId);
    return null;
  }
  return mem;
}

export async function setCollectState(senderId: string, state: CollectState): Promise<void> {
  const applied = await withRedis("booking_collect.set", async (r) => {
    await r.set(storeKey(senderId), JSON.stringify(state), "EX", REDIS_TTL_SEC);
    return true;
  });
  if (!applied) {
    memStore.set(senderId, state);
  }
}

export async function clearCollectState(senderId: string): Promise<void> {
  await withRedis("booking_collect.clear", async (r) => {
    await r.del(storeKey(senderId));
  });
  memStore.delete(senderId);
}

export function startCollectState(originalMessage: string): CollectState {
  return {
    step: "name",
    name: "",
    phone: "",
    trip: "",
    originalMessage,
    startedAt: Date.now(),
  };
}

/** Returns the question to ask for the current step. */
export function promptForStep(step: CollectStep): string {
  switch (step) {
    case "name":
      return "Захиалга бүртгэхийн тулд таны нэрийг асуулъя — нэрээ бичнэ үү.";
    case "phone":
      return "Баярлалаа! Тантай холбогдох утасны дугаараа бичнэ үү.";
    case "trip":
      return "Аль аялалд бүртгүүлэхийг хүсэж байна вэ? (маршрут эсвэл аялалын нэр)";
    default:
      return "";
  }
}

/** Advance the state with the user's answer. Returns the updated state. */
export function advanceCollectState(state: CollectState, userText: string): CollectState {
  const text = userText.trim();
  switch (state.step) {
    case "name":
      return { ...state, step: "phone", name: text.slice(0, 100) };
    case "phone":
      return { ...state, step: "trip", phone: text.slice(0, 40) };
    case "trip":
      return { ...state, step: "done", trip: text.slice(0, 200) };
    default:
      return state;
  }
}

/** True if the sender is currently mid-collection flow. */
export async function isInCollectFlow(senderId: string): Promise<boolean> {
  const state = await getCollectState(senderId);
  return state !== null && state.step !== "done";
}

export function buildLeadContext(state: CollectState): string {
  const lines = [];
  if (state.name) lines.push(`Нэр: ${state.name}`);
  if (state.phone) lines.push(`Утас: ${state.phone}`);
  if (state.trip) lines.push(`Хүссэн аялал: ${state.trip}`);
  lines.push(`Анхны мессеж: ${state.originalMessage}`);
  return lines.join("\n");
}

export function buildCompletionMessage(state: CollectState): string {
  const name = state.name || "Та";
  return (
    `${name}, мэдээллийг хүлээн авлаа. ` +
    `Манай ажилтан ${state.phone ? state.phone + " дугаарт " : ""}удахгүй холбогдоно. ` +
    `Хүлээж байсанд баярлалаа!`
  );
}

logInfo("booking_collect.module_loaded", {});
