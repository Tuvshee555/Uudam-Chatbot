export function posterPdfPath(posterId: string): string {
  return `/api/poster-pdf?id=${encodeURIComponent(posterId)}`;
}

export function isCloudinaryRawPdfUrl(value: string): boolean {
  return /^https:\/\/res\.cloudinary\.com\/[^/]+\/raw\/upload\/.+\.pdf(?:[?#].*)?$/i.test(value.trim());
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
  // The real captured poster PDF (brochure_pdf_url) is the actual file the
  // client uploaded/exported — always prefer it. The generated /api/poster-pdf
  // endpoint rebuilds a plain-text PDF from poster JSON and is only a
  // last-resort fallback for trips that never got a real PDF attached.
  const pdfUrl = typeof extra.brochure_pdf_url === "string" ? extra.brochure_pdf_url.trim() : "";
  if (pdfUrl.startsWith("https://")) return pdfUrl;
  const posterId = typeof extra.poster_trip_id === "string" ? extra.poster_trip_id.trim() : "";
  if (posterId) return posterPdfPath(posterId);
  return "";
}
