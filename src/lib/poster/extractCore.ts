/**
 * Document -> trip JSON extraction for the direct poster upload endpoint.
 * OpenAI is the only model provider used here.
 */
import { fileToImages, fileToText } from "@/lib/poster/parse";
import { extractTrip, extractTripFromImage, extractTripFromPdf } from "@/lib/poster/openai";
import { extractPdfImages } from "@/lib/poster/pdfImages";
import { applyDayText, applyMealMarks, extractPdfFacts } from "@/lib/poster/pdfMeals";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"];
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_IMAGES = 18;
const PDF_IMAGE_CROP_BUDGET_MS = 12_000;
const BLOB_FETCH_TIMEOUT_MS = 20_000;

type TripLike = { days?: Array<{ photo?: string | null }> };

async function extractPdfImagesGuarded(buffer: Buffer): Promise<string[]> {
  try {
    const budget = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve([]), PDF_IMAGE_CROP_BUDGET_MS);
    });
    const work = Promise.resolve().then(() => extractPdfImages(buffer));
    return await Promise.race([work, budget]);
  } catch {
    return [];
  }
}

async function extractPdfTripText(b64: string, filename: string) {
  const started = Date.now();
  const elapsed = () => `${((Date.now() - started) / 1000).toFixed(1)}s`;
  try {
    const trip = await extractTripFromPdf(b64, filename);
    console.log(`[extract] openai ok in ${elapsed()}: ${filename}`);
    return trip;
  } catch (err) {
    const detail = String((err as Error)?.message || err);
    console.warn(`[extract] openai failed after ${elapsed()}: ${detail}`);
    throw new Error(`Could not read file with OpenAI: ${detail}`);
  }
}

function assignPhotos(trip: TripLike, extractedImages: string[]) {
  if (!trip?.days?.length || !extractedImages?.length) return;
  const images = extractedImages.slice(0, MAX_EXTRACTED_IMAGES);
  const dayCount = trip.days.length;
  const imageCount = images.length;
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex += 1) {
    const imageIndex =
      imageCount <= dayCount
        ? dayIndex
        : Math.round((dayIndex * (imageCount - 1)) / (dayCount - 1 || 1));
    if (images[imageIndex]) trip.days[dayIndex].photo = images[imageIndex];
  }
}

export async function runExtraction(buffer: Buffer, filename: string, mime: string) {
  const name = filename.toLowerCase();

  if (IMAGE_TYPES.includes(mime) || /\.(jpe?g|png|webp|gif|bmp)$/.test(name)) {
    const b64 = buffer.toString("base64");
    const trip = await extractTripFromImage(b64, mime || "image/jpeg");
    return { trip, source_file: filename };
  }

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    const b64 = buffer.toString("base64");
    const [trip, pdfImages, pdfFacts] = await Promise.all([
      extractPdfTripText(b64, filename),
      extractPdfImagesGuarded(buffer),
      extractPdfFacts(buffer),
    ]);
    applyDayText(trip, pdfFacts.days);
    applyMealMarks(trip, pdfFacts.meals);
    assignPhotos(trip, pdfImages);
    return { trip, source_file: filename };
  }

  const text = await fileToText(buffer, filename);
  if (!text || text.trim().length < 20) {
    throw new Error("Could not read enough text from the uploaded file.");
  }
  const [trip, fileImages] = await Promise.all([
    extractTrip(text),
    fileToImages(buffer, filename),
  ]);
  assignPhotos(trip, fileImages);
  return { trip, source_file: filename };
}

export function assertReadableDocument(buffer: Buffer, filename: string, mime: string): void {
  if (!buffer || buffer.length === 0) {
    throw new Error(
      `"${filename}" is empty. If it is a OneDrive online-only file, download it fully and try again.`,
    );
  }
  const name = filename.toLowerCase();
  const isPdf = name.endsWith(".pdf") || mime === "application/pdf";
  if (isPdf && !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error(
      `"${filename}" is not a readable PDF. It may be corrupted or not fully downloaded.`,
    );
  }
}

export async function resolveFile(
  body: Record<string, unknown>,
): Promise<{ buffer: Buffer; filename: string; mime: string; blobUrl?: string }> {
  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : "";
  if (blobUrl) {
    const filename = typeof body.filename === "string" ? body.filename : "document";
    const mime = typeof body.mimeType === "string" ? body.mimeType : "";
    const res = await fetch(blobUrl, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Blob download failed: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), filename, mime, blobUrl };
  }

  throw new Error("No file found.");
}
