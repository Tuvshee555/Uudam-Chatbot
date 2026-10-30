import type { NextApiRequest, NextApiResponse } from "next";
import { Readable } from "node:stream";
import { queryNeon } from "../../../lib/neonDb";
import { readCustomerImage } from "../../../lib/customerImageStorage";
import { verifyCustomerImagePreview } from "../../../lib/customerImageAccess";

/**
 * A customer document behind a signed, expiring admin link (customerImageAccess.ts). The
 * server fetches the file and streams it: from the private Blob store, or for historical
 * documents from their Cloudinary copy — never by redirecting the browser to that public URL.
 * Images and PDFs open in the browser; any other type is downloaded, never rendered.
 */
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
  if (!row?.stored_url) return res.status(404).end();
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const serve = async (contentType: string, stream: ReadableStream) => {
    const type = contentType.split(";")[0].trim().toLowerCase();
    const inline = type.startsWith("image/") || type === "application/pdf";
    res.setHeader("Content-Type", inline ? type : "application/octet-stream");
    if (!inline) res.setHeader("Content-Disposition", "attachment");
    await new Promise<void>((resolve, reject) => {
      Readable.fromWeb(stream as Parameters<typeof Readable.fromWeb>[0])
        .on("error", reject).pipe(res).on("finish", resolve).on("error", reject);
    });
  };
  try {
    const url = new URL(row.stored_url);
    if (url.protocol !== "https:") return res.status(404).end();
    if (url.hostname.endsWith(".blob.vercel-storage.com")) {
      const blob = await readCustomerImage(row.stored_url);
      if (!blob || blob.statusCode !== 200) return res.status(404).end();
      await serve(blob.blob.contentType || row.mime_type || "", blob.stream as ReadableStream);
      return;
    }
    if (url.hostname !== "res.cloudinary.com") return res.status(404).end();
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) return res.status(502).end();
    await serve(response.headers.get("content-type") || row.mime_type || "", response.body);
  } catch {
    if (!res.headersSent) res.status(502).end();
    else res.destroy();
  }
}
