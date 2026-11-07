/**
 * Post-processing of the Chromium PDF with pdf-lib: document info (title, author, creation date,
 * version label), language and viewer hints, plus the facts the caller reports (page count, size,
 * embedded font names). The page content itself is not touched.
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, type PDFRef } from "pdf-lib";
import type { CatalogueSnapshot } from "../types";
import { catalogueDocumentTitle } from "./html";
import { planPages, type PagePlan } from "./layout";
import { displayTitle } from "./titleCase";

export type StampedPdf = {
  pdf: Buffer;
  pageCount: number;
  pageSize: { width: number; height: number };
  fonts: string[];
};

const SUBSET_PREFIX = /^[A-Z]{6}\+/;

export function embeddedFontNames(doc: PDFDocument): string[] {
  const names = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const type = obj.get(PDFName.of("Type"));
    const base = obj.get(PDFName.of("BaseFont"));
    if (type?.toString() === "/Font" && base) names.add(base.toString().replace(/^\//, "").replace(SUBSET_PREFIX, ""));
  }
  return [...names].sort();
}

export type OutlineNode = { title: string; page: number; children: OutlineNode[] };

/**
 * Bookmarks the reader's viewer shows as a table of contents: cover, contents, the trips grouped by
 * use-case ("A01 · title"), and the quotation page. Built here rather than by Chromium because
 * Chromium drops the space at every soft line wrap of a heading.
 */
export function outlineFor(plan: PagePlan): OutlineNode[] {
  const nodes: OutlineNode[] = [
    { title: "Нүүр", page: 1, children: [] },
    { title: "Агуулга", page: plan.firstContentsPage, children: [] },
  ];
  let current: OutlineNode | null = null;
  let currentLabel: string | null = null;
  for (const t of plan.trips) {
    if (t.groupLabel !== currentLabel) {
      current = { title: t.groupLabel, page: t.page, children: [] };
      currentLabel = t.groupLabel;
      nodes.push(current);
    }
    current!.children.push({ title: `${t.card.code} · ${displayTitle(t.card.title)}`, page: t.page, children: [] });
  }
  nodes.push({ title: "Үнийн санал авах", page: plan.closingPage, children: [] });
  return nodes;
}

function writeOutline(doc: PDFDocument, nodes: OutlineNode[]): void {
  const ctx = doc.context;
  const pages = doc.getPages();
  const lastPage = pages.length;

  const register = (list: OutlineNode[], parent: PDFRef): { first: PDFRef; last: PDFRef; count: number } | null => {
    if (list.length === 0) return null;
    const refs = list.map(() => ctx.nextRef());
    let count = list.length;
    list.forEach((node, i) => {
      const target = pages[Math.min(Math.max(node.page, 1), lastPage) - 1]!;
      const dict = ctx.obj({
        Title: PDFHexString.fromText(node.title),
        Parent: parent,
        Dest: [target.ref, PDFName.of("Fit")],
      }) as PDFDict;
      if (i > 0) dict.set(PDFName.of("Prev"), refs[i - 1]!);
      if (i < list.length - 1) dict.set(PDFName.of("Next"), refs[i + 1]!);
      const kids = register(node.children, refs[i]!);
      if (kids) {
        dict.set(PDFName.of("First"), kids.first);
        dict.set(PDFName.of("Last"), kids.last);
        dict.set(PDFName.of("Count"), PDFNumber.of(kids.count));
        count += kids.count;
      }
      ctx.assign(refs[i]!, dict);
    });
    return { first: refs[0]!, last: refs[refs.length - 1]!, count };
  };

  const rootRef = ctx.nextRef();
  const top = register(nodes, rootRef);
  if (!top) return;
  const root = ctx.obj({ Type: "Outlines", First: top.first, Last: top.last, Count: top.count });
  ctx.assign(rootRef, root);
  doc.catalog.set(PDFName.of("Outlines"), rootRef);
}

export async function stampPdf(raw: Buffer, snapshot: CatalogueSnapshot, versionLabel: string): Promise<StampedPdf> {
  const doc = await PDFDocument.load(raw, { updateMetadata: false });
  const when = new Date(Date.parse(snapshot.generatedAt));
  doc.setTitle(catalogueDocumentTitle(snapshot));
  doc.setAuthor("UUDAM Travel");
  doc.setSubject(`Хамт олны аяллын сонголт · ${snapshot.issueLabel} · ${versionLabel}`);
  doc.setKeywords(["UUDAM Travel", "байгууллагын аялал", "хамт олны аялал", snapshot.edition, versionLabel]);
  doc.setCreator("UUDAM Travel catalogue");
  doc.setProducer("UUDAM Travel catalogue (Chromium + pdf-lib)");
  if (Number.isFinite(when.getTime())) {
    doc.setCreationDate(when);
    doc.setModificationDate(when);
  }
  doc.catalog.set(PDFName.of("Lang"), PDFString.of("mn-MN"));
  doc.catalog.set(PDFName.of("ViewerPreferences"), doc.context.obj({ DisplayDocTitle: true }));

  writeOutline(doc, outlineFor(planPages(snapshot)));

  const first = doc.getPage(0).getSize();
  const bytes = await doc.save({ useObjectStreams: true });
  return {
    pdf: Buffer.from(bytes),
    pageCount: doc.getPageCount(),
    pageSize: { width: Math.round(first.width * 100) / 100, height: Math.round(first.height * 100) / 100 },
    fonts: embeddedFontNames(doc),
  };
}
