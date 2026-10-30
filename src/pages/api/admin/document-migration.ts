import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  deleteMigratedOriginals, documentMigrationSummary, migrateConversationAttachments, migrateHistoricalDocuments,
} from "../../../lib/documentMigration";
import { auditPrivateStorage } from "../../../lib/customerDocumentPurge";

export const config = { maxDuration: 300 };

/**
 * Historical customer-document migration (documentMigration.ts), driven in small batches by
 * an admin. GET: counts only. POST { action, limit }: "migrate" copies documents to the
 * private store, "delete_originals" removes verified Cloudinary originals one exact asset at
 * a time, "attachments" links or copies inbox attachments, "storage_audit" lists private
 * files nothing references (nothing is deleted). Responses hold ids and codes, never URLs.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAccess(req, res, "api.admin.document_migration")) return;
  if (req.method === "GET") return res.status(200).json({ ok: true, ...await documentMigrationSummary() });
  if (req.method !== "POST") return res.status(405).end();
  const action = String(req.body?.action || "");
  const limit = Number(req.body?.limit) || 5;
  // The signed admin preview is checked through this deployment's own production address
  // (Vercel's system variable), never a host taken from a request header.
  const origin = `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL || String(req.headers.host || "")}`;
  try {
    if (action === "migrate") return res.status(200).json({ ok: true, results: await migrateHistoricalDocuments({ limit, origin }) });
    if (action === "delete_originals") return res.status(200).json({ ok: true, results: await deleteMigratedOriginals({ limit, origin }) });
    if (action === "attachments") return res.status(200).json({ ok: true, results: await migrateConversationAttachments({ limit }) });
    if (action === "storage_audit") return res.status(200).json({ ok: true, audit: await auditPrivateStorage() });
  } catch (error) {
    const code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "migration_failed";
    return res.status(500).json({ ok: false, error: code });
  }
  return res.status(400).json({ error: "unknown_action" });
}
