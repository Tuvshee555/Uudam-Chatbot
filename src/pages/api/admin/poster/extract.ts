import type { NextApiRequest, NextApiResponse } from "next";
import { waitUntil } from "@vercel/functions";
import { requireAdminAccess } from "@/lib/adminAccess";
import { logError } from "@/lib/observability";
import { createPosterExtractJob } from "@/lib/poster/db";
import { resolveSelfBaseUrl } from "@/lib/poster/selfUrl";

/**
 * Starts a poster extraction job and returns immediately with a jobId — it
 * does NOT wait for the (possibly slow, especially for big PDFs read by
 * OpenAI vision) extraction to finish. Vercel Hobby hard-caps a function
 * invocation at 60s with no way to raise it; holding the client's request
 * open for the whole extraction meant a big real trip PDF could get silently
 * killed mid-flight, leaving the browser hanging forever with no error.
 *
 * The actual work happens in extract-worker.ts, triggered here as a
 * fire-and-forget request (not awaited) so this handler can respond right
 * away. The client polls extract-status.ts until the job is done/errored.
 */
export const config = {
  api: { bodyParser: { sizeLimit: "5mb" } },
  maxDuration: 15,
};

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract");
  if (!allowed) return;
  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as Record<string, unknown>;
  const hasBlobUrl = typeof body.blobUrl === "string" && body.blobUrl.trim();
  const hasDataBase64 = typeof body.dataBase64 === "string" && body.dataBase64.trim();
  if (!hasBlobUrl && !hasDataBase64) {
    return res.status(400).json({ error: "Файл олдсонгүй" });
  }

  const jobId = await createPosterExtractJob();
  if (!jobId) {
    return res.status(500).json({ error: "Ажил эхлүүлж чадсангүй (DB тохиргоо?)" });
  }

  // Dispatch the worker but don't await it here — waitUntil tells Vercel to
  // keep this invocation alive to finish the fetch AFTER the response below
  // is sent, instead of a plain unawaited fetch() that risks being killed the
  // instant the response goes out.
  const workerUrl = `${resolveSelfBaseUrl()}/api/admin/poster/extract-worker`;
  waitUntil(
    fetch(workerUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-admin-secret": (req.headers["x-admin-secret"] as string) || "",
      },
      body: JSON.stringify({ ...body, jobId }),
    }).catch((err) => {
      logError("poster.extract.worker_dispatch_failed", { jobId, error: String(err?.message || err) });
    }),
  );

  return res.status(202).json({ jobId });
}
