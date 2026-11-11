/**
 * Pure layout decisions for the catalogue: page order (cover, then one section per transport
 * category - its list page(s) followed by its trip pages - and the closing page), type sizes, price
 * wording, and which composition each trip page gets. No DOM, no clock, no I/O, so the page plan
 * (and therefore every page number printed in the lists and on the trip pages) is identical in the
 * HTML builder, the tests and the admin.
 */
import type { CatalogueSnapshot, CatalogueTripCard } from "../types";
import type { TripComposition } from "./renderTypes";
import { displayTitle } from "./titleCase";
import { transportKindOf, type TransportKind } from "./transport";

export const PAGE_WIDTH_PT = 540;
export const PAGE_HEIGHT_PT = 675;

/** Section for trips whose transport is not known (never guessed, never dropped from the book). */
export const UNGROUPED_LABEL = "Бусад аялал";

/**
 * The book's sections, in reading order: how the group travels. A trip goes to the section of its
 * printed transport label; a trip without one goes to «Бусад аялал».
 */
export const TRANSPORT_CHAPTERS: ReadonlyArray<{ kind: TransportKind; label: string; line: string }> = [
  { kind: "direct", label: "Шууд нислэгтэй аялал", line: "Улаанбаатараас шууд нислэгээр" },
  { kind: "combo", label: "Газар + нислэг хосолсон аялал", line: "Газрын болон агаарын замыг хослуулсан" },
  { kind: "ground", label: "Газрын аялал", line: "Газрын замаар зорчих аялал" },
  { kind: "cruise", label: "Усан онгоцны аялал", line: "Усан онгоцоор аялах" },
  { kind: "none", label: UNGROUPED_LABEL, line: "" },
];

export type OrderedTrip = {
  card: CatalogueTripCard;
  groupLabel: string;
  /** 0-based chapter (section) the trip sits in. */
  chapter: number;
  /** 0-based position in the whole book (drives the composition rhythm). */
  index: number;
  /** 1-based page number of the trip's own page. */
  page: number;
};

/** How densely a section page lists its trips. */
export type SectionDensity = "large" | "roomy" | "compact";

export type ChapterPlan = {
  index: number;
  kind: TransportKind;
  label: string;
  /** One neutral line under the section title (may be empty). */
  line: string;
  /** Page of the section's (first) list page: the chapter's first page. */
  sectionPage: number;
  /** Trips printed on each list page, in order; continuation pages follow the first. */
  listPages: OrderedTrip[][];
  density: SectionDensity;
  /** First page of the chapter (= sectionPage). */
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
 * Trips in book order: section by section (TRANSPORT_CHAPTERS order); inside a section, the theme
 * groups' order (similar destinations stay together), then snapshot order. A code listed twice prints once.
 */
export function orderTrips(snapshot: CatalogueSnapshot): { card: CatalogueTripCard; groupLabel: string }[] {
  const byCode = new Map<string, CatalogueTripCard>();
  for (const card of snapshot.trips) if (!byCode.has(card.code)) byCode.set(card.code, card);
  const placed = new Set<string>();
  const themed: CatalogueTripCard[] = [];
  for (const group of snapshot.groups) {
    for (const code of group.codes) {
      const card = byCode.get(code);
      if (!card || placed.has(code)) continue;
      placed.add(code);
      themed.push(card);
    }
  }
  for (const card of snapshot.trips) {
    if (placed.has(card.code)) continue;
    placed.add(card.code);
    themed.push(card);
  }
  const rank = (card: CatalogueTripCard) => {
    const kind = transportKindOf(card.transportLabel);
    const i = TRANSPORT_CHAPTERS.findIndex(c => c.kind === kind);
    return i < 0 ? TRANSPORT_CHAPTERS.length - 1 : i;
  };
  return themed
    .map((card, pos) => ({ card, pos, r: rank(card) }))
    .sort((a, b) => a.r - b.r || a.pos - b.pos)
    .map(({ card, r }) => ({ card, groupLabel: TRANSPORT_CHAPTERS[r]!.label }));
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
    if (fit.cinema) {
      out.push("cinema");
      previous = "cinema";
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

// --- sections: the category list pages ---------------------------------------------------------

/** Where every "Агуулга" link lands: the first section page. */
export const GUIDE_ANCHOR = "contents";

/** Up to this many trips: one column of large cards. Then two columns of six (roomy), then compact. */
export const SECTION_LARGE_MAX = 4;
export const SECTION_ROOMY_MAX = 12;
export const SECTION_COMPACT_FIRST = 18;
export const SECTION_COMPACT_NEXT = 22;

/** How a section's list is split over its pages: one page whenever it can be. */
export function sectionChunks(count: number): { density: SectionDensity; sizes: number[] } {
  if (count <= SECTION_LARGE_MAX) return { density: "large", sizes: [count] };
  if (count <= SECTION_ROOMY_MAX) return { density: "roomy", sizes: [count] };
  const sizes = [Math.min(count, SECTION_COMPACT_FIRST)];
  let left = count - sizes[0]!;
  while (left > 0) {
    const take = Math.min(left, SECTION_COMPACT_NEXT);
    sizes.push(take);
    left -= take;
  }
  return { density: "compact", sizes };
}

export type PagePlan = {
  chapters: ChapterPlan[];
  trips: OrderedTrip[];
  coverPage: 1;
  /** The first section page; the "contents" destination every back link goes to. */
  firstGuidePage: number;
  firstTripPage: number;
  closingPage: number;
  totalPages: number;
};

export function planPages(snapshot: CatalogueSnapshot): PagePlan {
  const ordered = orderTrips(snapshot);
  const groups: { label: string; cards: CatalogueTripCard[] }[] = [];
  for (const o of ordered) {
    const last = groups[groups.length - 1];
    if (last && last.label === o.groupLabel) last.cards.push(o.card);
    else groups.push({ label: o.groupLabel, cards: [o.card] });
  }
  let page = 2;
  let index = 0;
  const trips: OrderedTrip[] = [];
  const chapters: ChapterPlan[] = groups.map((g, ci) => {
    const def = TRANSPORT_CHAPTERS.find(c => c.label === g.label) ?? TRANSPORT_CHAPTERS[TRANSPORT_CHAPTERS.length - 1]!;
    const { density, sizes } = sectionChunks(g.cards.length);
    const sectionPage = page;
    page += sizes.length;
    const chapterTrips = g.cards.map(card => {
      const trip: OrderedTrip = { card, groupLabel: g.label, chapter: ci, index: index++, page: page++ };
      trips.push(trip);
      return trip;
    });
    const listPages: OrderedTrip[][] = [];
    let at = 0;
    for (const n of sizes) {
      listPages.push(chapterTrips.slice(at, at + n));
      at += n;
    }
    return { index: ci, kind: def.kind, label: def.label, line: def.line, sectionPage, listPages, density, firstPage: sectionPage, trips: chapterTrips };
  });
  const closingPage = page;
  return {
    chapters,
    trips,
    coverPage: 1,
    firstGuidePage: 2,
    firstTripPage: trips[0]?.page ?? closingPage,
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
