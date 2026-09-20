import type { NextApiRequest, NextApiResponse } from "next";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { hasAdminAccess } from "@/lib/adminAccess";
import { safeSecretCompare } from "@/lib/adminAuth";
import { getEnv } from "@/lib/env";
import { getClientKey, rateLimitAsync } from "@/lib/rateLimit";
import { recordCounter } from "@/lib/observability";

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

  // The admin secret can arrive inside the Blob client payload here rather than
  // as a header, so this route can't use requireAdminAccess. It mirrors what
  // that helper does by hand: throttle only the FAILURE path. Charging every
  // call would cap legitimate bulk poster/photo imports at the auth-failure
  // budget (20/min by default) and 429 a staff member mid-upload.
  let denial: "unauthorized" | "rate_limited" | null = null;
  let rateLimitReset = 0;

  try {
    const jsonResponse = await handleUpload({
      body: req.body as HandleUploadBody,
      request: req,
      onBeforeGenerateToken: async (_pathname, clientPayload) => {
        if (!hasAdminAccess(req) && !payloadHasAdminAccess(clientPayload)) {
          const attempt = await rateLimitAsync(
            `admin-auth:${getClientKey(req)}`,
            getEnv().adminAuthRateLimit,
            60 * 1000,
          );
          denial = attempt.allowed ? "unauthorized" : "rate_limited";
          rateLimitReset = attempt.reset;
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
    // A rejected secret is a 401, not a 400 — it used to be reported as a
    // generic Blob failure, which hid failed auth from logs and monitoring.
    if (denial === "rate_limited") {
      recordCounter("abuse.admin_auth_blocked_total", 1, {
        route: "api.admin.poster.upload",
      });
      return res.status(429).json({ error: "too_many_attempts", reset: rateLimitReset });
    }
    if (denial === "unauthorized") {
      recordCounter("abuse.admin_auth_failed_total", 1, {
        route: "api.admin.poster.upload",
      });
      return res.status(401).json({ error: "unauthorized" });
    }
    return res.status(400).json({
      error: `Vercel Blob токен авахад алдаа гарлаа: ${message}`,
    });
  }
}
