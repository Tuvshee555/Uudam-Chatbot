import type { NextApiRequest, NextApiResponse } from "next";
import { getPosterTrip } from "@/lib/poster/db";
import { sanitizePosterPdfFileName } from "@/lib/poster/pdfUrl";
import { renderPosterPdf } from "@/lib/poster/renderPdf";

export const config = { maxDuration: 60 };

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

  const pdf = await renderPosterPdf(poster);
  // Customers see this name on the file in Messenger, so keep the Mongolian
  // title readable and leave the transliterated name as the ASCII fallback.
  const fileName = `${sanitizePosterPdfFileName(poster.title)}-${poster.id}.pdf`;
  const readableName = `${
    poster.title.replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Аялал"
  }.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `inline; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(readableName)}`,
  );
  res.setHeader("Cache-Control", "no-cache, must-revalidate");
  res.setHeader("Content-Length", String(pdf.length));
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(200).send(pdf);
}
