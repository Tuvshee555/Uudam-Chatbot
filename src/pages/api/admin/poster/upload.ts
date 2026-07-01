import type { NextApiRequest, NextApiResponse } from "next";
import { put } from "@vercel/blob";
import { requireAdminAccess } from "@/lib/adminAccess";

// Large poster documents (>3MB) can't fit through a serverless function's
// ~4.5MB body cap. The client streams the raw file here first; we store it in
// Vercel Blob and hand back a URL. /api/admin/poster/extract then fetches that
// URL server-side (whole file, so PDF vision extraction still sees full layout)
// and deletes the blob once done.
export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

function readRawBody(req: NextApiRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.upload");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({
      error: "Vercel Blob тохируулаагүй байна (BLOB_READ_WRITE_TOKEN алга).",
    });
  }

  const filename = (req.headers["x-filename"] as string) || "upload";
  const contentType = (req.headers["content-type"] as string) || "application/octet-stream";

  try {
    const body = await readRawBody(req);
    if (body.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: "Файл хэт том (100MB дээд хязгаар)" });
    }
    const blob = await put(filename, body, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });
    return res.status(200).json({ url: blob.url });
  } catch (e) {
    return res.status(500).json({ error: String((e as Error).message || e) });
  }
}
