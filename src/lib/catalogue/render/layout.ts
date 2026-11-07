/**
 * Pure layout decisions for the catalogue: page order (cover, chapter guide, chapter openers, trip
 * pages, schedule appendix, index appendix, closing), type sizes, price wording, and which composition
 * each trip page gets. No DOM, no clock, no I/O, so the page plan (and therefore every page number
 * printed in the guide, the appendices and the trip pages) is identical in the HTML builder, the
 * tests and the admin.
 */
import type { CatalogueSnapshot, CatalogueTripCard } from "../types";
import { scheduleLines, type MonthLine } from "./dates";
import type { TripComposition } from "./renderTypes";
import { displayTitle } from "./titleCase";

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

// --- navigation guide, schedule appendix, index ---------------------------------------------------

export const GUIDE_ANCHOR = "contents";
export const SCHEDULE_ANCHOR = "schedule";
export const INDEX_ANCHOR = "index";

/** Letters and digits only, so a trip's schedule block is always a safe HTML id / anchor. */
export function scheduleBlockId(code: string): string {
  return `sched-${code.replace(/[^A-Za-z0-9]/g, "") || "x"}`;
}

export type GuideName = { code: string; title: string; page: number };
export type GuideEntry = {
  chapter: number;
  label: string;
  count: number;
  /** First page of the chapter (opener when it has one, else its first trip). */
  page: number;
  /** Page of the opener, or null. */
  openerPage: number | null;
  /** A few destination names, each linking to its own page. */
  names: GuideName[];
  /** Destinations in the chapter not named above. */
  more: number;
  /** Trip codes of the chapter in book order (the photo for the entry is chosen among them). */
  codes: string[];
};

const GUIDE_ROW_MIN_PT = 72;
const GUIDE_ROW_MAX_PT = 104;
const GUIDE_ROW_MULTI_PT = 84;
const GUIDE_FIRST_BUDGET_PT = 690;
const GUIDE_NEXT_BUDGET_PT = 800;

/** How many chapter blocks go on each guide page and how tall a block is: one page whenever it can be. */
export function planGuide(chapterCount: number): { perPage: number[]; rowHeightPt: number } {
  if (chapterCount <= 0) return { perPage: [0], rowHeightPt: GUIDE_ROW_MAX_PT };
  const single = Math.floor(GUIDE_FIRST_BUDGET_PT / GUIDE_ROW_MIN_PT);
  if (chapterCount <= single) {
    return { perPage: [chapterCount], rowHeightPt: Math.min(GUIDE_ROW_MAX_PT, Math.floor(GUIDE_FIRST_BUDGET_PT / chapterCount)) };
  }
  const cap1 = Math.floor(GUIDE_FIRST_BUDGET_PT / GUIDE_ROW_MULTI_PT);
  const capN = Math.floor(GUIDE_NEXT_BUDGET_PT / GUIDE_ROW_MULTI_PT);
  let pages = 2;
  while (cap1 + (pages - 1) * capN < chapterCount) pages += 1;
  const first = Math.min(cap1, Math.ceil(chapterCount / pages));
  const perPage = [first];
  let left = chapterCount - first;
  for (let p = 1; p < pages; p++) {
    const take = Math.ceil(left / (pages - p));
    perPage.push(take);
    left -= take;
  }
  return { perPage, rowHeightPt: GUIDE_ROW_MULTI_PT };
}

/** Destination names that fit the chapter block (two lines when the block is tall and the heading short). */
export function guideNames(trips: OrderedTrip[], rowHeightPt: number, label: string): { names: GuideName[]; more: number } {
  const lines = rowHeightPt >= GUIDE_ROW_MIN_PT && [...label].length <= 24 ? 2 : 1;
  const maxChars = lines === 2 ? 108 : 54;
  const names: GuideName[] = [];
  let used = 0;
  for (const t of trips) {
    const title = displayTitle(cardTitle(t.card));
    const next = used + (names.length ? 3 : 0) + [...title].length;
    if (names.length > 0 && (next > maxChars || names.length >= 6)) break;
    names.push({ code: t.card.code, title, page: t.page });
    used = next;
  }
  return { names, more: trips.length - names.length };
}

export type SchedBlock = {
  trip: OrderedTrip;
  lines: MonthLine[];
  priceVaries: boolean;
  heightPt: number;
  /** Page the block is printed on (set once the appendix is paginated). */
  page: number;
};
export type SchedPage = { columns: [SchedBlock[], SchedBlock[]] };

const SCHED_LINE_PT = 12.5;
const SCHED_LINE_CHARS = 36;
const SCHED_HEAD_CHARS = 26;
const SCHED_HEAD_LINE_PT = 13.5;
const SCHED_FIRST_BUDGET_PT = 700;
const SCHED_NEXT_BUDGET_PT = 770;

/** Rough printed height of one schedule block (header + month lines + gap), used only for pagination. */
export function scheduleBlockHeightPt(title: string, lines: MonthLine[]): number {
  const head = Math.max(1, Math.ceil([...title].length / SCHED_HEAD_CHARS));
  const body = lines.reduce((sum, l) => sum + Math.max(1, Math.ceil([...l.text].length / SCHED_LINE_CHARS)), 0);
  return 8 + head * SCHED_HEAD_LINE_PT + 4 + body * SCHED_LINE_PT + 10;
}

/** Natural order of trip codes: A02 before A10, A99 before B01. */
export function compareCodes(a: string, b: string): number {
  return a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
}

function paginateSchedule(blocks: SchedBlock[]): SchedPage[] {
  const pages: SchedPage[] = [];
  let page: SchedPage = { columns: [[], []] };
  let col = 0;
  let used = 0;
  let budget = SCHED_FIRST_BUDGET_PT;
  for (const block of blocks) {
    if (used > 0 && used + block.heightPt > budget) {
      if (col === 0) {
        col = 1;
      } else {
        pages.push(page);
        page = { columns: [[], []] };
        col = 0;
        budget = SCHED_NEXT_BUDGET_PT;
      }
      used = 0;
    }
    page.columns[col]!.push(block);
    used += block.heightPt;
  }
  if (page.columns[0].length || page.columns[1].length) pages.push(page);
  // A last page whose second column is empty reads better balanced: move the tail of column one across.
  const last = pages[pages.length - 1];
  if (last && last.columns[1].length === 0 && last.columns[0].length > 1) {
    const total = last.columns[0].reduce((s, b) => s + b.heightPt, 0);
    let acc = 0;
    let cut = last.columns[0].length;
    for (let i = 0; i < last.columns[0].length; i++) {
      acc += last.columns[0][i]!.heightPt;
      if (acc >= total / 2) {
        cut = i + 1;
        break;
      }
    }
    if (cut < last.columns[0].length) last.columns[1] = last.columns[0].splice(cut);
  }
  return pages;
}

const INDEX_ROW_PT = 21;
const INDEX_EXTRA_LINE_PT = 14;
const INDEX_TITLE_CHARS = 44;
const INDEX_FIRST_BUDGET_PT = 650;
const INDEX_NEXT_BUDGET_PT = 790;

export function indexRowHeightPt(card: CatalogueTripCard): number {
  return INDEX_ROW_PT + (estimateLines(displayTitle(cardTitle(card)), INDEX_TITLE_CHARS) - 1) * INDEX_EXTRA_LINE_PT;
}

function paginateIndex(rows: OrderedTrip[]): OrderedTrip[][] {
  const pages: OrderedTrip[][] = [[]];
  let used = 0;
  let budget = INDEX_FIRST_BUDGET_PT;
  for (const row of rows) {
    const h = indexRowHeightPt(row.card);
    if (used > 0 && used + h > budget) {
      pages.push([]);
      used = 0;
      budget = INDEX_NEXT_BUDGET_PT;
    }
    pages[pages.length - 1]!.push(row);
    used += h;
  }
  return pages;
}

/** Chapter openers: always in the complete book, in the others when there are at least two chapters. */
export function wantsOpeners(snapshot: CatalogueSnapshot, chapterCount: number): boolean {
  if (chapterCount < 1) return false;
  // An opener needs a photo no trip page already shows. Without a vetted secondary photo it would repeat a
  // hero one page later, which reads as a mistake, so the book simply has no openers then.
  if (!snapshot.trips.some(trip => trip.gallery.length > 0)) return false;
  return snapshot.edition === "complete" ? true : chapterCount >= 2;
}

export type PagePlan = {
  /** Guide (chapter navigation) pages in order; each is the list of chapter blocks printed on it. */
  guidePages: GuideEntry[][];
  guideRowHeightPt: number;
  chapters: ChapterPlan[];
  /** True when every chapter opens with a full-bleed photo page. */
  hasOpeners: boolean;
  trips: OrderedTrip[];
  coverPage: 1;
  /** First guide page; the "contents" destination every back link goes to. */
  firstGuidePage: number;
  firstTripPage: number;
  /** Schedule appendix: pages in order (empty when no trip has a future departure). */
  schedulePages: SchedPage[];
  firstSchedulePage: number | null;
  /** Page of each trip's schedule block, by code. */
  schedulePageByCode: Record<string, number>;
  /** Index appendix: rows in code order, paginated. */
  indexPages: OrderedTrip[][];
  firstIndexPage: number | null;
  closingPage: number;
  totalPages: number;
};

export function planPages(snapshot: CatalogueSnapshot): PagePlan {
  const ordered = orderTrips(snapshot);
  const chapterOfLabel: string[] = [];
  const withChapter = ordered.map(o => {
    if (chapterOfLabel[chapterOfLabel.length - 1] !== o.groupLabel) chapterOfLabel.push(o.groupLabel);
    return { ...o, chapter: chapterOfLabel.length - 1 };
  });
  const hasOpeners = wantsOpeners(snapshot, chapterOfLabel.length);
  const guide = planGuide(chapterOfLabel.length);

  const firstGuidePage = 2;
  const firstTripPage = firstGuidePage + guide.perPage.length;
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

  const entries: GuideEntry[] = chapters.map(c => {
    const { names, more } = guideNames(c.trips, guide.rowHeightPt, c.label);
    return { chapter: c.index, label: c.label, count: c.trips.length, page: c.firstPage, openerPage: c.openerPage, names, more, codes: c.trips.map(t => t.card.code) };
  });
  const guidePages: GuideEntry[][] = [];
  let at = 0;
  for (const n of guide.perPage) {
    guidePages.push(entries.slice(at, at + n));
    at += n;
  }

  // Schedule appendix: every trip with a future departure, code order, two columns per page.
  const byCode = [...trips].sort((a, b) => compareCodes(a.card.code, b.card.code));
  const blocks: SchedBlock[] = [];
  for (const t of byCode) {
    const { lines, priceVaries } = scheduleLines(t.card, snapshot.asOfDay);
    if (lines.length === 0) continue;
    blocks.push({ trip: t, lines, priceVaries, heightPt: scheduleBlockHeightPt(displayTitle(cardTitle(t.card)), lines), page: 0 });
  }
  const schedulePages = paginateSchedule(blocks);
  const firstSchedulePage = schedulePages.length ? page : null;
  const schedulePageByCode: Record<string, number> = {};
  schedulePages.forEach((sp, i) => {
    for (const block of sp.columns.flat()) {
      block.page = page + i;
      schedulePageByCode[block.trip.card.code] = block.page;
    }
  });
  page += schedulePages.length;

  const indexPages = trips.length ? paginateIndex(byCode) : [];
  const firstIndexPage = indexPages.length ? page : null;
  page += indexPages.length;

  const closingPage = page;
  return {
    guidePages,
    guideRowHeightPt: guide.rowHeightPt,
    chapters,
    hasOpeners,
    trips,
    coverPage: 1,
    firstGuidePage,
    firstTripPage,
    schedulePages,
    firstSchedulePage,
    schedulePageByCode,
    indexPages,
    firstIndexPage,
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
