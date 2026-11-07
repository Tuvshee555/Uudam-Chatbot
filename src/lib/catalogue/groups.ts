/**
 * Use-case groups for the catalogue contents page ("Далайн амралт", "Хот, соёл, худалдаа", ...).
 *
 * A trip's group comes from what the trip itself says, never from a destination written in code:
 *   1. the admin's override (tripId -> group key) always wins;
 *   2. THEMES are scored from all of the trip's own evidence, by the number of distinct theme words:
 *        - the title, destinations and aliases name the trip (weight 3 per word);
 *        - category, season, region and cruise transport are metadata (weight 2 per word);
 *        - the PROGRAM speaks for what the days are actually spent on: every program day whose title
 *          or description carries a theme word counts once for that theme (weight 1 per day), so a
 *          trip whose free days are spent on the beach is a beach holiday even when its name is only
 *          a city; the website summary, highlights and included items are weighed the same way (1);
 *      a clear winner (strictly ahead and by at least a fifth of its own score) names the group.
 *      A tie, or a narrow lead, is ambiguity, not an answer: no group is guessed;
 *      (A programme with several beach days is a holiday even when a city excursion rivals it.)
 *   3. a tie between the title/metadata themselves is never broken by the program (staff wrote the
 *      title for customers; a disagreement is for staff to settle);
 *   4. a COMPUTED price tier: clearly cheaper than the typical trip of this edition (at most 60% of
 *      the median starting price) -> "Хэмнэлттэй аялал". It outranks a program-only winner on thin
 *      evidence (under three program days, nothing in the title);
 *   5. otherwise the explicit "Бусад" group with a 'category_unknown' warning (naming the tied
 *      themes when there was a tie). Never a guess.
 * A group that rests on the program alone and on fewer than three program days is an info
 * 'category_unknown' ("автомат таамаглал") so staff confirm it.
 * Every trip is in exactly ONE group, so the renderer can lay pages out group by group.
 */
import type { TravelTrip } from "../travelTypes";
import type { CatalogueGroup, CatalogueWarning } from "./types";
import { row, rows, strList, text, warn } from "./diagnostics";

export type GroupKey = "beach" | "city" | "nature" | "wellness" | "budget" | "other";

/** Display order of the groups on the contents page. */
export const GROUP_DEFS: ReadonlyArray<{ key: GroupKey; label: string }> = [
  { key: "beach", label: "Далайн амралт" },
  { key: "city", label: "Хот, соёл, худалдаа" },
  { key: "nature", label: "Байгаль, адал явдал" },
  { key: "wellness", label: "Эрүүл мэнд, рашаан" },
  { key: "budget", label: "Хэмнэлттэй аялал" },
  { key: "other", label: "Бусад" },
];
const KEYS = new Set<string>(GROUP_DEFS.map((def) => def.key));

/** The share of the median starting price at or under which a trip is "budget-friendly". */
export const BUDGET_SHARE_OF_MEDIAN = 0.6;

// Theme words (stems), matched on lower-cased trip text. Words only: no place names.
const L = String.raw`(?<![\p{L}])`;
type ThemeKey = Exclude<GroupKey, "budget" | "other">;
const THEMES: ReadonlyArray<{ key: ThemeKey; pattern: RegExp }> = [
  { key: "beach", pattern: new RegExp(`далай(?!\\s+лам)|арлын|арлууд|${L}арал|${L}эрэг(?!тэй)|beach|resort|рэсорт|ресорт|тропик|шумбал|snorkel|круиз|круз|cruise|усан онгоц|тэнгис|усан\\s+парк|water\\s*(?:world|park)|шүрэн`, "iu") },
  { key: "city", pattern: new RegExp(`шопинг|shopping|худалдаа|худалдан\\s+авалт|дэлгүүр|${L}mall|outlet|хотын\\s+(?:(?:\\d+(?:\\s*,\\s*\\d+)*\\s*-?\\s*р\\s+сарын|\\d+\\s*(?:шөнө|өдрийн|өдөр))\\s+)*аял|city\\s*tour|театр|музей|museum|цамхаг`, "iu") },
  { key: "nature", pattern: new RegExp(`байгаль|${L}нуур|${L}уул(?!з)|${L}ой(?!\\p{L})|адал\\s*явдал|adventure|${L}трек|${L}trek|хавцал|каньон|canyon|цана|${L}ski(?![\\p{L}])|рафтинг|ширэнгэ|нуга|${L}эко|${L}eco|үндэсний\\s+парк|national\\s+park|хөндий|тайга|${L}цөл|desert|говь|геопарк`, "iu") },
  { key: "wellness", pattern: new RegExp(`шинжилгээ|эрүүл\\s+мэнд|оношилгоо|эмчилгээ|рашаан|${L}spa(?![\\p{L}])|массаж|sanatorium|сувилал|check-?up`, "iu") },
];

type ThemeScores = Record<ThemeKey, number>;

/** What one distinct theme word is worth, by where it was found. The title and destinations name the trip; the program shows what it is. */
const WEIGHT_TITLE = 3;
const WEIGHT_METADATA = 2;
const WEIGHT_PROGRAM = 1;
/** A winner must lead the runner-up by this share of its own score (and be strictly ahead). */
const CLEAR_LEAD = 0.2;
/** Program days that make a program-only decision firm enough not to need a staff glance. */
const FIRM_PROGRAM_DAYS = 3;
/**
 * A holiday programme spends days at the sea. Packaged city excursions and free-day shopping appear
 * in nearly every beach holiday (the reverse is rare), so when beach and a rival are level or close,
 * at least this many beach DAYS, and no more than one day fewer than the rival, make it a beach trip.
 */
const HOLIDAY_BEACH_DAYS = 3;

const emptyScores = (): ThemeScores => ({ beach: 0, city: 0, nature: 0, wellness: 0 });
const THEME_KEYS = THEMES.map((theme) => theme.key);

/** Distinct theme words per theme found in `source`. */
function wordsByTheme(source: string): Record<ThemeKey, Set<string>> {
  const haystack = source.toLowerCase();
  const found = { beach: new Set<string>(), city: new Set<string>(), nature: new Set<string>(), wellness: new Set<string>() };
  if (!haystack.trim()) return found;
  for (const theme of THEMES) {
    for (const match of haystack.matchAll(new RegExp(theme.pattern.source, "giu"))) found[theme.key].add(match[0].replace(/\s+/g, " "));
  }
  return found;
}

/** Adds `weight` per DISTINCT theme word found in `source` (the same word twice counts once). */
function addScores(scores: ThemeScores, source: string, weight: number): void {
  const found = wordsByTheme(source);
  for (const key of THEME_KEYS) scores[key] += found[key].size * weight;
}

/** Adds `weight` once for every theme that appears at all in `source` (a day, a line): breadth, not repetition. */
function addPresence(scores: ThemeScores, source: string, weight: number): void {
  const found = wordsByTheme(source);
  for (const key of THEME_KEYS) if (found[key].size) scores[key] += weight;
}

type ThemeVerdict = { winner: ThemeKey | null; tied: ThemeKey[] };

/** The single clear best-scoring theme; a tie or a narrow lead has no winner (and names the contenders). */
function verdictOf(scores: ThemeScores): ThemeVerdict {
  const ranked = [...THEME_KEYS].sort((a, b) => scores[b] - scores[a]);
  const top = scores[ranked[0]!];
  if (top <= 0) return { winner: null, tied: [] };
  const second = scores[ranked[1]!];
  if (top - second > 0 && top - second >= top * CLEAR_LEAD) return { winner: ranked[0]!, tied: [] };
  return { winner: null, tied: ranked.filter((key) => scores[key] >= second && scores[key] > 0) };
}

/** Metadata the trip states about itself, the strongest evidence of its theme: title and destinations weigh most. */
function metadataScores(trip: TravelTrip): ThemeScores {
  const extra = row(trip.extra);
  const website = row(extra.website_details);
  const scores = emptyScores();
  addScores(scores, [text(trip.route_name), ...strList(extra.destinations), ...strList(website.destinations), ...strList(extra.aliases)].join(" | "), WEIGHT_TITLE);
  addScores(scores, [trip.category, text(website.season), text(website.region), extra.transport_type === "cruise" ? "cruise" : ""].join(" | "), WEIGHT_METADATA);
  return scores;
}

/** The program and the copy written about it: each day (title + description), each summary / highlight / included line. */
function programScores(trip: TravelTrip): { scores: ThemeScores; days: ThemeScores } {
  const extra = row(trip.extra);
  const website = row(extra.website_details);
  const scores = emptyScores();
  const days = emptyScores();
  for (const day of rows(extra.itinerary_days)) {
    const dayScores = emptyScores();
    addPresence(dayScores, `${text(day.title)} | ${text(day.description)}`, 1);
    for (const key of THEME_KEYS) {
      scores[key] += dayScores[key] * WEIGHT_PROGRAM;
      days[key] += dayScores[key];
    }
  }
  // Summary prose: distinct words per source (a summary naming three sights is three words).
  addScores(scores, [text(extra.website_summary), text(website.summary)].join(" | "), WEIGHT_PROGRAM);
  for (const line of [...strList(website.highlights), ...strList(extra.included_items)]) addPresence(scores, line, WEIGHT_PROGRAM);
  return { scores, days };
}

const THEME_LABEL = (key: ThemeKey): string => GROUP_DEFS.find((def) => def.key === key)?.label ?? key;

/** Starting price at or under which a trip counts as budget-friendly; null with fewer than two priced trips. */
export function budgetCutoff(prices: readonly number[]): number | null {
  const sorted = prices.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  if (sorted.length < 2) return null;
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return median * BUDGET_SHARE_OF_MEDIAN;
}

export type GroupInput = { trip: TravelTrip; priceMnt: number | null };

export type GroupDecision = { groupKey: GroupKey; warnings: CatalogueWarning[] };

const sumScores = (a: ThemeScores, b: ThemeScores): ThemeScores => ({
  beach: a.beach + b.beach, city: a.city + b.city, nature: a.nature + b.nature, wellness: a.wellness + b.wellness,
});

/** Why a trip scores the way it does: title/metadata score, program score and the number of program days per theme (admin diagnostics, tests). */
export function themeEvidence(trip: TravelTrip): { meta: Record<string, number>; program: Record<string, number>; programDays: Record<string, number> } {
  const program = programScores(trip);
  return { meta: { ...metadataScores(trip) }, program: { ...program.scores }, programDays: { ...program.days } };
}

/** Group of every trip of one edition. Pure and order-independent (the budget tier is computed over the whole set). */
export function classifyTrips(items: readonly GroupInput[], overrides: Readonly<Record<string, string>> = {}): Map<string, GroupDecision> {
  const cutoff = budgetCutoff(items.map((item) => item.priceMnt ?? 0));
  const out = new Map<string, GroupDecision>();
  for (const { trip, priceMnt } of items) {
    const warnings: CatalogueWarning[] = [];
    const override = overrides[trip.id];
    let key: GroupKey | null = null;
    if (override !== undefined) {
      if (KEYS.has(override)) key = override as GroupKey;
      else warnings.push(warn("other", "info", `Админы сонгосон бүлэг «${override}» танигдсангүй — автомат ангилал ашиглав.`, trip.id));
    }
    let tied: ThemeKey[] = [];
    // A program-only winner on thin evidence (fewer than FIRM_PROGRAM_DAYS days, nothing in the title) is a
    // soft guess: the computed price tier is consulted before it, exactly as before the program was read.
    let soft: ThemeKey | null = null;
    if (!key) {
      const meta = metadataScores(trip);
      const metaVerdict = verdictOf(meta);
      const hasMeta = Object.values(meta).some((n) => n > 0);
      if (hasMeta && !metaVerdict.winner) {
        // The title / metadata disagree with themselves: ambiguity the program does not get to break.
        tied = metaVerdict.tied;
      } else {
        const program = programScores(trip);
        const combined = verdictOf(sumScores(meta, program.scores));
        const beachHoliday = !combined.winner && combined.tied.includes("beach") && program.days.beach >= HOLIDAY_BEACH_DAYS
          && combined.tied.every((rival) => rival === "beach" || program.days.beach >= program.days[rival] - 1);
        const winner = combined.winner ?? (beachHoliday ? "beach" : null);
        if (winner) {
          if (meta[winner] === 0 && program.days[winner] < FIRM_PROGRAM_DAYS) soft = winner;
          else key = winner;
        } else tied = combined.tied;
      }
    }
    if (!key && cutoff !== null && priceMnt !== null && priceMnt > 0 && priceMnt <= cutoff) key = "budget";
    if (!key && soft) {
      key = soft;
      warnings.push(warn("category_unknown", "info",
        `Ангилал зөвхөн хөтөлбөр/тайлбараас таамаглагдсан (автомат таамаглал: «${THEME_LABEL(soft)}»). Админаас бүлгийг баталгаажуулна уу.`, trip.id, { guess: soft }));
    }
    if (!key) {
      key = "other";
      warnings.push(warn("category_unknown", "warning", tied.length
        ? `Аяллын ангилал нэг утгатай биш (${tied.map(THEME_LABEL).join(" / ")} тэнцүү таарсан) тул «Бусад» бүлэгт орлоо. Админаас бүлэг сонгоно уу.`
        : "Аяллын ангилал тодорхойгүй тул «Бусад» бүлэгт орлоо. Админаас бүлэг сонгоно уу.", trip.id, tied.length ? { tied: tied.join(",") } : undefined));
    }
    out.set(trip.id, { groupKey: key, warnings });
  }
  return out;
}

/** The contents page: non-empty groups in display order, codes in card order. */
export function buildGroups(cards: ReadonlyArray<{ code: string; groupKey: string }>): CatalogueGroup[] {
  return GROUP_DEFS
    .map((def) => ({ key: def.key as string, label: def.label, codes: cards.filter((card) => card.groupKey === def.key).map((card) => card.code) }))
    .filter((group) => group.codes.length > 0);
}
