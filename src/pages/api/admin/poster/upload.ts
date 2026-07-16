import type { NextApiRequest, NextApiResponse } from "next";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { hasAdminAccess } from "@/lib/adminAccess";
import { safeSecretCompare } from "@/lib/adminAuth";
import { getEnv } from "@/lib/env";

function payloadHasAdminAccess(clientPayload: string | null): boolean {
  const env = getEnv();
  if (env.adminOpenAccess) return true;
  if (!clientPayload) return false;
  try {
    const parsed = JSON.parse(clientPayload) as unknown;
    const provided =
      parsed && typeof parsed === "object"
        ? String((parsed as Record<string, unknown>).adminSecret || "")
        : "";
    return safeSecretCompare(env.adminSecret, provided);
  } catch {
    return false;
  }
}

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
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        if (!hasAdminAccess(req) && !payloadHasAdminAccess(clientPayload)) {
          throw new Error("unauthorized");
        }
        return {
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
