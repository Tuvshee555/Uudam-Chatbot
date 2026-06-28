import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getBatch } from "../../../lib/tripPhotoImport/batchStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.trip-photos-full");
  if (!allowed) return;

  if (req.method !== "GET") {
    return res.status(405).end();
  }

  const batchId = String(req.query.batchId || "");
  const imageId = String(req.query.imageId || "");

  if (!batchId || !imageId) {
    return res.status(400).json({ error: "missing_params" });
  }

  const batch = getBatch(batchId);
  if (!batch) {
    return res.status(404).json({ error: "batch_not_found" });
  }

  const image = batch.items
    .flatMap((item) => item.images)
    .find((img) => img.id === imageId);

  if (!image || !image.buffer || image.buffer.length === 0) {
    return res.status(404).json({ error: "image_not_found" });
  }

  res.setHeader("Content-Type", image.mimeType || "image/jpeg");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(image.originalName || "image.jpg")}"`);
  res.setHeader("Cache-Control", "private, max-age=300");
  return res.status(200).send(image.buffer);
}
