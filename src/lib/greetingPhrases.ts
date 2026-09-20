/**
 * Pure greeting-word matching, deliberately dependency-free.
 *
 * welcomeFlow.ts (which decides whether to send the first-message greeting +
 * buttons) transitively imports the DB/env chain (travelDb -> neonDb -> env),
 * which throws at import time if required env vars aren't set. contextualText.ts
 * and its tests must stay importable standalone with no env setup at all — so
 * the shared greeting word list lives here, in a module neither side needs to
 * pull the other's dependencies in for.
 */

// Short generic openers that should trigger the greeting + buttons.
// Anything more specific (trip names, destinations, questions) skips the greeting.
export const GENERIC_OPENERS = [
  "сайн уу", "сайнуу", "сайн", "hi", "hello", "hey", "сайн байна уу",
  "байна уу", "мэнд", "нүүр", "нүүрх", "хэллоу", "хай", "мэндчилье",
  "ассалам", "привет", "өдрийн мэнд", "оюу", "ok", "ок", "ок",
  "👋", "😊", "🙏", "хэрхэн", "юу байна", "та нар",
];

/**
 * A message that is only a short number ("5", "55", "3.", "12)"): a customer
 * answering a numbered list, or a stray digit. It carries no meaning of its own
 * — one was read as "5 million" and quoted a price search — so unless a numbered
 * question is actually pending it must not be answered at all.
 */
export function isBareNumber(text: string): boolean {
  return /^\s*\d{1,3}\s*[.)]?\s*$/.test(text);
}

/**
 * Returns true if the message is a generic opener that should trigger the
 * full greeting flow. Returns false if the person already asked something
 * specific — in that case, skip the greeting and just answer.
 */
export function isGenericOpener(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[!?.🙏👋😊]/g, "").trim();
  // A bare number ("5", "55") is never a greeting. The old <=2-character rule
  // sent the welcome message to a customer whose first message was "55".
  if (isBareNumber(text)) return false;
  if (!norm || norm.length <= 2) return true;
  // Exact match only — "сайн уу бид явна шүү" is NOT generic even though it starts with "сайн уу"
  return GENERIC_OPENERS.some((w) => norm === w) || isGreetingLike(text);
}

/**
 * Narrower than isGenericOpener: matches ONLY a real greeting word/phrase
 * ("hi", "сайн уу", ...), never the length<=2 catch-all that also swallows a
 * bare digit like "5" (a real clarification-answer, e.g. "5 өдөр нь" mid
 * disambiguation) or a short destination name. Used by contextualText.ts so a
 * plain greeting is never treated as a context-dependent follow-up — a
 * customer typing "hi" days after asking about a trip must get a fresh
 * greeting, never that stale trip's price/dates re-served as if "hi" were
 * asking about it.
 */
export function isKnownGreetingPhrase(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[!?.🙏👋😊]/g, "").trim();
  if (!norm) return false;
  return GENERIC_OPENERS.some((w) => norm === w) || isGreetingLike(text);
}

// Words a greeting is made of, including the everyday typed forms ("бна",
// "бну", "sn", "bnuu"). A real customer wrote "сайн сайн байна уу?" and it was
// treated as an unknown price question and handed to staff, pausing the bot.
const GREETING_CORE_WORDS = new Set([
  "сайн", "сайнуу", "мэнд", "мэндээ", "мэндчилье", "амар", "амарсан", "амаржуу",
  "sain", "sn", "hi", "hii", "hello", "hey", "сонин",
]);
const GREETING_FILLER_WORDS = new Set([
  "байна", "бна", "бну", "бнуу", "бн", "уу", "юу", "өдрийн", "оройн", "өглөөний",
  "bn", "bna", "bnu", "bnuu", "baina", "bainuu", "uu", "yu",
]);

/**
 * Fuzzy greeting matcher: 1–5 words, every word a greeting word, at least one
 * a core greeting word ("сайн сайн байна уу", "сайн бна уу", "Sn bnuu",
 * "Өдрийн мэндээ"). Any other word — a name, a question — makes it a real
 * message, so "hi shanghai price" is never swallowed.
 */
export function isGreetingLike(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 5) return false;
  let sawCore = false;
  for (const token of tokens) {
    if (GREETING_CORE_WORDS.has(token)) {
      sawCore = true;
      continue;
    }
    if (!GREETING_FILLER_WORDS.has(token)) return false;
  }
  return sawCore;
}

const THANKS_CORE_WORDS = new Set([
  "баярлалаа", "баярлаа", "баярлалаа", "ачлалаа", "bayrlalaa", "bayrlaa", "bayrla",
  "bairlalaa", "thanks", "thank", "thx",
]);
const THANKS_FILLER_WORDS = new Set([
  "за", "zaa", "za", "ok", "ок", "okay", "маш", "их", "танд", "танай", "тань", "аа", "you", "very", "much",
]);

/**
 * A bare thank-you ("Баярлалаа", "за баярлалаа", "thanks"). It asks nothing, so
 * it must never be treated as a follow-up that borrows the previous turns' trips
 * — a real customer's "Баярлалаа" was answered with a list of Hainan trips.
 * Anything beyond thanks + filler ("баярлалаа, үнэ хэд вэ") is a real message.
 */
export function isThanksOnly(text: string): boolean {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (tokens.length === 0 || tokens.length > 4) return false;
  let sawCore = false;
  for (const token of tokens) {
    if (THANKS_CORE_WORDS.has(token)) {
      sawCore = true;
      continue;
    }
    if (!THANKS_FILLER_WORDS.has(token)) return false;
  }
  return sawCore;
}

/** Deterministic reply to a bare thank-you: friendly, asks nothing, no lead-capture push. */
export const THANKS_REPLY = "Зүгээр ээ 😊 Өөр асуух зүйл байвал чөлөөтэй бичээрэй.";

/**
 * True for the Messenger "Get Started" button tap. Meta localizes the button
 * title per viewer, and the payload is whatever the page configured (Meta's
 * default is GET_STARTED), so either field matching is enough.
 */
export function isGetStartedPostback(
  postback: { title?: unknown; payload?: unknown } | null | undefined,
): boolean {
  if (!postback || typeof postback !== "object") return false;
  const norm = (value: unknown) =>
    typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, " ") : "";
  const isGetStarted = (value: string) => value === "get started" || value === "эхлэх";
  return isGetStarted(norm(postback.title)) || isGetStarted(norm(postback.payload));
}

/**
 * How long after a Get Started tap a bare greeting ("hi") is treated as part of
 * the same opening gesture. Meta's own automated response already greeted the
 * customer at the tap, so a "hi" typed right after must not draw a second
 * greeting from the bot. Outside this window "hi" is a real re-greeting.
 */
export const GET_STARTED_QUIET_WINDOW_MS = 2 * 60 * 1000;

export function isWithinGetStartedQuietWindow(
  getStartedAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!getStartedAt) return false;
  const at = new Date(getStartedAt).getTime();
  if (!Number.isFinite(at)) return false;
  const age = now - at;
  return age >= 0 && age < GET_STARTED_QUIET_WINDOW_MS;
}

/**
 * Deterministic reply for a bare greeting that arrives mid-conversation (the
 * first-message welcome flow with buttons is handled separately in the
 * webhook). Sent instead of routing the greeting to the model: when the
 * previous turn was a multi-trip clarification, the model re-emits that
 * clarification's price list on "hi" ~50% of the time (found 2026-07-22 in the
 * 100-question sweep). A greeting asks nothing and must never re-serve a trip.
 */
export const MID_CONVERSATION_GREETING_REPLY =
  "Сайн байна уу! 😊 Аяллын талаар асуух зүйл байвал надад хэлээрэй. Би танд туслахад бэлэн байна.";
