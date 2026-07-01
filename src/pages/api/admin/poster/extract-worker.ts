import type { NextApiRequest, NextApiResponse } from "next";
import { del } from "@vercel/blob";
import { requireAdminAccess } from "@/lib/adminAccess";
import { logError, logInfo } from "@/lib/observability";
import {
  completePosterExtractJob,
  failPosterExtractJob,
  markPosterExtractJobRunning,
} from "@/lib/poster/db";
import { MAX_TOTAL_BYTES, resolveFile, runExtraction } from "@/lib/poster/extractCore";

/**
 * Does the actual (possibly slow) document extraction for a job created by
 * /api/admin/poster/extract. Invoked as a fire-and-forget request from that
 * route — the CLIENT never talks to this endpoint directly, it polls
 * /api/admin/poster/extract-status instead. Gets its own full 60s budget
 * (Vercel Hobby's ceiling) independent of how long the client has been
 * waiting overall, since the client only ever holds open short poll requests.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } },
  maxDuration: 60,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract-worker");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as Record<string, unknown>;
  const jobId = typeof body.jobId === "string" ? body.jobId : "";
  if (!jobId) return res.status(400).json({ error: "jobId шаардлагатай" });

  // Acknowledge immediately-ish; the real work happens below but the caller
  // (extract.ts) doesn't await this response body, only that the request was
  // accepted, so this return value is mostly for direct-invocation debugging.
  let blobUrl: string | undefined;
  try {
    await markPosterExtractJobRunning(jobId);
    const resolved = await resolveFile(body);
    blobUrl = resolved.blobUrl;
    if (resolved.buffer.length > MAX_TOTAL_BYTES) {
      await failPosterExtractJob(jobId, "Файл хэт том (100MB дээд хязгаар)");
      return res.status(200).json({ ok: false });
    }
    const result = await runExtraction(resolved.buffer, resolved.filename, resolved.mime);
    await completePosterExtractJob(jobId, result);
    logInfo("poster.extract_worker.done", { jobId });
    return res.status(200).json({ ok: true });
  } catch (e) {
    const message = String((e as Error).message || e);
    logError("poster.extract_worker.failed", { jobId, error: message });
    await failPosterExtractJob(jobId, message);
    return res.status(200).json({ ok: false });
  } finally {
    if (blobUrl) {
      del(blobUrl).catch(() => {});
    }
  }
}
