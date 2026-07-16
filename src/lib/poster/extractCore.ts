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
type UploadLike = { buffer: Buffer; filename: string; mimeType: string };
type PriceTableLike = {
  columns?: string[];
  rows?: Array<{ dates?: string; cells?: string[] }>;
  note?: string;
} | null;
type ExtractedTripLike = {
  title?: string;
  subtitle?: string;
  duration_days?: number;
  duration_nights?: number;
  flights?: { outbound?: string; return?: string } | null;
  departures?: Array<{ date?: string }>;
  price_table?: PriceTableLike;
  price_note?: string;
  days?: Array<Record<string, unknown> & { day?: number; route?: string; summary?: string }>;
  includes?: string[];
  excludes?: string[];
  contacts?: unknown;
  agency?: string;
};

const MAX_PARALLEL_PAGE_EXTRACTS = 5;

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

function nonEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueByText<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const normalized = key(value).trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(value);
  }
  return result;
}

function priceTableScore(table: PriceTableLike): number {
  if (!table) return 0;
  const columnScore = Array.isArray(table.columns) ? table.columns.filter(Boolean).length * 2 : 0;
  const rowScore = Array.isArray(table.rows)
    ? table.rows.reduce(
        (sum, row) => sum + (row.dates ? 1 : 0) + (row.cells || []).filter(Boolean).length,
        0,
      )
    : 0;
  return columnScore + rowScore + (table.note ? 1 : 0);
}

function mergePriceTables(tables: PriceTableLike[]): PriceTableLike {
  const ranked = tables.filter(Boolean).sort((a, b) => priceTableScore(b) - priceTableScore(a));
  const base = ranked[0];
  if (!base) return null;

  const rows = uniqueByText(
    ranked.flatMap((table) => table?.rows || []),
    (row) => `${row.dates || ""}|${(row.cells || []).join("|")}`,
  );

  return {
    columns: Array.isArray(base.columns) ? base.columns : [],
    rows,
    note: uniqueByText(
      ranked.map((table) => table?.note || "").filter(Boolean),
      (note) => note,
    ).join("\n"),
  };
}

export function mergeExtractedTrips(trips: ExtractedTripLike[]): ExtractedTripLike {
  const validTrips = trips.filter(Boolean);
  if (validTrips.length === 0) throw new Error("No extracted page results to merge.");
  if (validTrips.length === 1) return validTrips[0];

  const first = validTrips[0];
  const title =
    validTrips.map((trip) => nonEmpty(trip.title)).find((value) => value && !/uudam travel agency/i.test(value)) ||
    nonEmpty(first.title);
  const subtitle = validTrips.map((trip) => nonEmpty(trip.subtitle)).find(Boolean) || "";
  const durationDays = Math.max(0, ...validTrips.map((trip) => Number(trip.duration_days || 0)));
  const durationNights = Math.max(0, ...validTrips.map((trip) => Number(trip.duration_nights || 0)));
  const flights = validTrips.map((trip) => trip.flights).find((value) => value?.outbound || value?.return) || null;
  const departures = uniqueByText(
    validTrips.flatMap((trip) => trip.departures || []),
    (departure) => departure.date || "",
  );
  const daysInPageOrder = uniqueByText(
    validTrips.flatMap((trip) => trip.days || []),
    (day) => `${day.day || ""}|${day.route || ""}|${day.summary || ""}`,
  );
  const uniqueDayNumbers = new Set(daysInPageOrder.map((day) => Number(day.day || 0)).filter(Boolean));
  const shouldTrustDayNumbers = uniqueDayNumbers.size === daysInPageOrder.length;
  const days = daysInPageOrder.map((day, index) => ({
    ...day,
    day: shouldTrustDayNumbers ? Number(day.day || index + 1) : index + 1,
  }));

  return {
    ...first,
    title,
    subtitle,
    duration_days: durationDays || Number(first.duration_days || 0),
    duration_nights: durationNights || Number(first.duration_nights || 0),
    flights,
    departures,
    price_table: mergePriceTables(validTrips.map((trip) => trip.price_table || null)),
    price_note: uniqueByText(
      validTrips.map((trip) => trip.price_note || "").filter(Boolean),
      (note) => note,
    ).join("\n"),
    days,
    includes: uniqueByText(validTrips.flatMap((trip) => trip.includes || []), (value) => value),
    excludes: uniqueByText(validTrips.flatMap((trip) => trip.excludes || []), (value) => value),
  };
}

async function splitPdfPages(buffer: Buffer, filename: string): Promise<UploadLike[]> {
  const { PDFDocument } = await import("pdf-lib");
  const source = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const pageCount = Math.min(source.getPageCount(), MAX_PARALLEL_PAGE_EXTRACTS);
  if (pageCount <= 1) return [{ buffer, filename, mimeType: "application/pdf" }];

  return Promise.all(
    Array.from({ length: pageCount }, async (_, pageIndex) => {
      const doc = await PDFDocument.create();
      const [page] = await doc.copyPages(source, [pageIndex]);
      doc.addPage(page);
      const bytes = await doc.save();
      return {
        buffer: Buffer.from(bytes),
        filename: `${filename.replace(/\.pdf$/i, "")}-page-${pageIndex + 1}.pdf`,
        mimeType: "application/pdf",
      };
    }),
  );
}

function isImageUpload(upload: UploadLike): boolean {
  const name = upload.filename.toLowerCase();
  return IMAGE_TYPES.includes(upload.mimeType) || /\.(jpe?g|png|webp|gif|bmp)$/.test(name);
}

export async function runMultiImageExtraction(uploads: UploadLike[]) {
  const images = uploads.filter(isImageUpload).slice(0, MAX_PARALLEL_PAGE_EXTRACTS);
  if (images.length === 0) throw new Error("No readable poster image files found.");
  const trips = await Promise.all(
    images.map((upload) =>
      extractTripFromImage(
        upload.buffer.toString("base64"),
        upload.mimeType || "image/jpeg",
      ),
    ),
  );
  return {
    trip: mergeExtractedTrips(trips),
    source_file: images.map((upload) => upload.filename).join(", "),
  };
}

export async function runExtraction(buffer: Buffer, filename: string, mime: string) {
  const name = filename.toLowerCase();

  if (IMAGE_TYPES.includes(mime) || /\.(jpe?g|png|webp|gif|bmp)$/.test(name)) {
    const b64 = buffer.toString("base64");
    const trip = await extractTripFromImage(b64, mime || "image/jpeg");
    return { trip, source_file: filename };
  }

  if (name.endsWith(".pdf") || mime === "application/pdf") {
    const pages = await splitPdfPages(buffer, filename);
    const pageTripPromise =
      pages.length > 1
        ? Promise.all(
            pages.map((page) =>
              extractPdfTripText(page.buffer.toString("base64"), page.filename),
            ),
          ).then(mergeExtractedTrips)
        : extractPdfTripText(buffer.toString("base64"), filename);
    const [trip, pdfImages, pdfFacts] = await Promise.all([
      pageTripPromise,
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
