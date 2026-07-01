import type { NextApiRequest, NextApiResponse } from "next";
import Busboy from "busboy";
import { requireAdminAccess } from "@/lib/adminAccess";
import { logError } from "@/lib/observability";
import { MAX_TOTAL_BYTES, runExtraction } from "@/lib/poster/extractCore";

/**
 * Reads an uploaded trip document (PDF/docx/txt/image) as multipart FormData
 * and returns the extracted trip JSON — directly, in one request, exactly like
 * the standalone poster generator that works reliably.
 *
 * No Vercel Blob, no background job/worker, no polling. Those layers were added
 * to work around Vercel's serverless body cap but caused far more breakage than
 * they solved. The simple direct approach matches the proven original; if a
 * genuinely huge file hits Vercel's body limit it fails fast with a clear 413,
 * which is far better than the silent hangs the Blob/job machinery produced.
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

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  try {
    const upload = await readSingleUpload(req);
    if (!upload) return res.status(400).json({ error: "Файл олдсонгүй" });

    const result = await runExtraction(upload.buffer, upload.filename, upload.mimeType);
    return res.status(200).json(result);
  } catch (e) {
    const message = String((e as Error).message || e);
    logError("poster.extract.failed", { error: message });
    return res.status(500).json({ error: message });
  }
}
