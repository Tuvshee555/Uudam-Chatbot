/**
 * The actual document -> trip JSON extraction used by the direct poster
 * upload endpoint.
 */
import { fileToImages, fileToText } from "@/lib/poster/parse";
import { extractTrip, extractTripFromImage, extractTripFromPdf } from "@/lib/poster/openai";
import { extractTripFromPdfGemini } from "@/lib/poster/gemini";
import { extractPdfImages } from "@/lib/poster/pdfImages";
import { applyDayText, applyMealMarks, extractPdfFacts } from "@/lib/poster/pdfMeals";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"];
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_IMAGES = 18;

// Photo cropping (extractPdfImages) is pure synchronous CPU work — on a
// photo-heavy page it can block the event loop long enough to blow the whole
// serverless budget. It's a nice-to-have (auto day photos), NOT the point of
// extraction, so cap it: if it doesn't finish quickly, skip it and let the
// trip data (the real value) come through. This is the "90% not 150%" fix.
const PDF_IMAGE_CROP_BUDGET_MS = 12_000;

async function extractPdfImagesGuarded(buffer: Buffer): Promise<string[]> {
  try {
    const budget = new Promise<string[]>((resolve) => {
      setTimeout(() => resolve([]), PDF_IMAGE_CROP_BUDGET_MS);
    });
    // extractPdfImages is sync-heavy; defer it a tick so the timeout timer is
    // registered first, then race. If cropping runs long, we take [] and move
    // on rather than hanging the whole job.
    const work = Promise.resolve().then(() => extractPdfImages(buffer));
    return await Promise.race([work, budget]);
  } catch {
    return [];
  }
}

// PDF text extraction: Gemini first (fast, native PDF support, cheaper), then
// OpenAI vision as fallback — mirrors the standalone poster generator, which
// works reliably. Ours had been forced through OpenAI-only, which is the slow
// path that was timing out on large real PDFs.
async function extractPdfTripText(b64: string, filename: string) {
  if (process.env.GEMINI_API_KEY) {
    try {
      return await extractTripFromPdfGemini(b64, filename);
    } catch {
      // fall through to OpenAI vision
    }
  }
  return extractTripFromPdf(b64, filename);
}

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

/**
 * Fails fast on files that LOOK uploaded but aren't really there — the classic
 * OneDrive "online-only placeholder" case, where the browser reads a stub or
 * truncated bytes instead of the real document. Feeding that garbage to the AI
 * wastes 30-60s and dies confusingly; this dies in <1ms with a message that
 * says what's actually wrong.
 */
export function assertReadableDocument(buffer: Buffer, filename: string, mime: string): void {
  if (!buffer || buffer.length === 0) {
    throw new Error(
      `"${filename}" хоосон байна. Файл OneDrive-с бүрэн татагдаагүй байж магадгүй — файл дээр хулганы баруун товч дараад "Always keep on this device" сонгож, бүрэн татагдсаны дараа дахин оруулна уу.`,
    );
  }
  const name = filename.toLowerCase();
  const isPdf = name.endsWith(".pdf") || mime === "application/pdf";
  if (isPdf && !buffer.subarray(0, 1024).includes(Buffer.from("%PDF-"))) {
    throw new Error(
      `"${filename}" гэмтэлтэй эсвэл бүрэн татагдаагүй PDF байна (OneDrive sync шалгана уу). Файлыг бүрэн татаж аваад дахин оролдоно уу.`,
    );
  }
}

// A hung blob download must not silently consume the serverless time budget.
const BLOB_FETCH_TIMEOUT_MS = 20_000;

export async function resolveFile(
  body: Record<string, unknown>,
): Promise<{ buffer: Buffer; filename: string; mime: string; blobUrl?: string }> {
  const blobUrl = typeof body.blobUrl === "string" ? body.blobUrl : "";
  if (blobUrl) {
    const filename = typeof body.filename === "string" ? body.filename : "document";
    const mime = typeof body.mimeType === "string" ? body.mimeType : "";
    const res = await fetch(blobUrl, { signal: AbortSignal.timeout(BLOB_FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Blob татахад алдаа гарлаа: ${res.status}`);
    const arrayBuffer = await res.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer), filename, mime, blobUrl };
  }

  throw new Error("Файл олдсонгүй");
}

