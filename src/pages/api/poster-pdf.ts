import type { NextApiRequest, NextApiResponse } from "next";
import { getPosterTrip } from "@/lib/poster/db";
import { buildPosterPdf, sanitizePosterPdfFileName } from "@/lib/poster/pdf";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const id = typeof req.query.id === "string" ? req.query.id.trim() : "";
  if (!id || !/^[A-Za-z0-9_-]{3,160}$/.test(id)) {
    return res.status(400).json({ error: "Valid poster id is required" });
  }

  const poster = await getPosterTrip(id);
  if (!poster) {
    return res.status(404).json({ error: "Poster PDF not found" });
  }

  const pdf = await buildPosterPdf(poster);
  const fileName = `${sanitizePosterPdfFileName(poster.title)}-${poster.id}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
  res.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
  res.setHeader("Content-Length", String(pdf.length));
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(pdf);
}
