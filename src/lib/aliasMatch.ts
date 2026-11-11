/**
 * Does a trip alias occur in the customer's text as a WORD?
 *
 * Plain substring containment read a short alias inside an unrelated longer word: an alias
 * spelled like the start of the thank-you word "санал" (suggestion) made every sibling trip
 * "named" and answered a thanks with a trip list (real case, 2026-11-03; the alias sounded
 * the same as a four-letter stem once spelled in Latin). The class is any weak alias inside
 * a longer word.
 *
 * An alias occurs when each of its words equals a word of the text, or is a word of the
 * text followed by one Mongolian case ending from a CLOSED list (genitive, dative,
 * accusative, ablative, instrumental, comitative, plural), with or without the linking
 * consonant. An alias word shorter than five letters never matches inside a longer word:
 * it matches only as the whole word. The check runs in both spellings the matcher already
 * uses (Cyrillic/normalised and phonetic Latin), so Latin typing of the same endings is
 * covered.
 */
import { MIN_AFFIXED_WORD_LETTERS, isMongolianCaseEnding, normText, phoneticLatinText } from "./travelTextNorm";

/** Below this many letters an alias word matches only as a whole word, never inside a longer one. */
export const MIN_AFFIXED_ALIAS_LETTERS = MIN_AFFIXED_WORD_LETTERS;

function wordCarriesAlias(word: string, alias: string): boolean {
  if (word === alias) return true;
  if (alias.length < MIN_AFFIXED_ALIAS_LETTERS || word.length <= alias.length || !word.startsWith(alias)) return false;
  return isMongolianCaseEnding(word.slice(alias.length));
}

function occursAsWords(aliasText: string, queryText: string): boolean {
  const alias = aliasText.split(" ").filter(Boolean);
  const words = queryText.split(" ").filter(Boolean);
  if (!alias.length || !words.length) return false;
  for (let start = 0; start + alias.length <= words.length; start += 1) {
    if (alias.every((part, offset) => wordCarriesAlias(words[start + offset], part))) return true;
  }
  return false;
}

/**
 * `queryNorm` / `queryPhonetic` are normText(text) and phoneticLatinText(text), passed in because the
 * callers already hold them for every trip they score.
 */
export function aliasOccursInQuery(alias: string, queryNorm: string, queryPhonetic: string): boolean {
  const aliasNorm = normText(alias);
  if (aliasNorm && occursAsWords(aliasNorm, queryNorm)) return true;
  const aliasPhonetic = phoneticLatinText(alias);
  return Boolean(aliasPhonetic) && Boolean(queryPhonetic) && occursAsWords(aliasPhonetic, queryPhonetic);
}

export function aliasOccursInText(alias: string, text: string): boolean {
  return aliasOccursInQuery(alias, normText(text), phoneticLatinText(text));
}
