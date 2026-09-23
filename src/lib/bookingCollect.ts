/**
 * Booking info collector — the short mini-flow that runs BEFORE handoff.
 *
 * Flow: booking intent ("Захиалах") → ask name + phone in one message (the trip
 * the customer was looking at is pre-filled) → ask which trip only if it is
 * still unknown → create a full lead → hand off to a human. State is stored in
 * Redis (with in-memory fallback) keyed by sender.
 *
 * Every answer is VALIDATED. The first version stored whatever came next as
 * the name, then the phone, then the trip, so a customer who asked another
 * question instead was answered with nonsense and the bot paused itself:
 * "oor aylal hari, мэдээллийг хүлээн авлаа. Манай ажилтан bi <хот> aylalin
 * medeelel hariya дугаарт удахгүй холбогдоно" (replayed from a real 2026-09-11
 * conversation). A message that is not an answer now ABANDONS the flow and is
 * answered like any other message.
 */

import { sharedMap } from "./processState";
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

/** Result of feeding one customer message into the flow. */
export type CollectAdvance =
  | { kind: "ask"; state: CollectState; prompt: string }
  | { kind: "done"; state: CollectState }
  | { kind: "abandon" };

const TTL_MS = 10 * 60 * 1000; // 10 min — abandon stale flows
const REDIS_TTL_SEC = 600;

// In-process fallback for when Redis is down
const memStore = sharedMap<string, CollectState>("booking_collect.mem");

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

/** Starts the flow at the contact step; `trip` is the tour already being discussed, if any. */
export function startCollectState(originalMessage: string, trip = ""): CollectState {
  return {
    step: "phone",
    name: "",
    phone: "",
    trip: trip.slice(0, 200),
    originalMessage,
    startedAt: Date.now(),
  };
}

/**
 * Where a customer can see every trip, its full programme and prices without
 * waiting on anyone. Offered alongside the very first booking question: a
 * customer who taps "Захиалах" wants to move NOW, and being asked several
 * questions before receiving anything reads as a form, not service.
 */
export const BOOKING_WEBSITE_URL = "https://uudam-booking-web.vercel.app";

/** The opening question: name and phone together, naming the trip when known. */
export function buildBookingStartPrompt(trip: string): string {
  const lead = trip
    ? `«${trip}» аялалд захиалга өгөхөд тань туслъя 🙌`
    : "Захиалга өгөхөд тань туслъя 🙌";
  return [
    lead,
    "Нэр, утасны дугаараа бичнэ үү — манай аяллын зөвлөх тантай холбогдож захиалгыг баталгаажуулна.",
    "",
    `Бүх аяллыг үнэ, хөтөлбөрийн хамт эндээс харж болно 👉 ${BOOKING_WEBSITE_URL}`,
  ].join("\n");
}

/** Returns the question to ask for the current step. */
export function promptForStep(step: CollectStep, state?: Pick<CollectState, "name" | "trip">): string {
  switch (step) {
    case "name":
    case "phone":
      return state?.name
        ? `Баярлалаа, ${state.name}! Тантай холбогдох утасны дугаараа бичнэ үү 🙌`
        : buildBookingStartPrompt(state?.trip || "");
    case "trip":
      return "Аль аялалд бүртгүүлэхийг хүсэж байна вэ? (аяллын нэр)";
    default:
      return "";
  }
}

// Word stems that never start a person's name but do start the questions
// customers type instead of answering ("oor aylal hari", "Хөтөлбөр үзэх").
// Destinations are not listed here: the caller vetoes anything that matches a
// catalog trip (looksLikeTrip), so no place name lives in code.
const NON_NAME_PREFIXES = [
  "аял", "ayl", "ayal", "aial", "хөтөлб", "hutulb", "hotolb", "мэдээ", "medee", "зураг", "zurag",
  "захиал", "zahial", "бүртгүүл", "burtguul", "баярла", "bayarl", "bayrl", "холбогд", "асуулт",
  "asuult", "нислэг", "nisleg", "хосолс", "hosols", "явуул", "yavuul", "ywuul", "дугаар", "dugaar",
  "хүүхэд", "huuhed", "үнэ", "үний", "vne",
  "une", "огноо", "хэзээ", "hezee", "хэдэн", "heden", "сонир", "sonir", "хүсэлт",
];
// Short everyday words, matched as whole words so real names are not rejected
// for merely containing them ("Сайнбаяр", "Сараа").
const NON_NAME_WORDS = new Set([
  "уу", "юу", "вэ", "бэ", "хэд", "hed", "сайн", "sain", "hi", "hello", "ок", "ok", "за", "za", "zaa",
  "тийм", "tiim", "үгүй", "ugui", "болно", "bolno", "байна", "бна", "bna", "bnu", "bnuu", "baina",
  "байгаа", "bga", "сар", "өдөр", "хоног", "шууд", "shuud", "газар", "gazar", "утас", "utas", "харах",
  "үзэх", "uzeh", "том", "хүн", "tom", "hun", "yu", "we", "ve", "гэж", "юм", "нь", "өөр", "oor",
]);

/**
 * A short answer that reads as a person's name ("Бат", "Б. Болор", "Nomin
 * Bat"): 1-3 letter-only words, no digits or question marks, and none of the
 * words customers use when they are asking something rather than answering.
 */
export function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2 || trimmed.length > 40) return false;
  if (/[\d?!@#₮%]/.test(trimmed)) return false;
  const tokens = trimmed.toLowerCase().split(/\s+/);
  if (tokens.length > 3) return false;
  if (!tokens.every((token) => /^\p{L}[\p{L}.'-]*$/u.test(token))) return false;
  return !tokens.some((token) => {
    const word = token.replace(/[.'-]+$/g, "");
    return NON_NAME_WORDS.has(word) || NON_NAME_PREFIXES.some((prefix) => word.startsWith(prefix));
  });
}

/** Name typed together with the phone ("Бат 99112233") — the letters left over. */
function nameAlongsidePhone(text: string, phone: string): string {
  const rest = text.replace(/[\d\s\-()+.,]{6,}/g, " ").replace(phone, " ").replace(/\s+/g, " ").trim();
  return looksLikePersonName(rest) ? rest : "";
}

/**
 * Feed one customer message into the flow.
 *
 * `phone` is the Mongolian mobile number found in the message (extractPhoneNumber),
 * or "". `looksLikeTrip` lets the caller veto a "name" that is really a trip or
 * destination the customer typed.
 */
export function advanceCollectState(
  state: CollectState,
  userText: string,
  phone: string,
  options: { looksLikeTrip?: (text: string) => boolean } = {},
): CollectAdvance {
  const text = userText.trim();
  if (state.step === "done") return { kind: "done", state };

  if (state.step === "trip") {
    if (!text) return { kind: "ask", state, prompt: promptForStep("trip") };
    return { kind: "done", state: { ...state, step: "done", trip: text.slice(0, 200) } };
  }

  // Contact step ("name" is the legacy first step of flows stored before this change).
  if (phone) {
    const name = (state.name || nameAlongsidePhone(text, phone)).slice(0, 100);
    const next: CollectState = { ...state, name, phone: phone.slice(0, 40) };
    if (next.trip) return { kind: "done", state: { ...next, step: "done" } };
    const asking: CollectState = { ...next, step: "trip" };
    return { kind: "ask", state: asking, prompt: promptForStep("trip") };
  }
  if (!state.name && looksLikePersonName(text) && !options.looksLikeTrip?.(text)) {
    const named: CollectState = { ...state, step: "phone", name: text.slice(0, 100) };
    return { kind: "ask", state: named, prompt: promptForStep("phone", named) };
  }
  return { kind: "abandon" };
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
  const greeting = state.name ? `${state.name}, баярлалаа! ` : "Баярлалаа! ";
  const trip = state.trip ? `«${state.trip}» аяллын захиалгын хүсэлтийг хүлээн авлаа. ` : "Захиалгын хүсэлтийг хүлээн авлаа. ";
  const call = state.phone
    ? `Манай аяллын зөвлөх ${state.phone} дугаарт удахгүй холбогдоно 🙌`
    : "Манай аяллын зөвлөх удахгүй тантай холбогдоно 🙌";
  return `${greeting}${trip}${call}`;
}

/** Reply to "Захиалах" when this customer's booking request is already with staff. */
export const BOOKING_ALREADY_RECEIVED_REPLY =
  "Таны захиалгын хүсэлт манайд ирсэн байгаа 🙌 Манай аяллын зөвлөх тантай удахгүй холбогдоно. Өөр асуух зүйл байвал чөлөөтэй бичээрэй.";

logInfo("booking_collect.module_loaded", {});
