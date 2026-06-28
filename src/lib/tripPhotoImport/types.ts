import type { TravelTrip } from "../travelTypes";

export type ImportImage = {
  id: string;
  fileName: string;
  originalName: string;
  mimeType: string;
  size: number;
  buffer: Buffer;
  sha256: string;
  sequence?: number;
};

export type ImportItem = {
  id: string;
  name: string;
  sourceType: "zip" | "folder" | "image";
  images: ImportImage[];
  imageCount: number;
  error?: string;
};

export type MatchConfidence = "high" | "medium" | "low" | "none";

export type MatchResult = {
  tripId: string | null;
  tripName: string;
  confidence: MatchConfidence;
  score: number;
  matchedBy: "exact" | "alias" | "fuzzy" | "ai" | "manual" | "none";
  reason: string;
};

export type PreviewImportItem = ImportItem & {
  match: MatchResult;
  duplicateImageIds: string[];
  duplicateTripItemIds: string[];
};

export type BatchState = {
  id: string;
  createdAt: number;
  items: PreviewImportItem[];
  trips: TravelTrip[];
};

export type MergeMode = "append" | "replace";

export type ConfirmPayload = {
  batchId: string;
  mode: MergeMode;
  overrides: Record<string, string | null>;
  skippedItemIds: string[];
  /** Process only the listed item ids. When omitted, all non-skipped items are processed. */
  itemIds?: string[];
};

export type ConfirmResultItem = {
  itemId: string;
  itemName: string;
  tripId: string | null;
  tripName: string;
  uploaded: number;
  failed: number;
  photoUrls: string[];
  error?: string;
};

export const MAX_PHOTOS_PER_TRIP = 50;
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;
export const BATCH_TTL_MS = 60 * 60 * 1000;
export const MAX_BATCH_TOTAL_BYTES = 500 * 1024 * 1024;

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

export function isImageFileName(name: string): boolean {
  const lower = name.trim().toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot <= 0) return false;
  return IMAGE_EXTENSIONS.has(lower.slice(dot));
}

export function getMimeType(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}
