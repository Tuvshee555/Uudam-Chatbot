import type { TravelTrip } from "./travelTypes";
import { resolveTripFromUserMessage } from "./travelFastPathsSearch";
import { GENERIC_ROUTE_WORDS } from "./travelTextNorm";

/**
 * "Бээжин биш, далайтай нь", "<хот> үзмээр байна гэхдээ <парк> хэрэггүй", "<парк> орохгүй",
 * "<газар>-гүй", "<газар>-аас бусад", Latin "bish / hereggui / orohgui": the customer rules something
 * OUT. Keyword matching read the named thing as the request and answered with that very trip (live
 * replay 2026-10-30; owner's case "the city, but not its theme park"). A phrase before a negation word
 * that names something in the catalogue is removed, so only what the customer does want is matched,
 * and the caller leaves the trips it names out of this turn's catalogue. When nothing else remains the
 * message is kept as written. A negation asked as a question ("<парк> орохгүй юу?") rules nothing out,
 * and a negated package part ("хөтөлбөр хэрэггүй", "нислэггүй") is a package preference, not a trip.
 */

// The negation word that follows the thing ruled out (Latin "bus" is left out: it is also the English word).
const NEGATION_AFTER = /(?<![\p{L}])(хэрэггүй|хэрэггуй|орохгүй|оруулахгүй|биш|бус|hereggui|heregguj|herggui|xereggui|orohgui|oroxgui|oruulahgui|bish)(?![\p{L}])/giu;
// "<газар>-аас бусад": everything except it.
const EXCEPT_AFTER = /(?<![\p{L}])(\p{L}{3,}?)-?(?:аас|ээс|оос|өөс|гаас|гээс|гоос|гөөс|aas|ees|oos|gaas|gees)\s+(?:бусад|busad)(?![\p{L}])/giu;
// "<газар>гүй": without it.
const WITHOUT_SUFFIX = /(?<![\p{L}])(\p{L}{3,}?)-?(?:гүй|гуй|gui)(?![\p{L}])/giu;
const QUESTION_AFTER = /^\s*(?:юу|уу|үү|yu|uu|vv|бэ|вэ|ve|be|гэж|гэсэн|biz|биз)(?![\p{L}])/iu;
const CLAUSE_BREAK = /[,.;!?\n]|(?<![\p{L}])(?:гэхдээ|харин|тэгэхдээ|but|gehdee|gexdee|harin|xarin)(?![\p{L}])/giu;
const PARTICLES = new Set(["нь", "ни", "n", "ni", "бол", "bol", "л", "l"]);
// Parts of a package: "хөтөлбөр хэрэггүй" asks for the trip without it, it rules out no trip.
const PACKAGE_PARTS = /^(?:хөтөлбөр\p{L}*|хөтөч\p{L}*|гид\p{L}*|хоол\p{L}*|буудал\p{L}*|зочид|нислэг\p{L}*|тийз\p{L}*|виз\p{L}*|даатгал\p{L}*|трансфер\p{L}*|унаа\p{L}*|багц\p{L}*|хүүхэд\p{L}*|хүүхд\p{L}*|том|хүн|hutulbur\p{L}*|hotolbor\p{L}*|hutulbr\p{L}*|hoot\p{L}*|hool\p{L}*|buudal\p{L}*|nisleg\p{L}*|tiiz\p{L}*|viz\p{L}*|daatgal\p{L}*|transfer\p{L}*|bagts\p{L}*|bagc\p{L}*|huuhed\p{L}*|huuhd\p{L}*|tom|hun|энэ|тэр|ene|ter|өмнөх\p{L}*|нөгөө\p{L}*|omnoh\p{L}*|nugu\p{L}*)$/iu;
// A trip's name must not be ruled out by a word every trip shares ("аялал биш").
const isWeak = (word: string) => word.length < 3 || GENERIC_ROUTE_WORDS.has(word.toLowerCase()) || PACKAGE_PARTS.test(word) || PARTICLES.has(word.toLowerCase());

/** Cheap pre-check before the catalogue is read. */
export function mayNegateTrip(text: string): boolean {
  // "-гүй" after a verb ("явахгүй") is not "without <place>": only a noun stem can name a trip.
  return /биш|бус|bish|bus|хэрэггүй|хэрэггуй|hereggui|heregguj|herggui|xereggui|орохгүй|оруулахгүй|orohgui|oroxgui|oruulahgui|\p{L}{3}(?<![хx])(?:гүй|гуй)|[a-z]{3}(?<![hx])gui/iu.test(text);
}

type Cut = { start: number; end: number; phrase: string };

/** The words of the clause before `at`, most recent last. */
function clauseWordsBefore(text: string, at: number): Array<{ word: string; start: number }> {
  const before = text.slice(0, at);
  let from = 0;
  for (const match of before.matchAll(CLAUSE_BREAK)) from = (match.index || 0) + match[0].length;
  const words: Array<{ word: string; start: number }> = [];
  for (const match of before.slice(from).matchAll(/[\p{L}\p{N}-]+/gu)) words.push({ word: match[0], start: from + (match.index || 0) });
  while (words.length && PARTICLES.has(words[words.length - 1].word.toLowerCase())) words.pop();
  return words;
}

/**
 * `names` tells whether a phrase names something in the catalogue; it may return the ids it names, which
 * lets "<нэр> парк" (two words for the same trip) be ruled out whole while "<хот> <парк>" keeps the city.
 */
export function withoutNegatedTrips(text: string, names: (phrase: string) => boolean | string[]): { text: string; negated: string[] } {
  const named = (phrase: string): string[] | null => {
    const result = names(phrase);
    return result === true ? [] : Array.isArray(result) && result.length ? result : null;
  };
  const cuts: Cut[] = [];
  for (const match of text.matchAll(NEGATION_AFTER)) {
    const index = match.index || 0;
    const end = index + match[0].length;
    if (QUESTION_AFTER.test(text.slice(end))) continue;
    const words = clauseWordsBefore(text, index);
    const last = words[words.length - 1];
    const previous = words[words.length - 2];
    if (!last) continue;
    const lastNames = isWeak(last.word) ? null : named(last.word);
    if (lastNames) {
      // The word before names the same trip(s) ("<нэр> парк"): it is part of what is ruled out.
      const previousNames = previous && !isWeak(previous.word) ? named(previous.word) : null;
      const samePhrase = Boolean(previousNames && lastNames.length && previousNames.length && previousNames.every((id) => lastNames.includes(id)));
      const start = samePhrase ? previous!.start : last.start;
      cuts.push({ start, end, phrase: samePhrase ? `${previous!.word} ${last.word}` : last.word });
      continue;
    }
    // "<нэр> парк" where only the two words together name it.
    if (previous && !isWeak(previous.word) && named(`${previous.word} ${last.word}`)) {
      cuts.push({ start: previous.start, end, phrase: `${previous.word} ${last.word}` });
    }
  }
  for (const pattern of [EXCEPT_AFTER, WITHOUT_SUFFIX]) {
    for (const match of text.matchAll(pattern)) {
      const index = match.index || 0;
      const end = index + match[0].length;
      const stem = match[1];
      if (isWeak(stem) || (pattern === WITHOUT_SUFFIX && /[хxh]$/iu.test(stem)) || QUESTION_AFTER.test(text.slice(end))
        || cuts.some((cut) => index < cut.end && end > cut.start)) continue;
      // The suffix may be part of the name itself; the whole word is tried first.
      const word = match[0].split(/\s+/)[0];
      const phrase = named(stem) ? stem : pattern === EXCEPT_AFTER && named(word) ? word : null;
      if (phrase) cuts.push({ start: index, end, phrase });
    }
  }
  if (!cuts.length) return { text, negated: [] };
  cuts.sort((left, right) => right.start - left.start);
  let kept = text;
  for (const cut of cuts) kept = `${kept.slice(0, cut.start)} ${kept.slice(cut.end).replace(/^[,.!?;:]/, "")}`;
  kept = kept.replace(/\s+/g, " ").replace(/\s+([,.!?;:])/g, "$1").replace(/^[\s,.;:]+|[\s,;:]+$/g, "").trim();
  const negated = cuts.map((cut) => cut.phrase).reverse();
  return /[\p{L}\p{N}]/u.test(kept) ? { text: kept, negated } : { text, negated: [] };
}

/**
 * The webhook's use: the message without the ruled-out phrases, and the ids of the trips those
 * phrases name (exact match only), left out of this turn's catalogue.
 */
export function ruleOutNegatedTrips(text: string, trips: TravelTrip[]): { text: string; excludedTripIds: string[] } {
  if (!mayNegateTrip(text)) return { text, excludedTripIds: [] };
  const resolve = (phrase: string) => resolveTripFromUserMessage(phrase, trips, { allowLooseFallback: false });
  const idsOf = (phrase: string): string[] => {
    const resolved = resolve(phrase);
    return resolved.status === "verified" ? [resolved.trip.id] : resolved.status === "ambiguous" ? resolved.candidates.map((trip) => trip.id) : [];
  };
  const corrected = withoutNegatedTrips(text, idsOf);
  const excluded = new Set<string>();
  for (const phrase of corrected.negated) for (const id of idsOf(phrase)) excluded.add(id);
  return { text: corrected.text, excludedTripIds: [...excluded] };
}
