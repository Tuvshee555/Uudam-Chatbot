/**
 * Reference-resolution helper shared by the production webhook and the demo
 * endpoint (previously a webhook-local copy — demo silently behaved
 * differently from Messenger, so QA runs missed production-only bugs).
 *
 * When the current message is too short/vague to stand alone ("тэр ямар
 * үнэтэй вэ?", "дахиад зураг"), the last few USER turns are prepended so the
 * deterministic fast-path matchers can resolve what "тэр" refers to.
 *
 * IMPORTANT usage contract (see webhook fast-path dispatch): matchers must try
 * the RAW current message first and only fall back to this contextual text
 * when the raw message alone cannot resolve a trip. Matching over the
 * concatenated turns first lets a trip mentioned three turns ago outscore the
 * trip the customer is asking about right now.
 */

export function normalizeContextText(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isLikelyContextDependentText(text: string) {
  const normalized = normalizeContextText(text);
  if (!normalized) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length <= 2) return true;
  const referentialHints = [
    "again",
    "more",
    "photo",
    "photos",
    "program",
    "pdf",
    "price",
    "dates",
    "seat",
    "seats",
    "zurag",
    "үнэ",
    "хэзээ",
    "огноо",
    "суудал",
    "хөтөлбөр",
    "зураг",
    "дахин",
    "дахиад",
    "өөр",
    "энэ",
    "тэр",
  ];
  const hasHint = referentialHints.some((hint) => normalized.includes(hint));
  if (!hasHint) return false;
  if (normalized.length <= 24) return true;

  // A hint word alone isn't enough on longer messages: if the message also
  // carries its own content words (a trip name, a city), it stands alone and
  // must NOT be diluted with old turns.
  const contentWords = words.filter(
    (word) =>
      word.length >= 4 &&
      !referentialHints.includes(word) &&
      ![
        "аялал",
        "аяллын",
        "зураг",
        "хөтөлбөр",
        "program",
        "price",
        "dates",
        "seat",
        "seats",
        "үнэ",
        "огноо",
        "суудал",
      ].includes(word),
  );
  return contentWords.length === 0;
}

export function buildContextualUserText(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  userText: string,
) {
  if (!isLikelyContextDependentText(userText)) return userText;
  const recentUserTurns = history
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter(Boolean)
    .slice(-4);
  if (recentUserTurns.length === 0) return userText;
  return [...recentUserTurns, userText.trim()].join("\n");
}

type TripResolver<TTrip> = (
  text: string,
) => { status: "verified"; trip: TTrip } | { status: "ambiguous"; candidates: TTrip[] } | { status: string };

/**
 * Which text should the deterministic trip matchers see?
 *
 * Priority: (1) the current message alone resolves a trip → use it;
 * (2) the contextual blob resolves one → use it (the classic "тэр ямар үнэтэй
 * вэ?" follow-up); (3) the current message alone is ambiguous → clarify from
 * what the customer JUST said, not from stale turns; (4) otherwise fall back
 * to the contextual blob.
 *
 * Matching over the concatenated turns first (the old behavior) let a trip
 * mentioned three turns ago outscore the trip the customer is asking about
 * right now — confident, well-formatted, wrong-trip answers.
 */
export function pickFastPathMatchText<TTrip>(
  text: string,
  contextualUserText: string,
  resolve: TripResolver<TTrip>,
): string {
  if (contextualUserText === text) return text;
  const direct = resolve(text);
  if (direct.status === "verified") return text;
  const contextual = resolve(contextualUserText);
  if (contextual.status === "verified") return contextualUserText;
  if (direct.status === "ambiguous") return text;
  return contextualUserText;
}
