import type { NextApiRequest, NextApiResponse } from "next";
import { del } from "@vercel/blob";
import { requireAdminAccess } from "@/lib/adminAccess";
import { logError } from "@/lib/observability";
// Ported poster libs (plain JS, typed loosely via poster-libs.d.ts)
import { fileToImages, fileToText } from "@/lib/poster/parse";
import {
  extractTrip,
  extractTripFromImage,
  extractTripFromPdf,
} from "@/lib/poster/openai";
import { extractTripFromPdfGemini } from "@/lib/poster/gemini";
import { extractPdfImages } from "@/lib/poster/pdfImages";
import { applyDayText, applyMealMarks, extractPdfFacts } from "@/lib/poster/pdfMeals";

// Small files (<3MB) post directly as base64 JSON. Big files are uploaded to
// Vercel Blob first (see /api/admin/poster/upload) and we're just given the
// URL here — keeps this route's own body tiny regardless of document size.
export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } },
  maxDuration: 60,
};

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"];
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_IMAGES = 18;

type TripLike = { days?: Array<{ photo?: string | null }> };

function assignPhotos(trip: TripLike, extractedImages: string[]) {
  if (!trip?.days?.length || !extractedImages?.length) return;
  const images = extractedImages.slice(0, MAX_EXTRACTED_IMAGES);
  const dayCount = trip.days.length;
  const imageCount = images.length;
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const imageIndex =
      imageCount <= dayCount
        ? dayIndex
        : Math.round((dayIndex * (imageCount - 1)) / (dayCount - 1 || 1));
    if (images[imageIndex]) trip.days[dayIndex].photo = images[imageIndex];
  }
}

async function extractPdfTrip(b64: string, filename: string) {
  if (process.env.GEMINI_API_KEY) {
    try {
      return await extractTripFromPdfGemini(b64, filename);
    } catch (err) {
      logError("poster.extract.gemini_failed", { error: String((err as Error).message) });
    }
  }
  return extractTripFromPdf(b64, filename);
}

async function runExtraction(buffer: Buffer, filename: string, mime: string) {
  const name = filename.toLowerCase();

  if (IMAGE_TYPES.includes(mime) || /\.(jpe?g|png|webp|gif|bmp)$/.test(name)) {
    const b64 = buffer.toString("base64");
    const trip = await extractTripFromImage(b64, mime || "image/jpeg");
    return { trip, source_file: filename };
  }

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    const b64 = buffer.toString("base64");
    const [trip, pdfImages, pdfFacts] = await Promise.all([
      extractPdfTrip(b64, filename),
      extractPdfImages(buffer),
      extractPdfFacts(buffer),
    ]);
    applyDayText(trip, pdfFacts.days);
    applyMealMarks(trip, pdfFacts.meals);
    assignPhotos(trip, pdfImages);
    return { trip, source_file: filename };
  }

  // docx / txt
  const text = await fileToText(buffer, filename);
  if (!text || text.trim().length < 20) {
    throw new Error("Файлаас текст уншиж чадсангүй.");
  }
  const [trip, fileImages] = await Promise.all([
    extractTrip(text),
    fileToImages(buffer, filename),
  ]);
  assignPhotos(trip, fileImages);
  return { trip, source_file: filename };
}

async function resolveFile(
  body: Record<string, unknown>,
): Promise<{ buffer: Buffer; filename: string; mime: string; blobUrl?: string }> {
  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : "";
  if (blobUrl) {
    const filename = typeof body.filename === "string" ? body.filename : "document";
    const mime = typeof body.mimeType === "string" ? body.mimeType : "";
    const res = await fetch(blobUrl);
    if (!res.ok) throw new Error(`Blob татахад алдаа гарлаа: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), filename, mime, blobUrl };
  }

  // Small-file path: whole file as base64 in the JSON body.
  const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
  if (!dataBase64) throw new Error("Файл олдсонгүй");
  const filename = typeof body.filename === "string" ? body.filename : "document";
  const mime = typeof body.mimeType === "string" ? body.mimeType : "";
  return { buffer: Buffer.from(dataBase64, "base64"), filename, mime };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as Record<string, unknown>;
  let blobUrl: string | undefined;

  try {
    const resolved = await resolveFile(body);
    blobUrl = resolved.blobUrl;
    if (resolved.buffer.length > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: "Файл хэт том (100MB дээд хязгаар)" });
    }
    const result = await runExtraction(resolved.buffer, resolved.filename, resolved.mime);
    return res.status(200).json(result);
  } catch (e) {
    logError("poster.extract.failed", { error: String((e as Error).message) });
    return res.status(500).json({ error: String((e as Error).message || e) });
  } finally {
    if (blobUrl) {
      del(blobUrl).catch(() => {}); // best-effort cleanup, don't block the response
    }
  }
}
