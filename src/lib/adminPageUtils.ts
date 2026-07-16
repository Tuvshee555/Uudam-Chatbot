import type {
  AIAction,
  AIProposal,
  AIProposalResponse,
  ClarificationQuestion,
  ConflictItem,
  ConflictSeverity,
  DriveSyncDiagnostics,
  ParseUploadUnit,
  SettingsForm,
  StructuredRow,
  TravelBotSettings,
  TripStatus,
} from "./adminTypes";
/* ----------------------------------------------------------------
   Constants & helpers
   ---------------------------------------------------------------- */
const SECRET_KEY = "travel_admin_secret";
const SECRET_TS_KEY = "travel_admin_secret_ts";
// Remember the device for 7 days, sliding: the timer resets every time the
// admin opens/uses the panel, so it only logs out after a full week of no use.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_AUTO_REFRESH_MS =
  process.env.NODE_ENV === "development" ? 0 : 45_000;
const MAX_PARSE_UPLOAD_BYTES = 850_000;
// Keep each extraction request small enough that a long price list can return
// every action without the model's JSON response being cut off. 18k of source
// text is roughly 8-12 detailed trips for the documents this panel receives.
const MAX_TEXT_PARSE_CHARS = 18_000;
// Allow very large pasted price lists. Oversized pastes are auto-split into
// safe AI-sized batches server-side, so the admin can paste a whole list (or
// several) at once without it ever being truncated or rejected.
const MAX_AI_INPUT_CHARS = 500_000;
// Accept everything in the picker so nothing looks greyed-out. Unsupported
// types still get a clear message after selection rather than being silently
// unselectable.
const ACCEPT_FILES = "*";

const STATUS_LABELS: Record<TripStatus, string> = {
  active: "Идэвхтэй",
  cancelled: "Цуцлагдсан",
  sold_out: "Суудал дууссан",
  draft: "Ноорог",
  archived: "Архив",
};

const STATUS_TONE: Record<TripStatus, "success" | "danger" | "warning" | "neutral"> =
  {
    active: "success",
    cancelled: "danger",
    sold_out: "warning",
    draft: "neutral",
    archived: "neutral",
  };

const FIELD_LABELS: Record<string, string> = {
  category: "Ангилал",
  operator_name: "Оператор",
  route_name: "Аяллын нэр",
  duration_text: "Хугацаа",
  adult_price: "Том хүний үнэ",
  child_price: "Хүүхдийн үнэ",
  currency: "Валют",
  departure_dates: "Гарах өдөр",
  seats_total: "Нийт суудал",
  seats_left: "Үлдсэн суудал",
  has_food: "Хоол",
  status: "Төлөв",
  notes: "Тэмдэглэл",
  source_description: "Эх сурвалж",
};

const DURATIONS: Array<{ label: string; ms: number }> = [
  { label: "10 мин", ms: 10 * 60 * 1000 },
  { label: "30 мин", ms: 30 * 60 * 1000 },
  { label: "1 цаг", ms: 60 * 60 * 1000 },
  { label: "24 цаг", ms: 24 * 60 * 60 * 1000 },
  { label: "14 хоног", ms: 14 * 24 * 60 * 60 * 1000 },
];

const HANDOFF_DURATION_OPTIONS = [
  { label: "30 минут", value: "30" },
  { label: "1 цаг", value: "60" },
  { label: "2 цаг", value: "120" },
  { label: "Гараар сэргээх хүртэл", value: "0" },
] as const;

const HANDOFF_DURATION_CUSTOM = "custom";

const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  { label: "Аялал цуцлах", prompt: "Дараах аяллыг цуцал: " },
  { label: "Суудал шинэчлэх", prompt: "Дараах аяллын үлдсэн суудлыг шинэчил: " },
  { label: "Үнэ өөрчлөх", prompt: "Дараах аяллын үнийг өөрчил: " },
  { label: "Хоол", prompt: "Дараах аяллын хоолны мэдээллийг өөрчил: " },
  {
    label: "Шинэ аялал",
    prompt:
      "Шинэ аялал нэм. Оператор: , Маршрут: , Хугацаа: , Том хүний үнэ: , Гарах өдөр: ",
  },
];

let idCounter = 0;
function uid(): string {
  idCounter += 1;
  return `m${Date.now().toString(36)}${idCounter}`;
}

function getSecretStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

const TEST_BOT_CONVERSATION_KEY = "uudam_admin_testbot_conversation_id";

function getTestBotConversationId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.sessionStorage.getItem(TEST_BOT_CONVERSATION_KEY);
  if (existing) return existing;
  const nextId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
  window.sessionStorage.setItem(TEST_BOT_CONVERSATION_KEY, nextId);
  return nextId;
}

function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  return element.matches(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  );
}

function asInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isPdfFile(file: File): boolean {
  return (
    file.type === "application/pdf" ||
    file.name.trim().toLowerCase().endsWith(".pdf")
  );
}

function isImageFile(file: File): boolean {
  return (
    file.type.startsWith("image/") ||
    /\.(png|jpe?g|webp|gif)$/i.test(file.name.trim())
  );
}

function isZipFile(file: File): boolean {
  return (
    file.type === "application/zip" ||
    file.type === "application/x-zip-compressed" ||
    /\.zip$/i.test(file.name.trim())
  );
}

function isTextLikeFile(file: File): boolean {
  return (
    file.type.startsWith("text/") ||
    /\.(csv|txt|text|md|log)$/i.test(file.name.trim())
  );
}

function isOfficeDocFile(file: File): boolean {
  return /\.(xlsx|xlsm|xls|docx)$/i.test(file.name.trim());
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("read failed"));
    reader.readAsDataURL(file);
  });
}

function textToDataUrl(text: string): string {
  return bytesToDataUrl(new TextEncoder().encode(text), "text/plain");
}

function base64UrlToText(base64: string): string {
  const cleaned = base64.replace(/\s/g, "");
  try {
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

function dataUrlToText(dataUrl: string): string {
  if (!dataUrl) return "";
  if (!dataUrl.startsWith("data:")) return dataUrl;
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return "";
  const meta = dataUrl.slice(5, comma);
  const payload = dataUrl.slice(comma + 1);
  if (meta.includes(";base64")) {
    return base64UrlToText(payload);
  }
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function formatWaitMs(ms: number | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
    return "бага зэрэг хүлээгээд";
  }
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} секунд хүлээгээд`;
  return `${Math.ceil(seconds / 60)} минут хүлээгээд`;
}

function apiErrorMessage(
  data: Partial<AIProposalResponse> | undefined,
  fallback: string,
): string {
  const code = String(data?.error || "").trim();
  const raw = String(data?.message || data?.error || "").trim();
  const wait = formatWaitMs(data?.retry_after_ms);

  if (code === "rate_limited") {
    return `AI хэсэг түр хязгаарлагдлаа. ${wait} дахин оролдоно уу.`;
  }
  if (code === "instruction_too_long") {
    return `Заавар хэт урт байна. ${data?.max_chars || MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`;
  }
  if (code === "clarification_too_long") {
    return `Тодруулга хэт урт байна. ${data?.max_chars || MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`;
  }
  if (code === "note_too_long") {
    return `Файлтай хамт бичсэн тайлбар хэт урт байна. ${data?.max_chars || MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`;
  }
  if (code === "upload_payload_too_large") {
    return `Нэг удаагийн файл илгээх хэмжээ хэтэрлээ. Файлаа жижиглээд дахин оруулна уу.`;
  }
  if (code === "upload_file_too_large") {
    return `Нэг файлын боловсруулсан хэсэг ${formatBytes(Number(data?.max_file_bytes) || 0)}-аас том байна. Систем тухайн хэсгийг уншиж чадсангүй.`;
  }
  if (code === "upload_total_too_large") {
    return `Нэг боловсруулалтын нийт хэмжээ ${formatBytes(Number(data?.max_total_bytes) || 0)}-аас хэтэрлээ.`;
  }
  if (code === "too_many_uploads") {
    return `Нэг боловсруулалтад хэт олон хэсэг орлоо (${data?.max_uploads || 0}).`;
  }
  if (code === "too_many_drive_files") {
    return `Нэг боловсруулалтад хэт олон онлайн файл орлоо (${data?.max_drive_files || 0}).`;
  }
  if (/too large|request limit/i.test(raw)) {
    return "Файл эсвэл хүсэлт хэт том байна. Файлаа жижиглээд эсвэл цөөн файл сонгоод дахин оролдоно уу.";
  }
  if (/rate.?limit|quota|temporarily rate limited/i.test(raw)) {
    return `AI үйлчилгээ түр завгүй байна. ${wait} дахин оролдоно уу.`;
  }
  if (/timed out|too long|timeout/i.test(raw)) {
    return "AI хариу өгөхөд хэт удлаа. Асуултаа богино, тодорхой болгоод дахин оролдоно уу.";
  }
  if (/temporarily unavailable|circuit|upstream/i.test(raw)) {
    return `AI үйлчилгээ түр боломжгүй байна. ${wait} дахин оролдоно уу.`;
  }

  return raw || fallback;
}

function isTransientAiFailure(proposal: AIProposal | undefined): boolean {
  if (!proposal) return false;
  const text = [
    proposal.summary,
    proposal.important_reason,
    ...(proposal.conflicts || []),
  ].join(" ");
  return /429|rate.?limit|quota|resource.?exhausted|circuit|upstream|could not finish reading batch/i.test(
    text,
  );
}

function chunkText(text: string, maxChars = MAX_TEXT_PARSE_CHARS): string[] {
  const chunks: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxChars) {
    const slice = remaining.slice(0, maxChars);
    const splitAt = Math.max(
      slice.lastIndexOf("\n\n"),
      slice.lastIndexOf("\n"),
      slice.lastIndexOf(". "),
    );
    const end = splitAt > maxChars * 0.6 ? splitAt + 1 : maxChars;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function pdfTextItemsToText(items: unknown[]): string {
  const lines: string[] = [];
  let current = "";
  let lastY: number | null = null;
  let lastX: number | null = null;

  const flush = () => {
    const line = current.replace(/[ \t]+/g, " ").trim();
    if (line) lines.push(line);
    current = "";
    lastY = null;
    lastX = null;
  };

  for (const rawItem of items) {
    const item = rawItem as {
      str?: string;
      width?: number;
      transform?: number[];
      hasEOL?: boolean;
    };
    const text = item.str?.trim();
    if (!text) continue;
    const x = Array.isArray(item.transform) ? item.transform[4] : null;
    const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : null;
    if (lastY != null && y != null && Math.abs(y - lastY) > 4) {
      flush();
    }
    if (current) {
      current += x != null && lastX != null && x - lastX > 24 ? "\t" : " ";
    }
    current += text;
    if (x != null) lastX = x + (item.width || text.length * 5);
    if (y != null) lastY = y;
    if (item.hasEOL) flush();
  }
  flush();
  return lines.join("\n");
}

type PdfViewport = { width: number; height: number };
type PdfRenderPage = {
  getViewport(input: { scale: number }): PdfViewport;
  render(input: unknown): { promise: Promise<void> };
  getTextContent(): Promise<{ items: unknown[] }>;
};
type PdfDocumentProxy = {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfRenderPage>;
};

async function loadPdfDocument(bytes: Uint8Array): Promise<PdfDocumentProxy> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/legacy/build/pdf.worker.min.mjs`;
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
  } as unknown as Parameters<typeof pdfjs.getDocument>[0]);
  return (await loadingTask.promise) as PdfDocumentProxy;
}

type PdfPageText = { pageNumber: number; text: string };

async function extractPdfPageTexts(file: File): Promise<PdfPageText[]> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const pdf = await loadPdfDocument(bytes);
  const pages: PdfPageText[] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = pdfTextItemsToText(content.items);
    pages.push({ pageNumber, text: text.trim() });
  }

  return pages;
}

async function extractPdfText(file: File): Promise<string> {
  const pages = await extractPdfPageTexts(file);
  return pages
    .filter((page) => page.text)
    .map((page) => `Page ${page.pageNumber}\n${page.text}`)
    .join("\n\n")
    .trim();
}

async function canvasToJpegBytes(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", quality);
  });
  if (!blob) throw new Error("PDF хуудсыг зураг болгож чадсангүй.");
  return new Uint8Array(await blob.arrayBuffer());
}

async function renderPdfPageAsImageUnit(
  originalBytes: Uint8Array,
  filename: string,
  pageIndex: number,
  partNumber: number,
): Promise<ParseUploadUnit> {
  const pdf = await loadPdfDocument(originalBytes);
  const page = await pdf.getPage(pageIndex + 1);
  let scale = 1.45;
  let quality = 0.82;
  let bestBytes: Uint8Array | null = null;

  for (let attempt = 0; attempt < 14; attempt += 1) {
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const canvasContext = canvas.getContext("2d");
    if (!canvasContext) throw new Error("PDF хуудсыг зураг болгож чадсангүй.");

    await page.render({ canvasContext, viewport }).promise;
    const bytes = await canvasToJpegBytes(canvas, quality);
    if (!bestBytes || bytes.byteLength < bestBytes.byteLength) {
      bestBytes = bytes;
    }
    if (bytes.byteLength <= MAX_PARSE_UPLOAD_BYTES) {
      return {
        displayName: `${filename} (${partNumber}, page ${pageIndex + 1})`,
        filename: `${filename}.part-${String(partNumber).padStart(3, "0")}.page-${String(pageIndex + 1).padStart(3, "0")}.jpg`,
        mimeType: "image/jpeg",
        dataUrl: bytesToDataUrl(bytes, "image/jpeg"),
      };
    }

    if (quality > 0.46) {
      quality -= 0.12;
    } else {
      scale *= 0.72;
      quality = 0.72;
    }
  }

  throw new Error(
    `"${filename}" PDF-ийн ${pageIndex + 1}-р хуудсыг request limit-д багтааж жижиглэж чадсангүй (${formatBytes(bestBytes?.byteLength || 0)}).`,
  );
}

async function createPdfChunkBytes(
  sourcePdf: import("pdf-lib").PDFDocument,
  pageIndexes: number[],
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib");
  const chunkPdf = await PDFDocument.create();
  const pages = await chunkPdf.copyPages(sourcePdf, pageIndexes);
  for (const page of pages) {
    chunkPdf.addPage(page);
  }
  return chunkPdf.save({ useObjectStreams: true });
}

// Decides whether extracted PDF text is a real text layer worth sending as
// text, vs junk from a scanned/image PDF (which should go to OCR instead).
// Requires enough length AND a healthy share of letters/digits so a few stray
// glyphs from a scan don't get mistaken for a usable text layer.
function isUsablePdfText(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 200) return false;
  const wordChars = (trimmed.match(/[\p{L}\p{N}]/gu) || []).length;
  return wordChars >= 120 && wordChars / trimmed.length >= 0.5;
}

async function buildPdfUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const { PDFDocument } = await import("pdf-lib");
  const originalBytes = new Uint8Array(await file.arrayBuffer());
  const mimeType = "application/pdf";

  // Accuracy-first dual evidence: clean parsed text keeps tables/prices stable,
  // while a rendered first page preserves the logo, title, date and price blocks
  // that are often positioned visually and lost by raw text extraction.
  const extractedText = await extractPdfText(file).catch(() => "");
  if (isUsablePdfText(extractedText)) {
    const pageOneVisual = await renderPdfPageAsImageUnit(
      originalBytes,
      file.name,
      0,
      1,
    ).catch(() => null);
    return chunkText(extractedText).map((chunk, index, chunks) => ({
      displayName:
        chunks.length > 1 ? `${file.name} (${index + 1}/${chunks.length})` : file.name,
      filename: `${file.name}.parsed-text-${String(index + 1).padStart(3, "0")}-of-${String(chunks.length).padStart(3, "0")}.txt`,
      mimeType: "text/plain",
      dataUrl: textToDataUrl(chunk),
      companions: pageOneVisual
        ? [{
            filename: `${file.name}.visual-page-001.jpg`,
            mimeType: pageOneVisual.mimeType,
            dataUrl: pageOneVisual.dataUrl,
          }]
        : undefined,
    }));
  }

  // Scanned PDF: render every page for OCR and keep two adjacent pages in one
  // request so itinerary continuations retain local context without breaching
  // the platform request-body ceiling.
  try {
    const pdf = await loadPdfDocument(originalBytes);
    const rendered: ParseUploadUnit[] = [];
    for (let pageIndex = 0; pageIndex < pdf.numPages; pageIndex += 1) {
      rendered.push(
        await renderPdfPageAsImageUnit(
          originalBytes,
          file.name,
          pageIndex,
          pageIndex + 1,
        ),
      );
    }
    const grouped: ParseUploadUnit[] = [];
    for (let index = 0; index < rendered.length; index += 2) {
      const pair = rendered.slice(index, index + 2);
      const first = pair[0];
      grouped.push({
        ...first,
        displayName: `${file.name} (pages ${index + 1}-${index + pair.length})`,
        companions: pair.slice(1).map((page) => ({
          filename: page.filename,
          mimeType: page.mimeType,
          dataUrl: page.dataUrl,
        })),
      });
    }
    if (grouped.length > 0) return grouped;
  } catch {
    // Fall through to binary chunking for unusual PDFs that pdf.js cannot render.
  }

  let sourcePdf: import("pdf-lib").PDFDocument;
  try {
    sourcePdf = await PDFDocument.load(originalBytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
  } catch {
    const text = await extractPdfText(file);
    if (!text) throw new Error(`"${file.name}" PDF файлыг жижиглэж уншиж чадсангүй.`);
    return chunkText(text).map((chunk, index, chunks) => ({
      displayName: `${file.name} (${index + 1}/${chunks.length})`,
      filename: `${file.name}.text-${String(index + 1).padStart(3, "0")}.txt`,
      mimeType: "text/plain",
      dataUrl: textToDataUrl(chunk),
    }));
  }

  const units: ParseUploadUnit[] = [];
  let currentPages: number[] = [];

  const flushCurrent = async () => {
    if (currentPages.length === 0) return;
    const chunkBytes = await createPdfChunkBytes(sourcePdf, currentPages);
    if (chunkBytes.byteLength > MAX_PARSE_UPLOAD_BYTES) {
      for (const pageIndex of currentPages) {
        units.push(
          await renderPdfPageAsImageUnit(
            originalBytes,
            file.name,
            pageIndex,
            units.length + 1,
          ),
        );
      }
      currentPages = [];
      return;
    }
    units.push({
      displayName: `${file.name} (${units.length + 1})`,
      filename: `${file.name}.part-${String(units.length + 1).padStart(3, "0")}.pdf`,
      mimeType,
      dataUrl: bytesToDataUrl(chunkBytes, mimeType),
    });
    currentPages = [];
  };

  for (let pageIndex = 0; pageIndex < sourcePdf.getPageCount(); pageIndex += 1) {
    const candidatePages = [...currentPages, pageIndex];
    const candidateBytes = await createPdfChunkBytes(sourcePdf, candidatePages);
    if (
      candidateBytes.byteLength > MAX_PARSE_UPLOAD_BYTES &&
      currentPages.length > 0
    ) {
      await flushCurrent();
      currentPages = [pageIndex];
      const singlePageBytes = await createPdfChunkBytes(sourcePdf, currentPages);
      if (singlePageBytes.byteLength > MAX_PARSE_UPLOAD_BYTES) {
        await flushCurrent();
      }
      continue;
    }
    if (candidateBytes.byteLength > MAX_PARSE_UPLOAD_BYTES) {
      units.push(
        await renderPdfPageAsImageUnit(
          originalBytes,
          file.name,
          pageIndex,
          units.length + 1,
        ),
      );
      currentPages = [];
      continue;
    }
    currentPages = candidatePages;
  }

  await flushCurrent();
  return units;
}

async function buildTextUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const text = (await file.text()).trim();
  if (!text) throw new Error(`"${file.name}" текст файл хоосон байна.`);
  return chunkText(text).map((chunk, index, chunks) => ({
    displayName: `${file.name} (${index + 1}/${chunks.length})`,
    filename: `${file.name}.part-${String(index + 1).padStart(3, "0")}-of-${String(chunks.length).padStart(3, "0")}.txt`,
    mimeType: "text/plain",
    dataUrl: textToDataUrl(chunk),
  }));
}

/** Inflates a single entry from a ZIP (DOCX/XLSX) in the browser. */
async function readZipEntryInBrowser(
  buffer: ArrayBuffer,
  entryName: string,
): Promise<string | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const targetBytes = new TextEncoder().encode(entryName);
  const matches = (start: number) => {
    for (let i = 0; i < targetBytes.length; i += 1) {
      if (bytes[start + i] !== targetBytes[i]) return false;
    }
    return true;
  };

  let offset = 0;
  while (offset + 30 <= bytes.length) {
    if (view.getUint32(offset, true) !== 0x04034b50) break;
    const method = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    if (compressedSize === 0) break;

    if (nameLength === targetBytes.length && matches(nameStart)) {
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) {
        const stream = new Response(
          new Blob([data]).stream().pipeThrough(
            new DecompressionStream("deflate-raw"),
          ),
        );
        return await stream.text();
      }
      return null;
    }
    offset = dataStart + compressedSize;
  }
  return null;
}

/**
 * Extracts text from an Office document (Excel .xlsx/.xlsm/.xls, Word .docx)
 * in the browser, then chunks it like plain text. This keeps upload size tied
 * to the *content*, so a heavy Office file (embedded fonts/images) never trips
 * the per-request size wall — only its readable text is sent.
 */
async function buildOfficeUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const lower = file.name.trim().toLowerCase();
  const buffer = await file.arrayBuffer();
  let text = "";

  if (lower.endsWith(".docx")) {
    const xml = await readZipEntryInBrowser(buffer, "word/document.xml");
    if (!xml) {
      throw new Error(
        `"${file.name}" Word файлыг уншиж чадсангүй. PDF болгож хадгалаад дахин оруулна уу.`,
      );
    }
    text = xml
      .replace(/<w:tab\b[^>]*\/?>/g, "\t")
      .replace(/<\/w:tc>/g, "\t")
      .replace(/<\/w:tr>/g, "\n")
      .replace(/<\/w:p>/g, "\n")
      .replace(/<w:br\b[^>]*\/?>/g, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } else {
    const XLSX = await import("xlsx");
    const workbook = XLSX.read(new Uint8Array(buffer), { type: "array" });
    const parts: string[] = [];
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) continue;
      const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
      if (csv.trim()) parts.push(`# ${sheetName}\n${csv}`);
    }
    text = parts.join("\n\n").trim();
  }

  if (!text) {
    throw new Error(`"${file.name}" файлд текст өгөгдөл олдсонгүй.`);
  }

  return chunkText(text).map((chunk, index, chunks) => ({
    displayName: `${file.name} (${index + 1}/${chunks.length})`,
    filename: `${file.name}.part-${String(index + 1).padStart(3, "0")}-of-${String(chunks.length).padStart(3, "0")}.txt`,
    mimeType: "text/plain",
    dataUrl: textToDataUrl(chunk),
  }));
}

async function buildImageUploadUnit(file: File): Promise<ParseUploadUnit> {
  if (file.size <= MAX_PARSE_UPLOAD_BYTES) {
    return {
      displayName: file.name,
      filename: file.name,
      mimeType: file.type || "image/jpeg",
      dataUrl: await fileToDataUrl(file),
    };
  }

  const bitmap = await createImageBitmap(file);
  try {
    let scale = 1;
    let quality = 0.82;
    let bestBytes: Uint8Array | null = null;

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Зургийг жижиглэж чадсангүй.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const bytes = await canvasToJpegBytes(canvas, quality);
      if (!bestBytes || bytes.byteLength < bestBytes.byteLength) {
        bestBytes = bytes;
      }
      if (bytes.byteLength <= MAX_PARSE_UPLOAD_BYTES) {
        return {
          displayName: file.name,
          filename: `${file.name}.compressed.jpg`,
          mimeType: "image/jpeg",
          dataUrl: bytesToDataUrl(bytes, "image/jpeg"),
        };
      }
      if (quality > 0.46) {
        quality -= 0.12;
      } else {
        scale *= 0.72;
        quality = 0.78;
      }
    }

    throw new Error(
      `"${file.name}" зургийг request limit-д багтааж жижиглэж чадсангүй (${formatBytes(bestBytes?.byteLength || 0)}).`,
    );
  } finally {
    bitmap.close();
  }
}

function imageMimeFromName(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  return "image/jpeg";
}

function dataUrlDecodedByteLength(dataUrl: string): number {
  const raw = dataUrl.includes(",") ? dataUrl.slice(dataUrl.indexOf(",") + 1) : dataUrl;
  const compact = raw.replace(/\s/g, "");
  return (
    Math.ceil((compact.length * 3) / 4) -
    (compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0)
  );
}

async function buildZipImageUploadUnits(file: File): Promise<ParseUploadUnit[]> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const entries = Object.values(zip.files)
    .filter(
      (entry) =>
        !entry.dir &&
        !entry.name.includes("__MACOSX") &&
        /\.(png|jpe?g|webp)$/i.test(entry.name),
    )
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (entries.length === 0) {
    throw new Error(`"${file.name}" ZIP дотор зураг олдсонгүй.`);
  }

  const imageUnits: ParseUploadUnit[] = [];
  for (const entry of entries) {
    const blob = await entry.async("blob");
    const cleanName = entry.name.split("/").pop() || entry.name;
    const imageFile = new File([blob], `${file.name}/${cleanName}`, {
      type: imageMimeFromName(cleanName),
      lastModified: file.lastModified,
    });
    const unit = await buildImageUploadUnit(imageFile);
    imageUnits.push({
      ...unit,
      displayName: `${file.name} / ${cleanName}`,
      sourceGroup: file.name,
    });
  }

  const groups: ParseUploadUnit[] = [];
  let current: ParseUploadUnit | null = null;
  let currentBytes = 0;
  const maxGroupBytes = MAX_PARSE_UPLOAD_BYTES * 3;

  for (const unit of imageUnits) {
    const unitBytes = dataUrlDecodedByteLength(unit.dataUrl);
    if (!current || currentBytes + unitBytes > maxGroupBytes) {
      current = {
        ...unit,
        displayName: file.name,
        sourceGroup: file.name,
        companions: [],
      };
      groups.push(current);
      currentBytes = unitBytes;
      continue;
    }
    current.companions = [
      ...(current.companions || []),
      {
        filename: unit.filename,
        mimeType: unit.mimeType,
        dataUrl: unit.dataUrl,
      },
    ];
    currentBytes += unitBytes;
  }

  return groups;
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `…${value.slice(-12)}`;
}

function timeLeft(expiresAt: string | null): string {
  if (!expiresAt) return "∞";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Дууссан";
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return minutes <= 0 ? `${seconds}с` : `${minutes}м ${seconds}с`;
}

// Explicit Mongolian words — toLocaleString("mn-MN") falls back to English
// on browsers without Mongolian locale data (same fix as adminUtils.formatTime).
function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${date.getMonth() + 1} сарын ${date.getDate()}, ${hm}`;
}

function driveSyncTone(
  status: DriveSyncDiagnostics["state"]["status"] | undefined,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "success") return "success";
  if (status === "warning" || status === "running") return "warning";
  if (status === "error") return "danger";
  return "neutral";
}

function toStructuredRows(value: unknown): StructuredRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row: StructuredRow = {};
      for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
        row[key] = typeof val === "string" ? val : val == null ? "" : String(val);
      }
      return row;
    });
}

function settingsToForm(settings: TravelBotSettings): SettingsForm {
  return {
    business_name: settings.business_name || "",
    system_prompt: settings.system_prompt || "",
    quick_info_reply: settings.quick_info_reply || "",
    quick_info_keywords: (settings.quick_info_keywords || []).join("\n"),
    comment_trigger_patterns: (settings.comment_trigger_patterns || []).join("\n"),
    comment_public_reply: settings.comment_public_reply || "",
    comment_dm_reply: settings.comment_dm_reply || "",
    special_offers: toStructuredRows(settings.special_offers),
    discount_policies: toStructuredRows(settings.discount_policies),
    verified_credentials: toStructuredRows(settings.verified_credentials),
    faq: toStructuredRows(settings.faq),
    handoff_enabled: settings.handoff_enabled !== false,
    handoff_keywords: (settings.handoff_keywords || []).join("\n"),
    handoff_reply: settings.handoff_reply || "",
    handoff_pause_minutes: String(settings.handoff_pause_minutes ?? 60),
    chat_buttons: Array.isArray(settings.chat_buttons) ? settings.chat_buttons : [],
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function handoffDurationSelectValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "60";
  return HANDOFF_DURATION_OPTIONS.some((option) => option.value === trimmed)
    ? trimmed
    : HANDOFF_DURATION_CUSTOM;
}

function describeAction(action: AIAction): {
  verb: string;
  target: string;
  changes: string[];
} {
  const verbRaw = String(action.action || "").toLowerCase();
  const verb =
    verbRaw === "cancel"
      ? "Цуцлах"
      : verbRaw === "upsert"
        ? action.trip_id
          ? "Шинэчлэх"
          : "Шинэ аялал нэмэх"
        : verbRaw === "patch"
          ? "Шинэчлэх"
          : verbRaw || "Үйлдэл";
  const target =
    action.match?.route_name ||
    action.fields?.route_name?.toString() ||
    action.match?.operator_name ||
    action.trip_id ||
    "аялал";
  const fields = action.fields || {};
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    const label = FIELD_LABELS[key] || key;
    if (key === "has_food") {
      changes.push(`${label}: ${value ? "Байгаа" : "Байхгүй"}`);
    } else if (key === "status") {
      changes.push(
        `${label}: ${STATUS_LABELS[value as TripStatus] || String(value)}`,
      );
    } else if (key === "departure_dates" && Array.isArray(value)) {
      changes.push(`${label}: ${value.join(", ")}`);
    } else {
      changes.push(`${label}: ${String(value)}`);
    }
  }
  return { verb, target: String(target), changes };
}

function formatMoneyValue(
  amount: number | null | undefined,
  currency?: unknown,
): string {
  // This lands inside Mongolian-facing clarification questions — the English
  // word "unknown" was leaking into them whenever a price was missing.
  if (amount == null || !Number.isFinite(amount)) return "тодорхойгүй";
  const code = typeof currency === "string" && currency.trim() ? currency.trim() : "";
  return `${amount.toLocaleString("en-US")}${code ? ` ${code}` : ""}`;
}

function extractQuotedValues(text: string): string[] {
  const matches = Array.from(text.matchAll(/['"]([^'"]+)['"]/g));
  const values = matches
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);
  return Array.from(new Set(values));
}

function normalizeReviewText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isAgencyReviewText(text: string): boolean {
  const normalized = normalizeReviewText(text).replace(/[.,:;!?()[\]{}"']/g, "");
  const agencyHeaders = [
    "uudam travel agency",
    "uudam travel",
    "travel agency",
    "agency",
  ];
  return agencyHeaders.some(
    (header) => normalized === header || normalized.startsWith(`${header} `),
  );
}

function isLikelyTripRouteText(text: string): boolean {
  const normalized = normalizeReviewText(text);
  return (
    normalized.includes("аялал") ||
    normalized.includes("tour") ||
    normalized.includes("хөх хот") ||
    normalized.includes("эрээн") ||
    normalized.includes("бээжин") ||
    normalized.includes("сеoul") ||
    normalized.includes("seoul")
  );
}

function isSuspiciousChildPriceConflict(normalized: string): boolean {
  const mentionsChild =
    normalized.includes("хүүхдийн үнэ") || normalized.includes("child price");
  if (!mentionsChild) return false;
  const mentionsComparison =
    normalized.includes("higher") ||
    normalized.includes("greater") ||
    normalized.includes("more than") ||
    normalized.includes("өндөр") ||
    normalized.includes("их") ||
    normalized.includes("давсан");
  if (!mentionsComparison) return false;

  // Word order decides WHICH price is being called higher. In Mongolian
  // "A нь B-өөс өндөр" means A > B. An ADULT price higher than the child price
  // is completely normal — never flag it. Only a CHILD price higher than the
  // adult price is suspicious. Whichever subject ("хүүхдийн үнэ" vs
  // "том хүний үнэ") comes FIRST is the one claimed to be higher.
  const childIdx = normalized.indexOf("хүүхдийн үнэ");
  const childIdxEn = normalized.indexOf("child price");
  const childPos = Math.min(
    childIdx === -1 ? Number.MAX_SAFE_INTEGER : childIdx,
    childIdxEn === -1 ? Number.MAX_SAFE_INTEGER : childIdxEn,
  );
  const adultIdx = normalized.indexOf("том хүний үнэ");
  const adultIdxEn = normalized.indexOf("adult price");
  const adultPos = Math.min(
    adultIdx === -1 ? Number.MAX_SAFE_INTEGER : adultIdx,
    adultIdxEn === -1 ? Number.MAX_SAFE_INTEGER : adultIdxEn,
  );

  // If the adult price is mentioned first, it's "adult higher than child" =
  // normal, not suspicious. Only treat as suspicious when the child price is
  // the subject claimed to be higher (or no adult price is mentioned at all).
  if (adultPos < childPos) return false;
  return true;
}

// True when a "date is unclear / тодорхойгүй" conflict actually contains real
// dates in its text — e.g. "гарах огноо (06/10, 06/19, 06/22) тодорхойгүй".
// That is self-contradictory (the AI listed the dates it claims it couldn't
// find), so we drop the question instead of asking the admin an obvious one.
function isContradictoryDateConflict(detail: string): boolean {
  const normalized = normalizeReviewText(detail);
  const mentionsUnclearDate =
    (normalized.includes("огноо") ||
      normalized.includes("гарах өдөр") ||
      normalized.includes("departure date")) &&
    (normalized.includes("тодорхойгүй") ||
      normalized.includes("unclear") ||
      normalized.includes("чадсангүй") ||
      normalized.includes("чадаагүй"));
  if (!mentionsUnclearDate) return false;
  // A concrete date present in the same text: "06/10", "6/27", "06 сарын 17",
  // "2026-06-15", "17-21" etc. Any of these means a date WAS found.
  return (
    /\d{1,2}\s*[\/.\-]\s*\d{1,2}/.test(detail) ||
    /\d{4}-\d{1,2}-\d{1,2}/.test(detail) ||
    /\d{1,2}\s*сар(ын)?\s*\d{1,2}/.test(detail)
  );
}

function isOptionalAddOnCostConflict(normalized: string): boolean {
  const mentionsForeignCost =
    normalized.includes("cny") ||
    normalized.includes("yuan") ||
    normalized.includes("юань");
  if (!mentionsForeignCost) return false;
  return (
    normalized.includes("optional") ||
    normalized.includes("add-on") ||
    normalized.includes("addon") ||
    normalized.includes("extra") ||
    normalized.includes("нэмэлт төлбөр") ||
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("хөтөлбөрт багтаагүй") ||
    normalized.includes("ганцаараа орох") ||
    normalized.includes("single room")
  );
}

// Keep this list in sync with RECURRING_DEPARTURE_TOKENS in src/lib/travelOps.ts.
const RECURRING_DATE_TOKENS = [
  "өдөр бүр",
  "өдөр болгон",
  "өдөр тутам",
  "daily",
  "every day",
  "everyday",
  "гараг бүр",
  "долоо хоног бүр",
  "долоохоног бүр",
  "every week",
  "weekly",
  "пүрэв",
  "даваа",
  "мягмар",
  "лхагва",
  "баасан",
  "бямба",
  "ням",
  "thursday",
  "monday",
  "tuesday",
  "wednesday",
  "friday",
  "saturday",
  "sunday",
  "сар бүр",
  "monthly",
  "every month",
  "хоног тутам",
];

function isRecurringDateText(normalized: string): boolean {
  return RECURRING_DATE_TOKENS.some((token) => normalized.includes(token));
}

function isDocumentedMealExceptionConflict(normalized: string): boolean {
  const mentionsMeal =
    normalized.includes("хоол") ||
    normalized.includes("цай") ||
    normalized.includes("meal") ||
    normalized.includes("breakfast") ||
    normalized.includes("lunch") ||
    normalized.includes("dinner");
  if (!mentionsMeal) return false;
  return (
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("өөрсдийн зардлаар") ||
    normalized.includes("өөрөө") ||
    normalized.includes("чөлөөт өдөр") ||
    normalized.includes("байдаггүй") ||
    normalized.includes("байхгүй") ||
    normalized.includes("not included") ||
    normalized.includes("own expense") ||
    normalized.includes("free day")
  );
}

function summarizeConflict(detail: string): string {
  const normalized = normalizeReviewText(detail);
  const quoted = extractQuotedValues(detail);
  const subject = quoted[0] || "Энэ аялал";

  if (isAgencyReviewText(subject) || isAgencyReviewText(detail)) {
    return "";
  }
  if (isOptionalAddOnCostConflict(normalized)) {
    return "";
  }
  if (isDocumentedMealExceptionConflict(normalized)) {
    return "";
  }
  if (isRecurringDateText(normalized)) {
    return "";
  }
  if (isSuspiciousChildPriceConflict(normalized)) {
    return `${subject}: хүүхдийн болон том хүний үнэ зөрүүтэй байна.`;
  }
  if (normalized.includes("юань") || normalized.includes("cny") || normalized.includes("валют")) {
    return `${subject}: үндсэн үнэ MNT, шинжилгээний төлбөр CNY байна.`;
  }
  if (normalized.includes("хоол") || normalized.includes("meal")) {
    return `${subject}: хоол багтсан эсэх нь тодорхойгүй байна.`;
  }
  if (
    normalized.includes("batch failed") ||
    normalized.includes("503") ||
    normalized.includes("upstream")
  ) {
    return "Зарим файл түр уншигдаагүй байна.";
  }
  if (
    normalized.includes("6-р сард") ||
    normalized.includes("7-р сард") ||
      normalized.includes("8-р сард")
  ) {
    return `${subject}: сар бүрийн үнэ өөр байна.`;
  }
  if (
    normalized.includes("file") ||
    normalized.includes("файлын нэр") ||
    normalized.includes("operator") ||
    normalized.includes("оператор") ||
    normalized.includes("брэнд")
  ) {
    return "";
  }
  return "";
}

function buildProposalClarifications(
  proposal: AIProposal,
  answeredIds: string[] = [],
  sourceNames: string[] = [],
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const seen = new Set(answeredIds);
  const coveredConflictChecks: Array<(normalized: string) => boolean> = [];

  function pushQuestion(question: ClarificationQuestion | null) {
    if (!question) return;
    if (seen.has(question.id)) return;
    seen.add(question.id);
    questions.push(question);
  }

  proposal.actions.forEach((action, index) => {
    const fields = action.fields || {};
    const routeName =
      fields.route_name?.toString().trim() ||
      action.match?.route_name?.trim() ||
      `аялал ${index + 1}`;
    const adultPrice =
      typeof fields.adult_price === "number" ? fields.adult_price : null;
    const childPrice =
      typeof fields.child_price === "number" ? fields.child_price : null;
    const currency =
      typeof fields.currency === "string" ? fields.currency : undefined;
    if (adultPrice != null && childPrice != null && childPrice > adultPrice) {
      const routeKey = normalizeReviewText(routeName);
      coveredConflictChecks.push(
        (normalized) =>
          normalized.includes(routeKey) &&
          (normalized.includes("хүүхдийн үнэ") ||
            normalized.includes("child price") ||
            normalized.includes("том хүний үнэ")),
      );
      pushQuestion({
        id: `child-price:${routeName}`,
        prompt: `"${routeName}" аяллын хүүхдийн үнэ ${formatMoneyValue(childPrice, currency)} байгаа ч том хүний үнэ ${formatMoneyValue(adultPrice, currency)} байна. Ингэж үлдээх үү?`,
        options: [
          {
            label: "Тийм, ингэж үлдээх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}, том хүний үнийг ${adultPrice} гэж үлдээ.`,
          },
          {
            label: "Том хүний үнээр тэнцүүлэх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}-н оронд ${adultPrice} болгон өөрчил.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: `"${routeName}" аяллын зөв үнэ эсвэл зааварчилга бичнэ үү`,
      });
    }
  });

  // Build a fast lookup of severity by conflict text (when structured items present).
  // Only blocker items become clarification questions. info/warning just show as boxes.
  const conflictSeverityMap = new Map<string, ConflictSeverity>();
  if (proposal.conflict_items && proposal.conflict_items.length > 0) {
    for (const item of proposal.conflict_items) {
      conflictSeverityMap.set(item.text.trim(), item.severity);
    }
  }

  // Build a lookup of which trip action routes have departure_dates set, so we
  // never ask "date unclear" for a trip where the AI already extracted the dates.
  const tripsWithDates = new Set<string>();
  for (const action of proposal.actions) {
    const f = action.fields || {};
    const dates = f.departure_dates;
    const hasRealDates =
      Array.isArray(dates) && dates.some((d) => String(d).trim().length > 2);
    if (hasRealDates) {
      const name = (f.route_name?.toString() || action.match?.route_name || "").trim().toLowerCase();
      if (name) tripsWithDates.add(name);
    }
  }

  proposal.conflicts.forEach((conflict, index) => {
    const detail = conflict.trim();
    if (!detail) return;
    const normalized = normalizeReviewText(detail);
    if (coveredConflictChecks.some((check) => check(normalized))) return;

    // If the model provided structured severity, only generate a question for
    // blockers. info and warning are displayed as info boxes — no question needed.
    if (conflictSeverityMap.size > 0) {
      const severity = conflictSeverityMap.get(detail) ?? "blocker";
      if (severity !== "blocker") return;
    }

    // Incomplete parse: some trips were not read (timeout / failed batch) or
    // the model returned far fewer trips than the source contains. This MUST
    // block saving — never let a partial import look "ready".
    if (
      normalized.includes("аялал дутуу") ||
      normalized.includes("боловсруулсан") ||
      normalized.includes("уншиж амжсангүй") ||
      normalized.includes("уншиж чадсангүй") ||
      normalized.includes("дахин жижиг хэсг") ||
      normalized.includes("stopped before reading") ||
      normalized.includes("split the files")
    ) {
      pushQuestion({
        id: `incomplete-parse:${index}`,
        prompt: "Файлын зарим аялал боловсруулагдаагүй байна. Хэрхэн үргэлжлүүлэх вэ?",
        detail,
        options: [
          {
            label: "Болих — бүгдийг уншуулна",
            answer:
              "Энэ хагас дутуу импортыг бүү хадгал. Файлыг жижиг хэсгүүдэд (10-аас доош аялалтай) хувааж дахин оруулна.",
          },
          {
            label: "Зөвхөн уншсан аяллуудыг хадгалах",
            answer:
              "Зөвхөн одоо амжилттай уншсан аяллуудыг хадгал. Дутуу аяллуудыг дараа нь тусдаа оруулна гэдгийг ойлгосон.",
          },
        ],
        allowCustom: false,
      });
      return;
    }

    const quoted = extractQuotedValues(conflict);
    // The first quoted value is usually the trip/route the conflict is about.
    const subject = quoted[0] || "";
    const subjectTag = subject ? `"${subject}" аяллын ` : "";

    if (isAgencyReviewText(subject) || isAgencyReviewText(detail)) return;
    if (isOptionalAddOnCostConflict(normalized)) return;
    if (isDocumentedMealExceptionConflict(normalized)) return;
    if (isRecurringDateText(normalized)) return;
    if (
      normalized.includes("хүүхдийн үнэ") ||
      normalized.includes("child price")
    ) {
      if (!isSuspiciousChildPriceConflict(normalized)) return;
    }

    if (
      normalized.includes("file") ||
      normalized.includes("файлын нэр") ||
      normalized.includes("operator") ||
      normalized.includes("оператор") ||
      normalized.includes("брэнд")
    ) {
      const detected = quoted[0] || "файлын нэр";
      const operator = quoted[1] || "илэрсэн оператор";
      if (
        normalized.includes("file") ||
        normalized.includes("файлын нэр") ||
        isLikelyTripRouteText(detected) ||
        isLikelyTripRouteText(operator) ||
        isAgencyReviewText(detected) ||
        isAgencyReviewText(operator)
      ) {
        return;
      }
      pushQuestion({
        id: `operator-mismatch:${index}`,
        prompt: "Брэнд/операторын нэр зөрчилтэй байна. Аль нэрийг хэрэглэх вэ?",
        detail,
        options: [
          {
            label: `"${operator}" хэрэглэх`,
            answer: `Операторыг "${operator}" гэж үлдээнэ үү. (Зөрчил: ${detail})`,
          },
          {
            label: `"${detected}" хэрэглэх`,
            answer: `Операторыг "${detected}" болгоно уу. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Зөв оператор эсвэл брэндийн нэрийг бичнэ үү",
      });
      return;
    }

    if (normalized.includes("хөтөлбөртэй") && normalized.includes("чөлөөт")) {
      pushQuestion({
        id: `plan-choice:${index}`,
        prompt: `${subjectTag}хөтөлбөртэй болон чөлөөт гэсэн хоёр тусдаа үнийн хувилбар байна. Яаж хадгалах вэ?`,
        detail: detail,
        options: [
          {
            label: "Тусдаа хоёр аялал",
            answer: `${subjectTag}хөтөлбөртэй болон чөлөөт хувилбарыг тусдаа хоёр аялал болгон хадгал. (Зөрчил: ${detail})`,
          },
          {
            label: "Зөвхөн хөтөлбөртэй",
            answer: `${subjectTag}зөвхөн хөтөлбөртэй хувилбарыг үндсэн аялал болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Зөвхөн чөлөөт",
            answer: `${subjectTag}зөвхөн чөлөөт хувилбарыг үндсэн аялал болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: хоёр хувилбарыг тусдаа хадгал, эсвэл нэгийг сонго",
      });
      return;
    }

    if (
      normalized.includes("хоол") ||
      normalized.includes("meal") ||
      normalized.includes("day 7")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("хоол") || value.includes("meal")),
      );
      pushQuestion({
        id: `meal-conflict:${index}`,
        prompt: `${subjectTag}хоолны мэдээлэл зөрчилтэй байна. Хоол багтсан уу?`,
        detail,
        options: [
          {
            label: "Тийм, багтсан",
            answer: `${subjectTag}хоолыг багтсан гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Үгүй, багтаагүй",
            answer: `${subjectTag}хоолыг багтаагүй гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хоолны зөв дүрмийг бичнэ үү",
      });
      return;
    }

    // The AI sometimes lists the dates it found and then still claims the date
    // is "unclear" — a self-contradiction. Drop that question entirely; the
    // dates are right there in the text.
    if (isContradictoryDateConflict(detail)) return;

    if (
      normalized.includes("явах өдөр тодорхойгүй") ||
      normalized.includes("огноо") ||
      normalized.includes("departure date")
    ) {
      // If the conflict text also mentions prices (₮ or multi-month price differences),
      // it's a seasonal pricing conflict misrouted here — skip so the seasonal-price
      // branch below fires instead.
      const hasPriceContext =
        detail.includes("₮") ||
        (normalized.includes("сард") && /\d{3,}/.test(detail));
      // If the AI already extracted departure_dates for this trip in its action,
      // the date is NOT missing — skip the question (the extractor and conflict
      // engine disagree, and the extractor wins).
      const subjectRouteName = normalizeReviewText(subject);
      const tripAlreadyHasDates =
        subjectRouteName.length > 3 && tripsWithDates.has(subjectRouteName);
      if (!hasPriceContext && !tripAlreadyHasDates) {
        const subjectKey = normalizeReviewText(subject || detail);
        coveredConflictChecks.push(
          (value) =>
            value.includes(subjectKey) &&
            (value.includes("огноо") || value.includes("departure date")),
        );
        pushQuestion({
          id: `date-conflict:${index}`,
          prompt: `${subjectTag}гарах өдрийг тодорхойлж чадсангүй. Юу хийх вэ?`,
          detail,
          options: [
            {
              label: "Огноогүй үлдээх",
              answer: `${subjectTag}гарах өдөргүйгээр саналд хэвээр нь үлдээ. (Зөрчил: ${detail})`,
            },
            {
              label: "Энэ аяллыг хасах",
              answer: `${subjectTag}гарах өдөр нь тодорхойгүй тул санал болгохгүй. (Зөрчил: ${detail})`,
            },
            {
              label: "Огноо доороос бичих",
              answer: `${subjectTag}гарах өдрийг доорх талбарт бичнэ үү.`,
            },
          ],
          allowCustom: true,
          customPlaceholder: "Гарах өдрийг бичнэ үү (ж: 2026-06-15, 2026-07-02)",
        });
        return;
      }
    }

    if (
      normalized.includes("юань") ||
      normalized.includes("cny") ||
      normalized.includes("валют")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("юань") || value.includes("cny") || value.includes("валют")),
      );
      pushQuestion({
        id: `currency-conflict:${index}`,
        prompt: `${subjectTag}үндсэн үнэ MNT, шинжилгээний нэмэлт төлбөр CNY байна. Яаж хадгалах вэ?`,
        detail,
        options: [
          {
            label: "MNT + CNY тэмдэглэл",
            answer: `${subjectTag}үндсэн үнийг MNT-ээр хадгалж, шинжилгээний CNY төлбөрийг тэмдэглэл/source_description-д тодорхой бич.`,
          },
          {
            label: "Админаар засуулах",
            answer: `${subjectTag}үнийн бүтэц тодорхойгүй тул хадгалахаас өмнө админаас яг adult/child MNT болон CNY нэмэлт төлбөрийг асуу.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: том хүн 890000 MNT + 600 CNY, хүүхэд 700000 MNT + 300 CNY",
      });
      return;
    }

    if (
      normalized.includes("6-р сард") ||
      normalized.includes("7-р сард") ||
      normalized.includes("8-р сард") ||
      normalized.includes("сард") && normalized.includes("үнэ")
    ) {
      pushQuestion({
        id: `seasonal-price:${index}`,
        prompt: `${subjectTag}сараас хамаараад үнэ өөр байна. Яаж хадгалах вэ?`,
        detail,
        options: [
          {
            label: "Огноо тус бүрд үнийг тэмдэглэ (санал болгох)",
            answer: `${subjectTag}огноо бүрийн үнийг departure_dates дотор тус тусад нь тэмдэглэл/notes хэсэгт бич. Үндсэн adult_price-д хамгийн их үнийг тавь.`,
          },
          {
            label: "Тусдаа аялал болгох",
            answer: `${subjectTag}сар бүрийг тусдаа аялал болгон хадгал. Жишээ нь "Шанхай + Тэнгэрийн хаалга — 6-р сар" ба "...— 7/8-р сар" гэж.`,
          },
          {
            label: "Хамгийн бага үнийг үндсэн болгох",
            answer: `${subjectTag}хамгийн бага үнийг үндсэн adult_price болгож, ялгааг notes хэсэгт тайлбарла.`,
          },
          {
            label: "Хамгийн их үнийг үндсэн болгох",
            answer: `${subjectTag}хамгийн их үнийг үндсэн adult_price болгож, буусан хямдралыг notes хэсэгт тайлбарла.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Жишээ: 6-р сард 3,590,000 / 7,8-р сард 3,660,000 гэж тусад нь тэмдэглэ",
      });
      return;
    }

    if (
      normalized.includes("хоёр маршрут") ||
      normalized.includes("two route") ||
      normalized.includes("ижил")
    ) {
      pushQuestion({
        id: `duplicate-route:${index}`,
        prompt: "Ижил маршруттай боловч мэдээлэл нь зөрүүтэй хоёр аялал илэрлээ. Юу хийх вэ?",
        detail,
        options: [
          {
            label: "Тусдаа үлдээх",
            answer: `Эдгээрийг тусдаа аялал болгон үлдээ. (Зөрчил: ${detail})`,
          },
          {
            label: "Нэг болгон нэгтгэх",
            answer: `Эдгээрийг нэг аялал болгон нэгтгэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("batch failed") ||
      normalized.includes("upstream") ||
      normalized.includes("503")
    ) {
      return;
    }

    if (
      normalized.includes("нэмэлт шалгалт") ||
      normalized.includes("additional check") ||
      normalized.includes("review needed") ||
      normalized.includes("баталгаажуул")
    ) {
      return;
    }

    // "add as new or update existing?" duplicate-check question
    if (
      normalized.includes("шинэ аялал болгон нэмэх үү") ||
      normalized.includes("одоо байгааг шинэчлэх үү") ||
      (normalized.includes("existing trip") && normalized.includes("duplicate")) ||
      (normalized.includes("review before creating") && normalized.includes("duplicate"))
    ) {
      const sourceLabel = sourceNames.length === 1 ? sourceNames[0] : "";
      const fileTag = sourceLabel ? ` · 📄 ${sourceLabel}` : "";
      pushQuestion({
        id: `add-or-update:${index}`,
        prompt: subject
          ? `"${subject}"${fileTag} — шинэ аялал болгон нэмэх үү, эсвэл одоо байгааг шинэчлэх үү?`
          : `Шинэ аялал нэмэх үү, эсвэл одоо байгааг шинэчлэх үү?${fileTag}`,
        detail,
        options: [
          {
            label: "Шинэ аялал болгон нэмэх",
            answer: subject
              ? `"${subject}"-г шинэ аялал болгон нэм. Одоо байгаа аялалыг бүү өөрчил.`
              : "Шинэ аялал болгон нэм. Одоо байгаа аялалыг бүү өөрчил.",
          },
          {
            label: "Одоо байгааг шинэчлэх",
            answer: subject
              ? `"${subject}"-г одоо байгаа аялалтай нэгтгэж шинэчил.`
              : "Одоо байгаа ижил аяллыг шинэчил.",
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
      });
      return;
    }

    // Any concrete conflict that doesn't match a known category still gets surfaced
    // with the original detail, so the admin is not asked a blind question.
    pushQuestion({
      id: `conflict:${index}`,
      prompt: "Энэ мэдээллийг хадгалахаас өмнө нэг шийдвэр хэрэгтэй байна.",
      detail,
      options: [
        {
          label: "Файлд бичсэн утгыг зөв гэж хадгалах",
          answer: `Файлд бичсэн утгыг зөв гэж үзээд хадгал: ${detail}`,
        },
        {
          label: "Энэ өөрчлөлтийг хадгалахгүй",
          answer: `Энэ тодорхойгүй өөрчлөлтийг саналын жагсаалтаас хас: ${detail}`,
        },
      ],
      allowCustom: true,
      customPlaceholder: "Зөв нэр, үнэ, огноо эсвэл хийх үйлдлийг яг бичнэ үү",
    });
  });

  return questions.slice(0, 4);
}


export {
  ACCEPT_FILES, ADMIN_AUTO_REFRESH_MS, DURATIONS, FIELD_LABELS, MAX_PARSE_UPLOAD_BYTES,
  HANDOFF_DURATION_CUSTOM, HANDOFF_DURATION_OPTIONS, MAX_AI_INPUT_CHARS,
  QUICK_ACTIONS, SECRET_KEY, SECRET_TS_KEY, SESSION_TTL_MS, STATUS_LABELS,
  STATUS_TONE, apiErrorMessage, asInt, buildImageUploadUnit,
  buildZipImageUploadUnits,
  buildOfficeUploadUnits, buildPdfUploadUnits, buildProposalClarifications,
  buildTextUploadUnits, dataUrlToText, delayMs, describeAction, driveSyncTone,
  fileToDataUrl, formatBytes, formatMoneyValue, formatTime, getSecretStorage,
  getTestBotConversationId, handoffDurationSelectValue, isEditableElement,
  isImageFile, isOfficeDocFile, isPdfFile, isTextLikeFile, isTransientAiFailure,
  isZipFile,
  settingsToForm, shortId, splitLines, summarizeConflict, timeLeft, toStructuredRows,
  uid,
};

/**
 * Merges the AI proposals from several parsed files/chunks into one proposal,
 * de-duplicating actions/conflicts and unioning photo sources. Pure (moved out
 * of admin.tsx to keep that file under the 2,000-line cap).
 */
export function mergeAIProposals(
  proposals: AIProposal[],
  fileNames: string[],
): AIProposal {
  const actionKeys = new Set<string>();
  const actions: AIAction[] = [];
  const conflicts = new Set<string>();
  const conflictItems = new Map<string, ConflictItem>();
  const importantReasons = new Set<string>();
  const summaries = new Set<string>();
  const photoSources = new Map<string, Set<string>>();
  for (const proposal of proposals) {
    for (const action of proposal.actions || []) {
      const key = JSON.stringify(action);
      if (actionKeys.has(key)) continue;
      actionKeys.add(key);
      actions.push(action);
    }
    for (const conflict of proposal.conflicts || []) {
      if (conflict.trim()) conflicts.add(conflict.trim());
    }
    for (const item of proposal.conflict_items || []) {
      if (item.text?.trim()) conflictItems.set(item.text.trim(), item);
    }
    if (proposal.important_reason?.trim()) {
      importantReasons.add(proposal.important_reason.trim());
    }
    if (proposal.summary?.trim()) {
      summaries.add(proposal.summary.trim());
    }
    for (const source of proposal.photo_sources || []) {
      if (!source.label?.trim()) continue;
      const urls = photoSources.get(source.label) || new Set<string>();
      for (const url of source.urls || []) {
        if (typeof url === "string" && url.trim().startsWith("https://")) {
          urls.add(url.trim());
        }
      }
      if (urls.size > 0) photoSources.set(source.label, urls);
    }
  }
  return {
    summary:
      actions.length > 0
        ? `${fileNames.length} файл уншиж ${actions.length} өөрчлөлтийн санал оллоо.`
        : Array.from(summaries)[0] || "Файлуудаас хэрэгжүүлэх өөрчлөлт олдсонгүй.",
    needs_confirmation:
      proposals.some((proposal) => proposal.needs_confirmation) ||
      conflicts.size > 0,
    important_reason: Array.from(importantReasons).join(" "),
    conflicts: Array.from(conflicts),
    conflict_items: Array.from(conflictItems.values()),
    actions,
    ...(photoSources.size > 0
      ? {
          photo_sources: Array.from(photoSources, ([label, urls]) => ({
            label,
            urls: Array.from(urls),
          })),
        }
      : {}),
  };
}

/** A placeholder proposal for a file/chunk the parser could not read. Pure. */
export function emptyChunkResult(displayName: string): {
  proposal: AIProposal;
  requestId: number | null;
} {
  return {
    proposal: {
      summary: `"${displayName}" хэсгийг бүрэн уншиж чадсангүй.`,
      needs_confirmation: true,
      important_reason:
        "Энэ хэсгийн мэдээлэл хадгалагдаагүй. Бусад уншигдсан файлын үр дүнг үргэлжлүүлэн бэлдлээ.",
      conflicts: [`"${displayName}" хэсгийг дахин шалгах шаардлагатай.`],
      actions: [],
    },
    requestId: null,
  };
}
