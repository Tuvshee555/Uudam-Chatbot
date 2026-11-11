/**
 * CatalogueSnapshot -> one self-contained HTML document: cover, chapter guide, chapter
 * openers, one page per trip (five compositions), the schedule and index appendices and the closing page. Pure and browser-free, so
 * it is unit-testable; the browser only prints it.
 *
 * Everything dynamic is HTML-escaped, every URL is checked, and the document carries a CSP that
 * forbids scripts and any non-data: resource.
 */
import type { CatalogueSnapshot } from "../types";
import { planPages } from "./layout";
import { CATALOGUE_TITLE, closingPage, coverPage, guidePage, indexPage, openerPage, schedulePage } from "./pages";
import { tripPage } from "./tripPages";
import { escapeHtml, safeHref } from "./htmlParts";
import type { RenderAssets } from "./renderTypes";
import { buildCss } from "./theme";

export { escapeHtml, safeHref, CATALOGUE_TITLE };

export function catalogueDocumentTitle(snapshot: CatalogueSnapshot): string {
  return `UUDAM Travel · ${CATALOGUE_TITLE} · ${snapshot.issueLabel}`;
}

export function buildCatalogueHtml(snapshot: CatalogueSnapshot, assets: RenderAssets): string {
  const plan = planPages(snapshot);
  const pages: string[] = [coverPage(snapshot, plan, assets), ...plan.guidePages.map((_, i) => guidePage(snapshot, plan, assets, i))];
  for (const chapter of plan.chapters) {
    if (chapter.openerPage != null) pages.push(openerPage(snapshot, plan, assets, chapter));
    for (const t of chapter.trips) pages.push(tripPage(snapshot, plan, assets, t));
  }
  plan.schedulePages.forEach((_, i) => pages.push(schedulePage(snapshot, plan, assets, i)));
  plan.indexPages.forEach((_, i) => pages.push(indexPage(snapshot, plan, assets, i)));
  pages.push(closingPage(snapshot, plan, assets));
  return `<!doctype html>
<html lang="mn">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">
<meta name="viewport" content="width=720">
<meta name="author" content="UUDAM Travel">
<title>${escapeHtml(catalogueDocumentTitle(snapshot))}</title>
<style>${buildCss(assets.fonts)}</style>
</head>
<body>
${pages.join("\n")}
</body>
</html>`;
}
