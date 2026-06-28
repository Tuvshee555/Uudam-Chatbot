import type { NextApiRequest, NextApiResponse } from "next";
import sharp from "sharp";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getBatch } from "../../../lib/tripPhotoImport/batchStore";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.trip-photos-thumbnail");
  if (!allowed) return;

  if (req.method !== "GET") {
    return res.status(405).end();
  }

  const batchId = String(req.query.batchId || "");
  const imageId = String(req.query.imageId || "");
  const width = Math.min(Math.max(Number(req.query.w) || 160, 40), 800);

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

  try {
    const thumbnail = await sharp(image.buffer)
      .resize(width, undefined, { withoutEnlargement: true })
      .jpeg({ quality: 80, progressive: true })
      .toBuffer();

    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300");
    return res.status(200).send(thumbnail);
  } catch {
    return res.status(500).json({ error: "thumbnail_failed" });
  }
}
