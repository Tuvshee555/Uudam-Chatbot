/**
 * Language-level text normalization for trip matching: lowercasing, Latin/
 * Cyrillic spelling bridges, generic (non-destination) words and tokenizers.
 * No catalog data lives here — place names come from the DB only.
 * Split out of travelFastPathsSearch.ts to keep that file under the size cap;
 * it re-exports the public names, so existing imports are unchanged.
 */

export const GENERIC_ROUTE_WORDS = new Set([
  "аялал",
  "аяллын",
  "хот",
  "хотын",
  "шууд",
  "нислэг",
  "нислэгтэй",
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
  "үнэтэй",
  "үнэтэйхэн",
  "expensive",
  "final",
  "uudam",
  "travel",
  "agency",
  "зураг",
  "зургийг",
  "зурагаа",
  "зургууд",
  "photo",
  "photos",
  "image",
  "images",
  "picture",
  "program",
  "pdf",
  "хөтөлбөр",
  // Request verbs from the "Хөтөлбөр үзэх" / "Зураг үзэх" buttons and everyday
  // phrasing. They are never part of a destination. Without this,
  // "Хөтөлбөр үзэх" matched the trip "<хот> -намрын тахилга үзэх аялал" on the
  // single word "үзэх" and two real customers were sent the <city> PDF while
  // they were looking at <city>.
  "үзэх",
  "үзүүлээч",
  "үзье",
  "үзмээр",
  "харах",
  "харуулаач",
  "харья",
  "харъя",
  // Greeting words typed in front of a question ("hi <city> aylaliin medeelel
  // aviya"): never a destination, but they used to count as unmatched query
  // words and drag every candidate's score negative.
  // A thank-you is never a place. The spelling-tolerant matcher read the
  // Latin "bayrla" (thanks) as a trip whose name contains a similar word and
  // answered "за bayrla" with that trip's sold-out notice.
  "баярлалаа",
  "баярлаа",
  "bayrla",
  "bayrlaa",
  "bayrlalaa",
  "bayarlalaa",
  "bairlalaa",
  "hi",
  "hii",
  "hello",
  "hey",
  "сайн",
  "сайнуу",
  // Everyday words that are never a destination but sit one letter (or a shared
  // prefix) away from words inside trip names: "харин" ("however") ~ "сарын"
  // ("month's", in "11-р сарын аяллын хөтөлбөр"), "байгаа" ("is there") ~
  // "байгалийн" ("natural"). Each of these produced a wrong trip list for a real
  // customer's chit-chat.
  "сарын",
  "сар",
  "харин",
  "байгаа",
  "байна",
  "байдаг",
  "байх",
  "гарч",
  "юу",
  "уу",
  "вэ",
  "бэ",
  "тэ",
  "бас",
  "болон",
  "гэхдээ",
]);

/**
 * Words that make up a price / programme / information request without naming
 * a destination ("Үнэ", "Хэд хоногийн аялал хэдэн төг вээ", "Аялалын үнэ
 * сонирхож байна"). Used only by isGenericTripRequest below.
 */
export const GENERIC_REQUEST_WORDS = new Set([
  "үнэ",
  "үнийн",
  "үнийг",
  "үнэтэй",
  "хэд",
  "хэдэн",
  "хоног",
  "хоногийн",
  "төг",
  "төгрөг",
  "вээ",
  "вэ",
  "бэ",
  "уу",
  "юу",
  "ямар",
  "байна",
  "байгаа",
  "байдаг",
  "сонирхож",
  "сонирхоно",
  "мэдээлэл",
  "мэдээ",
  "авъя",
  "авья",
  "авмаар",
  "авах",
  "өгөөч",
  "хэлээч",
  "хэлээрэй",
  "хуваарь",
  "гарах",
  "гарна",
  "огноо",
  "хэзээ",
  "нийт",
  "төлбөр",
  "талаар",
  "тухай",
  "аялалууд",
  "аялалын",
  "аялалыг",
  "аялалд",
  "та",
  "би",
  "надад",
  "манай",
  "танай",
]);

export const STRUCTURED_QUERY_SIGNALS = [
  "үнэ",
  "хэд вэ",
  "хэдээр",
  "төлбөр",
  "нийт",
  "хэд болох",
  "хэдэн өдөр",
  "хэд хоног",
  "хэзээ",
  "огноо",
  "гарах",
  "хуваарь",
  "шууд нислэг",
  "нислэгтэй юу",
  "байна уу",
  "адилхан",
  "ижил",
  "болно уу",
];

export const PROGRAM_QUERY_SIGNALS = [
  "хөтөлбөр",
  "program",
  "pdf",
  "зураг",
  "өдөр өдөр",
  "day by day",
  "itinerary",
];

// Only language/script normalizations here — no trip-specific city names.
// City aliases and romanized destination names belong in each trip's
// extra.aliases array in the database, editable via the admin panel.
// Misspelled place names are handled by snapMisspelledWords(), which compares
// against the live catalog's own words — never a city list in code.
const ALIAS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bnaadam\b/gi, "наадам"],
  [/наадмын/gi, "наадам"],
  [/\bnisleggvi\b/gi, "нислэггүй"],
  [/\bnisleggui\b/gi, "нислэггүй"],
  [/\bniseleggvi\b/gi, "нислэггүй"],
  [/\bnislegtei\b/gi, "нислэгтэй"],
  [/\bnislegt[eэ]i\b/gi, "нислэгтэй"],
  [/\bnisleg\b/gi, "нислэг"],
  [/\bno flight\b/gi, "нислэггүй"],
  [/\bland tour\b/gi, "газрын аялал"],
  [/\bgazar\b/gi, "газар"],
  [/\bgazr\b/gi, "газар"],
  [/\bgazrin\b/gi, "газрын"],
  [/\bgazriin\b/gi, "газрын"],
  [/\bgazariin\b/gi, "газрын"],
  [/\bgazryn\b/gi, "газрын"],
  [/\bhosolson\b/gi, "хосолсон"],
  [/\bhoslson\b/gi, "хосолсон"],
  [/\baylal\b/gi, "аялал"],
  [/\bayalal\b/gi, "аялал"],
  [/\bzurag\b/gi, "зураг"],
  [/\buzi[eй]?\b/gi, "үзье"],
  // Everyday Latin-typed / mistyped forms of the price and information words.
  // Real customers wrote "Vne", "Үний", "Aylaluud", "Medeelel avay" as their
  // whole message and each one was handed off to staff as "no data".
  [/\b(?:vne|une|unee|unei|unii|uniin)\b/gi, "үнэ"],
  [/(?<![\p{L}\p{N}])үний(?![\p{L}\p{N}])/giu, "үнэ"],
  [/\baylaluud\b/gi, "аялалууд"],
  [/\baylaliin\b|\baylalin\b|\bayliin\b/gi, "аяллын"],
  [/\bmedeelel\b/gi, "мэдээлэл"],
  [/\b(?:avay|avya|awy|awya|aviy|aviya|avii|avia)\b/gi, "авъя"],
  [/\bwith ticket\b/gi, "тийзтэй"],
  [/\bwithout ticket\b/gi, "тийзгүй"],
  [/\bticketless\b/gi, "тийзгүй"],
  [/\bticket included\b/gi, "тийзтэй"],
];

export function normText(text: string) {
  let normalized = text.toLowerCase();
  for (const [pattern, replacement] of ALIAS_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  return normalized
    .replace(/[+_/\\|()[\],.:;!?-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when a free-text admin/AI-extraction field is actually an internal QA
 * placeholder ("шинэ мэдээлэл уншигдсан, баталгаажуулах шаардлагатай") rather
 * than real customer-facing content. Any reply builder rendering duration_text,
 * notes, or source_description verbatim must filter through this first —
 * otherwise an unverified admin sentinel gets read straight to a customer.
 * Kept in this dependency-free module (no DB/env imports) so every fast-path
 * file and the AI reply path can use the exact same check without pulling in
 * the database layer.
 */
export function isGenericConfirmationText(value: string | null | undefined): boolean {
  const normalized = (value || "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) return true;
  return (
    normalized.includes("файлнаас шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("баталгаажуулалт шаардлагатай") ||
    normalized.includes("баталгаажуулах шаардлагатай") ||
    (normalized.includes("new trip") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("review"))
  );
}

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "j",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  ө: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ү: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sh",
  ъ: "",
  ы: "i",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};

export function phoneticLatinText(text: string) {
  return normText(text)
    .split("")
    .map((char) => CYRILLIC_TO_LATIN[char] ?? char)
    .join("")
    // Pinyin-style spellings of Chinese places meet their Mongolian Cyrillic
    // forms: "zh" is "ж", "ng" before a consonant is "н" ("-ngh-" / "-ngj-"),
    // and "jie" is "жэ". Romanisation rules only — no place is named here.
    .replace(/zh/g, "j")
    .replace(/ng(?=[bcdfghjklmnpqrstvwxz])/g, "n")
    .replace(/([jqx])ie/g, "$1e")
    .replace(/ts/g, "c")
    .replace(/ch/g, "c")
    .replace(/sh/g, "s")
    .replace(/kyo/g, "kio")
    .replace(/yo/g, "o")
    .replace(/yu/g, "u")
    .replace(/ya/g, "a")
    .replace(/kh/g, "h")
    .replace(/ee+/g, "e")
    .replace(/oo+/g, "o")
    .replace(/uu+/g, "u")
    .replace(/ii+/g, "i")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_ROUTE_WORDS_PHONETIC = new Set(
  Array.from(GENERIC_ROUTE_WORDS, (word) => phoneticLatinText(word)).filter(Boolean),
);

export function keywordTokens(text: string) {
  return normText(text)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !GENERIC_ROUTE_WORDS.has(word));
}

export function phoneticKeywordTokens(text: string) {
  return phoneticLatinText(text)
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !GENERIC_ROUTE_WORDS_PHONETIC.has(word));
}

export function unique<T>(values: T[]) {
  return Array.from(new Set(values));
}

function isOneEditApart(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (a.length > b.length) i += 1;
    else if (b.length > a.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * True when the LONGER token is the shorter one plus a trailing Mongolian
 * case suffix — "далянийн" (genitive of "<хот>") vs "dalan"/"dalanin" in
 * phonetic space: "dalanin".startsWith("dalan"). Case endings (genitive,
 * accusative, dative...) add letters rather than substitute them, so this is
 * NOT a typo (isOneEditApart's territory, capped at 1 substitution) — a real
 * customer asking "Далянийн аялалын үнэ хэд вэ?" got "not_found" from the
 * resolver because the query token never equalled the bare route token.
 * Minimum shared length guards against short tokens prefix-matching by
 * coincidence, mirroring the same idiom already used for scoped-clarification
 * attribute answers (fastPathRouting.ts's filterCandidatesByAttribute).
 */
function isCaseSuffixedForm(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.length > shorter.length && longer.startsWith(shorter);
}

export function phoneticTokenMatches(queryToken: string, candidateToken: string): boolean {
  return (
    queryToken === candidateToken ||
    isOneEditApart(queryToken, candidateToken) ||
    isCaseSuffixedForm(queryToken, candidateToken)
  );
}
