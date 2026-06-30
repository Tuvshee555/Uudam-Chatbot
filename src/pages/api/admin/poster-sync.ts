import { createHash } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/observability";
import { findTripMatches, listTrips, patchTrip } from "@/lib/travelDb";

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
  const base64Match = [null, mimePrefix, dataUrl.slice(sepIdx + 8)] as const;
  if (!base64Match[2]) throw new Error(`Зурагны формат буруу: ${fileName}`);
  const mimeType = base64Match[1] as string;
  const buffer = Buffer.from(base64Match[2] as string, "base64");

  const formData = new FormData();
  const blob = new Blob([new Uint8Array(buffer)], { type: mimeType });
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster-sync");
  if (!allowed) return;

  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as {
    tripTitle?: unknown;
    photos?: unknown;
  };

  const tripTitle = typeof body.tripTitle === "string" ? body.tripTitle.trim() : "";
  if (!tripTitle) return res.status(400).json({ error: "tripTitle хоосон байна" });

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

  // Find matching trip (findTripMatches signature: trips, operatorName?, routeName?)
  const trips = await listTrips();
  const matches = findTripMatches(trips, undefined, tripTitle);

  if (matches.length === 0) {
    return res.status(404).json({
      error: `"${tripTitle}" нэртэй аялал олдсонгүй`,
      hint: "Аяллын нэр зөв эсэхийг шалгана уу",
    });
  }

  const bestMatch = matches[0];
  const tripId = bestMatch.id;
  const matchedName = bestMatch.route_name;

  logInfo("poster_sync.matched", { tripTitle, matchedName, tripId, photoCount: photos.length });

  // Upload each photo to Cloudinary
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

  // Replace photo_urls (always replace — poster is source of truth)
  const patched = await patchTrip(tripId, {
    photo_urls: uploadedUrls.slice(0, MAX_PHOTOS),
  });

  if (!patched) {
    return res.status(500).json({ error: "Аялалын зурагийг хадгалж чадсангүй" });
  }

  logInfo("poster_sync.done", { tripId, matchedName, uploaded: uploadedUrls.length, failed: failures.length });

  return res.status(200).json({
    ok: true,
    tripId,
    matchedName,
    uploaded: uploadedUrls.length,
    failed: failures.length,
    failures: failures.length > 0 ? failures : undefined,
  });
}
