/**
 * Turns an admin-uploaded file (Excel, CSV, PDF, image, plain text) into
 * something the AI can read reliably.
 *
 * - Spreadsheets become an HTML table — the model reads tabular data far
 *   more accurately as HTML than as raw cell dumps.
 * - PDFs are text-extracted server-side with pdf.js; a PDF with no text layer is
 *   an error here (the admin page renders those to images before uploading).
 * - Images are passed through as inline binary for OpenAI vision.
 */
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { docxDocumentXmlToText } from "./docxText";

export type ParsedUpload = {
  /** Short human label for the source, e.g. "price-list.xlsx". */
  label: string;
  /** HTML table or plain text for the AI prompt. Empty when `inline` is set. */
  text: string;
  /** Inline binary the model reads natively (image). */
  inline: { mimeType: string; data: string } | null;
};

type UploadInput = {
  filename: string;
  mimeType?: string;
  dataBase64: string;
};

// Browser uploads are split into sub-megabyte requests before they reach this
// parser. The larger ceiling is for server-side Drive downloads, where there is
// no request-body limit and larger workbooks/documents can be parsed directly.
export const MAX_PARSE_UPLOAD_DECODED_BYTES = 25 * 1024 * 1024;
export const MAX_PARSE_UPLOAD_TOTAL_DECODED_BYTES = 100 * 1024 * 1024;

function extensionOf(filename: string): string {
  const match = /\.([a-z0-9]+)$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function decodeBase64(dataBase64: string): Buffer {
  const cleaned = dataBase64.includes(",")
    ? dataBase64.slice(dataBase64.indexOf(",") + 1)
    : dataBase64;
  const compact = cleaned.replace(/\s/g, "");
  const estimatedBytes =
    Math.ceil((compact.length * 3) / 4) -
    (compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0);
  if (estimatedBytes > MAX_PARSE_UPLOAD_DECODED_BYTES) {
    throw new Error(
      `File is too large for one AI parse request. Maximum is ${MAX_PARSE_UPLOAD_DECODED_BYTES} bytes after decoding.`,
    );
  }
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.byteLength === 0) {
    throw new Error("Файл хоосон эсвэл уншигдсангүй.");
  }
  if (buffer.byteLength > MAX_PARSE_UPLOAD_DECODED_BYTES) {
    throw new Error(
      `File is too large for one AI parse request. Maximum is ${MAX_PARSE_UPLOAD_DECODED_BYTES} bytes after decoding.`,
    );
  }
  return buffer;
}

function rowsToHtmlTable(rows: string[][]): string {
  const body = rows
    .map(
      (row) =>
        `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<table border="1">${body}</table>`;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r") {
      // ignore — handled by \n
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim().length > 0));
}

function cellToText(value: ExcelJS.CellValue): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const obj = value as unknown as Record<string, unknown>;
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.richText)) {
      return obj.richText
        .map((part) => String((part as { text?: string })?.text ?? ""))
        .join("");
    }
    if (obj.result != null) return String(obj.result);
    if (typeof obj.hyperlink === "string") return String(obj.hyperlink);
  }
  return "";
}

async function excelToHtml(buffer: Buffer): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  try {
    type LoadArg = Parameters<typeof workbook.xlsx.load>[0];
    await workbook.xlsx.load(buffer as unknown as LoadArg);
  } catch {
    throw new Error(
      "Excel файлыг уншиж чадсангүй. .xlsx хэлбэрээр хадгалаад дахин оруулна уу.",
    );
  }

  const sections: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        cells.push(cellToText(cell.value));
      });
      if (cells.some((cell) => cell.trim().length > 0)) {
        rows.push(cells);
      }
    });
    if (rows.length > 0) {
      sections.push(
        `<h3>${escapeHtml(sheet.name)}</h3>${rowsToHtmlTable(rows)}`,
      );
    }
  });

  if (sections.length === 0) {
    throw new Error("Excel файлд өгөгдөл олдсонгүй.");
  }
  return sections.join("\n");
}

/**
 * Reads a legacy binary .xls (BIFF) workbook via SheetJS, which handles the
 * old format ExcelJS cannot. Output matches excelToHtml so the AI sees the
 * same HTML-table shape regardless of source format.
 */
async function legacyXlsToHtml(buffer: Buffer): Promise<string> {
  const XLSX = await import("xlsx");
  let workbook: import("xlsx").WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch {
    throw new Error(
      "Excel файлыг уншиж чадсангүй. .xlsx хэлбэрээр хадгалаад дахин оруулна уу.",
    );
  }

  const sections: string[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const rows = XLSX.utils.sheet_to_json<string[]>(sheet, {
      header: 1,
      blankrows: false,
      defval: "",
      raw: false,
    });
    const cleaned = rows
      .map((row) => (Array.isArray(row) ? row.map((cell) => String(cell ?? "")) : []))
      .filter((row) => row.some((cell) => cell.trim().length > 0));
    if (cleaned.length > 0) {
      sections.push(`<h3>${escapeHtml(sheetName)}</h3>${rowsToHtmlTable(cleaned)}`);
    }
  }

  if (sections.length === 0) {
    throw new Error("Excel файлд өгөгдөл олдсонгүй.");
  }
  return sections.join("\n");
}

/**
 * Extracts readable text from a .docx (Word) file. A .docx is a ZIP whose
 * word/document.xml holds the body. JSZip reads the central directory, so an
 * entry whose sizes live in a data descriptor (Google Docs and other streaming
 * writers) is found too; the earlier header-scanning reader skipped those and
 * reported the file as unreadable (2026-11-04).
 */
async function docxToText(buffer: Buffer): Promise<string> {
  let xml: string | undefined;
  try {
    const zip = await JSZip.loadAsync(buffer);
    xml = await zip.file("word/document.xml")?.async("string");
  } catch {
    xml = undefined;
  }
  if (!xml) {
    throw new Error(
      "Word файлыг уншиж чадсангүй (word/document.xml олдсонгүй). PDF болгож хадгалаад эсвэл текстээ хуулж оруулна уу.",
    );
  }
  return docxDocumentXmlToText(xml);
}

/**
 * The PDF's text layer, page by page, through pdf.js (the same engine the admin
 * page uses in the browser). pdf-parse 1.x bundled a 2018 pdf.js that rejected
 * PDFs with object streams, i.e. most files Word and Chrome write today, with
 * "Invalid PDF structure" (2026-11-04).
 */
async function pdfToText(buffer: Buffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const pages: string[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const lines: string[] = [];
      let line = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        } else if (item.str && !item.str.endsWith(" ")) {
          line += " ";
        }
      }
      if (line.trim()) lines.push(line);
      const text = lines.map((entry) => entry.replace(/[ \t]+/g, " ").trimEnd()).join("\n").trim();
      if (text) pages.push(`Page ${pageNumber}\n${text}`);
    }
  } finally {
    await document.destroy().catch(() => undefined);
  }
  return { text: pages.join("\n\n").trim(), pages: document.numPages };
}

function normalizeImageMime(extension: string, mimeType?: string): string {
  if (mimeType && mimeType.startsWith("image/")) return mimeType;
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    heic: "image/heic",
    heif: "image/heif",
  };
  return map[extension] || "image/jpeg";
}

export async function parseUpload(input: UploadInput): Promise<ParsedUpload> {
  const filename = input.filename.trim() || "upload";
  const extension = extensionOf(filename);
  const mimeType = (input.mimeType || "").toLowerCase();
  const buffer = decodeBase64(input.dataBase64);

  const isExcel = ["xlsx", "xlsm"].includes(extension);
  const isLegacyExcel = extension === "xls";
  const isWord =
    extension === "docx" ||
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const isCsv = extension === "csv" || mimeType === "text/csv";
  const isPdf = extension === "pdf" || mimeType === "application/pdf";
  const isImage =
    ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif"].includes(extension) ||
    mimeType.startsWith("image/");
  const isText =
    ["txt", "text", "md", "log"].includes(extension) ||
    mimeType.startsWith("text/");

  if (isLegacyExcel) {
    return { label: filename, text: await legacyXlsToHtml(buffer), inline: null };
  }

  if (isExcel) {
    return { label: filename, text: await excelToHtml(buffer), inline: null };
  }

  if (isWord) {
    const text = await docxToText(buffer);
    if (!text) throw new Error("Word файлд текст олдсонгүй.");
    return { label: filename, text, inline: null };
  }

  if (isCsv) {
    const rows = parseCsv(buffer.toString("utf8"));
    if (rows.length === 0) throw new Error("CSV файлд өгөгдөл олдсонгүй.");
    return { label: filename, text: rowsToHtmlTable(rows), inline: null };
  }

  if (isPdf) {
    let parsed: { text: string; pages: number };
    try {
      parsed = await pdfToText(buffer);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`PDF файлыг нээж чадсангүй (${reason}). Файл гэмтсэн эсвэл нууц үгтэй байж магадгүй.`);
    }
    if (parsed.text) {
      return { label: filename, text: parsed.text, inline: null };
    }
    // No text layer: a scanned or image-only PDF. Nothing can be read from it here; the
    // admin page renders such pages to images itself, so say that instead of sending the
    // model an empty source that looks like a parsed file.
    throw new Error(
      `PDF-д уншигдах текст алга (${parsed.pages} хуудас, сканнердсан зураг байж магадгүй). Админ хуудаснаас шууд оруулбал хуудас бүрийг зураг болгон уншина.`,
    );
  }

  if (isImage) {
    return {
      label: filename,
      text: "",
      inline: {
        mimeType: normalizeImageMime(extension, mimeType),
        data: buffer.toString("base64"),
      },
    };
  }

  if (isText) {
    const text = buffer.toString("utf8").trim();
    if (!text) throw new Error("Текст файл хоосон байна.");
    return { label: filename, text, inline: null };
  }

  throw new Error(
    "Энэ төрлийн файл дэмжигдэхгүй. Excel (.xlsx/.xls), Word (.docx), CSV, PDF, зураг эсвэл текст файл оруулна уу.",
  );
}
