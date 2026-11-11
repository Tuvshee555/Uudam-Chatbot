/**
 * Types private to the catalogue renderer. The shared contract (snapshot in, RenderedCatalogue out)
 * lives in ../types.ts; nothing here leaks into other modules except through render/index.ts.
 */

export type RenderFontFace = {
  family: string;
  weight: number;
  style: "normal" | "italic";
  /** data:font/ttf;base64,... Chromium only ever sees data: URLs. */
  dataUri: string;
};

/** A photo already cropped, resampled and JPEG-encoded for the page it will sit on. */
export type RenderImage = {
  dataUri: string;
  width: number;
  height: number;
  /** Pixel width of the crop taken from the source (before any resampling), for the low-resolution check. */
  sourceCropWidth: number;
  bytes: number;
  /** Dark tone taken from the photo's own lower edge (hex), for the page panel that continues the picture. */
  tone?: string;
};

/**
 * The page compositions of a trip. Chosen per trip from the photo's shape, resolution and the
 * rhythm of the pages around it (see assignCompositions in layout.ts).
 *
 *  cinema    full-bleed photo, the title set directly on it (a scrim is baked into the JPEG)
 *  plate     large photo on top, ivory editorial panel below
 *  panorama  headline on ivory, a wide photo band through the middle, details below
 *  diptych   large photo plus one carefully placed second photo of the same trip
 *  type      no usable photo: a typographic page (never a stretched or soft picture)
 */
export type TripComposition = "cinema" | "plate" | "panorama" | "diptych" | "type";

/** Everything a trip page needs from its photos. */
export type TripArt = {
  composition: TripComposition;
  /** Cropped to the composition's photo box. null for "type". */
  hero: RenderImage | null;
  /** The inset photo of a diptych. */
  second: RenderImage | null;
  /** Square crop for the contents list. null = monogram tile. */
  thumb: RenderImage | null;
  /** The photo's own dark edge tone (hex): the panel under the photo continues it instead of a fixed navy. */
  tone?: string;
};

export type PhotoStats = {
  width: number;
  height: number;
  /** Mean luminance 0..1 of the lower 45% of the frame (where a title on the photo would sit). */
  lowerLuma: number;
};

export type RenderAssets = {
  /** Empty in unit tests that never open a browser. */
  fonts: RenderFontFace[];
  /** The agency's original logo file, byte for byte, as a data URI. */
  logoDataUri: string;
  /** Per trip id: the composition and the crops of its photos. Missing id = typographic page. */
  trips: Record<string, TripArt>;
  /**
   * The cover photograph. "full" = whole page under a navy scrim; "plate" = a tall crop that fades into
   * the navy panel. tripId is the trip it was taken from (null for the dedicated cover photograph);
   * source says which kind of photograph it is.
   */
  cover: { tripId: string | null; mode: "full" | "plate"; image: RenderImage; credit: string | null; source: "cover_photo" | "gallery" | "hero" } | null;
  /** Chapter opener photos by chapter index (0-based). Missing = typographic opener. */
  chapters: Record<number, { tripId: string; image: RenderImage; credit: string | null } | undefined>;
  /** Calm photo band on the closing page. */
  closing: RenderImage | null;
  /** Printed discreetly on the closing page and written to the PDF info. */
  versionLabel: string;
};

export type CatalogueImageFetcher = (url: string) => Promise<Buffer | Uint8Array | null>;

export type RenderCatalogueOptions = {
  /** Also produce one JPEG thumbnail per page (admin preview, phone-size QA). Default false. */
  pageImages?: boolean;
  /** Test seam / custom storage. Default: guarded https fetch. */
  imageFetcher?: CatalogueImageFetcher;
  /** Printed on the closing page and stored in the PDF info. Default "<edition> <contentHash[0..8]>". */
  versionLabel?: string;
};

export class CatalogueRenderError extends Error {
  readonly code: "browser_unavailable" | "render_failed" | "invalid_snapshot";
  constructor(code: CatalogueRenderError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CatalogueRenderError";
    this.code = code;
  }
}

/** An empty art set: every trip falls back to its typographic page. Used by browser-free tests. */
export function emptyArt(): Pick<RenderAssets, "trips" | "cover" | "chapters" | "closing"> {
  return { trips: {}, cover: null, chapters: {}, closing: null };
}
