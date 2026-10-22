import { normText, phoneticLatinText } from "./travelTextNorm";

/** Details outside the catalog's supported hotel identity and fare fields. */
export const REQUESTED_FACT_FIELDS = [
  "hotel.connectivity", "hotel.facilities", "hotel.room", "hotel.location", "hotel.rating", "other.unsupported",
] as const;
export type RequestedFactField = typeof REQUESTED_FACT_FIELDS[number];
export type RequestedFact = { field: RequestedFactField; evidence: string };

const PROPERTY_FAMILIES: Array<{ field: RequestedFactField; hotelOnly?: boolean; pattern: RegExp }> = [
  { field: "hotel.connectivity", pattern: /(?:^|\s)(?:wi\s*fi|wifi|интерн[еэ]т|вай\s*фай|вайфай)(?=\s|$)/iu },
  { field: "hotel.facilities", hotelOnly: true, pattern: /(?:^|\s)(?:усан\s*сан|бассейн|pool|swimming|фитнес|fitness|gym|саун\S*|spa|спа|лифт|elevator)(?=\s|$)/iu },
  { field: "hotel.room", hotelOnly: true, pattern: /(?:^|\s)(?:өрөө\S*|орны|ор\s|rooms?|beds?)(?=\s|$)/iu },
  { field: "hotel.location", hotelOnly: true, pattern: /(?:^|\s)(?:байршил\S*|хаана|төвөөс|зайтай|distance|location|where)(?=\s|$)/iu },
  { field: "hotel.rating", hotelOnly: true, pattern: /(?:^|\s)(?:одтой|одны|од|stars?|rating)(?=\s|$)/iu },
];

const fieldSet = new Set<string>(REQUESTED_FACT_FIELDS);
const evidenceIn = (evidence: string, text: string) => {
  const normalized = normText(evidence);
  if (normalized.length < 2) return false;
  if (normText(text).includes(normalized)) return true;
  const phonetic = phoneticLatinText(evidence);
  return phonetic.length >= 3 && phoneticLatinText(text).includes(phonetic);
};

/** A model can identify a question, but cannot manufacture its customer evidence. */
export function parseRequestedFacts(value: unknown, customerText: string): RequestedFact[] {
  if (!Array.isArray(value)) return [];
  const facts = new Map<string, RequestedFact>();
  for (const item of value.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.field !== "string" || !fieldSet.has(record.field) || typeof record.evidence !== "string") continue;
    const evidence = record.evidence.trim();
    if (evidence.length > 240 || !evidenceIn(evidence, customerText)) continue;
    facts.set(record.field, { field: record.field as RequestedFactField, evidence });
  }
  return [...facts.values()];
}

/**
 * Bounded hotel-property coverage supplements model extraction. Identity text
 * is removed first: selecting a hotel named after an amenity is not a question
 * about that amenity. These requirements never choose trips or invent facts.
 */
export function requestedFactsFromText(customerText: string, options: { ignoredPhrases?: string[]; hotelContext?: boolean } = {}): RequestedFact[] {
  let text = normText(customerText);
  const hotelContext = options.hotelContext || /буудал|hotel|buudal/iu.test(text);
  for (const phrase of [...(options.ignoredPhrases || [])].sort((a, b) => b.length - a.length)) {
    const identity = normText(phrase);
    if (identity) text = text.split(identity).join(" ");
  }
  return PROPERTY_FAMILIES.flatMap(({ field, hotelOnly, pattern }) => {
    if (hotelOnly && !hotelContext) return [];
    const evidence = pattern.exec(text)?.[0].trim();
    return evidence ? [{ field, evidence }] : [];
  });
}
