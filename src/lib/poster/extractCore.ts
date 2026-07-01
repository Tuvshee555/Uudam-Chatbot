/**
 * The actual document -> trip JSON extraction. Pulled out of the extract API
 * route so both the job-creating endpoint and the background worker can call
 * it without duplicating logic.
 */
import { fileToImages, fileToText } from "@/lib/poster/parse";
import { extractTrip, extractTripFromImage, extractTripFromPdf } from "@/lib/poster/openai";
import { extractPdfImages } from "@/lib/poster/pdfImages";
import { applyDayText, applyMealMarks, extractPdfFacts } from "@/lib/poster/pdfMeals";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/bmp"];
export const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
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
      extractTripFromPdf(b64, filename),
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

export async function resolveFile(
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
