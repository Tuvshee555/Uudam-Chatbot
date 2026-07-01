import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { failPosterExtractJob, getPosterExtractJob } from "@/lib/poster/db";

const EXTRACT_JOB_STALE_MS = 75 * 1000;
const STALE_JOB_ERROR =
  "Poster extraction timed out before it could finish. Large PDFs can exceed the serverless function limit; try a smaller PDF or convert the itinerary to text/docx.";

/**
 * Polled by the client every few seconds while a poster extraction job runs.
 * Cheap and fast — just reads one DB row, never touches the AI itself.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster.extract-status");
  if (!allowed) return;
  if (req.method !== "GET") return res.status(405).end();

  const jobId = typeof req.query.jobId === "string" ? req.query.jobId : "";
  if (!jobId) return res.status(400).json({ error: "jobId шаардлагатай" });

  const job = await getPosterExtractJob(jobId);
  if (!job) return res.status(404).json({ error: "Ажил олдсонгүй" });

  if (job.status === "pending" || job.status === "running") {
    const updatedAt = new Date(job.updated_at).getTime();
    if (Number.isFinite(updatedAt) && Date.now() - updatedAt > EXTRACT_JOB_STALE_MS) {
      await failPosterExtractJob(jobId, STALE_JOB_ERROR);
      return res.status(200).json({ status: "error", error: STALE_JOB_ERROR });
    }
  }

  return res.status(200).json({
    status: job.status,
    result: job.status === "done" ? job.result : undefined,
    error: job.status === "error" ? job.error : undefined,
  });
}
