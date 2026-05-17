/**
 * Turns an admin-uploaded file (Excel, CSV, PDF, image, plain text) into
 * something the AI can read reliably.
 *
 * - Spreadsheets become an HTML table — the model reads tabular data far
 *   more accurately as HTML than as raw cell dumps.
 * - PDFs and images are passed through as inline binary; Gemini reads those
 *   natively (OCR-style), so a photo of a paper price list works too.
 */
import ExcelJS from "exceljs";

export const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

export type ParsedUpload = {
  /** Short human label for the source, e.g. "price-list.xlsx". */
  label: string;
  /** HTML table or plain text for the AI prompt. Empty when `inline` is set. */
  text: string;
  /** Inline binary the model reads natively (PDF / image). */
  inline: { mimeType: string; data: string } | null;
};

type UploadInput = {
  filename: string;
  mimeType?: string;
  dataBase64: string;
};

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
  const buffer = Buffer.from(cleaned, "base64");
  if (buffer.byteLength === 0) {
    throw new Error("Файл хоосон эсвэл уншигдсангүй.");
  }
  if (buffer.byteLength > MAX_UPLOAD_BYTES) {
    throw new Error("Файл хэт том байна (12MB-ээс бага байх ёстой).");
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
  const isCsv = extension === "csv" || mimeType === "text/csv";
  const isPdf = extension === "pdf" || mimeType === "application/pdf";
  const isImage =
    ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif"].includes(extension) ||
    mimeType.startsWith("image/");
  const isText =
    ["txt", "text", "md", "log"].includes(extension) ||
    mimeType.startsWith("text/");

  if (isLegacyExcel) {
    throw new Error(
      "Хуучин .xls формат дэмжигдэхгүй. Файлаа .xlsx болгож хадгалаад дахин оруулна уу.",
    );
  }

  if (isExcel) {
    return { label: filename, text: await excelToHtml(buffer), inline: null };
  }

  if (isCsv) {
    const rows = parseCsv(buffer.toString("utf8"));
    if (rows.length === 0) throw new Error("CSV файлд өгөгдөл олдсонгүй.");
    return { label: filename, text: rowsToHtmlTable(rows), inline: null };
  }

  if (isPdf) {
    return {
      label: filename,
      text: "",
      inline: { mimeType: "application/pdf", data: buffer.toString("base64") },
    };
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
    "Энэ төрлийн файл дэмжигдэхгүй. Excel, CSV, PDF, зураг эсвэл текст файл оруулна уу.",
  );
}
