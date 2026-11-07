/**
 * Pure layout decisions for the catalogue: page order (cover, contents, chapter openers, trip
 * pages, closing), contents pagination, type sizes, date and price wording, and which composition
 * each trip page gets. No DOM, no clock, no I/O, so the page plan (and therefore every page number
 * printed in the contents) is identical in the HTML builder, the tests and the admin.
 */
import type { CatalogueSnapshot, CatalogueTripCard } from "../types";
import type { TripComposition } from "./renderTypes";

export const PAGE_WIDTH_PT = 540;
export const PAGE_HEIGHT_PT = 960;

/** Group label used for trips that no group lists (never dropped from the book). */
export const UNGROUPED_LABEL = "Бусад аялал";

export type OrderedTrip = {
  card: CatalogueTripCard;
  groupLabel: string;
  /** 0-based chapter (group) the trip sits in. */
  chapter: number;
  /** 0-based position in the whole book (drives the composition rhythm). */
  index: number;
  /** 1-based page number of the trip's own page. */
  page: number;
};

export type ChapterPlan = {
  index: number;
  label: string;
  /** Page of the full-bleed opener, or null when this book has no openers. */
  openerPage: number | null;
  /** First page of the chapter (opener when present, else its first trip). */
  firstPage: number;
  trips: OrderedTrip[];
};

export type ContentsItem =
  | { kind: "group"; label: string; continued: boolean; chapter: number; page: number }
  | { kind: "row"; trip: OrderedTrip };

export type PagePlan = {
  /** Contents pages in order; each is the list of items printed on it. */
  contentsPages: ContentsItem[][];
  /** Row density the contents pages are set in (see ContentsDensity). */
  contentsDensity: ContentsDensity;
  chapters: ChapterPlan[];
  /** True when every chapter opens with a full-bleed photo page. */
  hasOpeners: boolean;
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

export function chapterAnchorId(index: number): string {
  return `chapter-${index + 1}`;
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

// --- copy shaping (display only, facts never change) -----------------------------------------

/** The editorial title when the data layer wrote one, else the canonical title. Casing is fixed by displayTitle. */
export function cardTitle(card: CatalogueTripCard): string {
  const editorial = (card.editorialTitle ?? "").trim();
  return editorial || card.title;
}

/**
 * Highlight as printed: staff text that runs on is cut at its first natural break (a semicolon, a
 * dash, or a comma) when it is long, and a trailing parenthesis is dropped from a long line.
 * Nothing is paraphrased; a line with no natural break is kept whole and simply wraps.
 */
export function clipHighlight(text: string, max = 60): string {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const noParen = s.replace(/\s*\([^)]*\)\s*$/u, "").trim();
  if (noParen.length >= 8 && noParen.length <= max) return noParen;
  const parts = s.split(/\s*[;]\s*|\s+[-–—]\s+|,\s+/u);
  let acc = "";
  for (const part of parts) {
    const next = acc ? `${acc}, ${part}` : part;
    if (next.length > max) break;
    acc = next;
  }
  if (acc.length >= 12) return acc;
  return s;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "Ойрын огноо: 11.14 · 11.28 · 12.12 + 1": the first three offered departures as month.day (the
 * year only where it differs from the issue year or from the date before), then how many more are
 * offered. With no departure list `plain` carries the data layer's own wording unchanged
 * ("Явах огноог лавлана"). The dates themselves are never altered or invented.
 */
export function departureLine(card: CatalogueTripCard, asOfDay: string): { dates: string[]; more: number; plain: string } {
  const plain = card.dates.label.trim() || "Явах огноог лавлана";
  const days = (card.dates.departures ?? []).filter(d => ISO_DAY.test(d));
  if (days.length === 0) return { dates: [], more: 0, plain };
  let year = asOfDay.slice(0, 4);
  const dates = days.slice(0, 3).map(d => {
    const m = ISO_DAY.exec(d)!;
    const text = m[1] === year ? `${m[2]}.${m[3]}` : `${m[1]}.${m[2]}.${m[3]}`;
    year = m[1]!;
    return text;
  });
  const fromLabel = /өөр\s+(\d+)\s+огноо/u.exec(card.dates.label);
  const more = Math.max(days.length - dates.length, fromLabel ? Number(fromLabel[1]) : 0);
  return { dates, more, plain };
}

/** "3,980,000₮-с" -> { amount: "3,980,000₮", suffix: "-с" }; anything else stays whole. */
export function priceParts(display: string): { amount: string; suffix: string } {
  const m = /^([\s\S]*?₮)([\s\S]*)$/.exec(display.trim());
  return m ? { amount: m[1]!, suffix: m[2]! } : { amount: display, suffix: "" };
}

// --- type sizing -------------------------------------------------------------------------

/**
 * Display headline size from title length. Chosen so a title wraps to at most about three lines;
 * the in-browser fit pass tightens it further when the real glyphs need it.
 */
export function headlineSizePt(title: string): number {
  const n = [...title.trim()].length;
  if (n <= 14) return 50;
  if (n <= 24) return 44;
  if (n <= 36) return 38;
  if (n <= 52) return 32;
  if (n <= 80) return 27;
  return 22;
}

/** Smallest the fit pass may take a headline to. Never below this: no microtype. */
export const HEADLINE_MIN_PT = 20;

/** Rough number of lines `text` takes at `charsPerLine`; used only for pagination budgets. */
export function estimateLines(text: string, charsPerLine: number): number {
  const n = [...text.trim()].length;
  return Math.max(1, Math.ceil(n / Math.max(8, charsPerLine)));
}

// --- compositions ------------------------------------------------------------------------

/** What a trip's photos make possible. The art stage fills this from real pixels. */
export type CompositionFit = {
  hasHero: boolean;
  cinema: boolean;
  plate: boolean;
  panorama: boolean;
  diptych: boolean;
};

const ROTATION: readonly Exclude<TripComposition, "type">[] = ["cinema", "plate", "panorama", "diptych"];

/**
 * One composition per trip, in book order. The rotation gives the book its rhythm (a full-bleed
 * page, then an ivory plate, a wide band, a diptych ...); each trip takes the first composition its
 * photos allow starting from its own slot, and never repeats its neighbour when another fits.
 * A trip with no usable photo gets the typographic page. Deterministic: same photos, same book.
 */
export function assignCompositions(fits: CompositionFit[]): TripComposition[] {
  const out: TripComposition[] = [];
  let previous: TripComposition | null = null;
  const lastUsed = new Map<string, number>();
  fits.forEach((fit, i) => {
    if (!fit.hasHero) {
      out.push("type");
      previous = "type";
      return;
    }
    // Rotation order from this trip's own slot; among what the photos allow, the composition that
    // has been absent the longest wins (ties keep the rotation order), so no composition hogs the book.
    const order = ROTATION.map((_, k) => ROTATION[(i + k) % ROTATION.length]!);
    const allowed = order.filter(c => fit[c]);
    const fresh = allowed.filter(c => c !== previous);
    const pool = fresh.length ? fresh : allowed;
    let pick: TripComposition = "plate";
    let oldest = Infinity;
    for (const c of pool) {
      const used = lastUsed.get(c) ?? -1;
      if (used < oldest) {
        oldest = used;
        pick = c;
      }
    }
    out.push(pick);
    lastUsed.set(pick, i);
    previous = pick;
  });
  return out;
}

// --- contents pagination ------------------------------------------------------------------

/**
 * Row density of the contents list. The least dense tier that still gives the fewest contents
 * pages is used, so a short list stays airy and a long one is packed instead of spilling a single
 * row onto an extra page. Heights are the CSS heights of `.crow` / `.cgroup` in theme.ts.
 */
export type ContentsDensity = "comfortable" | "compact" | "tight";
const DENSITIES: readonly ContentsDensity[] = ["comfortable", "compact", "tight"];
const DENSITY_PT: Record<ContentsDensity, { row: number; header: number }> = {
  comfortable: { row: 84, header: 84 },
  compact: { row: 70, header: 70 },
  tight: { row: 60, header: 60 },
};

const CONTENTS_FIRST_PAGE_BUDGET_PT = 660;
const CONTENTS_NEXT_PAGE_BUDGET_PT = 790;
const ROW_EXTRA_LINE_PT = 19;
const ROW_TITLE_CHARS_PER_LINE = 27;

/** The small line under a destination in the guide: "<region> · <duration> · <transport>" (transport only while it fits). */
export function contentsRowLine(card: CatalogueTripCard): string {
  const same = (a: string, b: string) => a.trim().toLocaleLowerCase("mn") === b.trim().toLocaleLowerCase("mn");
  const kicker = same(card.kicker, cardTitle(card)) ? "" : card.kicker.trim();
  const duration = card.durationText.trim();
  const transport = card.transportLabel.trim();
  let line = [kicker, duration].filter(Boolean).join(" · ");
  if (transport && line.length + transport.length + 3 <= 46) line = [line, transport].filter(Boolean).join(" · ");
  return line || transport;
}

const ROW_LINE_CHARS_PER_LINE = 40;
const ROW_SMALL_LINE_PT = 16;

export function contentsRowHeightPt(card: CatalogueTripCard, density: ContentsDensity = "comfortable"): number {
  const lines = Math.min(3, estimateLines(cardTitle(card), ROW_TITLE_CHARS_PER_LINE));
  const small = Math.min(3, estimateLines(contentsRowLine(card), ROW_LINE_CHARS_PER_LINE));
  return DENSITY_PT[density].row + (lines - 1) * ROW_EXTRA_LINE_PT + (small - 1) * ROW_SMALL_LINE_PT;
}

type OrderedForContents = { card: CatalogueTripCard; groupLabel: string; chapter: number }[];

/** Greedy fill: a group header never sits alone at the foot of a page, it moves with its first row. */
function fillContents(ordered: OrderedForContents, density: ContentsDensity, firstBudget: number, nextBudget: number): ContentsItem[][] {
  const headerH = DENSITY_PT[density].header;
  const pages: ContentsItem[][] = [[]];
  let used = 0;
  let budget = firstBudget;
  let lastChapter = -1;

  for (const { card, groupLabel, chapter } of ordered) {
    const rowH = contentsRowHeightPt(card, density);
    let needsHeader = chapter !== lastChapter;
    if (used + rowH + (needsHeader ? headerH : 0) > budget && used > 0) {
      pages.push([]);
      used = 0;
      budget = nextBudget;
      needsHeader = true; // a group split by a page break is announced again on the new page
    }
    const page = pages[pages.length - 1]!;
    if (needsHeader) {
      page.push({ kind: "group", label: groupLabel, continued: chapter === lastChapter, chapter, page: 0 });
      used += headerH;
    }
    // trip.page is filled once the page counts are known (planPages).
    page.push({ kind: "row", trip: { card, groupLabel, chapter, index: 0, page: 0 } });
    used += rowH;
    lastChapter = chapter;
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

/** Chapter openers: always in the complete book, in the others when there are at least two chapters. */
export function wantsOpeners(snapshot: CatalogueSnapshot, chapterCount: number): boolean {
  if (chapterCount < 1) return false;
  // An opener needs a photo no trip page already shows. Without a vetted secondary photo it would repeat a
  // hero one page later, which reads as a mistake, so the book simply has no openers then.
  if (!snapshot.trips.some(trip => trip.gallery.length > 0)) return false;
  return snapshot.edition === "complete" ? true : chapterCount >= 2;
}

export function planPages(snapshot: CatalogueSnapshot): PagePlan {
  const ordered = orderTrips(snapshot);
  const chapterOfLabel: string[] = [];
  const withChapter: OrderedForContents = ordered.map(o => {
    if (chapterOfLabel[chapterOfLabel.length - 1] !== o.groupLabel) chapterOfLabel.push(o.groupLabel);
    return { ...o, chapter: chapterOfLabel.length - 1 };
  });
  const { pages: contentsPages, density: contentsDensity } = paginateContents(withChapter);
  const hasOpeners = wantsOpeners(snapshot, chapterOfLabel.length);

  const firstContentsPage = 2;
  const firstTripPage = firstContentsPage + contentsPages.length;
  let page = firstTripPage;
  const complete = snapshot.edition === "complete";
  const trips: OrderedTrip[] = [];
  const chapters: ChapterPlan[] = chapterOfLabel.map((label, index) => ({ index, label, openerPage: null, firstPage: 0, trips: [] }));
  withChapter.forEach((o, i) => {
    const chapter = chapters[o.chapter]!;
    if (chapter.trips.length === 0) {
      chapter.firstPage = page;
      const count = withChapter.filter(w => w.chapter === o.chapter).length;
      if (hasOpeners && (complete || count >= 2)) {
        chapter.openerPage = page;
        page += 1;
      }
    }
    const trip: OrderedTrip = { card: o.card, groupLabel: o.groupLabel, chapter: o.chapter, index: i, page };
    page += 1;
    trips.push(trip);
    chapter.trips.push(trip);
  });

  // Re-point the contents at the final page numbers.
  const byCode = new Map(trips.map(t => [t.card.code, t] as const));
  for (const items of contentsPages) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (item.kind === "row") items[i] = { kind: "row", trip: byCode.get(item.trip.card.code) ?? item.trip };
      else items[i] = { ...item, page: chapters[item.chapter]?.firstPage ?? 0 };
    }
  }
  const closingPage = page;
  return {
    contentsPages,
    contentsDensity,
    chapters,
    hasOpeners,
    trips,
    coverPage: 1,
    firstContentsPage,
    firstTripPage,
    closingPage,
    totalPages: closingPage,
  };
}

// --- fixed wording -------------------------------------------------------------------------

export const GROUP_PRICE_NOTE = "Бүлгийн үнийг ажилтнаас лавлана";
export const PRICE_LABEL = "Эхлэх үнэ / нэг том хүн";
export const DISCLAIMER = "Эцсийн үнэ, суудал, огноо, нөхцөлийг ажилтан баталгаажуулна.";

/** The plain date wording for a trip card; never invented, neutral wording when the data has none. */
export function departureLabel(card: CatalogueTripCard): string {
  const label = card.dates.label.trim();
  return label || "Явах огноог лавлана";
}
