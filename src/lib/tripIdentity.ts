/**
 * Trip IDENTITY: which words of a message say WHERE the customer wants to go (a name, an alias, a
 * destination), as opposed to how the trip travels or what is asked about it.
 *
 * A customer who is already on a trip keeps that trip. Another trip replaces it only when the
 * message carries identity the current trip lacks: a distinctive name/alias/destination word of the
 * other trip that the current trip does not contain. A place word the current trip itself holds is
 * not new identity, and a transport or kind word ("нисэх", "нислэгтэй", "хосолсон") is never identity
 * at all. Before this, a follow-up such as "<town>-ээс нисэх үү" switched the customer to a sibling
 * trip whose TITLE held the same town and the word "нислэгтэй" (real case 11, 2026-11-05).
 */
import type { TravelTrip } from "./travelTypes";
import { getAliases } from "./travelFastPathsSearch";
import { keywordTokens, normText, phoneticLatinText, phoneticTokenMatches } from "./travelTextNorm";
import { hasReferentialHint } from "./contextualText";

/** How a trip travels or what kind it is: never a place, so never identity. */
const ATTRIBUTE_WORDS: RegExp[] = [
  /^нис(?:э|ж|н|д|л)/u, /^онгоц/u, /^галт$/u, /^тэрэг/u, /^автобус/u, /^хосолсон/u, /^хослуул/u, /^шууд/u,
  /^газар/u, /^газрын/u, /^круз/u, /^усан$/u, /^тийз/u, /^билет/u, /^буц/u, /^хөдл/u, /^эхл/u, /^ирэх/u,
  /^nis(?:e|j|n|d|l)/u, /^ongo/u, /^galt$/u, /^tereg/u, /^avtobus/u, /^hosols/u, /^shuu?d/u, /^gazar/u, /^gazr/u,
  /^kruz/u, /^tiz/u, /^bilet/u, /^buts/u, /^hodl/u, /^ehl/u, /^irej/u,
];

const isAttributeWord = (word: string) => ATTRIBUTE_WORDS.some((pattern) => pattern.test(word));

/** Words that carry no content beyond naming something: a message made only of these and place words is a bare mention. */
const BARE_FILLERS = new Set([
  "аялал", "аяллын", "аялалтай", "аяллууд", "аяллуудыг", "аяллаар", "хот", "хотын", "хотод", "хотоор", "байна", "байгаа",
  "байдаг", "сонирхож", "сонирхоод", "сонирхож", "уу", "үү", "юу", "вэ", "бэ", "ямар", "aylal", "aylaliin", "baina", "bn",
  "bna", "yamar", "uu", "yu", "ve", "be",
]);

function wordsOf(text: string): string[] {
  return normText(text).split(/\s+/).filter((word) => /\p{L}/u.test(word));
}

/** Phonetic forms of the words in `text` that could name a place: no generic route word, no attribute word, no number. */
export function identityWordsOf(text: string): string[] {
  const out: string[] = [];
  for (const word of wordsOf(text)) {
    if (word.length < 3 || isAttributeWord(word) || keywordTokens(word).length === 0) continue;
    const phonetic = phoneticLatinText(word);
    if (phonetic.length >= 3 && !out.includes(phonetic)) out.push(phonetic);
  }
  return out;
}

function destinationsOf(trip: TravelTrip): string[] {
  return Array.isArray(trip.extra?.destinations) ? trip.extra.destinations.filter((city): city is string => typeof city === "string") : [];
}

/** What a trip is called: its name, aliases and destinations. */
export function tripIdentityWords(trip: TravelTrip): string[] {
  return identityWordsOf([trip.route_name, ...getAliases(trip), ...destinationsOf(trip)].join(" "));
}

/** Words a trip contains anywhere that matters for "does this trip go there": identity words plus its itinerary day titles. */
export function tripContainedWords(trip: TravelTrip): string[] {
  const days = Array.isArray(trip.extra?.itinerary_days) ? trip.extra.itinerary_days as Array<Record<string, unknown>> : [];
  const titles = days.flatMap((day) => [day?.title, day?.route].filter((value): value is string => typeof value === "string"));
  return [...new Set([...tripIdentityWords(trip), ...identityWordsOf(titles.join(" "))])];
}

/**
 * A word names an identity word when it equals it, or (from four letters) is a one-edit spelling or a
 * case-suffixed form of it. Three-letter words match only exactly: one edit apart is no evidence there.
 */
const identityMatches = (word: string, candidate: string) =>
  word === candidate || (Math.min(word.length, candidate.length) >= 4 && phoneticTokenMatches(word, candidate));
const matchesAny = (word: string, pool: string[]) => pool.some((candidate) => identityMatches(word, candidate));

export type NewIdentity = {
  /** Words of the message that name the candidate and that none of the current trips contains. */
  words: string[];
  /** The candidate's complete name was typed (and no current trip's name was). */
  namedInFull: boolean;
  /** The message names something the current trip(s) lack: the customer leaves them for the candidate. */
  switches: boolean;
};

/**
 * Does `text` carry identity of `candidate` that none of `current` has? `current` is the trip (or the
 * offered list) the customer is already on.
 */
export function newIdentityOf(text: string, candidate: TravelTrip, current: TravelTrip[]): NewIdentity {
  const candidateWords = tripIdentityWords(candidate);
  const held = current.flatMap(tripContainedWords);
  const words = identityWordsOf(text).filter((word) => matchesAny(word, candidateWords) && !matchesAny(word, held));
  const said = normText(text);
  const fullName = normText(candidate.route_name);
  const namedInFull = fullName.length >= 8 && said.includes(fullName)
    && !current.some((trip) => normText(trip.route_name).length >= 8 && said.includes(normText(trip.route_name)));
  // Any word that names the candidate and that the current trip does not contain is a change of
  // destination ("<other town> руу нисэх үү"). Words the current trip holds and transport/kind words
  // are removed above, so a single such word is enough.
  return { words, namedInFull, switches: namedInFull || words.length >= 1 };
}

export type AnchorVerdict =
  /** The message names something the anchor lacks: these candidates replace it. */
  | { kind: "switch"; trips: TravelTrip[] }
  /** The message names the anchor (some of it): answer inside it. */
  | { kind: "within"; trips: TravelTrip[] }
  /** Nothing in the message leaves the anchor (a shared place word, a transport word): stay on it. */
  | { kind: "stay" };

/**
 * What the trips a message's words resolve to (`candidates`) mean for the trip(s) the customer is
 * already on (`anchor`: the selected trip, or the list the bot just offered). The anchor is the
 * default: it is left only for a candidate the message identifies by something the anchor lacks.
 */
export function verdictAgainstAnchor(text: string, candidates: TravelTrip[], anchor: TravelTrip[], catalog: TravelTrip[]): AnchorVerdict {
  const anchorIds = new Set(anchor.map((trip) => trip.id));
  const outside = candidates.filter((trip) => !anchorIds.has(trip.id));
  const switching = outside.filter((trip) => newIdentityOf(text, trip, anchor).switches);
  if (switching.length) return { kind: "switch", trips: switching };
  const inside = candidates.filter((trip) => anchorIds.has(trip.id));
  if (!inside.length) return { kind: "stay" };
  // A bare destination typed again ("<хот>", "<хот> аялал байна уу") asks for that destination's
  // trips, not a question about the one on screen: every candidate stays.
  return { kind: "within", trips: isBareMention(text, catalog) ? candidates : inside };
}

/**
 * A message that only names places and fillers ("<хот>", "<хот> аялал байна уу"): the customer asks for
 * that destination, not a question about the trip on screen.
 */
export function isBareMention(text: string, catalog: TravelTrip[]): boolean {
  const known = catalog.flatMap(tripIdentityWords);
  const words = wordsOf(text);
  if (!words.length) return false;
  return words.every((word) => word.length < 3 || /^\d/.test(word) || BARE_FILLERS.has(word)
    || (!isAttributeWord(word) && keywordTokens(word).length > 0 && matchesAny(phoneticLatinText(word), known))
    || (!isAttributeWord(word) && keywordTokens(word).length === 0 && /^(?:аялал|аяллын|хот)/u.test(word)));
}

/** "Can I ...?" ("төлж болох уу", "bolno") is a modal, not a word pointing at a trip. */
const MODAL = /болох(?:гүй)?|болно|болохгүй|bolno|boloh|bolohgui/gu;

/**
 * Does the message point back at something already on screen ("тэр", "үнэ", "нь", "өөр")? The shared
 * list also holds "болох", which sits in every "can I ...?" question and turned a payment question
 * ("барт ... төлж болох уу") into a follow-up about the last trips; the modal is removed first.
 */
export function pointsBackAtTrip(text: string): boolean {
  return hasReferentialHint(normText(text).replace(MODAL, " "));
}
