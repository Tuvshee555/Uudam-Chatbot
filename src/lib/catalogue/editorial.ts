/**
 * Editorial display titles and destination identity for the catalogue. DISPLAY ONLY: the canonical
 * trip title stays in card.title and is what liveDrift compares; staff can override the display
 * title per trip (config.titleOverrides), which always wins.
 *
 * editorialTitle() turns a database title into the name a travel book would print:
 *   "<place> шууд нислэгтэй аялал", "<place> хотын 8 шөнө 9 өдрийн аялал", "<place> нислэгтэй - 2"
 * lose their filler (duration, counters, weekdays, month lists, the agency's own departure city),
 * but ONLY when what remains is a clear destination phrase. A title that would be left with a
 * dangling case ending ("... арлын") is never cut mid-phrase: the filler stays. Casing follows the
 * render layer's displayTitle so the book reads evenly.
 *
 * destinationKey() is the normalised main destination used for "one place, one slot" in the
 * shortlist: spelling drift (ү/у, ө/о, ь, doubled vowels) collapses into one key.
 *
 * Pure: no clock, no database, no network. No real place is named here (AGENTS.md); every rule
 * works on generic words.
 */
import { displayTitle } from "./render/titleCase";
import { isAgencyFixedPoint, titleAnchoredPlaces } from "./kicker";

export const MAX_TITLE_OVERRIDE_CHARS = 80;
const MAX_EDITORIAL_CHARS = 64;

const LETTER = String.raw`\p{L}`;
const SEP = String.raw`[\s\-–—‑,.:;]`;
const WEEKDAYS = String.raw`(?:даваа|мягмар|лхагва|пүрэв|баасан|бямба|ням)(?:\s+гариг)?`;
const MONTH_LIST = String.raw`\d{1,2}(?:\s*,\s*\d{1,2})*\s*-?\s*р?\s*сар(?:ын|ууд)?(?:\s+\d{1,2}(?:\s*,\s*\d{1,2})*)?`;
const DAYS_WORD = String.raw`өдө?р(?:ийн)?`;
const DURATION_NN = String.raw`\d{1,2}\s*шөнө\s*,?\s*\d{1,2}\s*${DAYS_WORD}`;
const DURATION_DN = String.raw`\d{1,2}\s*${DAYS_WORD}\s*,?\s*\d{1,2}\s*шөнө(?:ийн)?`;

const space = (value: string) => value.replace(/\s+/g, " ").trim();
const lettersOf = (value: string) => value.match(/\p{L}/gu)?.length ?? 0;

export type EditorialParts = {
  title: string;
  /** What was stripped that tells two otherwise equal titles apart ("2", "Лхагва", "11-р сар", "Эрээнээс"). Empty when nothing. */
  qualifier: string;
};

/** Whole dash-separated segments that are only filler ("нислэгтэй", "газар нислэг хосолсон аялал"). */
const FILLER_SEGMENT = new RegExp(String.raw`^(?:(?:шууд\s+)?нислэгтэй|(?:газар\s+)?нислэг(?:ийн)?\s+хосолсон|нислэг|аялал(?:ын)?(?:\s+хөтөлбөр)?|аяллын\s+хөтөлбөр)(?:\s+аялал(?:ын)?)?$`, "iu");
const HOME_SEGMENT = /^(?:уб|улаанбаатар(?:аас)?)$/iu;
/** "… – <Place>аас [нислэгтэй]": where the trip starts from, booking information rather than the destination. */
const TRAILING_ORIGIN = new RegExp(String.raw`\s+[–—-]\s+(${LETTER}+(?:аас|ээс|оос|өөс))(?:\s+(?:шууд\s+)?нислэгтэй)?\s*$`, "iu");

/** Words that are filler at the END of a title, when what is left names a place. */
const TRAILING_FILLER: RegExp[] = [
  new RegExp(String.raw`${SEP}*(?:газар\s+нислэг\s+хосолсон|нислэг\s+хосолсон|газар\s+нислэгийн\s+хосолсон)(?:\s+аялал(?:ын)?(?:\s+хөтөлбөр)?)?\s*$`, "iu"),
  new RegExp(String.raw`${SEP}*(?:шууд\s+)?нислэгтэй(?:\s+аялал(?:ын)?(?:\s+хөтөлбөр)?)?\s*$`, "iu"),
  new RegExp(String.raw`${SEP}*аяллын\s+хөтөлбөр\s*$`, "iu"),
  new RegExp(String.raw`${SEP}*аялал(?:ын)?\s*$`, "iu"),
  new RegExp(String.raw`(?<=${LETTER}{3})\s+нислэг\s*$`, "iu"),
];

/** Dangling genitives that make a cut title read wrongly; the known ones are repaired, others block the cut. */
const REPAIR: Array<[RegExp, string]> = [
  [new RegExp(String.raw`(?<!${LETTER})(хот)ын\s*$`, "iu"), "$1"],
  [new RegExp(String.raw`(?<!${LETTER})(ар)лын\s*$`, "iu"), "$1ал"],
  [new RegExp(String.raw`(?<!${LETTER})(нуур)ын\s*$`, "iu"), "$1"],
  [new RegExp(String.raw`(?<!${LETTER})(уул)ын\s*$`, "iu"), "$1"],
];
/** A last word that still hangs off the cut-away "аялал": a case ending or a "-тай" adjective ("шинжилгээтэй"). */
const DANGLING = new RegExp(String.raw`${LETTER}{2,}(?:ын|ийн|ний|ны|ий|тай|тэй|той|төй)\s*$`, "iu");

function tidy(value: string): string {
  return space(value
    .replace(/\(\s+/g, "(").replace(/\s+\)/g, ")")
    .replace(/\s+[-–—]\s+|\s*[–—]\s*/g, " – ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/^[\s\-–—,.:;•]+|[\s\-–—,.:;•(]+$/gu, "")
    .replace(/\(\s*\)/g, ""));
}

/** Remove the agency's own departure city used as a prefix ("УБ-<place>", "Улаанбаатар – <place>"). */
function stripHomePrefix(value: string): string {
  const stripped = value.replace(/^(?:уб|улаанбаатар(?:аас)?)\s*[-–—]\s*(?=\p{L})/iu, "");
  return lettersOf(stripped) >= 3 ? stripped : value;
}

/** Drops whole segments that are the agency's own departure / border legs or pure filler, while at least `min` remain. */
function dropLegSegments(value: string): string {
  const segments = value.split(" – ");
  if (segments.length < 2) return value;
  const keep = segments.filter((segment) => !HOME_SEGMENT.test(segment.trim()) && !FILLER_SEGMENT.test(segment.trim()) && !isAgencyFixedPoint(segment.trim()));
  return keep.length >= 1 && (keep.length >= 2 || keep.length === segments.length || segments.length > 2) ? keep.join(" – ") : value;
}

/** Adopts the capital of the word it replaces ("Хотын" -> "Хот"). */
function repairEnding(value: string): string {
  let out = value;
  for (const [pattern, replacement] of REPAIR) {
    out = out.replace(pattern, (...m) => {
      const whole = m[0] as string;
      const fixed = replacement.replace(/\$(\d)/g, (_x, n: string) => String(m[Number(n)] ?? ""));
      return /\p{Lu}/u.test(whole.trim()[0] ?? "") ? fixed[0]!.toUpperCase() + fixed.slice(1) : fixed;
    });
  }
  return out;
}

/** The derivation without the final casing, plus what was stripped (used to tell equal titles apart). */
export function editorialParts(canonical: string): EditorialParts {
  const original = space(String(canonical ?? ""));
  if (!original) return { title: "", qualifier: "" };
  const qualifiers: string[] = [];
  let value = stripHomePrefix(original);

  // Duration written into the title (also in brackets): the card prints it separately.
  value = value.replace(new RegExp(String.raw`\(\s*(?:${DURATION_NN}|${DURATION_DN})\s*\)`, "giu"), " ");
  value = value.replace(new RegExp(String.raw`(?<![\d])(?:${DURATION_NN}|${DURATION_DN})`, "giu"), " ");
  value = value.replace(/\(\s*[\d\s,.\-–]*(?:өдөр|шөнө)?\s*\)/giu, " ");

  // Transport-mode filler is removed wherever it sits ("<A>-газар нислэг хосолсон - <B>"): the card prints the transport.
  const withoutMode = value.replace(/[\s\-–—]*(?:газар\s+)?нислэг(?:ийн)?\s+хосолсон(?:\s+аялал(?:ын)?)?/giu, " ");
  if (lettersOf(withoutMode) >= 3) value = withoutMode;

  // Month lists ("11-р сарын", "1,2,3-р сарын", "12 сарын 15, 20, 25") are departure info, not identity.
  value = value.replace(new RegExp(String.raw`(?<![\d])(${MONTH_LIST})`, "giu"), (m) => { qualifiers.push(space(m).replace(/ын$/u, "")); return " "; });
  // Weekday of departure.
  value = value.replace(new RegExp(String.raw`${SEP}*(?<!${LETTER})(${WEEKDAYS})(?!${LETTER})`, "giu"), (_m, day: string) => { qualifiers.push(space(day)); return " "; });
  value = space(value);

  // A trailing counter after filler words: "... нислэгтэй - 2", "... нислэгтэй 1".
  const counter = /(?:^|[\s\-–—])(\d{1,2})\s*$/u.exec(value);
  if (counter && /\p{L}/u.test(value.slice(0, counter.index))) {
    qualifiers.push(counter[1]!);
    value = value.slice(0, counter.index);
  }
  // Case once the lower-case clutter (duration, months, weekdays) is gone: an ALL-CAPS title is then wholly
  // capitals and becomes Title Case, so every piece the rules keep or repair reads evenly.
  value = tidy(displayTitle(tidy(value)));

  // A trailing bracket ("( A - B )") is kept as it is, apart from its spacing.
  let paren = "";
  const bracket = /\s*\(([^()]*)\)\s*$/u.exec(value);
  if (bracket && lettersOf(value.slice(0, bracket.index)) >= 3) {
    paren = tidy(bracket[1]!);
    value = tidy(value.slice(0, bracket.index));
  }

  const origin = TRAILING_ORIGIN.exec(value);
  if (origin && lettersOf(value.slice(0, origin.index)) >= 3) {
    qualifiers.push(origin[1]!);
    value = tidy(value.slice(0, origin.index));
  }
  value = dropLegSegments(value);

  // Filler at the end, only when a clear destination phrase is left.
  for (let pass = 0; pass < 3; pass++) {
    let changed = false;
    for (const filler of TRAILING_FILLER) {
      if (!filler.test(value)) continue;
      const rest = repairEnding(tidy(value.replace(filler, "")));
      if (lettersOf(rest) < 3 || DANGLING.test(rest) || /(?:^|[\s\-–—])(?:ба|болон|ч|буюу)\s*$/iu.test(rest)) continue;
      value = rest;
      changed = true;
      break;
    }
    if (!changed) break;
  }

  // "<Name>ын аялал – <places>": the genitive is only there to attach the word "аялал".
  value = value.replace(new RegExp(String.raw`^(${LETTER}{3,}?)(?:ын|ийн)\s+аялал(?:ын)?\s*[-–—]\s*(?=\p{L})`, "iu"), (_m, name: string) => `${name} – `);

  value = tidy(value);
  if (lettersOf(value) < 2) value = tidy(displayTitle(original));
  else if (paren && lettersOf(paren) >= 3) value = `${value} (${paren})`;
  return { title: value, qualifier: qualifiers.map(space).filter(Boolean).join(" ") };
}

/** Segment-wise shortening of a very long title at a natural separator; never mid-word, never inside a bracket. */
function shorten(value: string): string {
  if (value.length <= MAX_EDITORIAL_CHARS) return value;
  const bracket = /\s*\([^()]*\)\s*$/u.exec(value);
  const head = bracket ? value.slice(0, bracket.index) : value;
  const tail = bracket ? ` ${bracket[0].trim()}` : "";
  const parts = head.split(/\s+[–—]\s+|\s-\s/u);
  if (parts.length < 2) return value;
  const kept: string[] = [];
  for (const part of parts) {
    const next = [...kept, part].join(" – ");
    if (next.length > MAX_EDITORIAL_CHARS && kept.length) break;
    kept.push(part);
  }
  return `${kept.join(" – ")}${kept.length === parts.length ? tail : ""}`;
}

/**
 * The concise display title. `override` (staff, trimmed, at most 80 characters) wins as written.
 * `ctx.destinations` only rescues a title that would otherwise be empty.
 */
export function editorialTitle(canonical: string, ctx: { destinations?: readonly string[] } = {}, override?: string | null): string {
  const staff = space(String(override ?? "")).slice(0, MAX_TITLE_OVERRIDE_CHARS);
  if (staff) return staff;
  const { title } = editorialParts(canonical);
  const base = title || space(ctx.destinations?.find((d) => lettersOf(d) >= 2) ?? "") || space(String(canonical ?? ""));
  return displayTitle(shorten(base));
}

/* ------------------------------------------------------------------ destination identity */

const CYRILLIC_FOLD: Record<string, string> = { ү: "у", ө: "о", ё: "е", ъ: "", ь: "", й: "и", ы: "и", э: "е", ю: "у", я: "а" };

/** Spelling-drift-proof form of a place name: folded vowels, no soft sign, doubled letters collapsed. */
export function foldPlaceName(value: string): string {
  const letters = [...String(value ?? "").toLowerCase().replace(/[^\p{L}]/gu, "")].map((ch) => CYRILLIC_FOLD[ch] ?? ch).join("");
  return letters.replace(/(.)\1+/g, "$1");
}

/** Stem used as the key: names of five or more letters are compared by their first four. */
function keyOf(name: string): string {
  const folded = foldPlaceName(name);
  return folded.length >= 5 ? folded.slice(0, 4) : folded;
}

const GENERIC_FIRST_WORDS = /^(?:аялал|аяллын|нислэг|нислэгтэй|шууд|хотын|арал|арлын|газар|шинэ|жилийн|бүтэн|эрүүл)$/iu;

/**
 * Every place a trip is about, the main one first, normalised like foldPlaceName: the places its
 * TITLE names (departure and border legs dropped, see kicker.ts), the website region, and the
 * first word of the display title. Two trips that share one key are the same destination.
 * [] when nothing trustworthy exists.
 */
export function destinationKeys(canonicalTitle: string, destinations: readonly string[] = [], region = ""): string[] {
  const keys: string[] = [];
  const add = (name: string) => {
    const key = keyOf(name);
    if (key.length >= 3 && !keys.includes(key)) keys.push(key);
  };
  for (const place of titleAnchoredPlaces(canonicalTitle, destinations)) add(place);
  const regionName = space(region);
  if (regionName && lettersOf(regionName) >= 3 && !isAgencyFixedPoint(regionName)) add(regionName);
  const first = editorialParts(canonicalTitle).title.split(/\s+[–—-]\s+|[,•/(]/u)[0]?.split(/\s+/u).find((word) => lettersOf(word) >= 4 && !GENERIC_FIRST_WORDS.test(word));
  if (first && !isAgencyFixedPoint(first)) add(first.replace(/(?:ын|ийн|ны|ний)$/u, ""));
  return keys.slice(0, 4);
}

/** The main destination key (the first of destinationKeys), "" when unknown. */
export function destinationKey(canonicalTitle: string, destinations: readonly string[] = [], region = ""): string {
  return destinationKeys(canonicalTitle, destinations, region)[0] ?? "";
}
