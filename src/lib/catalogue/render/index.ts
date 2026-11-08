/**
 * Catalogue renderer: CatalogueSnapshot -> vector PDF (540 x 675 pt, 4:5, one page per screen) and
 * optional per-page JPEGs. No model calls, no network except the guarded photo fetch.
 */
import type { CatalogueSnapshot, CatalogueWarning, RenderedCatalogue } from "../types";
import { loadStaticAssets } from "./assets";
import { auditWarnings, renderHtml } from "./browser";
import { buildCatalogueHtml } from "./html";
import { prepareArt } from "./art";
import { defaultImageFetcher } from "./images";
import { planPages } from "./layout";
import { stampPdf } from "./pdfMeta";
import { auditNavigation, readPdfNavigation } from "./pdfNav";
import { CatalogueRenderError, type RenderAssets, type RenderCatalogueOptions } from "./renderTypes";

export { buildCatalogueHtml, catalogueDocumentTitle, escapeHtml, CATALOGUE_TITLE } from "./html";
export { isRenderBrowserAvailable } from "./browser";
export { planPages, PAGE_WIDTH_PT, PAGE_HEIGHT_PT } from "./layout";
export { prepareArt } from "./art";
export type { TripArt, TripComposition, RenderAssets, RenderCatalogueOptions, CatalogueImageFetcher, RenderImage, RenderFontFace } from "./renderTypes";
export { CatalogueRenderError } from "./renderTypes";

/** Above this the book is awkward to forward (Messenger accepts 25 MB; phones on mobile data prefer less). */
export const MAX_COMFORTABLE_PDF_BYTES = 12 * 1024 * 1024;

export function defaultVersionLabel(snapshot: CatalogueSnapshot): string {
  return `${snapshot.edition} ${snapshot.contentHash.slice(0, 8)}`;
}

export async function renderCatalogue(snapshot: CatalogueSnapshot, opts: RenderCatalogueOptions = {}): Promise<RenderedCatalogue> {
  if (!snapshot || !Array.isArray(snapshot.trips) || !Array.isArray(snapshot.groups)) {
    throw new CatalogueRenderError("invalid_snapshot", "Каталогийн өгөгдөл буруу байна.");
  }
  const started = Date.now();
  const fetcher = opts.imageFetcher ?? defaultImageFetcher;
  const versionLabel = opts.versionLabel?.trim() || defaultVersionLabel(snapshot);

  const plan = planPages(snapshot);
  const [statics, art] = await Promise.all([loadStaticAssets(), prepareArt(snapshot, plan, fetcher)]);
  const assets: RenderAssets = {
    fonts: statics.fonts,
    logoDataUri: statics.logoDataUri,
    trips: art.trips,
    cover: art.cover,
    chapters: art.chapters,
    closing: art.closing,
    versionLabel,
  };

  const html = buildCatalogueHtml(snapshot, assets);
  const rendered = await renderHtml(html, { pageImages: opts.pageImages === true });
  const stamped = await stampPdf(rendered.pdf, snapshot, versionLabel);

  const warnings: CatalogueWarning[] = [...art.warnings, ...auditWarnings(rendered.audit)];
  try {
    warnings.push(...auditNavigation(await readPdfNavigation(stamped.pdf), snapshot, plan));
  } catch {
    /* a PDF whose links cannot be read is reported by the page-count check below or by the admin preview */
  }
  const expected = plan.totalPages;
  if (stamped.pageCount !== expected) {
    warnings.push({
      code: "other",
      severity: "warning",
      message: `PDF-ийн хуудасны тоо (${stamped.pageCount}) төлөвлөснөөс (${expected}) зөрж байна.`,
      detail: { pageCount: stamped.pageCount, expected },
    });
  }

  if (stamped.pdf.length > MAX_COMFORTABLE_PDF_BYTES) {
    warnings.push({
      code: "other",
      severity: "warning",
      message: `PDF-ийн хэмжээ ${(stamped.pdf.length / 1048576).toFixed(1)} MB байна. Мессенжерээр илгээхэд том тул аяллын тоог цөөлөх эсвэл зургийг жижигрүүлнэ үү.`,
      detail: { sizeBytes: stamped.pdf.length },
    });
  }

  return {
    pdf: stamped.pdf,
    pageCount: stamped.pageCount,
    pageImages: rendered.pageImages,
    pageSize: stamped.pageSize,
    fonts: stamped.fonts,
    renderMs: Date.now() - started,
    warnings,
  };
}
