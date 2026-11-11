/**
 * Photo art direction: from the guarded photo bytes to the crops each page composition prints.
 *
 *  1. every photo is fetched ONCE and normalised into a working copy (long edge <= 2400 px);
 *  2. its real shape and resolution decide which compositions it can carry (compositionFit), and
 *     assignCompositions (layout.ts) gives the book its rhythm from that;
 *  3. each composition gets its own crop at its own aspect, centred on the staff/data focal point
 *     (card.photo.focal / zoom) or, without one, sharp's attention window. Nothing is ever
 *     stretched, and nothing is upscaled;
 *  4. cinema, opener and cover crops carry a scrim that is BAKED into the JPEG, strength measured
 *     from the real luminance under the type, so the PDF stays vector text on one flat image.
 *
 * A trip whose hero is flagged weak/missing (or too small to print well) gets the typographic page
 * and a staff warning instead of a soft picture.
 */
import sharp from "sharp";
import type { CatalogueSnapshot, CatalogueTripCard, CatalogueWarning, CataloguePhoto, PhotoFocal } from "../types";
import { assignCompositions, orderTrips, planPages, type CompositionFit, type PagePlan } from "./layout";
import { defaultImageFetcher } from "./images";
import { COLORS } from "./theme";
import type { CatalogueImageFetcher, RenderAssets, RenderImage, TripArt } from "./renderTypes";

/** Photo box shapes, height / width. The CSS in theme.ts uses the same boxes (in pt). */
export const ASPECT = {
  /** Whole page. */
  page: 675 / 540,
  /** Cover when the photo cannot carry a whole page: a tall photo that fades into the deep panel. */
  coverPlate: 400 / 540,
  plate: 360 / 540,
  panorama: 400 / 540,
  diptych: 500 / 540,
  inset: 270 / 200,
  closing: 300 / 540,
  thumb: 1,
} as const;

/** Source pixels across a crop below which a photo looks soft on a phone. */
export const LOW_RESOLUTION_CROP_PX = 800;
/** Below this the photo is not printed at all (typographic page + warning). */
export const MIN_PRINT_CROP_PX = 560;
const CINEMA_MIN_CROP_PX = 700;
const PANORAMA_MIN_CROP_PX = 880;
const INSET_MIN_CROP_PX = 480;
const OPENER_MIN_CROP_PX = 640;

const WORK_LONG_EDGE = 2400;
const FETCH_CONCURRENCY = 4;
const SCRIM_RGB = "6,6,6"; // neutral: the photo darkens to black by itself, never to a brand blue
const hexRgb = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)).join(",");
/** The cover panel's colour: a "solid" fade ends exactly here, so photo and panel are one surface. */
const PANEL_RGB = "17,17,17";
/** Cover thresholds (source pixels across the crop): the cover is the page everyone sees first. */
const COVER_FULL_MIN_PX = 820;
const COVER_PLATE_MIN_PX = 760;
/** At or below this width/height a photo counts as portrait/square and may carry the whole cover page. */
const COVER_PORTRAIT_MAX_ASPECT = 1.15;

export type EncodeProfile = {
  /** Output width for a 540pt-wide photo box. */
  width: number;
  /** Output width for a full-page crop (cinema, cover, opener). */
  fullWidth: number;
  quality: number;
  thumb: number;
};

/** Big editions trade a little resolution for file size so the book stays easy to forward. */
export function encodeProfileFor(tripCount: number): EncodeProfile {
  if (tripCount > 24) return { width: 800, fullWidth: 700, quality: 75, thumb: 150 };
  if (tripCount > 14) return { width: 920, fullWidth: 800, quality: 78, thumb: 170 };
  return { width: 1040, fullWidth: 900, quality: 80, thumb: 200 };
}

// --- working copy -----------------------------------------------------------------------------

export type Work = {
  buf: Buffer;
  width: number;
  height: number;
  /** Mean luminance 0..1 of the lower 45% of the frame, used when no crop-specific measure applies. */
  lowerLuma: number;
};

/** Decode, honour EXIF orientation, cap the long edge, and measure. null for junk or tiny images. */
export async function loadWork(source: Buffer | Uint8Array): Promise<Work | null> {
  const input = Buffer.isBuffer(source) ? source : Buffer.from(source);
  try {
    const base = sharp(input, { failOn: "none", limitInputPixels: 120_000_000 }).rotate();
    const { data, info } = await base
      .flatten({ background: "#F6F1E7" })
      .resize({ width: WORK_LONG_EDGE, height: WORK_LONG_EDGE, fit: "inside", withoutEnlargement: true })
      .toColorspace("srgb")
      .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
      .toBuffer({ resolveWithObject: true });
    if (info.width < 64 || info.height < 64) return null;
    const lowerLuma = await lumaOf(data, { left: 0, top: Math.round(info.height * 0.55), width: info.width, height: Math.max(1, info.height - Math.round(info.height * 0.55)) });
    return { buf: data, width: info.width, height: info.height, lowerLuma };
  } catch {
    return null;
  }
}

type Rect = { left: number; top: number; width: number; height: number };

async function lumaOf(buf: Buffer, rect: Rect): Promise<number> {
  try {
    const { data } = await sharp(buf)
      .extract({ left: rect.left, top: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) })
      .resize({ width: 24, height: 24, fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let sum = 0;
    for (const v of data) sum += v;
    return sum / data.length / 255;
  } catch {
    return 0.4;
  }
}

/** Largest crop window of `aspect` (h/w) that fits the source, shrunk by `zoom`, centred on the focal point. */
export function cropWindow(w: number, h: number, aspect: number, focal?: PhotoFocal | null, zoom?: number | null): Rect {
  let cw = Math.min(w, h / aspect);
  let ch = cw * aspect;
  const z = zoom && Number.isFinite(zoom) ? Math.min(3, Math.max(1, zoom)) : 1;
  cw /= z;
  ch /= z;
  const fx = focal ? Math.min(1, Math.max(0, focal.x)) : 0.5;
  const fy = focal ? Math.min(1, Math.max(0, focal.y)) : 0.5;
  const left = Math.min(w - cw, Math.max(0, fx * w - cw / 2));
  const top = Math.min(h - ch, Math.max(0, fy * h - ch / 2));
  return { left: Math.round(left), top: Math.round(top), width: Math.max(2, Math.floor(cw)), height: Math.max(2, Math.floor(ch)) };
}

/** Source pixels across the crop a composition of `aspect` would take. */
export function cropPixels(work: Pick<Work, "width" | "height">, aspect: number, zoom?: number | null): number {
  const z = zoom && Number.isFinite(zoom) ? Math.min(3, Math.max(1, zoom)) : 1;
  return Math.round(Math.min(work.width, work.height / aspect) / z);
}

export type Scrim = {
  /** 0..1 position where the gradient starts to appear (top = 0). */
  from: number;
  /** Peak opacity at the bottom edge. */
  strength: number;
  /** Fade to the opaque panel colour instead of a translucent scrim (cover plate). */
  solid?: boolean;
};

/** Opacity needed under light type for a lower region of mean luminance `luma` (0 dark .. 1 bright). */
export function scrimStrength(luma: number): number {
  return Math.round(Math.min(0.94, Math.max(0.68, 0.62 + luma * 0.5)) * 100) / 100;
}

function scrimSvg(w: number, h: number, scrim: Scrim): Buffer {
  const mid = scrim.from + (1 - scrim.from) * 0.36;
  const rgb = scrim.solid ? PANEL_RGB : SCRIM_RGB;
  const strength = scrim.solid ? 1 : scrim.strength;
  const midOpacity = scrim.solid ? 0.5 : scrim.strength * 0.82;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">` +
      `<stop offset="${scrim.from}" stop-color="rgb(${rgb})" stop-opacity="0"/>` +
      `<stop offset="${mid.toFixed(3)}" stop-color="rgb(${rgb})" stop-opacity="${midOpacity.toFixed(3)}"/>` +
      `<stop offset="1" stop-color="rgb(${rgb})" stop-opacity="${strength}"/></linearGradient></defs>` +
      `<rect width="${w}" height="${h}" fill="url(#g)"/></svg>`,
  );
}

export type CropSpec = {
  aspect: number;
  /** Output width in px (capped by the crop's real width: never upscaled). */
  outWidth: number;
  quality: number;
  focal?: PhotoFocal | null;
  zoom?: number | null;
  /** Bake a bottom scrim; strength follows the measured luminance when `auto`. */
  scrim?: { from: number; solid?: boolean } | null;
  /** Progressive JPEG (smaller). Baseline is used for the tiny thumbnails. */
  progressive?: boolean;
};

/**
 * The photo's own colour, for the panel that continues it: the average of the lower edge, kept in
 * its hue, with saturation tamed and lightness pulled down so light type always reads on it.
 */
export async function edgeTone(jpeg: Buffer, width: number, height: number): Promise<string | undefined> {
  try {
    const stripH = Math.max(1, Math.round(height * 0.1));
    const px = await sharp(jpeg).extract({ left: 0, top: Math.max(0, height - stripH), width, height: stripH }).resize(1, 1).raw().toBuffer();
    const [r, g, b] = [px[0]! / 255, px[1]! / 255, px[2]! / 255];
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d > 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
    const sat = Math.min(0.16, max === 0 ? 0 : d / max); // nearly neutral: a dark continuation of the photo, never a colour block
    const light = 0.12;
    const c = (1 - Math.abs(2 * light - 1)) * sat, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = light - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    const hex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return `#${hex(r1)}${hex(g1)}${hex(b1)}`;
  } catch {
    return undefined;
  }
}

/** Crop `work` to the composition's box, resample, bake the optional scrim, encode. */
export async function cropImage(work: Work, spec: CropSpec): Promise<RenderImage | null> {
  try {
    const hasFocal = !!(spec.focal || (spec.zoom && spec.zoom > 1));
    const rect = cropWindow(work.width, work.height, spec.aspect, spec.focal, spec.zoom);
    const outW = Math.max(2, Math.floor(Math.min(spec.outWidth, rect.width) / 2) * 2);
    const outH = Math.max(2, Math.round(outW * spec.aspect));
    let pipeline = sharp(work.buf);
    let luma = work.lowerLuma;
    if (hasFocal) {
      pipeline = pipeline.extract(rect).resize({ width: outW, height: outH, fit: "fill" });
      luma = await lumaOf(work.buf, { left: rect.left, top: rect.top + Math.round(rect.height * 0.55), width: rect.width, height: Math.max(1, Math.round(rect.height * 0.45)) });
    } else {
      pipeline = pipeline.resize({ width: outW, height: outH, fit: "cover", position: sharp.strategy.attention });
    }
    if (spec.scrim) {
      pipeline = pipeline.composite([{ input: scrimSvg(outW, outH, { from: spec.scrim.from, strength: scrimStrength(luma), solid: spec.scrim.solid }), top: 0, left: 0 }]);
    }
    const out = await pipeline
      .toColorspace("srgb")
      .jpeg({ quality: spec.quality, mozjpeg: true, progressive: spec.progressive !== false, chromaSubsampling: "4:2:0" })
      .toBuffer();
    return {
      dataUri: `data:image/jpeg;base64,${out.toString("base64")}`,
      width: outW,
      height: outH,
      sourceCropWidth: Math.round(rect.width),
      bytes: out.length,
      tone: await edgeTone(out, outW, outH),
    };
  } catch {
    return null;
  }
}

// --- which compositions a photo can carry -------------------------------------------------------

/**
 * How the cover can use a photo: "full" (the whole page, text over a navy scrim) needs a portrait or
 * square photograph with enough pixels; otherwise "plate" (a tall crop that fades into the navy
 * panel, cinematic rather than boxed) needs a smaller but still crisp crop. null = not good enough.
 */
export function coverModeFor(work: Pick<Work, "width" | "height">, photo?: { focal?: PhotoFocal | null; zoom?: number | null } | null): "full" | "plate" | null {
  const zoom = photo?.zoom;
  if (work.width / work.height <= COVER_PORTRAIT_MAX_ASPECT && cropPixels(work, ASPECT.page, zoom) >= COVER_FULL_MIN_PX) return "full";
  if (cropPixels(work, ASPECT.coverPlate, zoom) >= COVER_PLATE_MIN_PX) return "plate";
  return null;
}

/** Photo-quality rank used to order candidates for the cover and the chapter openers. */
export function qualityRank(card: CatalogueTripCard, work: Work | null): number {
  if (!work) return 0;
  const q = card.heroQuality;
  if (q === "weak" || q === "missing") return 0;
  if (q === "excellent") return 3;
  if (q === "good") return 2;
  return Math.min(work.width, work.height) >= 1100 ? 2 : 1; // unknown: judge by pixels
}

function isUsableHero(card: CatalogueTripCard, work: Work | null): work is Work {
  if (!work) return false;
  if (card.heroQuality === "weak" || card.heroQuality === "missing") return false;
  return cropPixels(work, ASPECT.plate, card.photo?.zoom) >= MIN_PRINT_CROP_PX;
}

export function compositionFit(card: CatalogueTripCard, hero: Work | null, second: Work | null, opts: { avoidCinema?: boolean } = {}): CompositionFit {
  if (!isUsableHero(card, hero)) return { hasHero: false, cinema: false, plate: false, panorama: false, diptych: false };
  const zoom = card.photo?.zoom;
  const hasFocal = !!card.photo?.focal;
  const srcAspect = hero.width / hero.height;
  const cinemaPx = cropPixels(hero, ASPECT.page, zoom);
  const cinemaOk = cinemaPx >= CINEMA_MIN_CROP_PX && (hasFocal || srcAspect <= 1.05 || hero.height >= 1600);
  const panoramaOk = srcAspect >= 1.2 && cropPixels(hero, ASPECT.panorama, zoom) >= PANORAMA_MIN_CROP_PX;
  const diptychOk = !!second && cropPixels(second, ASPECT.inset) >= INSET_MIN_CROP_PX && cropPixels(hero, ASPECT.diptych, zoom) >= 700;
  // Owner (launch week 2): ONE consistent trip page - the full-bleed photo that darkens by itself toward the
  // bottom, text on the photo - at the new 4:5 page. A photo too small for the whole page falls back to the
  // plate; the other compositions are retired.
  void panoramaOk; void diptychOk;
  return { hasHero: true, cinema: cinemaOk, plate: true, panorama: false, diptych: false };
}

// --- the whole book's art ------------------------------------------------------------------------

/** Which page printed which source photograph (thumbnails excluded). A URL listed twice is a visible repeat. */
export type PhotoUse = { url: string; role: string };

export type PreparedArt = Pick<RenderAssets, "trips" | "cover" | "chapters" | "closing"> & { warnings: CatalogueWarning[]; uses: PhotoUse[] };

async function pool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(runners);
}

/** A tiny memo: one fetch + decode per URL, however many compositions use it. */
function workLoader(fetcher: CatalogueImageFetcher) {
  const memo = new Map<string, Promise<Work | null>>();
  return (url: string): Promise<Work | null> => {
    let hit = memo.get(url);
    if (!hit) {
      hit = (async () => {
        try {
          const bytes = await fetcher(url);
          return bytes ? await loadWork(bytes) : null;
        } catch {
          return null;
        }
      })();
      memo.set(url, hit);
    }
    return hit;
  };
}

type Loaded = { card: CatalogueTripCard; hero: Work | null; gallery: { photo: CataloguePhoto; work: Work }[] };

function photoWarning(card: CatalogueTripCard, hero: Work | null, planned: boolean): CatalogueWarning | null {
  const base = { severity: "warning" as const, tripId: card.tripId, detail: { code: card.code } };
  if (!card.photo?.url) {
    return { ...base, code: "photo_missing", message: `${card.code}: батлагдсан зураг алга, хуудсанд бичвэрийн загвар тавилаа. Зураг нэмж дахин үүсгэнэ үү.` };
  }
  if (!hero) {
    return { ...base, code: "photo_fetch_failed", message: `${card.code}: зургийг татаж эсвэл боловсруулж чадсангүй, хуудсанд бичвэрийн загвар тавилаа.` };
  }
  if (card.heroQuality === "weak" || card.heroQuality === "missing") {
    return { ...base, code: "photo_low_resolution", message: `${card.code}: зураг тохиромжгүй (чанар сул) гэж тэмдэглэгдсэн тул хуудсанд бичвэрийн загвар тавилаа. Илүү сайн зураг сонгоно уу.` };
  }
  const crop = cropPixels(hero, ASPECT.plate, card.photo.zoom);
  if (crop < MIN_PRINT_CROP_PX) {
    return { ...base, code: "photo_low_resolution", message: `${card.code}: зургийн нягтрал хэт бага (${crop}px), хуудсанд бичвэрийн загвар тавилаа. Илүү сайн зураг сонгоно уу.`, detail: { code: card.code, cropWidthPx: crop } };
  }
  if (planned && crop < LOW_RESOLUTION_CROP_PX) {
    return { ...base, code: "photo_low_resolution", message: `${card.code}: зургийн нягтрал бага (${crop}px өргөн), утсан дээр бүдэгхэн харагдаж болно.`, detail: { code: card.code, cropWidthPx: crop } };
  }
  return null;
}

/**
 * Fetch and shape every photo the book prints. Failures become typographic pages plus warnings,
 * never exceptions. Deterministic for the same bytes: the same photos always give the same book.
 */
export async function prepareArt(
  snapshot: CatalogueSnapshot,
  plan: PagePlan = planPages(snapshot),
  fetcher: CatalogueImageFetcher = defaultImageFetcher,
): Promise<PreparedArt> {
  const profile = encodeProfileFor(snapshot.trips.length);
  const load = workLoader(fetcher);
  const ordered = orderTrips(snapshot).map(o => o.card);
  const warnings: CatalogueWarning[] = [];

  // 1. fetch + decode: hero and up to two gallery photos per trip (once per URL).
  const loaded = new Map<string, Loaded>();
  await pool(ordered, FETCH_CONCURRENCY, async card => {
    const hero = card.photo?.url ? await load(card.photo.url) : null;
    const gallery: Loaded["gallery"] = [];
    for (const photo of (card.gallery ?? []).slice(0, 2)) {
      if (!photo?.url || photo.url === card.photo?.url) continue;
      const work = await load(photo.url);
      if (work) gallery.push({ photo, work });
    }
    loaded.set(card.tripId, { card, hero, gallery });
  });

  // 2. cover: an INVITATION, never a second copy of a trip page. In order of preference:
  //    (a) the staff / data layer's cover photograph (snapshot.coverPhoto, used by no trip page);
  //    (b) another good photograph of the cover trip (its gallery) that can carry the whole page;
  //    (c) the cover trip's hero, or the best hero available.
  const printable = (l: Loaded | undefined): l is Loaded & { hero: Work } => !!l && isUsableHero(l.card, l.hero);
  const heroUrls = new Set<string>();
  for (const l of loaded.values()) if (l.card.photo?.url) heroUrls.add(l.card.photo.url);
  const sourceUrls = new Map<string, string>(); // url -> what it was used for, so no photo opens two spreads
  const uses: PhotoUse[] = [];
  const claim = (url: string, role: string) => {
    sourceUrls.set(url, role);
    uses.push({ url, role });
  };
  type CoverSrc = { work: Work; photo: Pick<CataloguePhoto, "url" | "focal" | "zoom" | "credit">; tripId: string | null; source: "cover_photo" | "gallery" | "hero" };
  const coverSources: CoverSrc[] = [];
  const dedicated = snapshot.coverPhoto?.url ? snapshot.coverPhoto : null;
  if (dedicated && !heroUrls.has(dedicated.url)) {
    const work = await load(dedicated.url);
    if (work) coverSources.push({ work, photo: dedicated, tripId: null, source: "cover_photo" });
  }
  const tripOrder = [
    ...(snapshot.coverTripId ? [loaded.get(snapshot.coverTripId)] : []),
    ...[...loaded.values()].sort((a, b) => qualityRank(b.card, b.hero) - qualityRank(a.card, a.hero) || (b.hero?.height ?? 0) - (a.hero?.height ?? 0)),
  ].filter((l): l is Loaded => !!l);
  for (const l of tripOrder) {
    if (l.card.heroQuality === "weak" || l.card.heroQuality === "missing") continue;
    for (const g of l.gallery) {
      if (!heroUrls.has(g.photo.url)) coverSources.push({ work: g.work, photo: g.photo, tripId: l.card.tripId, source: "gallery" });
    }
    if (printable(l) && l.card.photo) coverSources.push({ work: l.hero, photo: l.card.photo, tripId: l.card.tripId, source: "hero" });
  }
  // The dedicated photograph wins. Otherwise: a photograph that can carry the whole page beats one that
  // only fits the plate, another photograph of the cover trip beats its hero (no duplicate on its own
  // page), and the cover trip beats any other trip. Ties keep the order above (stable sort).
  const modeOf = (c: CoverSrc) => coverModeFor(c.work, c.photo);
  const coverScore = (c: CoverSrc) =>
    (c.source === "cover_photo" ? 0 : 10) + (modeOf(c) === "full" ? 0 : 4) + (c.source === "hero" ? 2 : 0) + (c.tripId !== null && c.tripId !== snapshot.coverTripId ? 6 : 0);
  const pickedCover = coverSources.filter(c => modeOf(c) !== null).sort((x, y) => coverScore(x) - coverScore(y))[0] ?? null;
  let cover: PreparedArt["cover"] = null;
  if (pickedCover) {
    const p = pickedCover.photo;
    const mode = coverModeFor(pickedCover.work, p)!;
    const image = await cropImage(pickedCover.work, mode === "full"
      ? { aspect: ASPECT.page, outWidth: profile.fullWidth + 140, quality: profile.quality + 4, focal: p.focal, zoom: p.zoom, scrim: { from: 0.46 } }
      : { aspect: ASPECT.coverPlate, outWidth: profile.width + 80, quality: profile.quality + 4, focal: p.focal, zoom: p.zoom, scrim: { from: 0.5, solid: true } });
    if (image) {
      cover = { tripId: pickedCover.tripId, mode, image, credit: p.credit?.trim() || null, source: pickedCover.source };
      claim(p.url, "cover");
    }
  }

  // 3. chapter openers: a gallery photograph no other page uses, so an opener never repeats a trip
  //    page's picture. A chapter without one gets the typographic opener.
  const chapters: PreparedArt["chapters"] = {};
  const openerUsedHero = new Set<string>();
  if (plan.hasOpeners) {
    for (const chapter of plan.chapters) {
      if (chapter.openerPage == null) continue;
      type Cand = { tripId: string; work: Work; photo: CataloguePhoto; isGallery: boolean; rank: number; pos: number };
      const cands: Cand[] = [];
      chapter.trips.forEach((t, pos) => {
        const l = loaded.get(t.card.tripId);
        if (!l) return;
        if ((l.card.heroQuality ?? "good") !== "weak" && (l.card.heroQuality ?? "good") !== "missing") {
          for (const g of l.gallery) cands.push({ tripId: t.card.tripId, work: g.work, photo: g.photo, isGallery: true, rank: 2, pos });
        }
      });
      const scored = cands
        .filter(c => !sourceUrls.has(c.photo.url) && !heroUrls.has(c.photo.url) && cropPixels(c.work, ASPECT.page, c.photo.zoom) >= OPENER_MIN_CROP_PX)
        .map(c => ({ c, score: c.rank * 10_000 + (c.isGallery ? 6_000 : Math.min(c.pos, 3) * 700) + Math.min(cropPixels(c.work, ASPECT.page, c.photo.zoom), 1400) }))
        .sort((a, b) => b.score - a.score);
      const pick = scored[0]?.c;
      if (!pick) continue;
      const image = await cropImage(pick.work, { aspect: ASPECT.page, outWidth: profile.fullWidth, quality: profile.quality, focal: pick.photo.focal, zoom: pick.photo.zoom, scrim: { from: 0.4 } });
      if (image) {
        chapters[chapter.index] = { tripId: pick.tripId, image, credit: pick.photo.credit?.trim() || null };
        claim(pick.photo.url, `chapter-${chapter.index}`);
      }
    }
  }
  if (cover?.source === "hero" && cover.tripId) openerUsedHero.add(cover.tripId);
  // A gallery photograph already printed (cover, opener) must not come back as a trip's inset.
  for (const l of loaded.values()) l.gallery = l.gallery.filter(g => !sourceUrls.has(g.photo.url) && !heroUrls.has(g.photo.url));

  // 4. compositions for the trips, in book order, then each trip's crops.
  const fits: CompositionFit[] = plan.trips.map(t => {
    const l = loaded.get(t.card.tripId);
    return compositionFit(t.card, l?.hero ?? null, l?.gallery[0]?.work ?? null, { avoidCinema: openerUsedHero.has(t.card.tripId) });
  });
  const compositions = assignCompositions(fits);
  const trips: PreparedArt["trips"] = {};
  await pool(plan.trips.map((t, i) => ({ t, i })), 3, async ({ t, i }) => {
    const card = t.card;
    const l = loaded.get(card.tripId);
    const composition = compositions[i]!;
    const p = card.photo;
    const hero = l?.hero ?? null;
    const w = warnings;
    const warn = photoWarning(card, hero, true);
    if (warn) w.push(warn);
    if (composition === "type" || !hero || !p) {
      trips[card.tripId] = { composition: "type", hero: null, second: null, thumb: null };
      return;
    }
    const common = { focal: p.focal, zoom: p.zoom, quality: profile.quality };
    const heroImage =
      composition === "cinema"
        ? await cropImage(hero, { ...common, aspect: ASPECT.page, outWidth: profile.fullWidth, scrim: { from: 0.24 } })
        : composition === "panorama"
          ? await cropImage(hero, { ...common, aspect: ASPECT.panorama, outWidth: profile.width })
          : composition === "diptych"
            ? await cropImage(hero, { ...common, aspect: ASPECT.diptych, outWidth: profile.width })
            : await cropImage(hero, { ...common, aspect: ASPECT.plate, outWidth: profile.width });
    const g = l?.gallery[0];
    const second =
      composition === "diptych" && g ? await cropImage(g.work, { aspect: ASPECT.inset, outWidth: Math.round(profile.width * 0.55), quality: profile.quality, focal: g.photo.focal, zoom: g.photo.zoom }) : null;
    const thumb = await cropImage(hero, { aspect: ASPECT.thumb, outWidth: profile.thumb, quality: Math.max(70, profile.quality - 6), focal: p.focal, zoom: p.zoom, progressive: false });
    if (!heroImage) {
      w.push({ severity: "warning", code: "photo_fetch_failed", tripId: card.tripId, detail: { code: card.code }, message: `${card.code}: зургийг боловсруулж чадсангүй, хуудсанд бичвэрийн загвар тавилаа.` });
      trips[card.tripId] = { composition: "type", hero: null, second: null, thumb };
      return;
    }
    uses.push({ url: p.url, role: `trip-${card.code}` });
    if (second && g) claim(g.photo.url, `inset-${card.code}`);
    trips[card.tripId] = { composition: composition === "diptych" && !second ? "plate" : composition, hero: heroImage, second, thumb, tone: heroImage.tone } satisfies TripArt;
  });

  // 5. closing band: a calm wide crop of a gallery photograph no page has used. No such photograph
  //    means a plain brand band, never a repeat of the cover or a trip page.
  let closing: RenderImage | null = null;
  const galleryPool: { work: Work; photo: CataloguePhoto; tripId: string }[] = [];
  const closingOrder = [...loaded.values()].sort((x, y) => Number(y.card.tripId === cover?.tripId) - Number(x.card.tripId === cover?.tripId));
  for (const l of closingOrder) {
    if (l.card.heroQuality === "weak" || l.card.heroQuality === "missing") continue;
    for (const g of l.gallery) {
      if (!sourceUrls.has(g.photo.url) && cropPixels(g.work, ASPECT.closing, g.photo.zoom) >= 900) galleryPool.push({ work: g.work, photo: g.photo, tripId: l.card.tripId });
    }
  }
  const band = galleryPool[0];
  if (band) {
    closing = await cropImage(band.work, { aspect: ASPECT.closing, outWidth: profile.width, quality: profile.quality, focal: band.photo.focal, zoom: band.photo.zoom });
    if (closing) claim(band.photo.url, "closing");
  }

  // Deterministic warning order regardless of fetch completion order.
  const order = new Map(ordered.map((c, i) => [c.tripId, i] as const));
  warnings.sort((a, b) => (order.get(a.tripId ?? "") ?? 0) - (order.get(b.tripId ?? "") ?? 0));
  return { trips, cover, chapters, closing, warnings, uses };
}
