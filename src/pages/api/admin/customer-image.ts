import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";
import { queryNeon } from "../../../lib/neonDb";
import { readCustomerImage } from "../../../lib/customerImageStorage";
import { verifyCustomerImagePreview } from "../../../lib/customerImageAccess";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "GET") return res.status(405).end();
  const id = Number(req.query.id);
  const expires = Number(req.query.expires);
  const signature = String(req.query.signature || "");
  if (!verifyCustomerImagePreview(id, expires, signature)) return res.status(403).end();
  const result = await queryNeon<{ stored_url: string; mime_type: string }>(
    `SELECT stored_url, mime_type FROM travel_customer_documents
      WHERE id=$1 AND retention_hidden_at IS NULL LIMIT 1`, [id],
  );
  const row = result?.rows[0];
  if (!row?.stored_url || !row.mime_type.startsWith("image/")) return res.status(404).end();
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  try {
    const url = new URL(row.stored_url);
    if (url.protocol !== "https:") return res.status(404).end();
    if (url.hostname.endsWith(".blob.vercel-storage.com")) {
      const blob = await readCustomerImage(row.stored_url);
      if (!blob || blob.statusCode !== 200) return res.status(404).end();
      res.setHeader("Content-Type", blob.blob.contentType.startsWith("image/") ? blob.blob.contentType : "application/octet-stream");
      await new Promise<void>((resolve, reject) => {
        Readable.fromWeb(blob.stream as Parameters<typeof Readable.fromWeb>[0])
          .on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
      });
      return;
    }
    if (url.hostname !== "res.cloudinary.com") return res.status(404).end();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (!response.ok || !response.body) return res.status(502).end();
    const type = response.headers.get("content-type") || "";
    if (!type.startsWith("image/")) return res.status(502).end();
    res.setHeader("Content-Type", type);
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
        .on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
    });
  } catch {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
}
