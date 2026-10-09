const MIN_POSTER_PDF_HEIGHT = 1528;
const MAX_POSTER_PDF_HEIGHT = 18_000;

/**
 * The poster editor is a vertically growing canvas. A fixed PDF sheet clips
 * longer itineraries and puts their photo gallery outside the exported page.
 */
export function posterPdfHeight(contentHeight: number): number {
  if (!Number.isFinite(contentHeight)) return MIN_POSTER_PDF_HEIGHT;
  return Math.min(MAX_POSTER_PDF_HEIGHT, Math.max(MIN_POSTER_PDF_HEIGHT, Math.ceil(contentHeight) + 1));
}
