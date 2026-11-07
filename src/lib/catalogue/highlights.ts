/**
 * Up to three short, REAL, customer-safe highlights for a trip card.
 *
 * Every line is taken from the trip's own data, in this order of trust: the website's curated
 * "Онцлох мөчүүд" list, short sentences of the website summary, the program's day titles that
 * name a sight or an activity (never a transfer, a meal, a free day or a border day), then the
 * included items that name a sight (an entrance ticket, a show) — not transport, hotels or meals.
 * Nothing is written, paraphrased or cut mid-sentence: a line that does not fit is skipped.
 * Staff / bot instructions, prices, discounts, contact details and availability claims never
 * reach a card. Fewer than three is fine; none raises a warning.
 */
import type { TravelTrip } from "../travelTypes";
import { STANDARD_DAYS } from "../tripTransitDays";
import type { CatalogueWarning } from "./types";
import { extractMntAmounts, isInternalCopy, row, rows, strList, text, warn } from "./diagnostics";

export const MAX_HIGHLIGHTS = 3;
export const MAX_HIGHLIGHT_CHARS = 60;
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

/** A candidate line made fit for a card, or null when it must not be printed. `dropped` counts internal copy. */
function clean(raw: unknown, counters: { internal: number }): string | null {
  const stripped = text(raw).replace(EMOJI, " ").replace(LEADING_MARK, "").replace(TRAILING_MARK, "").replace(/\s+/g, " ").trim();
  if (stripped.length < MIN_HIGHLIGHT_CHARS || stripped.length > MAX_HIGHLIGHT_CHARS) return null;
  if (isInternalCopy(stripped)) {
    counters.internal += 1;
    return null;
  }
  if (FORBIDDEN.test(stripped) || extractMntAmounts(stripped).length) return null;
  if (!/\p{L}{2}/u.test(stripped)) return null;
  const shown = readableCase(stripped);
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
  const candidates: string[] = [
    ...strList(website.highlights),
    ...[...summarySentences(extra.website_summary), ...summarySentences(website.summary)].filter((line) => !isLogistics(line)),
    ...rows(extra.itinerary_days).flatMap((day) => sightsInTitle(text(day.title))),
    ...strList(extra.included_items).filter(namesSight),
  ];
  const picked: string[] = [];
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (picked.length >= MAX_HIGHLIGHTS) break;
    const line = clean(candidate, counters);
    if (!line) continue;
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
