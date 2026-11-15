/**
 * The words of a trip name that tell it apart: the places ("Хөх", "Хайнан", "Чунчин", "Санья"), not the
 * words every name repeats ("шинэ жилийн", "аялал", "хотын", "нислэгтэй", "хөтөлбөртэй").
 *
 * Why (2026-11-14): "Шинэ жилийн Хөх хотын аялал" was called the same name as «ХАЙНАН – ДАМЖИН
 * НИСЛЭГТЭЙ ШИНЭ ЖИЛИЙН АЯЛАЛ», and asked for "шинэ жилийн хөх хотын аяллын линк" the assistant gave
 * the Hainan trip's link: only the generic words matched. Pure.
 */

/** Word starts that never name a trip (every inflection: "хотын", "хотоос", "аяллын", "өдрийн" …). */
const GENERIC_PREFIXES = [
  "аял", "ayal", "aylal", "хот", "жил", "шинэ", "нисл", "дамж", "шууд", "чартер", "хөтөлб", "чөлөө", "өдөр", "өдр", "шөн", "сар",
  "хоног", "үнэ", "үни", "хамт", "олн", "захиал", "газар", "галт", "тэрэг", "хослол", "арал", "арл", "улс", "нэм", "хас", "засах",
  "засвар", "бүрэн", "линк", "холбоос", "оруул", "болго", "өөрчил", "сүүл", "эхн", "буц", "гар", "ирэх", "ирн", "улаанбаатар",
  "хөдл", "тур", "tour", "trip", "болон", "энэ", "тэр", "рүү", "руу", "дээр", "дахь", "дэх", "аялал", "nem", "link",
];
const GENERIC_WORDS = new Set(["уб", "ub", "мөн", "ба", "нь", "бол", "юм", "гэж", "тэгэхдээ", "хүртэл", "өмнө", "өмнөх", "дараа"]);

/** The comparable form of a word: its first five letters (Mongolian endings vary after the stem). */
const stem = (word: string) => (word.length > 5 ? word.slice(0, 5) : word);

export function isGenericWord(word: string): boolean {
  const value = word.toLowerCase();
  return GENERIC_WORDS.has(value) || GENERIC_PREFIXES.some((prefix) => value.startsWith(prefix));
}

/** The distinctive stems of a text: letters only, 3+ letters, no number, no generic word. */
export function distinctiveTokens(text: unknown): string[] {
  const words = String(text ?? "").normalize("NFKC").toLowerCase().split(/[^\p{L}]+/u).filter((word) => word.length >= 3);
  return [...new Set(words.filter((word) => !isGenericWord(word)).map(stem))];
}

/** How many distinctive stems two names share (0 = they share only generic words). */
export function sharedDistinctive(a: unknown, b: unknown): number {
  const left = new Set(distinctiveTokens(a));
  return distinctiveTokens(b).filter((token) => left.has(token)).length;
}
