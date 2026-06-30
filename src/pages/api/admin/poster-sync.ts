import { createHash, randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/observability";
import { getTripById, patchTrip, upsertTrip } from "@/lib/travelDb";

const CLOUDINARY_FOLDER = "uudam-travel-trips";
const MAX_PHOTOS = 20;
const MAX_IMAGES_PER_SYNC = 10;

// Poster PNGs (base64) are well over the default 1MB body limit. Raise it so
// 2-3 high-res poster slices fit in one JSON POST.
export const config = {
  api: {
    bodyParser: {
      sizeLimit: "25mb",
    },
    maxDuration: 60,
  },
};

// base64 data URL → Cloudinary upload, returns secure_url
async function uploadBase64ToCloudinary(
  dataUrl: string,
  fileName: string,
): Promise<string> {
  const env = getEnv();
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
    throw new Error("Cloudinary тохиргоо дутуу байна");
  }

  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = `folder=${CLOUDINARY_FOLDER}&timestamp=${timestamp}`;
  const signature = createHash("sha256")
    .update(paramsToSign + env.cloudinaryApiSecret)
    .digest("hex");

  // Strip the "data:image/...;base64," prefix and decode to Buffer
  const sepIdx = dataUrl.indexOf(";base64,");
  const mimePrefix = dataUrl.indexOf("data:") === 0 && sepIdx > 5 ? dataUrl.slice(5, sepIdx) : "";
  if (!mimePrefix.startsWith("image/")) throw new Error(`Зурагны формат буруу: ${fileName}`);
  const base64Body = dataUrl.slice(sepIdx + 8);
  if (!base64Body) throw new Error(`Зурагны формат буруу: ${fileName}`);
  const buffer = Buffer.from(base64Body, "base64");

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimePrefix });
  formData.append("file", blob, fileName);
  formData.append("api_key", env.cloudinaryApiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("folder", CLOUDINARY_FOLDER);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/image/upload`,
    { method: "POST", body: formData },
  );
  const json = (await res.json()) as { secure_url?: string; error?: { message?: string } };
  if (!res.ok || !json.secure_url) {
    throw new Error(json.error?.message ?? "Cloudinary upload амжилтгүй");
  }
  return json.secure_url;
}

/**
 * Writes poster images to ONE explicit trip. The caller (poster app) has
 * already shown the user a confirmation modal and chosen exactly what to do:
 *   - tripId set        → attach to that exact trip (no guessing)
 *   - createNew + title → create a brand-new trip from the poster title
 *   - mode "replace"    → overwrite photo_urls (default; poster is source of truth)
 *   - mode "append"     → add to existing photo_urls
 *
 * Nothing is matched or overwritten implicitly here — that decision lives in
 * the UI, so the bot can never "do stupid shit" behind the user's back.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster-sync");
  if (!allowed) return;

  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as {
    tripId?: unknown;
    createNew?: unknown;
    newTripTitle?: unknown;
    mode?: unknown;
    photos?: unknown;
  };

  const tripId = typeof body.tripId === "string" && body.tripId.trim() ? body.tripId.trim() : null;
  const createNew = body.createNew === true;
  const newTripTitle =
    typeof body.newTripTitle === "string" ? body.newTripTitle.trim() : "";
  const mode = body.mode === "append" ? "append" : "replace";

  if (!tripId && !createNew) {
    return res.status(400).json({ error: "tripId эсвэл createNew шаардлагатай" });
  }
  if (createNew && !newTripTitle) {
    return res.status(400).json({ error: "Шинэ аялалын нэр хоосон байна" });
  }

  const rawPhotos = Array.isArray(body.photos) ? body.photos : [];
  type PhotoInput = { dataUrl: string; filename: string };
  const photos: PhotoInput[] = rawPhotos
    .filter(
      (p): p is PhotoInput =>
        p &&
        typeof p === "object" &&
        typeof (p as PhotoInput).dataUrl === "string" &&
        typeof (p as PhotoInput).filename === "string",
    )
    .slice(0, MAX_IMAGES_PER_SYNC);

  if (photos.length === 0) {
    return res.status(400).json({ error: "photos хоосон байна" });
  }

  // Resolve the target trip up-front so we never upload images for a trip
  // that doesn't exist.
  let targetTripId = tripId;
  let targetName = "";
  let existingUrls: string[] = [];

  if (createNew) {
    const created = await upsertTrip({
      id: randomUUID(),
      fields: { route_name: newTripTitle, status: "draft" },
    });
    if (!created) {
      return res.status(500).json({ error: "Шинэ аялал үүсгэж чадсангүй" });
    }
    targetTripId = created.id;
    targetName = created.route_name;
  } else {
    const trip = await getTripById(tripId as string);
    if (!trip) {
      return res.status(404).json({ error: "Сонгосон аялал олдсонгүй (устсан байж магадгүй)" });
    }
    targetTripId = trip.id;
    targetName = trip.route_name;
    existingUrls = Array.isArray(trip.photo_urls) ? trip.photo_urls : [];
  }

  logInfo("poster_sync.start", {
    targetTripId,
    targetName,
    createNew,
    mode,
    photoCount: photos.length,
  });

  // Upload to Cloudinary FIRST. We only touch the DB if at least one succeeds,
  // so a failed upload can never blank out a trip's photos.
  const uploadedUrls: string[] = [];
  const failures: Array<{ filename: string; error: string }> = [];

  for (const photo of photos) {
    try {
      const url = await uploadBase64ToCloudinary(photo.dataUrl, photo.filename);
      uploadedUrls.push(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload failed";
      logError("poster_sync.upload_failure", { filename: photo.filename, error: msg });
      failures.push({ filename: photo.filename, error: msg });
    }
  }

  if (uploadedUrls.length === 0) {
    return res.status(500).json({
      error: "Нэг ч зураг Cloudinary-д орсонгүй",
      failures,
    });
  }

  const finalUrls =
    mode === "append"
      ? [...existingUrls, ...uploadedUrls].slice(0, MAX_PHOTOS)
      : uploadedUrls.slice(0, MAX_PHOTOS);

  const patched = await patchTrip(targetTripId as string, { photo_urls: finalUrls });
  if (!patched) {
    return res.status(500).json({ error: "Аялалын зурагийг хадгалж чадсангүй" });
  }

  logInfo("poster_sync.done", {
    targetTripId,
    targetName,
    mode,
    uploaded: uploadedUrls.length,
    failed: failures.length,
    total: finalUrls.length,
  });

  return res.status(200).json({
    ok: true,
    tripId: targetTripId,
    tripName: targetName,
    created: createNew,
    mode,
    uploaded: uploadedUrls.length,
    failed: failures.length,
    totalPhotos: finalUrls.length,
    failures: failures.length > 0 ? failures : undefined,
  });
}
