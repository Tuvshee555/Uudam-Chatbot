import { createHash, randomUUID } from "crypto";
import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { getEnv } from "@/lib/env";
import { logError, logInfo } from "@/lib/observability";
import { getTripById, patchTrip, upsertTrip } from "@/lib/travelDb";
import type { TripMutationFields } from "@/lib/travelTypes";
import { dedupePhotoUrlsByContent } from "@/lib/tripPhotoImport/dedupePhotos";

// Only route_name/duration_text/departure_dates/adult_price/child_price/
// hotel/has_food/extra may be written by "Аялалд нэмэх" (the poster→trip
// field sync) — each is explicitly type-checked below so a malformed client
// payload can't touch unrelated trip columns.
function sanitizeApprovedFields(input: unknown): TripMutationFields {
  if (!input || typeof input !== "object") return {};
  const source = input as Record<string, unknown>;
  const fields: TripMutationFields = {};

  if (typeof source.route_name === "string") fields.route_name = source.route_name;
  if (typeof source.duration_text === "string") fields.duration_text = source.duration_text;
  if (Array.isArray(source.departure_dates)) {
    fields.departure_dates = source.departure_dates.filter((d): d is string => typeof d === "string");
  }
  if (typeof source.adult_price === "number") fields.adult_price = source.adult_price;
  if (typeof source.child_price === "number") fields.child_price = source.child_price;
  if (typeof source.hotel === "string") fields.hotel = source.hotel;
  if (typeof source.has_food === "boolean") fields.has_food = source.has_food;
  if (source.extra && typeof source.extra === "object") {
    const extraSource = source.extra as Record<string, unknown>;
    const extra: Record<string, unknown> = {};
    if (Array.isArray(extraSource.included_items)) {
      extra.included_items = extraSource.included_items.filter((v): v is string => typeof v === "string");
    }
    if (Array.isArray(extraSource.excluded_items)) {
      extra.excluded_items = extraSource.excluded_items.filter((v): v is string => typeof v === "string");
    }
    if (Object.keys(extra).length) fields.extra = extra;
  }
  return fields;
}

const CLOUDINARY_FOLDER = "uudam-travel-trips";
const MAX_PHOTOS = 20;
const MAX_IMAGES_PER_SYNC = 10;

export type PosterSyncPhotoInput = {
  dataUrl?: string;
  url?: string;
  filename: string;
};

export type PosterSyncPdfInput = {
  dataUrl?: string;
  url?: string;
  filename: string;
};

export function normalizePosterSyncPhotos(rawPhotos: unknown): PosterSyncPhotoInput[] {
  return (Array.isArray(rawPhotos) ? rawPhotos : [])
    .filter(
      (p): p is PosterSyncPhotoInput =>
        p &&
        typeof p === "object" &&
        typeof (p as PosterSyncPhotoInput).filename === "string" &&
        (typeof (p as PosterSyncPhotoInput).dataUrl === "string" ||
          typeof (p as PosterSyncPhotoInput).url === "string"),
    )
    .slice(0, MAX_IMAGES_PER_SYNC);
}

function normalizePosterSyncPdf(rawPdf: unknown): PosterSyncPdfInput | null {
  if (!rawPdf || typeof rawPdf !== "object") return null;
  const pdf = rawPdf as PosterSyncPdfInput;
  if (typeof pdf.filename !== "string" || !pdf.filename.trim()) return null;
  if (typeof pdf.dataUrl !== "string" && typeof pdf.url !== "string") return null;
  return {
    filename: pdf.filename.endsWith(".pdf") ? pdf.filename : `${pdf.filename}.pdf`,
    ...(typeof pdf.dataUrl === "string" ? { dataUrl: pdf.dataUrl } : {}),
    ...(typeof pdf.url === "string" ? { url: pdf.url } : {}),
  };
}

// Poster PDFs and legacy poster PNGs are well over the default 1MB body limit.
// Raise it so the admin can attach the finished poster without a proxy step.
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

async function resolvePosterSyncPhoto(photo: PosterSyncPhotoInput): Promise<string> {
  if (photo.url) {
    const parsed = new URL(photo.url);
    if (parsed.protocol !== "https:") {
      throw new Error(`Зурагны URL зөвхөн https байх ёстой: ${parsed.protocol}`);
    }
    return parsed.toString();
  }
  if (photo.dataUrl) {
    return uploadBase64ToCloudinary(photo.dataUrl, photo.filename);
  }
  throw new Error("Зурагны мэдээлэл алга");
}

async function uploadPdfDataUrlToCloudinary(dataUrl: string, fileName: string): Promise<string> {
  const env = getEnv();
  if (!env.cloudinaryCloudName || !env.cloudinaryApiKey || !env.cloudinaryApiSecret) {
    throw new Error("Cloudinary тохиргоо дутуу байна");
  }

  const sepIdx = dataUrl.indexOf(";base64,");
  const mimePrefix = dataUrl.indexOf("data:") === 0 && sepIdx > 5 ? dataUrl.slice(5, sepIdx) : "";
  if (mimePrefix !== "application/pdf") throw new Error(`PDF формат буруу: ${fileName}`);
  const base64Body = dataUrl.slice(sepIdx + 8);
  if (!base64Body) throw new Error(`PDF формат буруу: ${fileName}`);

  const timestamp = Math.round(Date.now() / 1000);
  const paramsToSign = `folder=${CLOUDINARY_FOLDER}&timestamp=${timestamp}`;
  const signature = createHash("sha256")
    .update(paramsToSign + env.cloudinaryApiSecret)
    .digest("hex");
  const buffer = Buffer.from(base64Body, "base64");
  if (buffer.length < 4 || buffer.slice(0, 4).toString("ascii") !== "%PDF") {
    throw new Error(`PDF файл буруу байна: ${fileName}`);
  }

  const formData = new FormData();
  formData.append("file", new Blob([new Uint8Array(buffer)], { type: "application/pdf" }), fileName);
  formData.append("api_key", env.cloudinaryApiKey);
  formData.append("timestamp", String(timestamp));
  formData.append("signature", signature);
  formData.append("folder", CLOUDINARY_FOLDER);

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${env.cloudinaryCloudName}/raw/upload`,
    { method: "POST", body: formData },
  );
  const json = (await res.json()) as { secure_url?: string; error?: { message?: string } };
  if (!res.ok || !json.secure_url) {
    throw new Error(json.error?.message ?? "PDF Cloudinary-д оруулахад алдаа гарлаа");
  }
  return json.secure_url;
}

async function resolvePosterSyncPdf(pdf: PosterSyncPdfInput): Promise<string> {
  if (pdf.url) {
    const parsed = new URL(pdf.url);
    if (parsed.protocol !== "https:") {
      throw new Error(`PDF URL зөвхөн https байх ёстой: ${parsed.protocol}`);
    }
    return parsed.toString();
  }
  if (pdf.dataUrl) return uploadPdfDataUrlToCloudinary(pdf.dataUrl, pdf.filename);
  throw new Error("PDF мэдээлэл алга");
}

/**
 * Writes a poster PDF (plus legacy poster images when supplied) to ONE explicit trip. The caller (poster app) has
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
    pdf?: unknown;
    fields?: unknown;
  };

  const tripId = typeof body.tripId === "string" && body.tripId.trim() ? body.tripId.trim() : null;
  const createNew = body.createNew === true;
  const newTripTitle =
    typeof body.newTripTitle === "string" ? body.newTripTitle.trim() : "";
  const mode = body.mode === "append" ? "append" : body.mode === "skip" ? "skip" : "replace";
  const approvedFields = sanitizeApprovedFields(body.fields);

  if (!tripId && !createNew) {
    return res.status(400).json({ error: "tripId эсвэл createNew шаардлагатай" });
  }
  if (createNew && !newTripTitle) {
    return res.status(400).json({ error: "Шинэ аялалын нэр хоосон байна" });
  }

  const photos = normalizePosterSyncPhotos(body.photos);
  const pdf = normalizePosterSyncPdf(body.pdf);

  const hasFieldsToWrite = Object.keys(approvedFields).length > 0;
  if (!pdf && photos.length === 0 && !hasFieldsToWrite && !createNew) {
    return res.status(400).json({ error: "Шинэчлэх PDF, зураг эсвэл мэдээлэл алга" });
  }

  // Resolve the target trip up-front so we never upload files for a missing
  // existing trip. For new trips, delay the DB insert until after images are
  // resolved so a Cloudinary outage cannot leave an empty draft behind.
  let targetTripId = tripId;
  let targetName = createNew ? newTripTitle : "";
  let existingUrls: string[] = [];

  if (createNew) {
    targetTripId = randomUUID();
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
    hasPdf: Boolean(pdf),
    fieldKeys: Object.keys(approvedFields),
  });

  // Resolve files FIRST. Data URLs are uploaded to Cloudinary; hosted URLs
  // (from the production client-side Blob upload) are reused directly. We only
  // touch legacy photo_urls if at least one image resolves, so a failed image
  // step can never blank out a trip's photos. Field updates are independent.
  const uploadedUrls: string[] = [];
  let uploadedPdfUrl = "";
  const failures: Array<{ filename: string; error: string }> = [];

  if (pdf) {
    try {
      uploadedPdfUrl = await resolvePosterSyncPdf(pdf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "PDF байршуулахад алдаа гарлаа";
      logError("poster_sync.pdf_failure", { filename: pdf.filename, error: msg });
      return res.status(500).json({ error: msg });
    }
  }

  const resolvedPhotos: Array<{ url?: string; failure?: { filename: string; error: string } }> =
    await Promise.all(
      photos.map(async (photo) => {
        try {
          return { url: await resolvePosterSyncPhoto(photo) };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Зураг байршуулахад алдаа гарлаа";
          logError("poster_sync.upload_failure", { filename: photo.filename, error: msg });
          return { failure: { filename: photo.filename, error: msg } };
        }
      }),
    );
  uploadedUrls.push(
    ...resolvedPhotos
      .map((result) => result.url)
      .filter((url): url is string => Boolean(url)),
  );
  failures.push(
    ...resolvedPhotos
      .map((result) => result.failure)
      .filter((failure): failure is { filename: string; error: string } => Boolean(failure)),
  );

  if (photos.length > 0 && uploadedUrls.length === 0) {
    return res.status(500).json({
      error: "Нэг ч зураг Cloudinary-д орсонгүй",
      failures,
    });
  }

  const patchFields: TripMutationFields = { ...approvedFields };
  if (uploadedPdfUrl) {
    patchFields.extra = {
      ...(patchFields.extra || {}),
      brochure_pdf_url: uploadedPdfUrl,
      brochure_pdf_required: true,
      brochure_pdf_missing: false,
    };
    patchFields.photo_urls = [];
  }
  if (uploadedUrls.length > 0 && mode !== "skip") {
    // Appending a re-exported poster would otherwise stack a second copy of the
    // same pages under new Cloudinary ids, and the bot sends the customer both.
    const merged =
      mode === "append"
        ? await dedupePhotoUrlsByContent([...existingUrls, ...uploadedUrls])
        : uploadedUrls;
    patchFields.photo_urls = merged.slice(0, MAX_PHOTOS);
  }

  if (createNew) {
    const approvedRouteName =
      typeof patchFields.route_name === "string" ? patchFields.route_name.trim() : "";
    const created = await upsertTrip({
      id: targetTripId as string,
      fields: {
        ...patchFields,
        route_name: approvedRouteName || newTripTitle,
        status: "draft",
      },
    });
    if (!created) {
      return res.status(500).json({ error: "Шинэ аялал үүсгэж чадсангүй" });
    }
    targetTripId = created.id;
    targetName = created.route_name;
  }

  const patched = createNew
    ? true
    : Object.keys(patchFields).length
      ? await patchTrip(targetTripId as string, patchFields)
      : true;

  if (!patched) {
    return res.status(500).json({ error: "Аялалыг хадгалж чадсангүй" });
  }

  logInfo("poster_sync.done", {
    targetTripId,
    targetName,
    mode,
    uploaded: uploadedUrls.length,
    pdfUrl: uploadedPdfUrl || undefined,
    failed: failures.length,
    total: patchFields.photo_urls?.length,
    fieldsWritten: Object.keys(approvedFields),
  });

  // Expand "extra" into its child field names so the client's success
  // message shows "Багтсан зүйлс" etc. instead of leaking the raw key.
  const fieldsWritten = Object.keys(approvedFields).flatMap((key) =>
    key === "extra" && approvedFields.extra
      ? Object.keys(approvedFields.extra)
      : [key],
  );

  return res.status(200).json({
    ok: true,
    tripId: targetTripId,
    tripName: targetName,
    created: createNew,
    mode,
    uploaded: uploadedUrls.length,
    pdfUrl: uploadedPdfUrl || undefined,
    failed: failures.length,
    fieldsWritten,
    totalPhotos: patchFields.photo_urls?.length ?? existingUrls.length,
    failures: failures.length > 0 ? failures : undefined,
  });
}
