/**
 * "Бээжин биш, далайтай нь" / "beejin bish": the customer rules a destination OUT.
 * Keyword matching read the named place as the request and answered with that very
 * destination's trip (live replay 2026-10-30). A word followed by "биш" that names
 * something in the catalogue is removed, so only what the customer does want is
 * matched, and the caller leaves that place's trips out of this turn's answer. When
 * nothing else remains the message is kept as written.
 */
export function withoutNegatedTrips(text: string, namesCatalogTrip: (word: string) => boolean): { text: string; negated: string[] } {
  const negated: string[] = [];
  const kept = text.replace(/([\p{L}-]{3,})\s+(?:биш|bish)(?=$|[\s,.!?;:])[,.!?;:]?\s*/giu, (whole, word: string) => {
    if (!namesCatalogTrip(word)) return whole;
    negated.push(word);
    return " ";
  }).replace(/\s+/g, " ").trim();
  return /[\p{L}\p{N}]/u.test(kept) ? { text: kept, negated } : { text, negated: [] };
}
