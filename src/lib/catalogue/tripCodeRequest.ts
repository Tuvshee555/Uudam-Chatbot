/**
 * The reply the catalogue asks for: "A01, 25 хүн, 1-р сар" (trip code, head count, month).
 *
 * Customers type it on a phone keyboard, so the code arrives as "A01", "a1", "а01" (Cyrillic
 * letter), "A-01" and the rest in Mongolian or Latin: "25 хүн", "25 human", "25 hun", "1-р сар",
 * "3 sar", "нэгдүгээр сард", "March". Pure text in, a request out: the code is resolved to a trip
 * by the store (store.resolveTripCode), never here, and nothing here names a trip.
 *
 * Wrongly reading a sentence as a code would put a bogus staff lead in front of a person, so a
 * code is accepted only where it is clearly the point of the message. A two-digit code written
 * inside a short sentence ("Сайн байна уу, A02 аяллыг сонирхож байна") is only a candidate: it
 * counts once the store knows the code (readTripCode with `loose`, decided in webhookCatalogue.ts).
 */
import { phoneticLatinText } from "../travelTextNorm";
import { editWithin } from "./intent";
import type { TripCodeRequest } from "./types";

const MAX_REQUEST_CHARS = 200;
const CODE_LETTERS = "ABCDАВС"; // Latin A-D plus the Cyrillic А, В, С a phone keyboard types for them
/** The most words a message may have for a code inside it to be a candidate; a story with a code in it is not a code reply. */
const LOOSE_MAX_WORDS = 12;
/** An implicit head count above this is a date, a year or a price, not a group. */
const IMPLICIT_GROUP_MAX = 500;

/** Letter + one or two digits ("A01", "a1", "A-01") or letter + space + 0-digit ("A 03"). */
const CODE_RE = /(?<![\p{L}\p{N}])([ABCDАВС])(?:[-_.]?(\d{1,2})|\s0(\d))(?![\p{L}\p{N}])/giu;

const CODE_WORD_RE = /(?<![\p{L}])(?:код|kod|code)(?![\p{L}])/iu;
const COUNT_UNIT = "(?:hun|хүн|хун|huntei|хүнтэй|human|people|pax|persons?|ppl|хүний|hunii|ажилтан|ажилчин|ajilchin)";
const GROUP_SIZE_AFTER = new RegExp(`(?<![\\p{L}\\p{N}./-])(\\d{1,4})\\s*(?:-?\\s*(?:н|ны|ний|ын))?\\s*${COUNT_UNIT}(?![\\p{L}])`, "iu");
const GROUP_SIZE_BEFORE = new RegExp(`(?<![\\p{L}])${COUNT_UNIT}\\s*[:=-]?\\s*(\\d{1,4})(?![\\p{L}\\p{N}./-])`, "iu");
const MONTH_DIGITS = /(?<![\p{N}./-])(\d{1,2})\s*(?:-?\s*(?:р|r|дугаар|дүгээр|dugaar))?\s*-?\s*(?:сар|sar)/iu;
/** The same phrase with its case ending, to tell "3-р сарын 15" (a date follows) from "3-р сард" (in March). */
const MONTH_PHRASE = /(?<![\p{N}./-])\d{1,2}\s*(?:-?\s*(?:р|r|дугаар|дүгээр|dugaar))?\s*-?\s*(?:сар|sar)(\p{L}*)/giu;

/** A head count when the message states one ("25 хүн", "25 people", "хүн 25"), else null. */
export function extractGroupSize(text: string): number | null {
  const raw = String(text || "").normalize("NFKC");
  const match = GROUP_SIZE_AFTER.exec(raw) || GROUP_SIZE_BEFORE.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value >= 1 && value <= 9999 ? value : null;
}

const ordinal = (word: string) => phoneticLatinText(word).replace(/\s+/g, "");
const MONTH_ORDINALS: Array<[string, number]> = [
  ["нэгдүгээр", 1], ["хоёрдугаар", 2], ["гуравдугаар", 3], ["дөрөвдүгээр", 4], ["тавдугаар", 5], ["зургадугаар", 6],
  ["долдугаар", 7], ["наймдугаар", 8], ["есдүгээр", 9], ["аравдугаар", 10],
].map(([word, month]) => [ordinal(word as string), month as number]);
const MONTH_CARDINALS: Array<[string, number]> = [
  ["нэг", 1], ["хоёр", 2], ["гурав", 3], ["дөрөв", 4], ["тав", 5], ["зургаа", 6], ["долоо", 7], ["найм", 8], ["ес", 9], ["арав", 10],
].map(([word, month]) => [ordinal(word as string), month as number]);
const ENGLISH_MONTHS: Array<[RegExp, number]> = [
  [/^(?:january|jan)$/, 1], [/^(?:february|feb)$/, 2], [/^(?:march|mar)$/, 3], [/^(?:april|apr)$/, 4],
  [/^june?$/, 6], [/^(?:july|jul)$/, 7], [/^(?:august|aug)$/, 8], [/^(?:september|sept?)$/, 9],
  [/^(?:october|oct)$/, 10], [/^(?:november|nov)$/, 11], [/^(?:december|dec)$/, 12],
];

function monthFromWords(text: string): number | null {
  for (const word of text.toLowerCase().match(/[a-z]+/g) || []) {
    const english = ENGLISH_MONTHS.find(([pattern]) => pattern.test(word));
    if (english) return english[1];
  }
  const tokens = phoneticLatinText(text).split(" ").filter(Boolean);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^sar/.test(tokens[index]) || index === 0) continue;
    const word = tokens[index - 1];
    const tenPrefixed = tokens[index - 2] && /^arvan/.test(tokens[index - 2]);
    const ordinalHit = MONTH_ORDINALS.find(([stem]) => stem.length >= 4 && editWithin(word.slice(0, stem.length), stem, stem.length >= 8 ? 2 : 1));
    if (ordinalHit) return tenPrefixed && ordinalHit[1] <= 2 ? 10 + ordinalHit[1] : ordinalHit[1];
    const cardinalHit = MONTH_CARDINALS.find(([stem]) => word === stem || (stem.length >= 4 && editWithin(word, stem, 1)));
    if (cardinalHit) return tenPrefixed && cardinalHit[1] <= 2 ? 10 + cardinalHit[1] : cardinalHit[1];
  }
  return null;
}

/** A month 1-12 when the message states one ("1-р сар", "3 sar", "нэгдүгээр сард", "March"), else null. */
export function extractMonth(text: string): number | null {
  const raw = String(text || "").normalize("NFKC");
  const digits = MONTH_DIGITS.exec(raw);
  if (digits) {
    const month = Number(digits[1]);
    return month >= 1 && month <= 12 ? month : null;
  }
  return monthFromWords(raw);
}

export function normalizeTripCode(letter: string, digits: string): string {
  const mapped = ({ "А": "A", "В": "B", "С": "C" } as Record<string, string>)[letter.toUpperCase()] || letter.toUpperCase();
  return `${mapped}${digits.padStart(2, "0")}`;
}

type CodeMatch = { code: string; twoDigit: boolean; index: number; length: number };

function codeMatches(raw: string): CodeMatch[] {
  const found: CodeMatch[] = [];
  for (const match of raw.matchAll(CODE_RE)) {
    const digits = match[2] ?? match[3] ?? "";
    if (!CODE_LETTERS.includes(match[1].toUpperCase()) || !digits) continue;
    found.push({ code: normalizeTripCode(match[1], digits), twoDigit: digits.length === 2 || match[3] !== undefined, index: match.index ?? 0, length: match[0].length });
  }
  return found;
}

// Marks that stand in for a month phrase while the numbers around it are read.
const MONTH_MARK = "";
const MONTH_OF_MARK = ""; // "сарын": a day of the month follows
/** What follows a number that makes it a length of time, a year or a date, never a head count. */
const NOT_A_COUNT_AFTER = /^\s*(?:оны|ony|он(?![\p{L}])|жилийн|жил|jil|өдөр|odor|хоног|honog|цаг|tsag|минут|day|days|year|years|₮|төг|mnt)/iu;

function isEnglishMonth(word: string | undefined): boolean {
  return Boolean(word) && ENGLISH_MONTHS.some(([pattern]) => pattern.test((word as string).toLowerCase()));
}

/**
 * The head count a message gives without a unit ("A04 25"): the one number left once the code and
 * the month are taken out. A day of the month ("3-р сарын 15", "March 15"), a year ("2027 оны
 * 1-р сар", 1900-2100), a length of time ("5 хоног") and anything above a plausible group are not
 * a head count: reading them as one would tell the customer, and staff, a wrong party size.
 */
function loneNumber(raw: string, codes: CodeMatch[]): number | null {
  let rest = raw;
  for (const code of [...codes].sort((a, b) => b.index - a.index)) rest = `${rest.slice(0, code.index)} ${rest.slice(code.index + code.length)}`;
  rest = rest.replace(MONTH_PHRASE, (_whole, ending: string) => ` ${/^(?:ын|ны|ний)$/iu.test(ending) ? MONTH_OF_MARK : MONTH_MARK} `);
  const candidates: number[] = [];
  for (const match of rest.matchAll(/(?<![\p{L}\p{N}.,/:-])(\d{1,4})(?![\p{L}\p{N}.,/:-])/gu)) {
    const value = Number(match[1]);
    if (value < 2 || value > IMPLICIT_GROUP_MAX || (value >= 1900 && value <= 2100)) continue;
    const start = match.index ?? 0;
    const before = rest.slice(0, start).trimEnd();
    const after = rest.slice(start + match[0].length);
    if (before.endsWith(MONTH_OF_MARK)) continue; // "3-р сарын 15"
    if (NOT_A_COUNT_AFTER.test(after)) continue; // "2027 оны", "5 хоног"
    const wordBefore = before.split(/\s+/).pop()?.replace(/[^a-zA-Z]/g, "");
    const wordAfter = after.trimStart().split(/\s+/)[0]?.replace(/[^a-zA-Z]/g, "");
    if (isEnglishMonth(wordBefore) || isEnglishMonth(wordAfter)) continue; // "March 15", "15 March"
    candidates.push(value);
  }
  return candidates.length === 1 ? candidates[0] : null;
}

// ── Does the message ask something? ──────────────────────────────────────────────────────────────

const QUESTION_WORDS = new Set(
  ["юу", "вэ", "уу", "үү", "хэд", "хэдэн", "ямар", "яаж", "хэзээ", "хаана", "хэрхэн", "хэн", "яагаад"].map((word) => phoneticLatinText(word)),
);
/** "Сайн байна уу" ends in the question particle but is a greeting. */
const GREETING_RE = /(?:сайн|sain|sn)\s*(?:байна|baina|bna|бна|bn)?\s*(?:уу|үү|uu|u)(?![\p{L}])/giu;

/** "A01 хөтөлбөр юу вэ", "A02 үнэ хэд вэ?": a question about a trip, which the trip flow answers. */
function asksSomething(raw: string): boolean {
  const text = raw.replace(GREETING_RE, " ");
  if (/[?？]/.test(text)) return true;
  return phoneticLatinText(text).split(" ").some((token) => QUESTION_WORDS.has(token));
}

// ── Reading a message ────────────────────────────────────────────────────────────────────────────

/** A trip-code message with how it qualified. */
export type TripCodeReading = TripCodeRequest & {
  /** The code opens the message ("A01 ...", "Код: A01"). */
  leading: boolean;
  /** The word "код" / "code" is in it. */
  codeWord: boolean;
  /** A head count or a month is stated: a quotation request whatever else is written. */
  stated: boolean;
  /** It asks something ("A01 хөтөлбөр юу вэ"): the trip flow answers that, not a quotation acknowledgement. */
  question: boolean;
  /** Accepted only because a two-digit code sits in a short sentence: the store must know the code before it counts. */
  loose: boolean;
};

/**
 * The message as a trip-code reply, or null. Without `loose` only a message whose shape says "this
 * is a code reply" qualifies. With `loose` a two-digit code anywhere in a short message is also
 * returned, flagged `loose`: it is a candidate that counts only if the store resolves the code.
 */
export function readTripCode(text: string, options: { loose?: boolean } = {}): TripCodeReading | null {
  const raw = String(text || "").normalize("NFKC").trim();
  if (!raw || raw.length > MAX_REQUEST_CHARS) return null;
  const codes = codeMatches(raw);
  if (!codes.length) return null;
  const groupSize = extractGroupSize(raw);
  const month = extractMonth(raw);
  const stated = groupSize !== null || month !== null;
  const codeWord = CODE_WORD_RE.test(raw);
  const startsWithCode = (code: CodeMatch) => code.index === 0 || /^(?:код|kod|code|аялал|aylal)[\s:.-]*$/iu.test(raw.slice(0, code.index));
  const words = raw.split(/\s+/).filter(Boolean).length;
  const hasTwoDigit = codes.some((code) => code.twoDigit);
  const strict = hasTwoDigit ? stated || codeWord || (startsWithCode(codes[0]) && words <= 8) : stated || codeWord;
  const loose = !strict && options.loose === true && hasTwoDigit && words <= LOOSE_MAX_WORDS;
  if (!strict && !loose) return null;
  const primary = strict ? codes[0] : (codes.find((code) => code.twoDigit) as CodeMatch);
  return {
    code: primary.code, groupSize: groupSize ?? loneNumber(raw, codes), month, raw,
    leading: startsWithCode(primary), codeWord, stated, question: asksSomething(raw), loose,
  };
}

/** Every distinct code in the message, in order; empty when the message is not a code request. */
export function parseAllTripCodes(text: string, options: { loose?: boolean } = {}): string[] {
  if (!readTripCode(text, options)) return [];
  const raw = String(text || "").normalize("NFKC");
  return [...new Set(codeMatches(raw).map((match) => match.code))];
}

/** The code reply, or null when the message is not one by its shape alone. */
export function parseTripCodeRequest(text: string): TripCodeRequest | null {
  const reading = readTripCode(text);
  return reading ? { code: reading.code, groupSize: reading.groupSize, month: reading.month, raw: reading.raw } : null;
}
