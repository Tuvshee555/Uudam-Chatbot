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

