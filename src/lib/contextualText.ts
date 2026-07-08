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
        "хүүхэд",
        "хүүхдийн",
        "нярай",
        "том",
        "хүн",
        "үнэтэй",
        "төлбөртэй",
        "child",
        "infant",
        "adult",
      ].includes(word),
  );
  return contentWords.length === 0;
}

function isGenericAssistantFollowup(text: string) {
  const normalized = normalizeContextText(text);
  return (
    normalized.includes("аль нь хэрэгтэй") ||
    normalized.includes("алийг хэлж") ||
    normalized.includes("аль аяллыг") ||
    normalized.includes("нэг тодруулаад")
  );
}

export function buildContextualUserText(
  history: Array<{ role: "user" | "assistant"; text: string }>,
  userText: string,
) {
  if (!isLikelyContextDependentText(userText)) return userText;
  const previousAssistantReply = [...history]
    .reverse()
    .find((message) => message.role === "assistant" && message.text.trim())
    ?.text.trim();
  if (previousAssistantReply && !isGenericAssistantFollowup(previousAssistantReply)) {
    return `${previousAssistantReply}\n${userText.trim()}`;
  }
  const recentUserTurns = history
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter(Boolean)
    .slice(-4);
  if (recentUserTurns.length === 0) return userText;
  return [...recentUserTurns, userText.trim()].join("\n");
}

type TripResolution<TTrip> =
  | { status: "verified"; trip: TTrip }
  | { status: "ambiguous"; candidates: TTrip[] }
  | { status: string };

type TripResolver<TTrip> = (text: string) => TripResolution<TTrip>;

/**
 * Which text should the deterministic trip matchers see?
 *
 * Priority: (1) the current message alone resolves a trip → use it;
 * (2) the current message is ambiguous and the contextual blob verifies one
 * OF THOSE candidates → use the context (legit narrowing: "Бээжин" earlier +
 * "шууд нислэгтэй нь" now); a contextual winner OUTSIDE the candidates is a
 * stale unrelated trip hijacking the match and is rejected; (3) the current
 * message is ambiguous otherwise → clarify from what the customer JUST said;
 * (4) the current message resolves nothing → fall back to the contextual blob.
 *
 * Matching over the concatenated turns first (the old behavior) let a trip
 * mentioned three turns ago outscore the trip the customer is asking about
 * right now — confident, well-formatted, wrong-trip answers.
 */
export function pickFastPathMatchText<TTrip extends { id: string }>(
  text: string,
  contextualUserText: string,
  resolve: TripResolver<TTrip>,
): string {
  if (contextualUserText === text) return text;
  const direct = resolve(text);
  if (direct.status === "verified") return text;
  const contextual = resolve(contextualUserText);
  if (direct.status === "ambiguous" && "candidates" in direct) {
    if (contextual.status === "verified" && "trip" in contextual) {
      const candidateIds = new Set(direct.candidates.map((trip) => trip.id));
      if (candidateIds.has(contextual.trip.id)) return contextualUserText;
    }
    return text;
  }
  if (contextual.status === "verified") return contextualUserText;
  return contextualUserText;
}
