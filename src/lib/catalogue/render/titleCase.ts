/**
 * Display-only casing for trip titles. Staff type titles in ALL CAPS, all lowercase or mixed case;
 * a printed book should read evenly. Stored data is never touched: only the render layer calls this.
 *
 * What is safe to do without knowing which words are proper nouns:
 *  - mixed-case title: leave it alone (a person chose that casing), except that a fully capitalised
 *    word of 4+ letters ("ЕГИПЕТ шууд нислэгтэй") is a caps-lock slip and gets Title Case, and a
 *    title starting with a lowercase letter gets that one letter capitalised;
 *  - all-lowercase title: capitalise the first letter only;
 *  - ALL-CAPS title: Title Case per word. Kept lowercase: the small connector words, the unit words
 *    that follow a number ("8 шөнө"), case endings glued on by a hyphen ("хот-оос") and anything
 *    attached to a digit ("12-р"). Kept upper: short acronyms ("УБ", "UB", "ХХК").
 * Ө, Ү and Ё case-map correctly with the standard Unicode case functions. Only letter case changes,
 * never a character or its position, so text lengths (and the layout estimates) are unchanged.
 */

const LETTER_RUN = /\p{L}+/gu;
const HAS_LOWER = /\p{Ll}/u;
const HAS_UPPER = /\p{Lu}/u;
const CYRILLIC_VOWEL = /[аэиоуөүеёюяыАЭИОУӨҮЕЁЮЯЫ]/u;
const LATIN_ONLY = /^[A-Za-z]+$/;

/** Connector words that stay lowercase inside an ALL-CAPS title. */
const CONNECTORS = new Set(["ба", "буюу", "эсвэл", "болон", "бөгөөд", "мөн", "ч", "нь"]);
/** Words that follow a number and stay lowercase: "8 ШӨНӨ 9 ӨДӨР" -> "8 шөнө 9 өдөр" (prefix covers "сарын", "хоногийн"). */
const UNIT_PREFIX = /^(?:шөнө|өдөр|хоног|сар|хүн|жил|цаг|минут|настай|оны)/u;
/** Case endings written after a hyphen without a space ("ХОТ-ООС"). */
const HYPHEN_SUFFIX = /^(?:аас|ээс|оос|өөс|ас|эс|ос|өс|с|д|т|ын|ийн|ий|ы|ууд|үүд|нууд|нүүд|тай|тэй|той|төй)$/u;

const isDigit = (ch: string | undefined) => !!ch && /\p{Nd}/u.test(ch);
const isHyphen = (ch: string | undefined) => ch === "-" || ch === "‑";

function titleWord(word: string): string {
  const [first = "", ...rest] = [...word.toLowerCase()];
  return first.toUpperCase() + rest.join("");
}

/** 2-3 letter all-caps words that are abbreviations rather than short words. */
function isAcronym(word: string): boolean {
  const n = [...word].length;
  if (LATIN_ONLY.test(word)) return n >= 2 && n <= 3;
  if (n === 2) return true;
  return n === 3 && !CYRILLIC_VOWEL.test(word);
}

/** The last character before `index` that is not a space or hyphen, and whether a hyphen touches the word. */
function lookBack(title: string, index: number): { prev: string; hyphenGlued: boolean; glueBase: string } {
  const hyphenGlued = isHyphen(title[index - 1]);
  const glueBase = hyphenGlued ? (title[index - 2] ?? "") : "";
  let i = index - 1;
  while (i >= 0 && (/\s/u.test(title[i]!) || isHyphen(title[i]))) i--;
  return { prev: i >= 0 ? title[i]! : "", hyphenGlued, glueBase };
}

function titleCaseAllCaps(title: string): string {
  let afterNumberSuffix = false; // the previous word was a suffix glued to a number ("12-Р")
  return title.replace(LETTER_RUN, (word, offset: number) => {
    const lower = word.toLowerCase();
    const { prev, hyphenGlued, glueBase } = lookBack(title, offset);
    const touchesDigit = isDigit(title[offset - 1]) || (hyphenGlued && isDigit(glueBase));
    const followsNumber = isDigit(prev) || afterNumberSuffix;
    afterNumberSuffix = false;

    if (touchesDigit) {
      afterNumberSuffix = true;
      return lower;
    }
    if (followsNumber && UNIT_PREFIX.test(lower)) return lower;
    if (hyphenGlued && /\p{L}/u.test(glueBase) && HYPHEN_SUFFIX.test(lower)) return lower;
    if (CONNECTORS.has(lower)) return offset === 0 ? titleWord(lower) : lower;
    if (isAcronym(word)) return word;
    return titleWord(word);
  });
}

/** Mixed-case title: only shouted words (all capitals, 4+ letters, not an acronym) are brought down to Title Case. */
function calmShoutedWords(title: string): string {
  return title.replace(LETTER_RUN, (word, offset: number) => {
    if ([...word].length < 4 || !HAS_UPPER.test(word) || HAS_LOWER.test(word) || isAcronym(word)) return word;
    const lower = word.toLowerCase();
    return CONNECTORS.has(lower) && offset > 0 ? lower : titleWord(word);
  });
}

/** Upper-case the first letter of the title when the title starts with a letter (never after a digit). */
function capitaliseFirstLetter(title: string): string {
  const m = /^([^\p{L}\p{N}]*)(\p{L})/u.exec(title);
  if (!m) return title;
  const at = m[1]!.length;
  return `${title.slice(0, at)}${m[2]!.toUpperCase()}${title.slice(at + m[2]!.length)}`;
}

/** The title as the book prints it. */
export function displayTitle(title: string): string {
  const raw = String(title ?? "").trim();
  if (!raw) return raw;
  const letters = raw.match(/\p{L}/gu)?.length ?? 0;
  if (HAS_UPPER.test(raw) && !HAS_LOWER.test(raw)) {
    // One lone capital ("А") is not a shouted title.
    return letters >= 2 ? titleCaseAllCaps(raw) : raw;
  }
  if (HAS_LOWER.test(raw) && !HAS_UPPER.test(raw)) return capitaliseFirstLetter(raw);
  const calmed = calmShoutedWords(raw);
  const first = /\p{L}/u.exec(calmed);
  return first && HAS_LOWER.test(first[0]) ? capitaliseFirstLetter(calmed) : calmed;
}
