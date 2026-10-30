import { del, list } from "@vercel/blob";
import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";
import { isPrivateBlobUrl } from "./adminFileProxy";
import { cloudinaryConfigured, cloudinaryDestroy, parseCloudinaryUrl } from "./cloudinaryAdmin";
import { otherReferences } from "./documentMigration";
import { logError, logInfo } from "./observability";
import type { ReadinessIssue } from "./readiness";

/**
 * Permanent deletion of a customer document's file. An admin's "delete" only hides a
 * document (it can be restored); purging is a second, explicit step on a hidden document.
 * The stored file is removed only when no other document or inbox copy uses it, then the
 * row is kept as a tombstone (no file, no extracted data). A storage failure leaves the
 * row as it was, is shown in the admin issues and is retried by the daily check.
 */
export type PurgeOutcome = "purged" | "not_found" | "not_deleted_first" | "linked_to_payment" | "already_purged" | "busy" | "storage_failed";

export type PurgeDeps = {
  del: (url: string) => Promise<void>;
  destroy: typeof cloudinaryDestroy;
  references: typeof otherReferences;
  list: typeof list;
};
const defaultDeps: PurgeDeps = { del: (url) => del(url), destroy: cloudinaryDestroy, references: otherReferences, list };

const safeCode = (error: unknown) => error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "storage_delete_failed";

async function removeStoredFile(id: number, url: string, deps: PurgeDeps): Promise<"deleted" | "kept_shared" | "none"> {
  if (!url) return "none";
  const shared = await queryNeon<{ n: number }>(
    `SELECT ((SELECT count(*) FROM travel_customer_documents WHERE stored_url=$1 AND id<>$2)
           + (SELECT count(*) FROM travel_conversation_attachments WHERE blob_url=$1))::int AS n`, [url, id],
  );
  if (!shared) throw new Error("database_unavailable");
  if (shared.rows[0].n > 0) return "kept_shared";
  if (isPrivateBlobUrl(url)) { await deps.del(url); return "deleted"; }
  const asset = parseCloudinaryUrl(url);
  if (!asset) throw new Error("unknown_storage");
  if (!cloudinaryConfigured()) throw new Error("cloudinary_not_configured");
  if ((await deps.references([{ documentId: id, asset }])).get(id)?.length) return "kept_shared";
  await deps.destroy(asset);
  return "deleted";
}

export async function purgeCustomerDocument(id: number, actor = "admin", deps: PurgeDeps = defaultDeps): Promise<{ outcome: PurgeOutcome; error?: string }> {
  await ensureTravelSchema();
  const row = (await queryNeon<{ stored_url: string; hidden: boolean; matched_payment_id: string | null; purged_at: string | null; category: string }>(
    `SELECT stored_url, retention_hidden_at IS NOT NULL AS hidden, matched_payment_id, purged_at, category
       FROM travel_customer_documents WHERE id=$1`, [id],
  ))?.rows[0];
  if (!row) return { outcome: "not_found" };
  if (row.purged_at) return { outcome: "already_purged" };
  if (!row.hidden) return { outcome: "not_deleted_first" };
  // A payment matched to this document keeps its evidence.
  if (row.matched_payment_id) return { outcome: "linked_to_payment" };
  const claimed = await queryNeon(
    `UPDATE travel_customer_documents
        SET storage_delete_status='pending', storage_delete_attempts=storage_delete_attempts+1, updated_at=NOW()
      WHERE id=$1 AND purged_at IS NULL AND retention_hidden_at IS NOT NULL
        AND (storage_delete_status <> 'pending' OR updated_at < NOW() - INTERVAL '10 minutes')
      RETURNING id`, [id],
  );
  if (!claimed?.rowCount) return { outcome: "busy" };
  let storage: Awaited<ReturnType<typeof removeStoredFile>>;
  try {
    storage = await removeStoredFile(id, row.stored_url, deps);
  } catch (error) {
    const code = safeCode(error);
    await queryNeon(
      "UPDATE travel_customer_documents SET storage_delete_status='failed', storage_delete_error=$2, updated_at=NOW() WHERE id=$1",
      [id, code],
    );
    logError("customer_documents.storage_delete_failed", { documentId: id, error: code });
    return { outcome: "storage_failed", error: code };
  }
  await queryNeon(
    `UPDATE travel_customer_documents
        SET stored_url='', extracted_json='{}'::jsonb, storage_delete_status='deleted', storage_delete_error='',
            purged_at=NOW(), updated_at=NOW()
      WHERE id=$1`, [id],
  );
  await queryNeon(
    `INSERT INTO travel_customer_document_audit (document_id, action, actor, before_json, after_json)
     VALUES ($1, 'purged', $2, $3::jsonb, $4::jsonb)`,
    [id, actor, JSON.stringify({ category: row.category, storage: isPrivateBlobUrl(row.stored_url) ? "private_blob" : row.stored_url ? "cloudinary" : "none" }),
      JSON.stringify({ file: storage })],
  );
  logInfo("customer_documents.purged", { documentId: id, file: storage });
  return { outcome: "purged" };
}

/** Daily: purges whose storage deletion failed are tried again, at most five times each. */
export async function retryFailedStorageDeletions(limit = 20): Promise<number> {
  await ensureTravelSchema();
  const rows = (await queryNeon<{ id: string }>(
    `SELECT id FROM travel_customer_documents
      WHERE storage_delete_status='failed' AND purged_at IS NULL AND storage_delete_attempts < 5
      ORDER BY updated_at LIMIT $1`, [limit],
  ))?.rows ?? [];
  let purged = 0;
  for (const row of rows) if ((await purgeCustomerDocument(Number(row.id), "retry")).outcome === "purged") purged += 1;
  return purged;
}

export async function storageDeletionIssues(): Promise<ReadinessIssue[]> {
  const failed = (await queryNeon<{ n: number }>(
    "SELECT count(*)::int AS n FROM travel_customer_documents WHERE storage_delete_status='failed' AND purged_at IS NULL",
  ).catch(() => null))?.rows[0]?.n ?? 0;
  return failed ? [{
    key: "customer_document_storage_delete",
    severity: "warning",
    message: `Устгах гэж тэмдэглэсэн ${failed} баримтын файлыг хадгалалтаас устгаж чадаагүй; өдөр бүр дахин оролдоно.`,
  }] : [];
}

/**
 * Private files nothing references: every object under customer-documents/ compared with the
 * documents and inbox copies that point at it. Reported for a person to decide; never deleted
 * here, whatever their age.
 */
export async function auditPrivateStorage(deps: Pick<PurgeDeps, "list"> = defaultDeps) {
  await ensureTravelSchema();
  if (!process.env.BLOB_READ_WRITE_TOKEN && deps === defaultDeps) throw new Error("private_blob_not_configured");
  const [documents, copies] = await Promise.all([
    queryNeon<{ url: string }>("SELECT stored_url AS url FROM travel_customer_documents WHERE stored_url LIKE 'https://%.blob.vercel-storage.com/%'"),
    queryNeon<{ url: string }>("SELECT blob_url AS url FROM travel_conversation_attachments WHERE blob_url <> ''"),
  ]);
  if (!documents || !copies) throw new Error("database_unavailable");
  const pathOf = (url: string) => { try { return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")); } catch { return url; } };
  const referenced = new Set([...documents.rows, ...copies.rows].map((row) => pathOf(row.url)));
  const blobs: Array<{ pathname: string; size: number; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  do {
    const page = await deps.list({ prefix: "customer-documents/", cursor, limit: 1000 });
    blobs.push(...page.blobs.map((blob) => ({ pathname: blob.pathname, size: blob.size, uploadedAt: blob.uploadedAt })));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  const orphaned = blobs.filter((blob) => !referenced.has(blob.pathname));
  return {
    objects: blobs.length,
    referenced: blobs.length - orphaned.length,
    orphaned: orphaned.length,
    orphanedBytes: orphaned.reduce((sum, blob) => sum + blob.size, 0),
    missing: [...referenced].filter((path) => !blobs.some((blob) => blob.pathname === path)).length,
    sample: orphaned.slice(0, 50).map((blob) => ({ pathname: blob.pathname, size: blob.size, uploadedAt: blob.uploadedAt })),
  };
}
