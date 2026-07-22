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
 * Returns true if the message is a generic opener that should trigger the
 * full greeting flow. Returns false if the person already asked something
 * specific — in that case, skip the greeting and just answer.
 */
export function isGenericOpener(text: string): boolean {
  const norm = text.trim().toLowerCase().replace(/[!?.🙏👋😊]/g, "").trim();
  if (!norm || norm.length <= 2) return true;
  // Exact match only — "сайн уу бид явна шүү" is NOT generic even though it starts with "сайн уу"
  return GENERIC_OPENERS.some((w) => norm === w);
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
  return GENERIC_OPENERS.some((w) => norm === w);
}
