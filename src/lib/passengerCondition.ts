/**
 * The condition a passenger price's label states when it is not an age:
 * "Хүүхэд 1,2-1,4 м өндөр" → "1,2–1,4 м өндөр", "Хүүхэд оргүй" → "оргүй".
 *
 * A saved passenger row has only a label, an age_range and a price. The fare
 * resolver reads the age from age_range alone, so a height- or bed-labelled child
 * fare was printed as a bare "Хүүхэд: …" and read as every child's price. Pure
 * text helper with no catalogue access, so the fare card (tripFareBlock.ts) and
 * the resolver can share one reading.
 */
import { parseDepartureDateText } from "./travelDates";
import type { PassengerKind } from "./tripOffers";

const KIND_WORDS: Record<PassengerKind, RegExp> = {
  adult: /том\s*хүн\S*|насанд\s*хүр\S*|adults?/giu,
  child: /хүүх(?:эд|дийн|дүүд)\S*|child(?:ren)?/giu,
  infant: /нярай\S*|infants?/giu,
};
const ANY_KIND_WORD = /том\s*хүн|насанд\s*хүр|adult|хүүх(?:эд|дийн|дүүд)|child|нярай|infant/iu;
// An age written in a label belongs in age_range, where the resolver and the reply
// checker read it; an age printed here would be checked as an age it is not.
const AGE_WORDS = /\d\s*(?:нас|настай|сар(?!ын)|жил|years?|months?|yrs?)|(?:^|\D)(?:19|20)\d{2}(?!\d)/iu;

/**
 * The condition as it can be printed without reading as a departure date: the
 * reply checker parses "1,2-1,4" as 2/1 and "1.2–1.4" as 1/2, and a fare line
 * holding a date that is not a departure silences the whole answer. The same
 * height is tried with a comma decimal and either dash; null when every form
 * still reads as a date.
 */
function printable(condition: string): string | null {
  const comma = condition.replace(/(\d)\.(\d)/g, "$1,$2");
  const variants = [condition, comma, comma.replace(/(\d)\s*-\s*(\d)/g, "$1–$2"), comma.replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")];
  return variants.find((variant) => [variant, `/${variant}/`, `(${variant})`, `Хүүхэд /${variant}/: `, `Хүүхэд (${variant}): `]
    .every((form) => parseDepartureDateText(form).length === 0)) ?? null;
}

/**
 * The label without its age text: "Хүүхэд 6-11 нас оргүй" → "Хүүхэд  оргүй", "6-11 насны хүүхэд" →
 * " хүүхэд". The age itself lives in age_range; what is left can still be a condition (a bed).
 */
export function labelWithoutAge(label: string): string {
  return label.replace(/\d+(?:[.,]\d+)?\s*(?:[-–—]\s*\d+(?:[.,]\d+)?\s*)?(?:\+\s*)?(?:нас|настай|сар(?!ын)|жил|years?|months?|yrs?)\S*/giu, " ");
}

/** Null for a bare kind ("Хүүхэд"), an age, a label naming another passenger kind, or a date-like text. */
export function passengerLabelCondition(label: string, kind: PassengerKind): string | null {
  // "1,1М-С ДООШ/ДЭЭШ": a slash lists alternatives; printed inside "/…/" it would end the band early.
  const rest = label.replace(KIND_WORDS[kind], " ").replace(/үнэ|price/giu, " ").replace(/\s*[/\\]\s*/g, ", ")
    .replace(/\s+/g, " ").replace(/^[\s:;,.()\-–—]+|[\s:;,()\-–—]+$/gu, "").trim();
  if (rest.replace(/[^\p{L}\p{N}]/gu, "").length < 2 || AGE_WORDS.test(rest) || ANY_KIND_WORD.test(rest)) return null;
  return printable(rest);
}
