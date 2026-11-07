/**
 * What a customer message asks of the corporate catalogue. Pure text in, a decision out: no
 * clock, no database, no model call (the feature spends nothing).
 *
 * Mongolian Cyrillic, Latin/transliterated spellings and English are all read through the
 * repo's own phonetic form (travelTextNorm.ts), so "байгууллагын аялал", "baiguullagiin aylal"
 * and "baigulagiin ayal" reach the same words. A Mongolian word is matched by stem, with a small
 * edit tolerance for typos; an English word is matched whole, because a prefix reads "companion"
 * as "company" and "very" as "every". Never a destination name: no trip, place or price lives here.
 *
 * The decision is deliberately conservative. A specific-trip question ("<place> аяллын үнэ",
 * "тэр аяллын хөтөлбөр", "энэ аялалд бүх зүйл багтсан уу") carries none of the catalogue words
 * below in the shape of a request, so the existing trip flow keeps it. The webhook layer adds the
 * two checks text alone cannot make (a named trip, an open trip conversation): webhookCatalogue.ts.
 */
import { phoneticLatinText } from "../travelTextNorm";
import type { CatalogueIntent } from "./types";

/** Which words a message holds. Exported so the webhook layer can decide "explicit or vague". */
export type CatalogueSignals = {
  /** company / organisation / team / "хамт олон" framing, as the customer's own side */
  corporate: boolean;
  /** a trip word: аялал, trip, tour, travel */
  travel: boolean;
  /** the catalogue itself: каталог, catalog, brochure, буклет */
  catalogue: boolean;
  /** "сонголт", "танилцуулга", "options": a selection of trips */
  options: boolean;
  /** "бүх", "all", "full", "complete" anywhere: only picks the edition once the catalogue is named */
  all: boolean;
  /** "бүх аяллаа", "all tours": "all" directly in front of a trip word, the way a listing is asked for */
  allListing: boolean;
  /** "дахин", "again", "resend" */
  resend: boolean;
  /** a word that asks for something to be sent or shown: явуул, илгээ, харуул, send, show */
  sendVerb: boolean;
  /** "энэ", "тэр", "this": the message points at something already under discussion */
  demonstrative: boolean;
  /** "баярлалаа", "thanks" */
  thanks: boolean;
  /** a thing other than the file: үнэ, хөтөлбөр, зураг, дугаар, price, program */
  otherObject: boolean;
  /** every word is "again" or a politeness: "дахин", "again please" */
  resendOnly: boolean;
  /** "үнийн санал", "quote", "quotation" */
  quote: boolean;
  /** a head count ("30 хүн", "25 people") */
  groupSize: boolean;
  /** a list word that is not a catalogue on its own: жагсаалт, list */
  list: boolean;
  /** number of words, to tell a short request from a long story */
  words: number;
};

const MAX_TEXT_CHARS = 400;

/** A stem is written in any spelling; it is read through the same phonetic form as the text. */
type Stem = { stem: string; exact?: boolean; tol?: number };
const stems = (...values: Array<string | Stem>): Array<{ stem: string; exact: boolean; tol: number }> =>
  values.map((value) => {
    const spec = typeof value === "string" ? { stem: value } : value;
    const stem = phoneticLatinText(spec.stem).replace(/\s+/g, "");
    const exact = spec.exact === true;
    return { stem, exact, tol: exact ? 0 : spec.tol ?? (stem.length >= 9 ? 2 : stem.length >= 5 ? 1 : 0) };
  });

/** The text and the word lists go through one phonetic form, but "your" stays apart from "our" (the form would make them one word). */
const phonetic = (value: string): string => phoneticLatinText(value.replace(/(?<![a-z])yours?(?![a-z])/gi, "yr"));
/** English words are compared whole and in that phonetic form: "show" reads as "sow". */
const words = (...values: string[]): Set<string> => new Set(values.map((value) => phonetic(value)));

/** Words that name the customer's own side whatever stands next to them. */
const CORPORATE_STEMS = stems(
  "байгууллага", "baiguullaga", "baigullaga", "organization", "organisation",
  "corporate", "korporate", "корпорат", "корпорэйт", "корпорейт", "korporeit", "корпоратив",
  "ажилчид", "ажилчдын", "ajilchid", "teambuilding", "тимбилдинг",
);
/** Whole English words: "employer" and "companion" are not these. */
const CORPORATE_EN = words("employees", "employee");
const BULGIIN = stems("бүлгийн", "bulgiin");
/** "зохион байгуулдаг", "байгуулах": the verb to organise, two edits from the noun "байгууллага". */
const ORGANISE_VERB = /^baigul(?:ah|aj|aa|dag|deg|uj|j|san|na|x|d|s)/;
/** No typo tolerance: "companion" is one edit from "kompani". */
const COMPANY_MN = stems({ stem: "компани", tol: 0 }, { stem: "kompani", tol: 0 });
const COMPANY_EN = words("company", "companies");
/** "манай компани", "our company": the customer's company. */
const OUR = words("манай", "бидний", "миний", "our", "my");
/** Words that make "компани" the travel agency, not the customer's: "аялал жуулчлалын компани", "танай компани". */
const AGENCY_BEFORE = words("танай", "танайд", "your", "энэ", "тэр", "уг", "жуулчлалын", "жуулчлал", "tourism", "agency", "agent");
const TEAM_NEXT = words("building", "trip", "trips", "tour", "tours", "travel", "outing", "retreat", "event", "events");

const TRAVEL_MN = stems("аял", "ayal", "ayl", { stem: "тур", exact: true });
const TRAVEL_EN = words("trip", "trips", "tour", "tours", "travel", "travels", "traveling", "travelling");
const CATALOGUE = stems("каталог", "catalog", "catalogue", "брошюр", "brochure", "brosyur", "буклет", "booklet", "buklet");
const OPTIONS = stems("сонголт", "songolt", "танилцуулга", "tanilcuulga", "options", "option");
const LIST = stems("жагсаалт", "jagsaalt", { stem: "list", exact: true });
/** "all" anywhere, only to choose the edition once the catalogue is named. Short English words are whole-word. */
const ALL = stems(
  { stem: "бүх", exact: true }, { stem: "бүгд", exact: true }, "бүгдийг", "бүтэн", { stem: "all", exact: true }, { stem: "every", exact: true },
  { stem: "full", exact: true }, { stem: "complete", exact: true }, { stem: "whole", exact: true }, { stem: "entire", exact: true }, "bvh",
);
/** The "all" of a listing request. "бүтэн", "full", "every", "complete" are left out: "бүтэн өдрийн аялал" is a full-day trip. */
const ALL_LISTING = words("бүх", "bvh", "all");
const LISTING_FILLER = words("your", "the", "our", "of", "these", "those", "you");
const RESEND = stems("дахин", "дахиад", "dahin", "dahiad", { stem: "again", exact: true }, { stem: "resend", exact: true }, { stem: "repeat", exact: true });
const SEND_VERB_MN = stems("явуул", "илгээ", "харуул", "үзүүл", "өгөөч", "өгнө");
const SEND_VERB_EN = words("send", "sends", "show", "shows", "share", "list", "see", "view", "give", "resend");
const THANKS = stems("баярлалаа", "bayarlalaa", "thanks", "thank", { stem: "thx", exact: true });
const OTHER_OBJECT_MN = stems("үнэ", "үнийг", "хөтөлбөр", "зураг", "дугаар", "хаяг", "байршил", "төлбөр", "данс", "утас", "цаг");
const OTHER_OBJECT_EN = words("price", "prices", "program", "programme", "photo", "photos", "picture", "pictures", "number", "address", "location", "time", "schedule", "hotel", "ticket", "visa", "passport", "itinerary");
const POLITE = words("pls", "plz", "please");
const DEMONSTRATIVE = words("энэ", "энэхүү", "энийг", "тэр", "тэрийг", "уг", "this", "that");
const QUOTE = stems("quote", "quotation", "pricing");

/** Levenshtein distance, capped: only "is it within tol" matters. */
export function editWithin(a: string, b: string, tol: number): boolean {
  if (a === b) return true;
  if (tol === 0 || Math.abs(a.length - b.length) > tol) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost);
      if (row[j] < rowMin) rowMin = row[j];
    }
    if (rowMin > tol) return false;
    previous = row;
  }
  return previous[b.length] <= tol;
}

function tokenIs(token: string, list: ReturnType<typeof stems>): boolean {
  if (token.length < 2) return false;
  return list.some(({ stem, exact, tol }) => {
    if (!stem) return false;
    if (exact) return token === stem;
    if (token.length < stem.length - tol) return false;
    // A typo can drop or add a letter, so the token's head is tried at a few lengths around the stem's.
    for (let length = Math.max(1, stem.length - tol); length <= stem.length + tol; length += 1) {
      if (editWithin(token.slice(0, length), stem, tol)) return true;
    }
    return false;
  });
}

const isTripWord = (token: string | undefined): boolean => Boolean(token) && (TRAVEL_EN.has(token as string) || tokenIs(token as string, TRAVEL_MN));

/** "ger bulin" (family) must not read as "bulgiin" (group): the stems differ, but a typo must not bridge them. */
function isFamilyWord(previous: string | undefined, token: string): boolean {
  return previous === "ger" && token.startsWith("bul");
}

/** "компани" is the customer's company, not the travel agency being asked. */
function isOwnCompany(tokens: string[], index: number): boolean {
  const token = tokens[index];
  const genitiveMn = tokenIs(token, COMPANY_MN);
  if (!genitiveMn && !COMPANY_EN.has(token)) return false;
  const previous = tokens[index - 1] ?? "";
  const next = tokens[index + 1] ?? "";
  if (AGENCY_BEFORE.has(previous) || isTripWord(previous)) return false;
  if (genitiveMn && token.startsWith("kompanin")) return true; // "компанийн …": the company's
  if (COMPANY_EN.has(token) && next === "s") return true; // "company's"
  if (OUR.has(previous)) return true; // "манай компани", "our company"
  return isTripWord(next); // "компани аялал", "company trip"
}

/**
 * Is the word at `index` the customer speaking as a company / organisation / team? Bare "group",
 * "групп", "баг" and every word that merely starts like one ("Bulgaria", "companion", "teammate")
 * are NOT: every public trip is a group tour, so "групп аялал" is ordinary wording.
 */
function isCorporateAt(tokens: string[], index: number): boolean {
  const token = tokens[index];
  const previous = tokens[index - 1];
  const next = tokens[index + 1];
  if ((tokenIs(token, CORPORATE_STEMS) && !ORGANISE_VERB.test(token)) || CORPORATE_EN.has(token)) return true;
  if (isOwnCompany(tokens, index)) return true;
  if (token === "hamt" && /^ol/.test(next || "")) return true;
  if (/^hamtol/.test(token)) return true;
  if ((token === "team" || token === "teams") && (TEAM_NEXT.has(next || "") || OUR.has(previous || ""))) return true;
  if (token === "tim" && /^bild/.test(next || "")) return true;
  if (token === "bagaaraa") return true;
  if (token === "bagin" && isTripWord(next)) return true; // "багийн аялал" (team trip), not "аялал багийн хэдэн хүнтэй"
  if (tokenIs(token, BULGIIN) && !isFamilyWord(previous, token) && isTripWord(next)) return true; // "бүлгийн аялал", never "Bulgaria"
  return false;
}

/** "all" directly in front of a trip word the way a listing is asked for: "бүх аяллаа", "all your tours". */
function isAllListingAt(tokens: string[], index: number): boolean {
  if (!ALL_LISTING.has(tokens[index])) return false;
  let next = index + 1;
  if (tokens[index] === "all") {
    for (let skipped = 0; skipped < 2 && LISTING_FILLER.has(tokens[next] ?? ""); skipped += 1) next += 1;
  }
  const word = tokens[next];
  if (!word) return false;
  if (TRAVEL_EN.has(word)) return true;
  // Not the genitive ("бүх аяллын үнэ"), dative, ablative or comitative: those ask about the trips, not for them.
  return tokenIs(word, TRAVEL_MN) && !/(?:n|ld|aas|aar|ees|eer|oor|tai|tei)$/.test(word);
}

const GROUP_SIZE = /(?<![\p{L}\p{N}])\d{1,4}\s*(?:-?\s*(?:н|ны|ний|ын))?\s*(?:hun|хүн|хун|huntei|хүнтэй|human|people|pax|persons?|ppl|хүний|hunii|ажилтан|ажилчин|ajilchin)(?![\p{L}])/iu;

/** Which words the message holds. */
export function analyzeCatalogueText(text: string): CatalogueSignals {
  const raw = String(text || "").normalize("NFKC").trim().slice(0, MAX_TEXT_CHARS);
  const tokens = phonetic(raw).split(" ").filter(Boolean);
  const signals: CatalogueSignals = {
    corporate: false, travel: false, catalogue: false, options: false, all: false, allListing: false, resend: false, sendVerb: false,
    demonstrative: false, thanks: false, otherObject: false, resendOnly: tokens.length > 0, quote: false,
    groupSize: GROUP_SIZE.test(raw), list: false, words: tokens.length,
  };
  tokens.forEach((token, index) => {
    if (isCorporateAt(tokens, index)) signals.corporate = true;
    if (isTripWord(token)) signals.travel = true;
    if (tokenIs(token, CATALOGUE)) signals.catalogue = true;
    if (tokenIs(token, OPTIONS)) signals.options = true;
    if (tokenIs(token, LIST)) signals.list = true;
    if (tokenIs(token, ALL)) signals.all = true;
    if (isAllListingAt(tokens, index)) signals.allListing = true;
    const resendWord = tokenIs(token, RESEND) || (token === "re" && tokens[index + 1] === "send");
    if (resendWord) signals.resend = true;
    if (!resendWord && !POLITE.has(token)) signals.resendOnly = false;
    if (tokenIs(token, SEND_VERB_MN) || SEND_VERB_EN.has(token) || token === "resend" || (token === "re" && tokens[index + 1] === "send")) signals.sendVerb = true;
    if (DEMONSTRATIVE.has(token)) signals.demonstrative = true;
    if (tokenIs(token, THANKS)) signals.thanks = true;
    if (tokenIs(token, OTHER_OBJECT_MN) || OTHER_OBJECT_EN.has(token)) signals.otherObject = true;
    if (tokenIs(token, QUOTE)) signals.quote = true;
    // "үнийн санал" / "unin sanal": two words, so read as a pair.
    if (/^uni?n$/.test(token) && /^sanal/.test(tokens[index + 1] || "")) signals.quote = true;
    if (/^uni?n$/.test(token) && /^toc/.test(tokens[index + 1] || "")) signals.quote = true;
    if (token === "price" && /^(?:offer|quote)/.test(tokens[index + 1] || "")) signals.quote = true;
  });
  return signals;
}

/** A catalogue word, or a corporate trip phrase, is on the page: the message asks for the catalogue. */
export function detectCatalogueIntent(text: string): CatalogueIntent {
  const raw = String(text || "").trim();
  if (!raw || raw.length > MAX_TEXT_CHARS) return { kind: "none" };
  const s = analyzeCatalogueText(raw);
  const short = s.words <= 5;
  const label = (...parts: Array<[boolean, string]>) => parts.filter(([on]) => on).map(([, name]) => name).join("+") || "catalogue";
  // "дахин" counts as a resend only beside a send word or in a very short message: "дахин асуух зүйл байна" is not one.
  const resend = s.resend && (s.sendVerb || s.words <= 4);

  // A request for a quotation for a company or group, with no catalogue asked for: staff prepare
  // it, the bot collects group size, month and destination (the PDF is not the end of the sale).
  if (s.quote && (s.corporate || s.groupSize) && !s.catalogue) {
    return { kind: "group_quote", matched: label([s.corporate, "corporate"], [s.groupSize, "group_size"], [true, "quote"]) };
  }

  // 1. The catalogue by name: "каталог явуул", "trip brochure", "corporate trip catalog".
  //    Long messages that merely contain the word are not requests.
  if (s.catalogue && (s.travel || s.corporate || s.all || s.options || short)) {
    const edition = s.all || !s.corporate ? "complete" : "quick";
    return { kind: "catalogue", edition, resend, matched: label([s.corporate, "corporate"], [s.travel, "travel"], [true, "catalogue"], [s.all, "all"]) };
  }
  // 2. The whole offer: "бүх аяллаа", "all tours". "All" directly in front of a trip word, asked
  //    for in a few words or with a send/show word. "бүх зардал", "бүтэн өдрийн аялал", "full day
  //    tour" and "do all tours include lunch" are questions about trips, not requests for the list.
  if (s.allListing && !s.demonstrative && s.words <= 8 && (s.words <= 4 || s.sendVerb)) {
    return { kind: "catalogue", edition: "complete", resend, matched: label([true, "all"], [true, "travel"]) };
  }
  // 3. Company / team / group trips: "байгууллагын аялал", "hamt olnii aylal". "Энэ аяллыг
  //    байгууллагаар явж болох уу" asks about the one trip it points at.
  if (s.corporate && s.travel && !s.demonstrative) {
    return { kind: "catalogue", edition: "quick", resend, matched: label([true, "corporate"], [true, "travel"], [s.options || s.list, "options"]) };
  }
  // 4. "аяллын сонголтууд": the selection the catalogue is titled after. Needs a trip word.
  if (s.travel && s.options && s.words <= 5) {
    return { kind: "catalogue", edition: "quick", resend, matched: "travel+options" };
  }
  return { kind: "none" };
}

/**
 * "дахин явуул" with no catalogue word: a resend, if the conversation already holds a catalogue.
 * "дахин" alone next to a question, a thanks or another thing ("үнийг дахиад хэлээч", "баярлалаа
 * дахин хандъя", "thanks again") is not one: the message must ask for something to be sent again,
 * or be nothing but "again".
 */
export function isBareResendRequest(text: string): boolean {
  const raw = String(text || "").trim();
  if (!raw || raw.length > 80) return false;
  const s = analyzeCatalogueText(raw);
  if (!s.resend || s.catalogue || s.travel || s.corporate || s.all || s.quote || s.words > 5) return false;
  if (s.thanks || s.otherObject) return false;
  return s.sendVerb || s.resendOnly;
}

/**
 * A request the catalogue is only one possible answer to ("бүх аяллаа", "аяллын сонголтууд"):
 * when the catalogue cannot be sent, the existing trip flow still answers it. A request that names
 * the catalogue or a company/team trip ("каталог", "байгууллагын аялал") has no other answer.
 */
export function isSoftCatalogueRequest(text: string): boolean {
  const s = analyzeCatalogueText(text);
  return !s.catalogue && !s.corporate;
}
