import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { createPosterExtractJob } from "@/lib/poster/db";

/**
 * Creates a poster extraction job row and returns its id immediately. Does
 * NOT run the extraction itself and does NOT try to trigger the worker via a
 * server-to-server self-fetch — that (fire-and-forget fetch wrapped in
 * @vercel/functions' waitUntil) proved unreliable in production: the worker
 * invocation silently never ran, leaving jobs stuck at "pending" forever with
 * no visible error.
 *
 * Instead the CLIENT drives the next step directly: after getting this jobId
 * back, it calls /api/admin/poster/extract-worker itself (one request, up to
 * its own 60s budget — the Vercel Hobby ceiling either way), then polls
 * /api/admin/poster/extract-status. No server-to-server hop to go wrong.
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

  return res.status(202).json({ jobId });
}
