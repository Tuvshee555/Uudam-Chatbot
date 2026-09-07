import type { NextApiRequest, NextApiResponse } from "next";
import { del } from "@vercel/blob";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { listTrips } from "../../../lib/travelDb";
import { createBatch, setBatchItems } from "../../../lib/tripPhotoImport/batchStore";
import {
  buildImportItemsFromRawFiles,
  parseMultipartFiles,
  type ExtractResult,
  type RawFile,
} from "../../../lib/tripPhotoImport/extract";
import { matchImportItemToTripsWithAI } from "../../../lib/tripPhotoImport/match";
import {
  MAX_BATCH_TOTAL_BYTES,
  type PreviewImportItem,
  type MatchResult,
} from "../../../lib/tripPhotoImport/types";

export const config = {
  api: {
    bodyParser: false,
  },
  maxDuration: 60,
};

type BlobFileRef = { blobUrl: string; filename: string; mimeType: string };

function readJsonBody(req: NextApiRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Large batches (a whole trip's photo folder, easily tens of MB) can't be
 * posted directly to this function — Vercel rejects any serverless request
 * body over ~4.5MB with a plain-text 413 before the handler even runs. For
 * those the browser uploads straight to Vercel Blob first and only sends us
 * the resulting URLs here, so we fetch the bytes server-side instead.
 */
async function extractFromBlobUrls(refs: BlobFileRef[]): Promise<ExtractResult> {
  const blobUrls = refs.map((ref) => ref.blobUrl);
  try {
    let totalBytes = 0;
    const rawFiles: RawFile[] = await Promise.all(
      refs.map(async (ref) => {
        const res = await fetch(ref.blobUrl);
        if (!res.ok) throw new Error(`Файл татахад алдаа гарлаа: ${ref.filename}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        totalBytes += buffer.length;
        if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
          throw new Error("Batch too large");
        }
        return { fieldName: "files", fileName: ref.filename, mimeType: ref.mimeType, buffer };
      }),
    );
    return await buildImportItemsFromRawFiles(rawFiles);
  } finally {
    for (const blobUrl of blobUrls) {
      del(blobUrl).catch(() => {});
    }
  }
}

export function mergeMatchedImageItems(items: PreviewImportItem[]): PreviewImportItem[] {
  const merged: PreviewImportItem[] = [];
  const tripImageGroups = new Map<string, PreviewImportItem>();

  for (const item of items) {
    if (item.sourceType !== "image" || !item.match.tripId) {
      merged.push(item);
      continue;
    }

    const existing = tripImageGroups.get(item.match.tripId);
    if (!existing) {
      const group = {
        ...item,
        name: item.match.tripName || item.name,
        images: [...item.images],
        imageCount: item.images.length,
        error: item.error,
        duplicateImageIds: [...item.duplicateImageIds],
        duplicateTripItemIds: [],
      };
      tripImageGroups.set(item.match.tripId, group);
      merged.push(group);
      continue;
    }

    existing.images.push(...item.images);
    existing.images.sort((a, b) =>
      a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
    );
    existing.imageCount = existing.images.length;
    existing.duplicateImageIds = Array.from(
      new Set([...existing.duplicateImageIds, ...item.duplicateImageIds]),
    );
    existing.error = [existing.error, item.error].filter(Boolean).join("; ") || undefined;
  }

  return merged;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.trip-photos-preview");
  if (!allowed) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  try {
    const contentType = String(req.headers["content-type"] || "");
    const [trips, extracted] = await Promise.all([
      listTrips({ limit: 1000 }),
      contentType.includes("application/json")
        ? readJsonBody(req).then((body) => {
            const refs = Array.isArray(body.files)
              ? body.files.filter(
                  (file): file is BlobFileRef =>
                    Boolean(file) &&
                    typeof file === "object" &&
                    typeof (file as BlobFileRef).blobUrl === "string",
                )
              : [];
            return extractFromBlobUrls(refs);
          })
        : parseMultipartFiles(req),
    ]);

    if (extracted.items.length === 0) {
      return res.status(400).json({ error: "no_valid_images" });
    }

    // Deduplicate by file/folder name. If the user drops the same file twice,
    // keep the first occurrence and warn about the rest.
    const seenNames = new Set<string>();
    const dedupedItems: typeof extracted.items = [];
    for (const item of extracted.items) {
      const key = item.name.trim().toLowerCase();
      if (seenNames.has(key)) {
        extracted.errors.push(`Ижил нэртэй файл алгаслаа: ${item.name}`);
        continue;
      }
      seenNames.add(key);
      dedupedItems.push(item);
    }

    const batchId = await createBatch(trips);

    const matchedItems: PreviewImportItem[] = [];
    for (const item of dedupedItems) {
      const match: MatchResult = item.imageCount > 0
        ? await matchImportItemToTripsWithAI(item.name, trips)
        : {
            tripId: null,
            tripName: "",
            confidence: "none",
            score: 0,
            matchedBy: "none",
            reason: "Зураг олдоогүй",
          };
      matchedItems.push({
        ...item,
        match,
        duplicateImageIds: [],
        duplicateTripItemIds: [],
      });
    }

    const items = mergeMatchedImageItems(matchedItems);

    // Duplicate image detection across the whole batch
    const shaToImageIds = new Map<string, string[]>();
    for (const item of items) {
      for (const image of item.images) {
        const list = shaToImageIds.get(image.sha256) || [];
        list.push(image.id);
        shaToImageIds.set(image.sha256, list);
      }
    }
    for (const item of items) {
      for (const image of item.images) {
        const duplicates = shaToImageIds.get(image.sha256) || [];
        if (duplicates.length > 1) {
          item.duplicateImageIds.push(...duplicates.filter((id) => id !== image.id));
        }
      }
      item.duplicateImageIds = Array.from(new Set(item.duplicateImageIds));
    }

    // Duplicate trip detection
    const tripIdToItemIds = new Map<string, string[]>();
    for (const item of items) {
      if (item.match.tripId) {
        const list = tripIdToItemIds.get(item.match.tripId) || [];
        list.push(item.id);
        tripIdToItemIds.set(item.match.tripId, list);
      }
    }
    for (const item of items) {
      if (item.match.tripId) {
        const duplicates = tripIdToItemIds.get(item.match.tripId) || [];
        item.duplicateTripItemIds = duplicates.filter((id) => id !== item.id);
      }
    }

    await setBatchItems(batchId, items);

    const previewItems = items.map((item) => ({
      id: item.id,
      name: item.name,
      sourceType: item.sourceType,
      imageCount: item.imageCount,
      imageIds: item.images.map((img) => img.id),
      imageOriginalNames: item.images.map((img) => img.originalName),
      match: item.match,
      duplicateImageIds: item.duplicateImageIds,
      duplicateTripItemIds: item.duplicateTripItemIds,
      error: item.error,
    }));

    return res.status(200).json({
      batchId,
      items: previewItems,
      tripCount: trips.length,
      errors: extracted.errors,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    return res.status(500).json({ error: message });
  }
}
