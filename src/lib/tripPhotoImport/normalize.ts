import { fixMojibake } from "../encoding";

const MONGOLIAN_VOWEL_REPLACEMENTS: Array<[RegExp, string]> = [
  // Common Cyrillic letter confusions caused by encoding or keyboard layouts
  [/Ã/g, "А"],
  [/Â/g, "А"],
  [/Ð/g, "Д"],
  [/Ñ/g, "Н"],
  [/Ò/g, "О"],
  [/Ó/g, "О"],
  [/Ô/g, "О"],
  [/Õ/g, "Ө"],
  [/Ö/g, "Ө"],
  [/Ø/g, "Ө"],
  [/Ý/g, "Ү"],
  [/Þ/g, "Ү"],
];

const PUNCTUATION_TO_SPACE = /[+_/\\|()[\],.:;!?"'`~*]+/g;
const DASH_VARIATIONS = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\u002D\u2013]+/g;
const WHITESPACE = /\s+/g;

export function normalizeTripName(value: string): string {
  let text = fixMojibake(value);

  // Fix obvious mojibake glyphs first
  for (const [pattern, replacement] of MONGOLIAN_VOWEL_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }

  return text
    .toLowerCase()
    .replace(DASH_VARIATIONS, " ")
    .replace(PUNCTUATION_TO_SPACE, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

export function normalizeFilenameForMatch(value: string): string {
  // Strip leading numeric/sort prefixes, sequence markers, and common archive noise.
  const base = value.replace(/\.[^.]+$/g, ""); // remove extension
  return normalizeTripName(base)
    .replace(/^\d+[\s\-_.]*/, " ") // "01-Name" / "01 Name" → "Name"
    .replace(/[\s\-_.]*\d+$/, " ") // "Name-01" / "Name 01" → "Name"
    .replace(WHITESPACE, " ")
    .trim();
}

export function extractSequencePrefix(value: string): number | undefined {
  // "02-Name.jpg" or "Name-2.jpg" -> 2
  const base = value.replace(/\.[^.]+$/g, "");
  const leading = base.match(/^(\d+)/);
  if (leading) return Number(leading[1]);
  const trailing = base.match(/-(\d+)$/);
  if (trailing) return Number(trailing[1]);
  return undefined;
}

const GENERIC_ROUTE_WORDS = new Set([
  "аялал",
  "аяллын",
  "хот",
  "хотын",
  "шууд",
  "нислэг",
  "нислэгтэй",
  "нислэггүй",
  "газар",
  "газрын",
  "хосолсон",
  "аялалтай",
  "өдөр",
  "шөнө",
  "өдрийн",
  "шөнийн",
  "буюу",
  "тусгай",
  "хямдрал",
  "final",
  "uudam",
  "travel",
  "agency",
  "тур",
  "tour",
  "program",
  "pdf",
  "img",
  "image",
  "зураг",
  "photo",
]);

export function keywordTokens(value: string): string[] {
  return normalizeTripName(value)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !GENERIC_ROUTE_WORDS.has(word));
}

function bigrams(text: string): Set<string> {
  const normalized = normalizeTripName(text);
  const set = new Set<string>();
  for (let i = 0; i < normalized.length - 1; i += 1) {
    set.add(normalized.slice(i, i + 2));
  }
  return set;
}

function bigramOverlap(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let shared = 0;
  for (const g of gb) {
    if (ga.has(g)) shared += 1;
  }
  return (2 * shared) / (ga.size + gb.size);
}

export function tokenCoverageScore(a: string, b: string): number {
  const tokensA = new Set(keywordTokens(a));
  const tokensB = keywordTokens(b);
  let tokenMatches = 0;
  for (const token of tokensB) {
    if (tokensA.has(token)) tokenMatches += 1;
  }
  const tokenScore =
    tokensA.size === 0 || tokensB.length === 0
      ? 0
      : tokenMatches / Math.max(tokensA.size, tokensB.length);
  const gramScore = bigramOverlap(a, b);
  return Math.max(tokenScore, gramScore);
}
