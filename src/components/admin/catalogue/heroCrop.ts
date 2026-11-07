import type { CSSProperties } from "react";
import type { CataloguePhotoCandidate, CataloguePhotoQuality, PhotoFocal } from "@/lib/catalogue/types";

/** Pure helpers of the hero photo picker, kept out of the component so they are unit-tested. */

export const FOCAL_CENTER: PhotoFocal = { x: 0.5, y: 0.5 };
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;
export const TITLE_MAX = 80;

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function focalFromPointer(rect: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number): PhotoFocal {
  if (rect.width <= 0 || rect.height <= 0) return FOCAL_CENTER;
  return {
    x: Math.round(clamp((clientX - rect.left) / rect.width, 0, 1) * 1000) / 1000,
    y: Math.round(clamp((clientY - rect.top) / rect.height, 0, 1) * 1000) / 1000,
  };
}

/**
 * The 9:16 crop as CSS: the photo covers the page-shaped box, the focal point decides which part stays
 * (object-position), and the zoom scales it around that same point. The renderer uses the same model, so the
 * preview is what the page shows.
 */
export function cropStyle(focal: PhotoFocal | null | undefined, zoom: number | null | undefined): CSSProperties {
  const f = focal ?? FOCAL_CENTER;
  const x = `${(clamp(f.x, 0, 1) * 100).toFixed(1)}%`;
  const y = `${(clamp(f.y, 0, 1) * 100).toFixed(1)}%`;
  const scale = clamp(zoom ?? 1, ZOOM_MIN, ZOOM_MAX);
  return { width: "100%", height: "100%", objectFit: "cover", objectPosition: `${x} ${y}`, transformOrigin: `${x} ${y}`, transform: scale === 1 ? undefined : `scale(${scale})` };
}

export const QUALITY_LABEL: Record<CataloguePhotoQuality, string> = {
  excellent: "Маш сайн зураг",
  good: "Сайн зураг",
  weak: "Сул зураг",
  missing: "Зураггүй",
};

export const needsNewPhoto = (quality: CataloguePhotoQuality) => quality === "weak" || quality === "missing";

export function sizeLabel(candidate: Pick<CataloguePhotoCandidate, "width" | "height">): string {
  return candidate.width && candidate.height ? `${candidate.width}×${candidate.height}px` : "хэмжээ тодорхойгүй";
}

export type HeroDraft = { url: string | null; focal: PhotoFocal; zoom: number; title: string };

export function draftOf(chosen: { url: string; focal?: PhotoFocal | null; zoom?: number | null } | null, titleOverride: string | null, fallbackUrl: string | null): HeroDraft {
  return { url: chosen?.url ?? fallbackUrl, focal: chosen?.focal ?? FOCAL_CENTER, zoom: chosen?.zoom ?? 1, title: titleOverride ?? "" };
}

/** Differs from what is stored (or, with nothing stored, from the automatic first candidate at the centre, no zoom). */
export function heroChanged(draft: HeroDraft, chosen: { url: string; focal?: PhotoFocal | null; zoom?: number | null } | null, automaticUrl: string | null = null): boolean {
  if (!draft.url) return false;
  const base = chosen ?? { url: automaticUrl ?? "", focal: FOCAL_CENTER, zoom: 1 };
  const f = base.focal ?? FOCAL_CENTER;
  return draft.url !== base.url || Math.abs(draft.focal.x - f.x) > 0.0005 || Math.abs(draft.focal.y - f.y) > 0.0005 || Math.abs(draft.zoom - (base.zoom ?? 1)) > 0.004;
}

export const titleChanged = (draft: HeroDraft, titleOverride: string | null) => draft.title.trim() !== (titleOverride ?? "");
