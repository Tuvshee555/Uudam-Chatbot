import type { IncomingMessage } from "http";
import Busboy from "busboy";
import JSZip from "jszip";
import { createHash, randomUUID } from "crypto";
import {
  type ImportImage,
  type ImportItem,
  MAX_BATCH_TOTAL_BYTES,
  MAX_FILE_SIZE_BYTES,
  getMimeType,
  isImageFileName,
} from "./types";
import { extractSequencePrefix } from "./normalize";

type RawFile = {
  fieldName: string;
  fileName: string;
  mimeType: string;
  buffer: Buffer;
};

export type ExtractResult = {
  items: ImportItem[];
  totalBytes: number;
  errors: string[];
};

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function bufferToImportImage(
  fileName: string,
  buffer: Buffer,
  mimeType?: string,
): ImportImage {
  const cleanName = fileName.split("/").pop() || fileName;
  return {
    id: randomUUID(),
    fileName: cleanName,
    originalName: cleanName,
    mimeType: mimeType || getMimeType(cleanName),
    size: buffer.length,
    buffer,
    sha256: sha256(buffer),
    sequence: extractSequencePrefix(cleanName),
  };
}

async function extractZip(fileName: string, buffer: Buffer): Promise<ImportItem> {
  const zip = await JSZip.loadAsync(buffer);
  const images: ImportImage[] = [];
  const errors: string[] = [];

  zip.forEach((relativePath, entry) => {
    if (entry.dir) return;
    if (relativePath.includes("__MACOSX")) return;
    if (!isImageFileName(relativePath)) return;
    images.push({
      id: randomUUID(),
      fileName: relativePath,
      originalName: relativePath,
      mimeType: getMimeType(relativePath),
      size: 0,
      buffer: Buffer.alloc(0),
      sha256: "",
      sequence: extractSequencePrefix(relativePath),
    });
  });

  // Load buffers asynchronously preserving order metadata
  const loaded = await Promise.all(
    images.map(async (img) => {
      const entry = zip.file(img.fileName);
      if (!entry) return null;
      try {
        const buffer = await entry.async("nodebuffer");
        if (buffer.length > MAX_FILE_SIZE_BYTES) {
          errors.push(`${img.fileName}: 10MB-ээс том`);
          return null;
        }
        return bufferToImportImage(img.fileName, buffer, img.mimeType);
      } catch {
        errors.push(`${img.fileName}: задлахад алдаа`);
        return null;
      }
    }),
  );

  const validImages = loaded
    .filter((img): img is ImportImage => img !== null)
    .sort((a, b) => a.fileName.localeCompare(b.fileName, undefined, { numeric: true }));

  return {
    id: randomUUID(),
    name: fileName.split("/").pop() || fileName,
    sourceType: "zip",
    images: validImages,
    imageCount: validImages.length,
    error: errors.length ? errors.join("; ") : undefined,
  };
}

export async function parseMultipartFiles(
  req: IncomingMessage,
): Promise<ExtractResult> {
  const rawFiles: RawFile[] = [];
  let totalBytes = 0;
  const errors: string[] = [];

  const contentType = req.headers["content-type"];
  if (!contentType || !contentType.includes("multipart/form-data")) {
    return { items: [], totalBytes: 0, errors: ["multipart/form-data expected"] };
  }

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });

    busboy.on("file", (fieldName, file, info) => {
      const chunks: Buffer[] = [];
      const { filename, mimeType } = info;

      file.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalBytes += chunk.length;
        if (totalBytes > MAX_BATCH_TOTAL_BYTES) {
          file.resume();
          reject(new Error("Batch too large"));
          return;
        }
      });

      file.on("end", () => {
        const buffer = Buffer.concat(chunks);
        if (buffer.length > 0) {
          rawFiles.push({ fieldName, fileName: filename, mimeType, buffer });
        }
      });

      file.on("error", (err) => {
        errors.push(String(err));
      });
    });

    busboy.on("error", (err) => reject(err));

    busboy.on("finish", async () => {
      try {
        const items: ImportItem[] = [];
        for (const raw of rawFiles) {
          if (raw.fileName.toLowerCase().endsWith(".zip")) {
            items.push(await extractZip(raw.fileName, raw.buffer));
          } else if (isImageFileName(raw.fileName)) {
            if (raw.buffer.length > MAX_FILE_SIZE_BYTES) {
              errors.push(`${raw.fileName}: 10MB-ээс том`);
              continue;
            }
            items.push({
              id: randomUUID(),
              name: raw.fileName.split("/").pop() || raw.fileName,
              sourceType: "image",
              images: [bufferToImportImage(raw.fileName, raw.buffer, raw.mimeType)],
              imageCount: 1,
            });
          }
        }
        resolve({ items, totalBytes, errors });
      } catch (err) {
        reject(err);
      }
    });

    req.pipe(busboy);
  });
}

export function buildImageGroupFromFiles(files: File[]): ImportItem[] {
  // Browser-side helper for folder/file drops; images with a common directory
  // prefix are grouped into one folder item so the matching is per-folder.
  const groups = new Map<string, ImportImage[]>();
  for (const file of files) {
    if (!isImageFileName(file.name)) continue;
    const path = file.webkitRelativePath || "";
    const dir = path.split("/").slice(0, -1).join("/") || "";
    const groupKey = dir || file.name;
    const buffer = Buffer.from([]); // not available in browser; server re-extracts
    groups.set(groupKey, [
      ...(groups.get(groupKey) || []),
      {
        id: randomUUID(),
        fileName: file.name,
        originalName: file.name,
        mimeType: file.type || getMimeType(file.name),
        size: file.size,
        buffer,
        sha256: "",
        sequence: extractSequencePrefix(file.name),
      },
    ]);
  }

  return Array.from(groups.entries()).map(([name, images]) => ({
    id: randomUUID(),
    name,
    sourceType: "folder" as const,
    images: images.sort((a, b) =>
      a.fileName.localeCompare(b.fileName, undefined, { numeric: true }),
    ),
    imageCount: images.length,
  }));
}
