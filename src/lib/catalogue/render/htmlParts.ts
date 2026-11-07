/**
 * Small shared pieces of the catalogue HTML: escaping, URL and image checks, footers, the px
 * conversion used by the in-browser fit pass. Pure and browser-free.
 */
import { pad2 } from "./layout";
import type { RenderAssets, RenderImage } from "./renderTypes";

const PX_PER_PT = 4 / 3;
export const px = (pt: number) => Math.round(pt * PX_PER_PT * 100) / 100;

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Only absolute http(s) URLs may become links; anything else is dropped. */
export function safeHref(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Image sources are produced by our own pipeline; refuse anything that is not a plain data URI. */
export function safeImageSrc(dataUri: string): string {
  return /^data:image\/(?:jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(dataUri) ? dataUri : "";
}

export function imageTag(img: RenderImage | null | undefined, alt: string, cls = ""): string {
  if (!img) return "";
  const src = safeImageSrc(img.dataUri);
  return src ? `<img${cls ? ` class="${cls}"` : ""} src="${src}" width="${img.width}" height="${img.height}" alt="${escapeHtml(alt)}">` : "";
}

/** The agency's original logo, untouched, on a clean paper tile. */
export function logoTile(assets: RenderAssets, extraClass = ""): string {
  const src = safeImageSrc(assets.logoDataUri);
  return `<div class="tile${extraClass ? ` ${extraClass}` : ""}">${src ? `<img class="logo" src="${src}" alt="UUDAM Travel Agency">` : ""}</div>`;
}

export type FootOptions = {
  page: number;
  total: number;
  /** Link back to the contents. */
  back: boolean;
  /** Middle text (a photo credit); empty for none. */
  credit?: string;
  brand?: boolean;
};

export function footHtml(o: FootOptions): string {
  const left = o.back ? `<a class="back" href="#contents">Агуулга</a>` : o.brand ? `<span class="brand">UUDAM Travel</span>` : `<span></span>`;
  return `<footer class="foot">${left}<span class="credit">${o.credit ? `Фото: ${escapeHtml(o.credit)}` : ""}</span><span class="pn">${pad2(o.page)} / ${pad2(o.total)}</span></footer>`;
}

/** Distinct, non-empty credits joined for a footer line. */
export function creditLine(credits: Array<string | null | undefined>): string {
  const seen: string[] = [];
  for (const c of credits) {
    const t = (c ?? "").trim();
    if (t && !seen.includes(t)) seen.push(t);
  }
  return seen.join("; ");
}
