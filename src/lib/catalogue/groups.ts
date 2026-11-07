/**
 * Use-case groups for the catalogue contents page ("Далайн амралт", "Хот, соёл, худалдаа", ...).
 *
 * A trip's group comes from what the trip itself says, never from a destination written in code:
 *   1. the admin's override (tripId -> group key) always wins;
 *   2. the trip's metadata (name, destinations, aliases, category, season, region, transport type)
 *      names a theme. Themes are SCORED by the number of distinct theme words found, a word in the
 *      title / destinations / aliases weighing more than one in the other metadata; the single
 *      best score wins. A tie for first place is ambiguity, not an answer: no group is guessed;
 *   3. otherwise a COMPUTED price tier: clearly cheaper than the typical trip of this edition
 *      (at most 60% of the median starting price) -> "Хэмнэлттэй аялал";
 *   4. otherwise (and only when step 2 found NO theme word at all) its prose (website summary,
 *      program day titles, highlights) is scored the same way. Prose only hints: a clear winner
 *      groups the trip but raises an info 'category_unknown' ("автомат таамаглал") so staff
 *      confirm it; a tie in prose is treated as unknown;
 *   5. otherwise the explicit "Бусад" group with a 'category_unknown' warning (naming the tied
 *      themes when there was a tie). Never a guess.
 * Every trip is in exactly ONE group, so the renderer can lay pages out group by group.
 */
import type { TravelTrip } from "../travelTypes";
import type { CatalogueGroup, CatalogueWarning } from "./types";
import { row, rows, strList, text, warn } from "./diagnostics";

export type GroupKey = "beach" | "city" | "nature" | "budget" | "other";

/** Display order of the groups on the contents page. */
export const GROUP_DEFS: ReadonlyArray<{ key: GroupKey; label: string }> = [
  { key: "beach", label: "Далайн амралт" },
  { key: "city", label: "Хот, соёл, худалдаа" },
  { key: "nature", label: "Байгаль, адал явдал" },
  { key: "budget", label: "Хэмнэлттэй аялал" },
  { key: "other", label: "Бусад" },
];
const KEYS = new Set<string>(GROUP_DEFS.map((def) => def.key));

/** The share of the median starting price at or under which a trip is "budget-friendly". */
export const BUDGET_SHARE_OF_MEDIAN = 0.6;

// Theme words (stems), matched on lower-cased trip text. Words only: no place names.
const L = String.raw`(?<![\p{L}])`;
const THEMES: ReadonlyArray<{ key: Exclude<GroupKey, "budget" | "other">; pattern: RegExp }> = [
  { key: "beach", pattern: new RegExp(`далай|арлын|арлууд|${L}арал|эрэг(?!тэй)|beach|resort|рэсорт|ресорт|тропик|шумбал|snorkel|круиз|круз|cruise|усан онгоц|тэнгис`, "iu") },
  { key: "city", pattern: new RegExp(`шопинг|shopping|худалдаа|худалдан\\s+авалт|дэлгүүр|${L}mall|outlet|хотын\\s+(?:(?:\\d+(?:\\s*,\\s*\\d+)*\\s*-?\\s*р\\s+сарын|\\d+\\s*(?:шөнө|өдрийн|өдөр))\\s+)*аял|city\\s*tour|театр|музей|museum|цамхаг`, "iu") },
  { key: "nature", pattern: new RegExp(`байгаль|нуур|уул(?!з)|${L}ой(?!\\p{L})|адал\\s*явдал|adventure|${L}трек|${L}trek|хавцал|каньон|canyon|цана|${L}ski(?![\\p{L}])|рафтинг|ширэнгэ|нуга|${L}эко|${L}eco|үндэсний\\s+парк|national\\s+park|хөндий|тайга|цөл|desert|говь|геопарк`, "iu") },
];

type ThemeKey = Exclude<GroupKey, "budget" | "other">;
type ThemeScores = Record<ThemeKey, number>;

/** What one distinct theme word is worth, by where it was found. The title and destinations name the trip; prose only hints. */
const WEIGHT_TITLE = 3;
const WEIGHT_METADATA = 2;
const WEIGHT_PROSE = 1;

const emptyScores = (): ThemeScores => ({ beach: 0, city: 0, nature: 0 });

/** Adds `weight` per DISTINCT theme word found in `source` (the same word twice counts once). */
function addScores(scores: ThemeScores, source: string, weight: number): void {
  const haystack = source.toLowerCase();
  if (!haystack.trim()) return;
  for (const theme of THEMES) {
    const words = new Set<string>();
    for (const match of haystack.matchAll(new RegExp(theme.pattern.source, "giu"))) words.add(match[0].replace(/\s+/g, " "));
    scores[theme.key] += words.size * weight;
  }
}

type ThemeVerdict = { winner: ThemeKey | null; tied: ThemeKey[] };

/** The single best-scoring theme; a tie for first place has no winner (and names the tied themes). */
function verdictOf(scores: ThemeScores): ThemeVerdict {
  const top = Math.max(...Object.values(scores));
  if (top <= 0) return { winner: null, tied: [] };
  const leaders = (Object.keys(scores) as ThemeKey[]).filter((key) => scores[key] === top);
  return leaders.length === 1 ? { winner: leaders[0], tied: [] } : { winner: null, tied: leaders };
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

/** Prose that only hints at a theme; consulted last, and only ever a guess staff are asked to confirm. */
function proseScores(trip: TravelTrip): ThemeScores {
  const extra = row(trip.extra);
  const website = row(extra.website_details);
  const scores = emptyScores();
  addScores(scores, [
    text(extra.website_summary), text(website.summary), ...strList(website.highlights),
    ...rows(extra.itinerary_days).map((day) => text(day.title)),
  ].join(" | "), WEIGHT_PROSE);
  return scores;
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
    if (!key) {
      const meta = verdictOf(metadataScores(trip));
      key = meta.winner;
      tied = meta.tied;
    }
    if (!key && cutoff !== null && priceMnt !== null && priceMnt > 0 && priceMnt <= cutoff) key = "budget";
    // Prose is consulted only when the metadata named nothing at all (a tie in the metadata is
    // ambiguity, not silence: prose does not get to break it). A prose-only decision is a guess:
    // the trip is grouped by it, but staff are told so they can confirm or override.
    if (!key && !tied.length) {
      const prose = verdictOf(proseScores(trip));
      if (prose.winner) {
        key = prose.winner;
        warnings.push(warn("category_unknown", "info",
          `Ангилал зөвхөн тайлбар текстээс таамаглагдсан (автомат таамаглал: «${THEME_LABEL(prose.winner)}»). Админаас бүлгийг баталгаажуулна уу.`, trip.id, { guess: prose.winner }));
      } else tied = prose.tied;
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
