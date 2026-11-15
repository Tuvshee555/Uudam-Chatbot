/**
 * Hero photo selection for the corporate catalogue: which of a trip's stored photos makes the best
 * premium page, and how good the best one really is.
 *
 *   rankPhotoCandidates(trip, poster, opts)   PURE. Every distinct stored photo of the trip (poster
 *                                             hero, the trip's own photos, poster day photos), scored
 *                                             0..100, best first. Never fetches anything.
 *   measurePhotoSizes(urls, opts)             IMPURE (network). Real pixel sizes through the guarded
 *                                             image fetcher; used by generate and by the photo audit,
 *                                             never on a customer path.
 *   assessHero(candidate)                     excellent | good | weak | missing for the admin and the
 *                                             shortlist ("weak"/"missing" are flagged for replacement).
 *
 * What a premium book wants from a hero (learned from looking at the real photo pool, see
 * scripts/catalogue-photo-audit.ts): a SHARP photo of at least ~1400px on its long edge, a landscape
 * or portrait frame with room to crop, no price text or graphic layout on it. Poster images and
 * stories are usually layouts with text, tiny files are soft on a phone, ultra-wide panoramas lose
 * their subject in a portrait crop. A staff choice (config.heroByTripId) always beats this ranking.
 *
 * No real trip, place or photo is named here (AGENTS.md).
 */
import type { TravelTrip } from "../travelTypes";
import type { CataloguePhoto, CataloguePhotoCandidate, CataloguePhotoQuality, CatalogueHeroChoice } from "./types";
import { row, rows, text } from "./diagnostics";

/** What the measuring step learned about one photo. width/height are the only fields the contract needs. */
export type PhotoStats = {
  width: number;
  height: number;
  /** Variance of the Laplacian of a 256px grey copy: low = soft / blurred / flat. */
  sharpness?: number;
  /** Share of pixels in the single most common grey band: high = a flat graphic / poster / text page. */
  flat?: number;
  /** Hasler-Suesstrunk colourfulness of a 128px copy: ~15 dull / grey, ~45 vivid. */
  colorful?: number;
};
export type PhotoSizes = Record<string, PhotoStats>;

/**
 * Automatic grading is deliberately strict: the numbers cannot see the subject (a sharp 2200px hotel
 * entrance scores like a sunset), so only a large, sharp, vivid file is "excellent" on its own. A
 * photo editor's choice (config.heroByTripId, with its quality) is graded by the file alone.
 */
export const HERO_EXCELLENT_LONG_EDGE = 1800;
export const HERO_GOOD_LONG_EDGE = 1000;
export const HERO_EXCELLENT_SCORE = 80;
export const HERO_GOOD_SCORE = 60;
/** File size at which a human-approved photo is not held back. */
export const STAFF_EXCELLENT_LONG_EDGE = 1500;

const HTTPS_IMAGE = /^https:\/\/[^\s]+$/i;
const NOT_A_PHOTO = /\.(svg|gif|mp4|mov|webm|pdf)(\?|#|$)|\/video\/upload\//i;
/** File or folder names that point at a layout rather than a photograph. */
const LAYOUT_NAME = /(?:^|[/_.-])(poster|banner|flyer|brochure|infographic|logo|price|map|schedule|program|itinerary|screenshot)(?:[/_.-]|$)/i;
const TEXT_OVERLAY = /\/l_text[:,]|\/l_fetch[:,]|\/l_subtitles[:,]/i;

/**
 * The poster hero is what the poster designer picked, not a layout with text (the audit found real
 * photographs there), and the best picture of a trip is as often the poster hero as a trip photo:
 * no source is favoured. The shape of the picture decides (see scorePhoto).
 */
const SOURCE_BONUS: Record<CataloguePhoto["source"], number> = { trip_photo: 0, poster_day: 0, poster_hero: 0 };
const SOURCE_RANK: Record<CataloguePhoto["source"], number> = { trip_photo: 0, poster_day: 1, poster_hero: 2 };

/** Pixel size only when the URL states it unambiguously (an exact Cloudinary crop, a Commons thumb, "-1200x800"). */
export function photoSizeFromUrl(url: string): { width: number | null; height: number | null } {
  const exactCrop = /\/image\/upload\/([^/]*,)?c_(?:fill|scale|thumb|crop|pad)(?:,[^/]*)?\//.test(url);
  if (exactCrop) {
    const w = /(?:^|[,/])w_(\d{2,5})(?=[,/])/.exec(url);
    const h = /(?:^|[,/])h_(\d{2,5})(?=[,/])/.exec(url);
    if (w) return { width: Number(w[1]), height: h ? Number(h[1]) : null };
  }
  const commons = /\/(\d{2,5})px-[^/]+$/.exec(url);
  if (commons) return { width: Number(commons[1]), height: null };
  const named = /[-_](\d{3,5})x(\d{3,5})\.(?:jpe?g|png|webp)(?:\?|#|$)/i.exec(url);
  if (named) return { width: Number(named[1]), height: Number(named[2]) };
  const query = /[?&](?:w|width)=(\d{2,5})(?:&|$)/.exec(url);
  return { width: query ? Number(query[1]) : null, height: null };
}

/** Same picture under different transformations / sizes shares one key. */
export function photoKey(url: string): string {
  const clean = url.trim();
  const upload = /^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/([^?#]+)/i.exec(clean);
  if (upload) {
    const segments = upload[1]!.split("/");
    const version = segments.findIndex((segment) => /^v\d+$/.test(segment));
    // After the version number is the public id; without one, leading transformation segments ("c_fill,w_800", "f_jpg") are skipped.
    const idSegments = version >= 0
      ? segments.slice(version + 1)
      : segments.filter((segment, i) => i === segments.length - 1 || !(segment.includes(",") || /^[a-z]{1,4}_[^/]+$/i.test(segment)));
    return `cld:${idSegments.join("/").replace(/\.[a-z0-9]{3,4}$/i, "").toLowerCase()}`;
  }
  const thumb = /\/thumb\/[0-9a-f]\/[0-9a-f]{2}\/([^/]+)\//i.exec(clean);
  if (thumb) return `wm:${decodeURIComponent(thumb[1]!).toLowerCase()}`;
  const commons = /upload\.wikimedia\.org\/wikipedia\/commons\/[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)$/i.exec(clean);
  if (commons) return `wm:${decodeURIComponent(commons[1]!).toLowerCase()}`;
  return clean.replace(/[?#].*$/, "").toLowerCase();
}

function creditOf(trip: TravelTrip, url: string): string | null {
  const credit = row(row(row(trip.extra).photo_credits)[url]);
  const author = text(credit.author);
  const license = text(credit.license);
  const line = [author, license].filter(Boolean).join(", ") || text(credit.provider) || text(credit.title);
  return line ? line.slice(0, 160) : null;
}

type RawPhoto = { url: string; source: CataloguePhoto["source"]; order: number };

/** Every distinct https photo URL stored for the trip, in source priority order; near-identical URLs collapse. */
export function collectPhotos(trip: TravelTrip, poster: unknown): RawPhoto[] {
  const posterRow = row(poster);
  const sources: Array<{ url: unknown; source: CataloguePhoto["source"] }> = [
    { url: posterRow.hero_image, source: "poster_hero" },
    ...(trip.photo_urls || []).map((url) => ({ url, source: "trip_photo" as const })),
    ...rows(posterRow.days).map((day) => ({ url: day.photo, source: "poster_day" as const })),
  ];
  const seen = new Set<string>();
  const out: RawPhoto[] = [];
  for (const { url, source } of sources) {
    const clean = typeof url === "string" ? url.trim() : "";
    if (!clean || !HTTPS_IMAGE.test(clean) || NOT_A_PHOTO.test(clean)) continue;
    const key = photoKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url: clean, source, order: out.length });
  }
  return out;
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

/** Score one photo 0..100 and say why in Mongolian for staff. Pure. */
export function scorePhoto(raw: { url: string; source: CataloguePhoto["source"] }, stats: Partial<PhotoStats> | null): { score: number; issues: string[]; width: number | null; height: number | null } {
  const hint = photoSizeFromUrl(raw.url);
  const width = stats?.width ?? hint.width;
  const height = stats?.height ?? hint.height;
  const issues: string[] = [];
  let score = 52 + SOURCE_BONUS[raw.source];

  const long = width !== null && height !== null ? Math.max(width, height) : width;
  if (long === null) {
    score -= 5;
    issues.push("хэмжээ шалгагдаагүй");
  } else if (long >= 2400) score += 22;
  else if (long >= 1800) score += 18;
  else if (long >= 1400) score += 13;
  else if (long >= 1100) score += 6;
  else if (long >= 800) score += 0;
  else if (long >= 600) { score -= 14; issues.push(`нягтрал бага (${long}px)`); }
  else { score -= 28; issues.push(`маш жижиг зураг (${long}px)`); }

  if (width !== null && height !== null && width > 0 && height > 0) {
    const ratio = width / height;
    if (ratio < 0.6) { score -= 12; issues.push("хэт өндөр хүрээ (постер/story байж магадгүй)"); }
    else if (ratio < 0.85) score += 3;
    else if (ratio >= 1.0 && ratio < 1.9) score += 4;
    else if (ratio >= 1.9 && ratio < 2.4) score -= 4;
    else if (ratio >= 2.4) { score -= 14; issues.push("хэт өргөн панорам, босоо хуудсанд сэдэв нь тасрах эрсдэлтэй"); }
    // The crop that survives on a page: a wide frame is judged by its height.
    const cropSide = Math.min(width, height / 1.04);
    if (cropSide < 900 && long !== null && long >= 1100) { score -= 6; issues.push("тайрах үед нягтрал буурна"); }
  }

  if (TEXT_OVERLAY.test(raw.url)) { score -= 35; issues.push("зураг дээр текст давхарласан"); }
  else if (LAYOUT_NAME.test(raw.url)) { score -= 22; issues.push("текст/постер байж магадгүй"); }

  if (stats?.flat !== undefined && stats.flat >= 0.45) { score -= 18; issues.push("хавтгай график/текстэн хуудас шиг"); }
  // Texture (Laplacian variance) is content-dependent (a clear sky has little), so only a near-total lack of it counts as blur.
  if (stats?.sharpness !== undefined && stats.sharpness < 60) { score -= 12; issues.push("бүдэг, тод биш"); }
  // Vivid pictures are the inviting ones; grey, hazy, flat-lit ones are not. The audit's editor picks averaged ~60, the rest ~46.
  if (stats?.colorful !== undefined) {
    const vivid = clamp((stats.colorful - 35) / 4, -5, 9);
    score += vivid;
    if (stats.colorful < 25) issues.push("өнгө бүдэг, уйтгартай");
  }
  return { score: clamp(Math.round(score)), issues, width: width ?? null, height: height ?? null };
}

/**
 * Every distinct stored photo of the trip, scored, best first. `sizes` are real measurements
 * (measurePhotoSizes); without them only what the URL states is known and the score says so.
 */
export function rankPhotoCandidates(trip: TravelTrip, poster: unknown, opts: { sizes?: PhotoSizes } = {}): CataloguePhotoCandidate[] {
  const sizes = opts.sizes ?? {};
  const scored = collectPhotos(trip, poster).map((raw) => {
    const result = scorePhoto(raw, sizes[raw.url] ?? null);
    return { raw, ...result };
  });
  scored.sort((a, b) => b.score - a.score || SOURCE_RANK[a.raw.source] - SOURCE_RANK[b.raw.source] || a.raw.order - b.raw.order);
  return scored.map(({ raw, score, issues, width, height }) => ({
    url: raw.url, width, height, source: raw.source, score, issues, credit: creditOf(trip, raw.url),
  }));
}

/** Longest edge of a candidate, null when unknown. */
export function longEdgeOf(candidate: { width: number | null; height: number | null }): number | null {
  if (candidate.width === null) return null;
  return candidate.height === null ? candidate.width : Math.max(candidate.width, candidate.height);
}

/** How good the hero is for a premium book. A photo of unknown size can be "good" at best. */
export function assessHero(candidate: CataloguePhotoCandidate | null): CataloguePhotoQuality {
  if (!candidate) return "missing";
  const long = longEdgeOf(candidate);
  if (candidate.score >= HERO_EXCELLENT_SCORE && long !== null && long >= HERO_EXCELLENT_LONG_EDGE) return "excellent";
  if (candidate.score >= HERO_GOOD_SCORE && (long === null || long >= HERO_GOOD_LONG_EDGE)) return "good";
  return "weak";
}

/** Quality of a photo a human chose: the subject is approved, so only the file itself can still be weak. */
export function assessStaffChoice(candidate: Pick<CataloguePhotoCandidate, "width" | "height"> | null, stated?: CataloguePhotoQuality | null): CataloguePhotoQuality {
  if (!candidate) return stated ?? "good";
  const long = longEdgeOf(candidate);
  const fileQuality: CataloguePhotoQuality = long === null ? "good" : long >= STAFF_EXCELLENT_LONG_EDGE ? "excellent" : long >= HERO_GOOD_LONG_EDGE ? "good" : "weak";
  if (!stated) return fileQuality;
  const order: CataloguePhotoQuality[] = ["missing", "weak", "good", "excellent"];
  return order[Math.min(order.indexOf(stated), order.indexOf(fileQuality))]!;
}

export type HeroSelection = {
  hero: CataloguePhotoCandidate | null;
  quality: CataloguePhotoQuality;
  focal: CatalogueHeroChoice["focal"];
  zoom: CatalogueHeroChoice["zoom"];
  /** Up to two further good photos of the same trip, never the hero, never a near-duplicate. */
  gallery: CataloguePhotoCandidate[];
  staffChosen: boolean;
};

/**
 * The hero (staff choice first, else the best ranked candidate) and up to two more good photos for
 * secondary compositions. A staff-chosen URL that is not among the stored photos is still honoured.
 */
export function selectHero(candidates: readonly CataloguePhotoCandidate[], choice?: CatalogueHeroChoice | null, sizes: PhotoSizes = {}): HeroSelection {
  const chosenUrl = choice?.url && HTTPS_IMAGE.test(choice.url) ? choice.url : null;
  let hero: CataloguePhotoCandidate | null = null;
  let staffChosen = false;
  if (chosenUrl) {
    const known = candidates.find((c) => photoKey(c.url) === photoKey(chosenUrl));
    const stats = sizes[chosenUrl] ?? sizes[known?.url ?? ""] ?? null;
    hero = known
      ? { ...known, url: chosenUrl, width: stats?.width ?? known.width, height: stats?.height ?? known.height }
      : { url: chosenUrl, width: stats?.width ?? photoSizeFromUrl(chosenUrl).width, height: stats?.height ?? photoSizeFromUrl(chosenUrl).height, source: "trip_photo", score: 60, issues: [], credit: null };
    staffChosen = true;
  } else hero = candidates[0] ?? null;

  const quality = !hero ? "missing" : staffChosen ? assessStaffChoice(hero, choice?.quality ?? null) : assessHero(hero);
  const heroKey = hero ? photoKey(hero.url) : "";
  const gallery = candidates
    .filter((c) => photoKey(c.url) !== heroKey && assessHero(c) !== "weak" && c.score >= HERO_GOOD_SCORE && c.source !== "poster_hero")
    .slice(0, 2);
  return { hero, quality, focal: staffChosen ? (choice?.focal ?? null) : null, zoom: staffChosen ? (choice?.zoom ?? null) : null, gallery, staffChosen };
}

/* ------------------------------------------------------------------ measuring (network) */

export type PhotoMeasurement = PhotoStats & { byteLength: number; thumb?: Buffer };

const GREY_BANDS = 32;

/** Width, height, sharpness and flatness of one image. Null when the bytes are not a decodable image. */
export async function measureImageBytes(bytes: Buffer | Uint8Array, opts: { thumbWidth?: number } = {}): Promise<Omit<PhotoMeasurement, "byteLength"> | null> {
  try {
    const sharp = (await import("sharp")).default;
    const input = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const base = sharp(input, { failOn: "none", limitInputPixels: 160_000_000 }).rotate();
    const meta = await base.metadata();
    const rotated = (meta.orientation ?? 1) >= 5;
    const width = (rotated ? meta.height : meta.width) ?? 0;
    const height = (rotated ? meta.width : meta.height) ?? 0;
    if (width < 16 || height < 16) return null;

    const { data, info } = await base.clone().greyscale().resize({ width: 256, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    const w = info.width;
    const h = info.height;
    const bands = new Array<number>(GREY_BANDS).fill(0);
    for (let i = 0; i < data.length; i++) bands[Math.min(GREY_BANDS - 1, data[i]! >> 3)]! += 1;
    const flat = Math.max(...bands) / data.length;
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const lap = 4 * data[i]! - data[i - 1]! - data[i + 1]! - data[i - w]! - data[i + w]!;
        sum += lap;
        sumSq += lap * lap;
        n++;
      }
    }
    const mean = n ? sum / n : 0;
    const sharpness = n ? Math.round((sumSq / n - mean * mean) * 10) / 10 : 0;
    const rgb = await base.clone().removeAlpha().resize({ width: 128, withoutEnlargement: true }).raw().toBuffer({ resolveWithObject: true });
    let rgMean = 0;
    let ybMean = 0;
    let rgSq = 0;
    let ybSq = 0;
    const pixels = rgb.data.length / 3;
    for (let i = 0; i < rgb.data.length; i += 3) {
      const rg = rgb.data[i]! - rgb.data[i + 1]!;
      const yb = 0.5 * (rgb.data[i]! + rgb.data[i + 1]!) - rgb.data[i + 2]!;
      rgMean += rg;
      ybMean += yb;
      rgSq += rg * rg;
      ybSq += yb * yb;
    }
    rgMean /= pixels || 1;
    ybMean /= pixels || 1;
    const rgStd = Math.sqrt(Math.max(0, rgSq / (pixels || 1) - rgMean * rgMean));
    const ybStd = Math.sqrt(Math.max(0, ybSq / (pixels || 1) - ybMean * ybMean));
    const colorful = Math.round((Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean)) * 10) / 10;
    const thumb = opts.thumbWidth
      ? await base.clone().resize({ width: opts.thumbWidth, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer()
      : undefined;
    return { width, height, sharpness, flat: Math.round(flat * 100) / 100, colorful, ...(thumb ? { thumb } : {}) };
  } catch {
    return null;
  }
}

export type MeasureOptions = {
  fetcher?: (url: string) => Promise<Buffer | Uint8Array | null>;
  concurrency?: number;
  thumbWidth?: number;
  onResult?: (url: string, measurement: PhotoMeasurement | null) => void;
};

/**
 * Real pixel sizes (plus sharpness / flatness) for a list of https image URLs, through the guarded
 * fetcher the renderer uses (public hosts only, bounded time and size). A URL that cannot be
 * fetched or decoded is simply absent from the result. NOT for customer paths.
 */
export async function measurePhotoDetails(urls: readonly string[], opts: MeasureOptions = {}): Promise<Record<string, PhotoMeasurement>> {
  const unique = [...new Set(urls.filter((u) => HTTPS_IMAGE.test(u)))];
  const fetcher = opts.fetcher ?? (await import("./render/images")).defaultImageFetcher;
  const out: Record<string, PhotoMeasurement> = {};
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, unique.length)) }, async () => {
    while (next < unique.length) {
      const url = unique[next++]!;
      let measurement: PhotoMeasurement | null = null;
      try {
        const bytes = await fetcher(url);
        if (bytes) {
          const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
          const stats = await measureImageBytes(buffer, { thumbWidth: opts.thumbWidth });
          if (stats) measurement = { ...stats, byteLength: buffer.length };
        }
      } catch {
        measurement = null;
      }
      if (measurement) out[url] = measurement;
      opts.onResult?.(url, measurement);
    }
  });
  await Promise.all(runners);
  return out;
}

/** Sizes only (the contract): url -> measured stats, without the image bytes. */
export async function measurePhotoSizes(urls: readonly string[], opts: Omit<MeasureOptions, "thumbWidth" | "onResult"> = {}): Promise<PhotoSizes> {
  const details = await measurePhotoDetails(urls, opts);
  const sizes: PhotoSizes = {};
  for (const [url, d] of Object.entries(details)) sizes[url] = { width: d.width, height: d.height, ...(d.sharpness !== undefined ? { sharpness: d.sharpness } : {}), ...(d.flat !== undefined ? { flat: d.flat } : {}), ...(d.colorful !== undefined ? { colorful: d.colorful } : {}) };
  return sizes;
}
