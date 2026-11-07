/**
 * Pure layout decisions for the catalogue: page order, contents pagination, type sizes, date labels.
 * No DOM, no clock, no I/O, so the page plan (and therefore every page number printed in the
 * contents) is identical in the HTML builder, the tests and the admin.
 */
import type { CatalogueSnapshot, CatalogueTripCard } from "../types";

export const PAGE_WIDTH_PT = 540;
export const PAGE_HEIGHT_PT = 960;

/** Group label used for trips that no group lists (never dropped from the book). */
export const UNGROUPED_LABEL = "Бусад аялал";

export type OrderedTrip = {
  card: CatalogueTripCard;
  groupLabel: string;
  /** 1-based page number of the trip's own page. */
  page: number;
};

export type ContentsItem =
  | { kind: "group"; label: string; continued: boolean }
  | { kind: "row"; trip: OrderedTrip };

export type PagePlan = {
  /** Contents pages in order; each is the list of items printed on it. */
  contentsPages: ContentsItem[][];
  /** Row density the contents pages are set in (see ContentsDensity). */
  contentsDensity: ContentsDensity;
  trips: OrderedTrip[];
  coverPage: 1;
  firstContentsPage: number;
  firstTripPage: number;
  closingPage: number;
  totalPages: number;
};

/** "2026-11-06" -> "2026.11.06" (anything else passes through untouched). */
export function dotDay(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : iso;
}

/**
 * "2026-11-06T06:03:00.000Z" -> "2026.11.06 14:03" in Asia/Ulaanbaatar (UTC+8, no daylight saving).
 * Returns the raw input when it is not a parseable timestamp.
 */
export function ulaanbaatarStamp(isoTimestamp: string): string {
  const ms = Date.parse(isoTimestamp);
  if (!Number.isFinite(ms)) return isoTimestamp;
  const d = new Date(ms + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** Two-digit page counter: 7 -> "07". */
export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Letters and digits only, so a code is always a safe HTML id / anchor. */
export function anchorId(code: string): string {
  return `trip-${code.replace(/[^A-Za-z0-9]/g, "") || "x"}`;
}

/**
 * Trips in book order: group by group (the order the snapshot lists them), codes in each group's
 * order. Trips no group lists follow in snapshot order. A code listed twice prints once.
 */
export function orderTrips(snapshot: CatalogueSnapshot): { card: CatalogueTripCard; groupLabel: string }[] {
  const byCode = new Map<string, CatalogueTripCard>();
  for (const card of snapshot.trips) if (!byCode.has(card.code)) byCode.set(card.code, card);
  const placed = new Set<string>();
  const out: { card: CatalogueTripCard; groupLabel: string }[] = [];
  for (const group of snapshot.groups) {
    for (const code of group.codes) {
      const card = byCode.get(code);
      if (!card || placed.has(code)) continue;
      placed.add(code);
      out.push({ card, groupLabel: group.label });
    }
  }
  for (const card of snapshot.trips) {
    if (placed.has(card.code)) continue;
    placed.add(card.code);
    out.push({ card, groupLabel: UNGROUPED_LABEL });
  }
  return out;
}

// --- type sizing -------------------------------------------------------------------------

/**
 * Headline size from title length. Chosen so a title wraps to at most about three lines inside the
 * 472pt text column; the in-browser fit pass tightens it further when the real glyphs need it.
 */
export function headlineSizePt(title: string): number {
  const n = [...title.trim()].length;
  if (n <= 16) return 42;
  if (n <= 26) return 36;
  if (n <= 38) return 31;
  if (n <= 54) return 27;
  if (n <= 80) return 23;
  return 20;
}

/** Smallest the fit pass may take a headline to. Never below this: no microtype. */
export const HEADLINE_MIN_PT = 18;

/** Rough number of lines `text` takes at `charsPerLine`; used only for pagination budgets. */
export function estimateLines(text: string, charsPerLine: number): number {
  const n = [...text.trim()].length;
  return Math.max(1, Math.ceil(n / Math.max(8, charsPerLine)));
}

// --- contents pagination ------------------------------------------------------------------

/**
 * Row density of the contents list. The least dense tier that still gives the fewest contents
 * pages is used, so a short list stays airy and a long one is packed instead of spilling a single
 * row onto an extra page. Heights are the CSS min-heights of `.crow` / `.cgroup` in theme.ts.
 */
export type ContentsDensity = "comfortable" | "compact" | "tight";
const DENSITIES: readonly ContentsDensity[] = ["comfortable", "compact", "tight"];
const DENSITY_PT: Record<ContentsDensity, { row: number; header: number }> = {
  comfortable: { row: 50, header: 46 },
  compact: { row: 41, header: 36 },
  tight: { row: 38, header: 30 },
};

const CONTENTS_FIRST_PAGE_BUDGET_PT = 712;
const CONTENTS_NEXT_PAGE_BUDGET_PT = 768;
const ROW_EXTRA_LINE_PT = 17;
const ROW_TITLE_CHARS_PER_LINE = 33;

export function contentsRowHeightPt(card: CatalogueTripCard, density: ContentsDensity = "comfortable"): number {
  const lines = Math.min(4, estimateLines(card.title, ROW_TITLE_CHARS_PER_LINE));
  return DENSITY_PT[density].row + (lines - 1) * ROW_EXTRA_LINE_PT;
}

type OrderedForContents = { card: CatalogueTripCard; groupLabel: string }[];

/** Greedy fill: a group header never sits alone at the foot of a page, it moves with its first row. */
function fillContents(ordered: OrderedForContents, density: ContentsDensity, firstBudget: number, nextBudget: number): ContentsItem[][] {
  const headerH = DENSITY_PT[density].header;
  const pages: ContentsItem[][] = [[]];
  let used = 0;
  let budget = firstBudget;
  let lastGroup: string | null = null;

  for (const { card, groupLabel } of ordered) {
    const rowH = contentsRowHeightPt(card, density);
    let needsHeader = groupLabel !== lastGroup;
    if (used + rowH + (needsHeader ? headerH : 0) > budget && used > 0) {
      pages.push([]);
      used = 0;
      budget = nextBudget;
      needsHeader = true; // a group split by a page break is announced again on the new page
    }
    const page = pages[pages.length - 1]!;
    if (needsHeader) {
      page.push({ kind: "group", label: groupLabel, continued: groupLabel === lastGroup });
      used += headerH;
    }
    // trip.page is filled once the page counts are known (planPages).
    page.push({ kind: "row", trip: { card, groupLabel, page: 0 } });
    used += rowH;
    lastGroup = groupLabel;
  }
  return pages;
}

/**
 * 1. density: the least dense tier whose page count equals the densest tier's (the minimum);
 * 2. balance: with that page count fixed, the smallest page budget that still fits, so no page is
 *    packed to the brim while another carries one orphan row or header.
 */
function paginateContents(ordered: OrderedForContents): { pages: ContentsItem[][]; density: ContentsDensity } {
  const delta = CONTENTS_NEXT_PAGE_BUDGET_PT - CONTENTS_FIRST_PAGE_BUDGET_PT;
  const fill = (d: ContentsDensity, next: number) => fillContents(ordered, d, next - delta, next);
  const fewest = fill("tight", CONTENTS_NEXT_PAGE_BUDGET_PT).length;
  const density = DENSITIES.find(d => fill(d, CONTENTS_NEXT_PAGE_BUDGET_PT).length === fewest) ?? "tight";
  if (fewest === 1) return { pages: fill(density, CONTENTS_NEXT_PAGE_BUDGET_PT), density };
  let lo = 0;
  let hi = CONTENTS_NEXT_PAGE_BUDGET_PT;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fill(density, mid).length <= fewest) hi = mid;
    else lo = mid + 1;
  }
  return { pages: fill(density, hi), density };
}

export function planPages(snapshot: CatalogueSnapshot): PagePlan {
  const ordered = orderTrips(snapshot);
  const { pages: contentsPages, density: contentsDensity } = paginateContents(ordered);
  const firstContentsPage = 2;
  const firstTripPage = firstContentsPage + contentsPages.length;
  const trips: OrderedTrip[] = ordered.map((o, i) => ({ ...o, page: firstTripPage + i }));
  // Re-point the contents rows at the final page numbers.
  const byCode = new Map(trips.map(t => [t.card.code, t] as const));
  for (const items of contentsPages) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind === "row") items[i] = { kind: "row", trip: byCode.get(item.trip.card.code) ?? item.trip };
    }
  }
  const closingPage = firstTripPage + trips.length;
  return {
    contentsPages,
    contentsDensity,
    trips,
    coverPage: 1,
    firstContentsPage,
    firstTripPage,
    closingPage,
    totalPages: closingPage,
  };
}

// --- price text ---------------------------------------------------------------------------

export const GROUP_PRICE_NOTE = "Бүлгийн үнийг ажилтнаас лавлана";
export const PRICE_LABEL = "Эхлэх үнэ / нэг том хүн";
export const DISCLAIMER = "Эцсийн үнэ, суудал, огноо, нөхцөлийг ажилтан баталгаажуулна.";

/** The date line for a trip card; never invented, neutral wording when the data has none. */
export function departureLabel(card: CatalogueTripCard): string {
  const label = card.dates.label.trim();
  return label || "Явах огноог лавлана";
}
