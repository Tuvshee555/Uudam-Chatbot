/**
 * Up to three short, REAL, customer-safe highlights for a trip card.
 *
 * Every line is taken from the trip's own data, in this order of trust: the website's curated
 * "Онцлох мөчүүд" list, short sentences of the website summary, the program's day titles that
 * name a sight or an activity (never a transfer, a meal, a free day or a border day), then the
 * included items that name a sight (an entrance ticket, a show) — not transport, hotels or meals.
 * A highlight is short (at most 4 words / 32 characters) so a card reads at a glance. A long raw
 * line from a LIST source (the website's highlights, a program day title, an included item) is
 * split at its first natural clause break ("A, B", "A – B", "A ба B", "A (note)") and the first
 * clause is used when it fits and stands alone; a summary sentence is used whole or not at all.
 * Nothing is written, paraphrased or cut mid-word: a line that cannot be shortened cleanly is skipped.
 * Staff / bot instructions, prices, discounts, contact details and availability claims never
 * reach a card. Fewer than three is fine; none raises a warning.
 */
import type { TravelTrip } from "../travelTypes";
import { STANDARD_DAYS } from "../tripTransitDays";
import type { CatalogueWarning } from "./types";
import { extractMntAmounts, isInternalCopy, row, rows, strList, text, warn } from "./diagnostics";

export const MAX_HIGHLIGHTS = 3;
export const MAX_HIGHLIGHT_CHARS = 32;
export const MAX_HIGHLIGHT_WORDS = 4;
const MIN_HIGHLIGHT_CHARS = 4;

const LEADING_MARK = /^[\s•·▪●○◦✓✔✅➤➢▶►*\-–—]+/u;
const TRAILING_MARK = /[\s.;,:!]+$/u;
const EMOJI = /[\p{Extended_Pictographic}️‍]/gu;
const FORBIDDEN = new RegExp([
  "https?:\\/\\/", "www\\.", "@", "\\d{7,}", // links, e-mail, phone numbers
  "₮|төгрөг|mnt|\\$|usd|eur|юань|¥|cny|rmb", // money
  "хямд|хөнгөлөлт|урамшуул|промо|promo|discount|sale|%", // promotions and discounts
  "суудал|захиалга|баталгаат|гарантаар|заавал", // availability or booking claims
  "\\?", // questions
].join("|"), "iu");

/** Titles of the standard train / airport days (tripTransitDays.ts) are transfers, not highlights. */
const STANDARD_TITLES = new Set([
  STANDARD_DAYS.departure.title,
  STANDARD_DAYS.borderOutbound.title,
  STANDARD_DAYS.arrival.title,
].map((title) => title.toUpperCase()));
const TRANSFER_WORDS = /буцах|буцна|буцаж|ирнэ|ирэх|нисэх буудал|хөдлөх|цуглах|өндөрлөнө|эхэлнэ|хил гаал|галт тэрэг|тээвэр|трансфер|transfer|check[ -]?in|check[ -]?out|\d+\s*-?\s*р\s*өдөр|өдөр\s*\d+/iu;
// A route leg ("A – B", "A-B", "A → B") is a transfer, not a highlight.
const ROUTE_LEG = /[–—→➔]|\s-\s|(?<=\p{L})-(?=\p{L})|->/u;
/** Logistics: transport, hotels, meals, guides, insurance, free days. Included in the price, but not what a trip is remembered for. */
const LOGISTICS = /тийз|нислэг|автобус|унаа|хөтөч|ахлагч|даатгал|виз(?!\p{L})|трансфер|тээвэр|зочид\s+буудал|буудлын|өглөөний\s+цай|хоол|байр(?!\p{L})|чөлөөт|ажилтнаас|лавлана|тасалбар|зардал|төлбөр|хөтөлбөр|заагдсан|заасан|дурдсан|дурдагдсан|сонгогдсон|\d+\s*-?\s*(?:өдөр|шөнө|өдрийн|шөнийн)/iu;
/** Words that name a sight, an activity or a place type; program titles and included items need one to count as a highlight. */
const SIGHT = /аялал(?!ын)|нуур|уул(?!з)|арал|арлын|парк|музей|museum|ордон|хэрэм|цамхаг|талбай|үзэсгэлэнт|рашаан|аквариум|зоо|цэцэрлэг|сүм|хийд|шоу|театр|гүүр|хавцал|ширэнгэ|ойн|далай|тэнгис|эрэг|beach|park|studios?|resort|круиз|cruise|шопинг|дэлгүүр|булаг|хөшөө|харш|үзвэр|водопад|хүрхрээ|гэр\s+кэмп|кемп|ski|цана/iu;
const GENERIC_WORDS = /(?:^|\s)(?:хот|хотын|далай|далайн|аялал|аяллын|өдөр|өдрийн|нутгийн|орчмын)(?=\s|$)/giu;

function squash(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** "ЛОТОС НУУР" -> "Лотос Нуур": all-capitals program titles read as headlines in a brochure. */
function readableCase(value: string): string {
  if (!/\p{Lu}/u.test(value) || /\p{Ll}/u.test(value)) return value;
  return value.split(" ").map((word) => (word ? word[0] + word.slice(1).toLowerCase() : word)).join(" ");
}

/** The first natural clause of a raw line: before the first comma / dash / "ба" / bracket. */
function firstClause(value: string): string {
  const withoutNote = value.replace(/\([^)]*\)?/gu, " ");
  const head = withoutNote.split(/\s*[,;:–—]\s*|\s-\s|\s+(?:ба|болон|буюу)\s+|\s*[+&]\s*/u)[0] ?? "";
  return head.replace(/\s+/g, " ").trim();
}

const wordCount = (value: string) => value.split(/\s+/u).filter(Boolean).length;
const fits = (value: string) => value.length >= MIN_HIGHLIGHT_CHARS && value.length <= MAX_HIGHLIGHT_CHARS && wordCount(value) <= MAX_HIGHLIGHT_WORDS;

/**
 * A candidate line made fit for a card, or null when it must not be printed. `counters.internal`
 * counts staff / bot copy. A `list` line may be reduced to its first clause; any other line is
 * kept whole or dropped.
 */
function clean(raw: unknown, counters: { internal: number }, list: boolean): string | null {
  const stripped = text(raw).replace(EMOJI, " ").replace(/\s*\+\s*/g, " + ").replace(LEADING_MARK, "").replace(TRAILING_MARK, "").replace(/\s+/g, " ").trim();
  if (stripped.length < MIN_HIGHLIGHT_CHARS) return null;
  if (isInternalCopy(stripped)) {
    counters.internal += 1;
    return null;
  }
  if (FORBIDDEN.test(stripped) || extractMntAmounts(stripped).length) return null;
  let line = stripped;
  if (!fits(line)) {
    if (!list) return null;
    line = firstClause(stripped).replace(LEADING_MARK, "").replace(TRAILING_MARK, "").trim();
    if (!fits(line) || (wordCount(line) === 1 && line.length < 6)) return null;
  }
  if (!/\p{L}{2}/u.test(line)) return null;
  // One short bare word ("Музей") says nothing about what the trip offers.
  if (wordCount(line) === 1 && line.replace(/\P{L}/gu, "").length < 7) return null;
  const shown = readableCase(line);
  return shown[0].toUpperCase() + shown.slice(1);
}

function summarySentences(value: unknown): string[] {
  return text(value) ? String(value).split(/(?<=[.!?])\s+|\n+|;|•/u).map(text).filter(Boolean) : [];
}

/** Transport, hotel, meal, guide or "included in the programme" wording: true when the line is logistics. */
function isLogistics(value: string): boolean {
  return LOGISTICS.test(value.replace(/орох\s+тасалбар/giu, " "));
}

/** A program title or included item that names something to see or do. */
function namesSight(value: string): boolean {
  const normalized = text(value);
  if (!normalized || STANDARD_TITLES.has(normalized.toUpperCase())) return false;
  if (ROUTE_LEG.test(normalized) || TRANSFER_WORDS.test(normalized) || isLogistics(normalized)) return false;
  if (!SIGHT.test(normalized)) return false;
  // "Хотын аялал" alone names nothing; it needs a place or a thing beside the generic words.
  return normalized.replace(GENERIC_WORDS, " ").trim().length >= 3;
}

/**
 * What a program day title offers to see. A title that names a sight is one highlight; a title in
 * the "<place> – <sight>, <sight>" shape gives the sights after the dash, one by one. A pure route
 * ("<place> – <place>") gives nothing.
 */
function sightsInTitle(title: string): string[] {
  const whole = text(title);
  if (namesSight(whole)) return [whole];
  return whole.split(/\s[–—-]\s|→|➔/u).flatMap((part) => part.split(",")).map(text).filter((part) => part && namesSight(part));
}

/** The trip's real highlights (at most three) and the warnings about what was dropped or missing. */
export function deriveHighlights(trip: TravelTrip): { highlights: string[]; warnings: CatalogueWarning[] } {
  const extra = row(trip.extra);
  const website = row(extra.website_details);
  const counters = { internal: 0 };
  const candidates: Array<{ line: string; list: boolean }> = [
    ...strList(website.highlights).map((line) => ({ line, list: true })),
    ...[...summarySentences(extra.website_summary), ...summarySentences(website.summary)].filter((line) => !isLogistics(line)).map((line) => ({ line, list: false })),
    ...rows(extra.itinerary_days).flatMap((day) => sightsInTitle(text(day.title))).map((line) => ({ line, list: true })),
    ...strList(extra.included_items).filter(namesSight).map((line) => ({ line, list: true })),
    // Last resort: the destination list also names sights ("<name> парк", "<name> талбай"), not only cities.
    ...[...strList(extra.destinations), ...strList(website.destinations)].filter(namesSight).map((line) => ({ line, list: true })),
  ];
  const picked: string[] = [];
  const keys: string[] = [];
  // A line that only repeats the trip's own name ("<place> арал" under "<place> арлын аялал") adds nothing.
  const stem = (word: string) => word.toLowerCase().replace(/[^\p{L}]/gu, "").slice(0, 4);
  const titleStems = new Set(text(trip.route_name).split(/[\s\-–—,.:;()]+/u).map(stem).filter((value) => value.length >= 3));
  const repeatsTitle = (line: string) => {
    const words = line.split(/[\s\-–—,.:;()+]+/u).map(stem).filter((value) => value.length >= 3);
    return words.length > 0 && words.every((word) => titleStems.has(word));
  };
  for (const candidate of candidates) {
    if (picked.length >= MAX_HIGHLIGHTS) break;
    const line = clean(candidate.line, counters, candidate.list);
    if (!line || repeatsTitle(line)) continue;
    const key = squash(line);
    if (!key || keys.some((other) => other === key || (other.length >= 8 && key.length >= 8 && (other.includes(key) || key.includes(other))))) continue;
    keys.push(key);
    picked.push(line);
  }
  const warnings: CatalogueWarning[] = [];
  if (counters.internal) {
    warnings.push(warn("internal_copy_dropped", "info", `Ажилтан/ботод зориулсан ${counters.internal} мөр хэрэглэгчийн хуудаснаас хасагдсан.`, trip.id, { count: counters.internal }));
  }
  if (!picked.length) {
    warnings.push(warn("highlights_missing", "warning", "Онцлох мөчийн жинхэнэ мэдээлэл олдсонгүй (вэбсайтын «Онцлох мөчүүд», товч тайлбар, хөтөлбөр, багтсан зүйл хоосон эсвэл урт).", trip.id));
  }
  return { highlights: picked, warnings };
}
