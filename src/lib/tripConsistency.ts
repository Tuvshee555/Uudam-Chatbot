/**
 * Wrong-trip output guard.
 *
 * The deterministic fast paths already refuse to serve a stale/unrelated trip
 * (see pickFastPathMatchText). This guard covers the ONE remaining opening: a
 * question falls through to the LLM, the customer clearly asked about trip A,
 * and the model answers — confidently, well-formatted — with a DIFFERENT
 * destination's price. That is the "asked Далянь, got Бээжин's price" class.
 *
 * Deliberately high-precision, not high-recall. It fires only when ALL hold:
 *   1. The deterministic matcher resolved the question to specific trip(s)
 *      (`relevantTripNames` non-empty). When it's empty the customer asked
 *      something broad ("ямар аялал байна?", "хамгийн хямд нь?", a compare) and
 *      a multi-trip priced answer is CORRECT — so the guard stays out entirely.
 *   2. The reply mentions none of the relevant trips' destinations. If it names
 *      any relevant destination (same trip, or a same-city variant) it is
 *      on-topic and left alone.
 *   3. The reply confidently prices some OTHER catalog destination.
 *
 * Because (2) keys off the relevant trips' own destination tokens, a
 * same-destination variant ("Бээжин шууд" asked, "Бээжин галт тэрэг" answered)
 * can never trip it — only a genuinely different place does. Nothing here is
 * hardcoded to a trip name; everything is derived from the live catalog.
 */

export interface TripLike {
  route_name: string;
  adult_price?: number | null;
  child_price?: number | null;
}

// Generic travel words that carry no destination meaning. Tokens left after
// removing these are the parts that actually name a place, so matching on them
// won't collide across unrelated routes.
const GENERIC_ROUTE_WORDS = new Set([
  "аялал",
  "аяллын",
  "аялалд",
  "аяллууд",
  "шууд",
  "нислэг",
  "нислэгтэй",
  "нислэггүй",
  "онгоц",
  "онгоцны",
  "галт",
  "тэрэг",
  "тэргээр",
  "замын",
  "замаар",
  "авто",
  "автобус",
  "хөтөлбөр",
  "багц",
  "амралт",
  "далайн",
  "аврага",
  "өдөр",
  "шөнө",
  "тур",
  "жуулчлал",
  "аяллаар",
]);

function normalize(text: string): string {
  return (text || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The place-naming tokens of a route: significant words (>= 4 chars) that are
 * not generic travel vocabulary. "Хайнан Саньяа аялал" -> ["хайнан","саньяа"].
 */
function destinationTokens(routeName: string): string[] {
  return normalize(routeName)
    .split(" ")
    .filter((word) => word.length >= 4 && !GENERIC_ROUTE_WORDS.has(word) && !/^\d+$/.test(word));
}

// A grouped 6+ digit number (1,890,000 -> 1890000) or an explicit currency word
// is the "this reply is quoting a price" signal.
function mentionsPrice(replyText: string): boolean {
  if (/₮|төгрөг/i.test(replyText)) return true;
  return /\d{6,}/.test(replyText.replace(/[\s,.]/g, ""));
}

export interface WrongTripLeak {
  offendingTripName: string;
  relevantTripNames: string[];
}

/**
 * Returns the offending mismatch when the reply prices a destination the
 * customer did not ask about (and never mentions the one they did), else null.
 */
export function findWrongTripReference(input: {
  replyText: string;
  relevantTripNames: string[];
  catalog: TripLike[];
}): WrongTripLeak | null {
  const relevantNames = (input.relevantTripNames || [])
    .map((name) => (name || "").trim())
    .filter(Boolean);
  // Condition 1: no specific trip was resolved -> broad question -> stay out.
  if (relevantNames.length === 0) return null;

  const reply = normalize(input.replyText);
  if (!reply) return null;

  // Condition 3 (cheap pre-check): a priced answer is required to be a wrong
  // ANSWER; a plain clarifier with no price is never suppressed here.
  if (!mentionsPrice(input.replyText)) return null;

  // Union of the destinations the customer actually asked about.
  const relevantTokens = new Set<string>();
  for (const name of relevantNames) {
    for (const token of destinationTokens(name)) relevantTokens.add(token);
  }
  if (relevantTokens.size === 0) return null;

  // Condition 2: if the reply names ANY relevant destination it is on-topic
  // (or a same-city variant) — leave it alone.
  for (const token of relevantTokens) {
    if (reply.includes(token)) return null;
  }

  // The reply mentions none of the asked-for destinations. Does it instead name
  // some OTHER catalog destination? Any token that matches is genuinely foreign,
  // since no relevant token is present in the reply.
  const relevantNameSet = new Set(relevantNames.map((name) => normalize(name)));
  for (const trip of input.catalog || []) {
    if (relevantNameSet.has(normalize(trip.route_name))) continue;
    const tokens = destinationTokens(trip.route_name);
    if (tokens.some((token) => !relevantTokens.has(token) && reply.includes(token))) {
      return { offendingTripName: trip.route_name, relevantTripNames: relevantNames };
    }
  }

  return null;
}
