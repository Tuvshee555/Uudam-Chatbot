import type { NextApiRequest, NextApiResponse } from "next";
import Busboy from "busboy";
import { del } from "@vercel/blob";
import { requireAdminAccess } from "@/lib/adminAccess";
import { logError } from "@/lib/observability";
import {
  MAX_TOTAL_BYTES,
  assertReadableDocument,
  resolveFile,
  runExtraction,
} from "@/lib/poster/extractCore";

// Answer with a clean JSON error BEFORE Vercel's hard 60s kill — a killed
// function returns nothing, which the browser experiences as an endless hang.
// The AI calls inside runExtraction are awaited network I/O, so this race can
// actually fire (the one sync-CPU hotspot, photo cropping, is already capped).
const EXTRACTION_BUDGET_MS = 52_000;

function withBudget<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            "Уншилт хугацаанаас хэтэрлээ (52s). PDF хэт том эсвэл нарийн байна — хуудсыг цөөлж эсвэл текст/docx болгож дахин оролдоно уу.",
          ),
        ),
      EXTRACTION_BUDGET_MS,
    );
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Small files come in as multipart FormData and are extracted directly. Large
 * files must be uploaded browser -> Blob first because Vercel rejects bodies
 * over ~4.5MB before this handler runs; in that case the client posts a tiny
 * JSON body with the Blob URL and we read the file from there.
 */
export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

function readSingleUpload(
  req: NextApiRequest,
): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  return new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      resolve(null);
      return;
    }
    const busboy = Busboy({ headers: req.headers, defParamCharset: "utf8" });
    let picked: { buffer: Buffer; filename: string; mimeType: string } | null = null;
    let tooBig = false;

    busboy.on("file", (_field, file, info) => {
      // Only keep the first file; drain any extras.
      if (picked) {
        file.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      file.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_TOTAL_BYTES) {
          tooBig = true;
          file.resume();
          return;
        }
        chunks.push(chunk);
      });
      file.on("end", () => {
        if (!tooBig) {
          picked = {
            buffer: Buffer.concat(chunks),
            filename: info.filename || "document",
            mimeType: info.mimeType || "",
          };
        }
      });
    });

    busboy.on("error", (err) => reject(err));
    busboy.on("finish", () => {
      if (tooBig) {
        reject(new Error("Файл хэт том (100MB дээд хязгаар)"));
        return;
      }
      resolve(picked);
    });

    req.pipe(busboy);
  });
}

function readJsonBody(req: NextApiRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8").trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  let blobUrl: string | undefined;
  try {
    const contentType = String(req.headers["content-type"] || "");
    let upload: { buffer: Buffer; filename: string; mimeType: string } | null = null;

    if (contentType.includes("multipart/form-data")) {
      upload = await readSingleUpload(req);
    } else if (contentType.includes("application/json")) {
      const resolved = await resolveFile(await readJsonBody(req));
      blobUrl = resolved.blobUrl;
      upload = {
        buffer: resolved.buffer,
        filename: resolved.filename,
        mimeType: resolved.mime,
      };
    }

    if (!upload) return res.status(400).json({ error: "Файл олдсонгүй" });

    // Rejects empty/truncated files (OneDrive online-only placeholders) in
    // <1ms with a message that says what's wrong, instead of feeding garbage
    // to the AI and failing confusingly a minute later.
    assertReadableDocument(upload.buffer, upload.filename, upload.mimeType);

    const result = await withBudget(
      runExtraction(upload.buffer, upload.filename, upload.mimeType),
    );
    return res.status(200).json(result);
  } catch (e) {
    const message = String((e as Error).message || e);
    logError("poster.extract.failed", { error: message });
    return res.status(500).json({ error: message });
  } finally {
    if (blobUrl) {
      del(blobUrl).catch(() => {});
    }
  }
}
