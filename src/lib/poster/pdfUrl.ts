export function posterPdfPath(posterId: string): string {
  return `/api/poster-pdf?id=${encodeURIComponent(posterId)}`;
}

/**
 * Cloudinary blocks raw PDF delivery account-wide unless "PDF and ZIP files
 * delivery" is enabled, so these stored URLs answer 401 to everyone —
 * Facebook included. Treat them as missing rather than sending a dead link.
 */
export function isCloudinaryRawPdfUrl(value: string): boolean {
  return /^https:\/\/res\.cloudinary\.com\/[^/]+\/raw\/upload\/.+\.pdf(?:[?#].*)?$/i.test(value.trim());
}

/** True for our own rendered-poster endpoint, wherever it is hosted. */
export function isPosterPdfEndpointUrl(value: string): boolean {
  try {
    return new URL(value).pathname === "/api/poster-pdf";
  } catch {
    return false;
  }
}

/** A stored brochure URL is only usable if something can actually fetch it. */
export function isUsableStoredPdfUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().startsWith("https://") &&
    !isCloudinaryRawPdfUrl(value)
  );
}

function normalizeBaseUrl(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withProtocol.replace(/\/+$/, "");
}

export function getPosterPdfPublicUrl(posterId: string): string {
  const env: Partial<NodeJS.ProcessEnv> = typeof process !== "undefined" ? process.env : {};
  const base = normalizeBaseUrl(
    env.NEXT_PUBLIC_SITE_URL ||
      env.SITE_URL ||
      env.VERCEL_PROJECT_PRODUCTION_URL ||
      env.VERCEL_URL,
  );
  return base ? `${base}${posterPdfPath(posterId)}` : "";
}

export function getPosterBrochureHref(extra: Record<string, unknown>): string {
  // The rendered poster endpoint is the live source of truth: it always shows
  // the poster exactly as it is saved right now. A copy uploaded before the
  // last edit only applies to trips that have no poster behind them.
  const posterId = typeof extra.poster_trip_id === "string" ? extra.poster_trip_id.trim() : "";
  if (posterId) return posterPdfPath(posterId);
  const pdfUrl = typeof extra.brochure_pdf_url === "string" ? extra.brochure_pdf_url.trim() : "";
  return isUsableStoredPdfUrl(pdfUrl) ? pdfUrl : "";
}
