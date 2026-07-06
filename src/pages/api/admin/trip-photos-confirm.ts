import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getTripById, patchTrip } from "../../../lib/travelDb";
import { deleteBatch, getBatch } from "../../../lib/tripPhotoImport/batchStore";
import {
  type ConfirmPayload,
  type ConfirmResultItem,
  MAX_PHOTOS_PER_TRIP,
} from "../../../lib/tripPhotoImport/types";
import { uploadImagesToCloudinary } from "../../../lib/tripPhotoImport/upload";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.trip-photos-confirm");
  if (!allowed) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const body = req.body as ConfirmPayload;
  if (!body?.batchId) {
    return res.status(400).json({ error: "batch_id_required" });
  }

  const batch = await getBatch(body.batchId);
  if (!batch) {
    return res.status(404).json({ error: "batch_not_found" });
  }

  const results: ConfirmResultItem[] = [];
  const skippedSet = new Set(body.skippedItemIds || []);
  const overrides = body.overrides || {};
  const targetItemIds = new Set(body.itemIds || []);

  for (const item of batch.items) {
    if (targetItemIds.size > 0 && !targetItemIds.has(item.id)) continue;
    if (skippedSet.has(item.id)) continue;

    const tripId = overrides[item.id] ?? item.match.tripId;
    const resultBase: ConfirmResultItem = {
      itemId: item.id,
      itemName: item.name,
      tripId,
      tripName: "",
      uploaded: 0,
      failed: 0,
      photoUrls: [],
    };

    if (!tripId) {
      resultBase.error = "Аялал сонгоогүй тул алгаслаа";
      results.push(resultBase);
      continue;
    }

    const trip = await getTripById(tripId);
    if (!trip) {
      resultBase.error = "Аялал олдсонгүй";
      results.push(resultBase);
      continue;
    }
    resultBase.tripName = trip.route_name;

    if (item.images.length === 0) {
      resultBase.error = "Зураг олдоогүй";
      results.push(resultBase);
      continue;
    }

    const { urls, failures } = await uploadImagesToCloudinary(
      item.images.map((img) => ({
        buffer: img.buffer,
        fileName: img.fileName,
        mimeType: img.mimeType,
      })),
    );

    resultBase.uploaded = urls.length;
    resultBase.failed = failures.length;

    if (urls.length === 0) {
      resultBase.error = failures.map((f) => `${f.fileName}: ${f.error}`).join("; ") || "Upload failed";
      results.push(resultBase);
      continue;
    }

    const existing = Array.isArray(trip.photo_urls) ? trip.photo_urls : [];
    const nextUrls =
      body.mode === "replace"
        ? urls
        : Array.from(new Set([...existing, ...urls]));
    const trimmed = nextUrls
      .filter((url): url is string => typeof url === "string" && url.startsWith("https://"))
      .slice(0, MAX_PHOTOS_PER_TRIP);

    try {
      await patchTrip(trip.id, { photo_urls: trimmed });
      resultBase.photoUrls = urls;
    } catch (err) {
      resultBase.error = err instanceof Error ? err.message : "Database update failed";
      resultBase.uploaded = 0;
      resultBase.failed = item.images.length;
    }

    results.push(resultBase);
  }

  // Only delete the batch when processing the full set in one call.
  if (targetItemIds.size === 0) {
    await deleteBatch(body.batchId);
  }

  return res.status(200).json({ results });
}
