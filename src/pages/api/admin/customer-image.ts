import type { NextApiRequest, NextApiResponse } from "next";
import { queryNeon } from "../../../lib/neonDb";
import { serveAdminFile } from "../../../lib/adminFileProxy";
import { verifyCustomerImagePreview } from "../../../lib/customerImageAccess";

/**
 * A customer document behind a signed, expiring admin link (customerImageAccess.ts). The
 * server fetches the file and streams it (adminFileProxy.ts): from the private Blob store, or
 * for historical documents not yet migrated from their Cloudinary copy — never by
 * redirecting the browser to a public URL.
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
  const outcome = await serveAdminFile(res, { url: row.stored_url, mimeType: row.mime_type });
  if (outcome === "not_found") return res.status(404).end();
  if (outcome === "unavailable") return res.status(502).end();
}
