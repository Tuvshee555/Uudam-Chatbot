import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { logError } from "@/lib/observability";
import { assembleChunks, putChunk } from "@/lib/poster/chunkStore";
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

export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } }, // one <4MB chunk per request
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as {
    uploadId?: unknown;
    filename?: unknown;
    mimeType?: unknown;
    chunkIndex?: unknown;
    totalChunks?: unknown;
    chunk?: unknown; // base64 (no data: prefix)
  };

  const uploadId = typeof body.uploadId === "string" ? body.uploadId : "";
  const filename = typeof body.filename === "string" ? body.filename : "document";
  const mimeType = typeof body.mimeType === "string" ? body.mimeType : "";
  const chunkIndex = Number(body.chunkIndex);
  const totalChunks = Number(body.totalChunks);
  const chunk = typeof body.chunk === "string" ? body.chunk : "";

  if (!uploadId || !chunk || !Number.isFinite(chunkIndex) || !Number.isFinite(totalChunks)) {
    return res.status(400).json({ error: "Дутуу chunk мэдээлэл" });
  }
  if (totalChunks < 1 || totalChunks > 64) {
    return res.status(400).json({ error: "totalChunks буруу" });
  }
  if (totalChunks * 4 * 1024 * 1024 > MAX_TOTAL_BYTES + 8 * 1024 * 1024) {
    return res.status(413).json({ error: "Файл хэт том (100MB дээд хязгаар)" });
  }

  await putChunk(uploadId, chunkIndex, totalChunks, chunk);

  // Not the last chunk yet — acknowledge and wait for more.
  if (chunkIndex < totalChunks - 1) {
    return res.status(200).json({ received: chunkIndex, more: true });
  }

  // Final chunk: assemble + extract.
  const buffer = await assembleChunks(uploadId, totalChunks);
  if (!buffer) {
    return res.status(409).json({ error: "Зарим chunk дутуу тул угсарч чадсангүй. Дахин оролдоно уу." });
  }
  if (buffer.length > MAX_TOTAL_BYTES) {
    return res.status(413).json({ error: "Файл хэт том (100MB дээд хязгаар)" });
  }

  try {
    const result = await runExtraction(buffer, filename, mimeType);
    return res.status(200).json(result);
  } catch (e) {
    logError("poster.extract.failed", { error: String((e as Error).message) });
    return res.status(500).json({ error: String((e as Error).message || e) });
  }
}
