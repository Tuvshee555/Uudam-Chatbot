import type { NextApiRequest, NextApiResponse } from "next";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { hasAdminAccess } from "../../../lib/adminAccess";
import { MAX_BATCH_TOTAL_BYTES } from "../../../lib/tripPhotoImport/types";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(503).json({
      error:
        "Vercel Blob-ын BLOB_READ_WRITE_TOKEN тохируулаагүй байна. " +
        "Vercel -> Storage -> Blob сан -> Connect Project хийгээд deploy хийнэ үү.",
    });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req,
      // Only the signed-in admin's session cookie opens an upload token (POST: never the read-only API token).
      onBeforeGenerateToken: async () => {
        if (!hasAdminAccess(req)) {
          throw new Error("unauthorized");
        }
        return {
          allowedContentTypes: [
            "application/zip",
            "application/x-zip-compressed",
            "image/jpeg",
            "image/png",
            "image/webp",
          ],
          maximumSizeInBytes: MAX_BATCH_TOTAL_BYTES,
          addRandomSuffix: true,
        };
      },
    });
    return res.status(200).json(jsonResponse);
  } catch (e) {
    const message = String((e as Error).message || e);
    return res.status(400).json({
      error: `Vercel Blob токен авахад алдаа гарлаа: ${message}`,
    });
  }
}
