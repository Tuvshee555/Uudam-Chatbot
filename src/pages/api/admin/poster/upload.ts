import type { NextApiRequest, NextApiResponse } from "next";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { requireAdminAccess } from "@/lib/adminAccess";

/**
 * Issues a short-lived client upload token so the BROWSER can upload large
 * poster documents DIRECTLY to Vercel Blob — never through this (or any)
 * serverless function's request body.
 *
 * Vercel enforces a hard ~4.5MB cap on a serverless function's request body,
 * no matter how the function reads it (streamed or buffered). A route that
 * accepts the raw file as its body — as this one used to — gets rejected by
 * the platform with FUNCTION_PAYLOAD_TOO_LARGE before the handler even runs.
 * The fix is Vercel Blob's client-upload pattern: this endpoint only ever
 * exchanges a tiny JSON token request/response; the actual file bytes flow
 * browser → Blob storage directly.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.upload");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    // BLOB_STORE_ID/BLOB_WEBHOOK_PUBLIC_KEY existing without this token means
    // the Blob store was connected but Vercel didn't attach the read-write
    // token to this project's env vars — reconnect it from Vercel's Storage
    // tab (Storage -> your Blob store -> Connect Project), which should add
    // BLOB_READ_WRITE_TOKEN automatically, then redeploy.
    return res.status(503).json({
      error:
        "Vercel Blob-ын BLOB_READ_WRITE_TOKEN тохируулаагүй байна. " +
        `(BLOB_STORE_ID ${process.env.BLOB_STORE_ID ? "бий" : "байхгүй"}) ` +
        "Vercel → Storage → Blob сан → Connect Project дахин хийгээд deploy хийнэ үү.",
    });
  }

  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "text/plain",
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/gif",
          "image/bmp",
        ],
        maximumSizeInBytes: 100 * 1024 * 1024,
        addRandomSuffix: true,
      }),
    });
    return res.status(200).json(jsonResponse);
  } catch (e) {
    const message = String((e as Error).message || e);
    return res.status(400).json({
      error: `Vercel Blob токен авахад алдаа гарлаа: ${message}`,
    });
  }
}
