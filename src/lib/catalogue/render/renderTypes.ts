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
};

export type RenderAssets = {
  /** Empty in unit tests that never open a browser. */
  fonts: RenderFontFace[];
  /** The agency's original logo file, byte for byte, as a data URI. */
  logoDataUri: string;
  /** Per trip id: the hero crop for the trip page, or null when the photo is missing/unusable. */
  heroes: Record<string, RenderImage | null>;
  /** Optional dedicated crop for the cover and the trip it was taken from. */
  cover: { tripId: string; image: RenderImage } | null;
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
