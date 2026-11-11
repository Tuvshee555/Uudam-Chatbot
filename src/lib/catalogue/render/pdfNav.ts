/**
 * Reads the navigation of a finished catalogue PDF (internal links, named destinations, bookmarks)
 * with pdf-lib, so a broken link can be caught at render time and in tests instead of by a customer.
 * Read-only; never changes the file.
 */
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFObject,
} from "pdf-lib";
import type { CatalogueSnapshot, CatalogueWarning } from "../types";
import { GUIDE_ANCHOR, INDEX_ANCHOR, SCHEDULE_ANCHOR, anchorId, chapterAnchorId, planPages, scheduleBlockId, type PagePlan } from "./layout";

export type PdfLink = {
  /** 1-based page the link sits on. */
  page: number;
  rect: [number, number, number, number];
  /** 1-based page the link goes to; null for an external link or a destination that does not resolve. */
  target: number | null;
  /** Destination name for an internal link (e.g. "trip-A01"). */
  dest: string | null;
  /** http(s) / tel URI for an external link. */
  uri: string | null;
};

export type PdfOutlineEntry = { title: string; page: number | null; depth: number };

export type PdfNavigation = {
  pageCount: number;
  links: PdfLink[];
  outline: PdfOutlineEntry[];
  /** Named destination -> 1-based page. */
  destinations: Record<string, number>;
};

const decodeText = (obj: PDFObject | undefined): string | null => {
  if (obj instanceof PDFHexString || obj instanceof PDFString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return null;
};

export async function readPdfNavigation(pdf: Uint8Array | Buffer): Promise<PdfNavigation> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const ctx = doc.context;
  const pages = doc.getPages();
  const pageIndexByRef = new Map<string, number>();
  pages.forEach((p, i) => pageIndexByRef.set(p.ref.toString(), i + 1));
  const pageOfTarget = (target: PDFObject | undefined): number | null => {
    if (target instanceof PDFRef) return pageIndexByRef.get(target.toString()) ?? null;
    if (target instanceof PDFNumber) return target.asNumber() + 1;
    return null;
  };

  // Named destinations: catalog /Dests dictionary (what Chromium writes) and a /Names /Dests tree.
  const destinations: Record<string, number> = {};
  const readDestValue = (value: PDFObject | undefined): number | null => {
    const v = value instanceof PDFRef ? ctx.lookup(value) : value;
    if (v instanceof PDFArray) return pageOfTarget(v.get(0));
    if (v instanceof PDFDict) {
      const d = v.lookup(PDFName.of("D"));
      return d instanceof PDFArray ? pageOfTarget(d.get(0)) : null;
    }
    return null;
  };
  const legacy = doc.catalog.lookup(PDFName.of("Dests"));
  if (legacy instanceof PDFDict) {
    for (const [key, value] of legacy.entries()) {
      const page = readDestValue(value);
      if (page != null) destinations[key.decodeText()] = page;
    }
  }
  const walkNameTree = (node: PDFDict | undefined, depth = 0) => {
    if (!node || depth > 8) return;
    const names = node.lookup(PDFName.of("Names"));
    if (names instanceof PDFArray) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const key = decodeText(names.lookup(i));
        const page = readDestValue(names.get(i + 1));
        if (key && page != null) destinations[key] = page;
      }
    }
    const kids = node.lookup(PDFName.of("Kids"));
    if (kids instanceof PDFArray) for (let i = 0; i < kids.size(); i++) walkNameTree(kids.lookupMaybe(i, PDFDict), depth + 1);
  };
  const names = doc.catalog.lookup(PDFName.of("Names"));
  if (names instanceof PDFDict) walkNameTree(names.lookupMaybe(PDFName.of("Dests"), PDFDict));

  const resolveDest = (dest: PDFObject | undefined): { name: string | null; page: number | null } => {
    const d = dest instanceof PDFRef ? ctx.lookup(dest) : dest;
    if (d instanceof PDFArray) return { name: null, page: pageOfTarget(d.get(0)) };
    const name = decodeText(d);
    return { name, page: name ? (destinations[name] ?? null) : null };
  };

  const links: PdfLink[] = [];
  pages.forEach((page, index) => {
    const annots = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict);
      if (!annot || annot.lookup(PDFName.of("Subtype"))?.toString() !== "/Link") continue;
      const rectArr = annot.lookupMaybe(PDFName.of("Rect"), PDFArray);
      const rect = (rectArr ? [0, 1, 2, 3].map(k => (rectArr.lookup(k) as PDFNumber).asNumber()) : [0, 0, 0, 0]) as PdfLink["rect"];
      let target: number | null = null;
      let dest: string | null = null;
      let uri: string | null = null;
      if (annot.has(PDFName.of("Dest"))) {
        const r = resolveDest(annot.get(PDFName.of("Dest")));
        target = r.page;
        dest = r.name;
      } else {
        const action = annot.lookupMaybe(PDFName.of("A"), PDFDict);
        const kind = action?.lookup(PDFName.of("S"))?.toString();
        if (action && kind === "/GoTo") {
          const r = resolveDest(action.get(PDFName.of("D")));
          target = r.page;
          dest = r.name;
        } else if (action && kind === "/URI") {
          uri = decodeText(action.lookup(PDFName.of("URI")));
        }
      }
      links.push({ page: index + 1, rect, target, dest, uri });
    }
  });

  const outline: PdfOutlineEntry[] = [];
  const walkOutline = (first: PDFObject | undefined, depth: number) => {
    let node = first instanceof PDFRef ? ctx.lookup(first, PDFDict) : undefined;
    let guard = 0;
    while (node && guard++ < 5000) {
      outline.push({ title: decodeText(node.lookup(PDFName.of("Title"))) ?? "", page: resolveDest(node.get(PDFName.of("Dest"))).page, depth });
      walkOutline(node.get(PDFName.of("First")), depth + 1);
      const next = node.get(PDFName.of("Next"));
      node = next instanceof PDFRef ? ctx.lookup(next, PDFDict) : undefined;
    }
  };
  const outlines = doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict);
  if (outlines) walkOutline(outlines.get(PDFName.of("First")), 0);

  return { pageCount: pages.length, links, outline, destinations };
}

/** What the plan promises: where each linked destination must land (the browser only writes destinations something links to). */
export function expectedDestinations(plan: PagePlan): Record<string, number> {
  const out: Record<string, number> = { [GUIDE_ANCHOR]: plan.firstGuidePage };
  for (const t of plan.trips) out[anchorId(t.card.code)] = t.page;
  for (const c of plan.chapters) if (c.openerPage != null) out[chapterAnchorId(c.index)] = c.openerPage;
  if (plan.firstSchedulePage != null) out[SCHEDULE_ANCHOR] = plan.firstSchedulePage;
  if (plan.firstIndexPage != null) out[INDEX_ANCHOR] = plan.firstIndexPage;
  for (const [code, page] of Object.entries(plan.schedulePageByCode)) out[scheduleBlockId(code)] = page;
  return out;
}

const warn = (message: string, detail?: CatalogueWarning["detail"]): CatalogueWarning => ({ code: "other", severity: "warning", message, ...(detail ? { detail } : {}) });

/**
 * Compare the finished PDF's navigation with the page plan: every trip has a destination on its own
 * page; every guide link (chapter, destination name), every index row and every schedule block goes
 * where it should; every trip page leads back to the guide and to its schedule block; bookmarks list
 * the guide, the chapters, every trip, the schedule and the index. Returns staff-facing warnings (empty
 * when everything is in order).
 */
export function auditNavigation(nav: PdfNavigation, snapshot: CatalogueSnapshot, plan: PagePlan = planPages(snapshot)): CatalogueWarning[] {
  const warnings: CatalogueWarning[] = [];
  const expected = expectedDestinations(plan);
  const missing = Object.entries(expected).filter(([name, page]) => nav.destinations[name] !== page);
  if (missing.length > 0) {
    warnings.push(warn(`PDF доторх холбоос зөв хуудас руу заахгүй байна (${missing.length}): ${missing.slice(0, 4).map(([n]) => n).join(", ")}.`, { broken: missing.length }));
  }
  const guidePageNos = new Set(plan.guidePages.map((_, i) => plan.firstGuidePage + i));
  const indexPageNos = new Set(plan.indexPages.map((_, i) => (plan.firstIndexPage ?? 0) + i));
  const schedPageNos = new Set(plan.schedulePages.map((_, i) => (plan.firstSchedulePage ?? 0) + i));
  const linkOn = (pages: Set<number>, dest: string) => nav.links.find(l => pages.has(l.page) && l.dest === dest);
  for (const entry of plan.guidePages.flat()) {
    const chapter = plan.chapters[entry.chapter]!;
    const dest = chapter.openerPage != null ? chapterAnchorId(chapter.index) : anchorId(chapter.trips[0]?.card.code ?? "");
    const link = linkOn(guidePageNos, dest);
    if (!link || link.target !== chapter.firstPage) warnings.push(warn(`${chapter.label}: агуулгын бүлгийн холбоос буруу хуудас руу заав.`, { chapter: chapter.index }));
    for (const n of entry.names) {
      const l = linkOn(guidePageNos, anchorId(n.code));
      if (!l || l.target !== n.page) warnings.push(warn(`${n.code}: агуулга дахь нэрийн холбоос аяллын хуудас руу заахгүй байна.`, { code: n.code }));
    }
  }
  for (const t of plan.trips) {
    const row = nav.links.find(l => indexPageNos.has(l.page) && l.dest === anchorId(t.card.code));
    if (!row || row.target !== t.page) warnings.push({ ...warn(`${t.card.code}: жагсаалтын мөр аяллын хуудас руу заахгүй байна.`, { code: t.card.code }), tripId: t.card.tripId });
    const blockPage = plan.schedulePageByCode[t.card.code];
    if (blockPage != null) {
      const toBlock = nav.links.find(l => l.page === t.page && l.dest === scheduleBlockId(t.card.code));
      if (!toBlock || toBlock.target !== blockPage) warnings.push({ ...warn(`${t.card.code}: аяллын хуудас огнооны товлол руу заахгүй байна.`, { code: t.card.code }), tripId: t.card.tripId });
      const back = nav.links.find(l => schedPageNos.has(l.page) && l.dest === anchorId(t.card.code));
      if (!back || back.target !== t.page) warnings.push({ ...warn(`${t.card.code}: товлолын блок аяллын хуудас руу буцахгүй байна.`, { code: t.card.code }), tripId: t.card.tripId });
    }
  }
  // Every page after the guide leads back to it; the cover leads into it.
  const backPages = [
    1,
    ...plan.trips.map(t => t.page),
    ...plan.chapters.flatMap(c => (c.openerPage != null ? [c.openerPage] : [])),
    ...schedPageNos,
    ...indexPageNos,
    plan.closingPage,
  ];
  const noBack = backPages.filter(page => !nav.links.some(l => l.page === page && l.dest === GUIDE_ANCHOR && l.target === plan.firstGuidePage));
  if (noBack.length > 0) warnings.push(warn(`Агуулга руу буцах холбоос байхгүй хуудас: ${noBack.slice(0, 6).join(", ")}.`, { pages: noBack.length }));
  const bookmarkTitles = nav.outline.map(o => o.title);
  const need: [string, boolean][] = [
    ["Агуулга", true],
    ["Хавсралт · Хөдөлгөөний товлол", plan.firstSchedulePage != null],
    ["Хавсралт · Кодын жагсаалт", plan.firstIndexPage != null],
  ];
  for (const [title, wanted] of need) if (wanted && !bookmarkTitles.includes(title)) warnings.push(warn(`Хавчуурга алга: ${title}.`));
  for (const c of plan.chapters) if (!bookmarkTitles.includes(c.label)) warnings.push(warn(`${c.label}: бүлгийн хавчуурга алга.`, { chapter: c.index }));
  for (const t of plan.trips) {
    if (!bookmarkTitles.some(title => title.startsWith(`${t.card.code} ·`))) warnings.push({ ...warn(`${t.card.code}: хавчуургад алга.`, { code: t.card.code }), tripId: t.card.tripId });
  }
  return warnings;
}
