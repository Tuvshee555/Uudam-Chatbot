import type { NextApiRequest, NextApiResponse } from "next";
import { getPosterTrip, linkedTripId } from "@/lib/poster/db";
import { getTripById } from "@/lib/travelDb";
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

  // The real captured poster PDF lives on the linked trip's brochure_pdf_url —
  // that IS the actual brochure the client exported. Redirect to it and only
  // fall back to rebuilding a plain-text PDF from poster JSON when no real
  // PDF was ever attached.
  const linkedTrip = await getTripById(linkedTripId(id));
  const realPdfUrl =
    typeof linkedTrip?.extra?.brochure_pdf_url === "string"
      ? linkedTrip.extra.brochure_pdf_url.trim()
      : "";
  if (realPdfUrl.startsWith("https://")) {
    return res.redirect(302, realPdfUrl);
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
