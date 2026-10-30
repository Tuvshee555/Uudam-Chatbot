import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";

/**
 * Deleting a customer document used to hide the row and keep its file in storage forever.
 * Now an admin's delete stays a restorable hide, and "delete permanently" on a hidden document
 * removes the stored file (only when nothing else uses it), keeps a tombstone without the
 * extracted data, and records a storage failure for the daily retry instead of losing it.
 * The orphan audit reports unreferenced private files and deletes nothing.
 */
applyTestEnv({ NEON_DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:1/document-purge" });

type Row = { id: number; stored_url: string; hidden: boolean; matched_payment_id: number | null; purged_at: string | null;
  category: string; storage_delete_status: string; storage_delete_error: string; extracted_json: Record<string, unknown> };
const BLOB = (key: string) => `https://fixture.private.blob.vercel-storage.com/customer-documents/${key}`;

function fakeDb(rows: Row[], inboxCopies: string[] = []) {
  const docs = new Map(rows.map((row) => [row.id, { ...row }]));
  const audit: Array<{ id: number; action: string; after: string }> = [];
  const query = async (sql: string, params: unknown[] = []) => {
    const out = (list: unknown[]) => ({ rows: list, rowCount: list.length });
    if (/SELECT stored_url, retention_hidden_at IS NOT NULL AS hidden, matched_payment_id, purged_at, category/.test(sql)) {
      const row = docs.get(Number(params[0]));
      return out(row ? [row] : []);
    }
    if (/SET storage_delete_status='pending'/.test(sql)) {
      const row = docs.get(Number(params[0]));
      if (!row || row.purged_at || !row.hidden || row.storage_delete_status === "pending") return out([]);
      row.storage_delete_status = "pending";
      return out([{ id: row.id }]);
    }
    if (/AS n/.test(sql) && /travel_conversation_attachments WHERE blob_url=\$1/.test(sql)) {
      const shared = [...docs.values()].filter((row) => row.stored_url === params[0] && row.id !== Number(params[1])).length
        + inboxCopies.filter((url) => url === params[0]).length;
      return out([{ n: shared }]);
    }
    if (/SET storage_delete_status='failed'/.test(sql)) {
      const row = docs.get(Number(params[0]))!;
      row.storage_delete_status = "failed"; row.storage_delete_error = String(params[1]);
      return out([]);
    }
    if (/SET stored_url='', extracted_json='\{\}'::jsonb, storage_delete_status='deleted'/.test(sql)) {
      const row = docs.get(Number(params[0]))!;
      Object.assign(row, { stored_url: "", extracted_json: {}, storage_delete_status: "deleted", purged_at: "now" });
      return out([]);
    }
    if (/INSERT INTO travel_customer_document_audit/.test(sql)) { audit.push({ id: Number(params[0]), action: "purged", after: String(params[3]) }); return out([]); }
    if (/SELECT stored_url AS url FROM travel_customer_documents/.test(sql)) {
      return out([...docs.values()].filter((row) => row.stored_url.includes(".blob.vercel-storage.com/")).map((row) => ({ url: row.stored_url })));
    }
    if (/SELECT blob_url AS url FROM travel_conversation_attachments/.test(sql)) return out(inboxCopies.map((url) => ({ url })));
    return out([]);
  };
  return { docs, audit, query };
}

async function install(context: test.TestContext, query: (sql: string, params?: unknown[]) => Promise<unknown>) {
  const { Pool } = await import("pg");
  context.mock.method(Pool.prototype, "query", query as unknown as typeof Pool.prototype.query);
  context.mock.method(Pool.prototype, "connect", (async () => ({ query, release() {} })) as unknown as typeof Pool.prototype.connect);
}

const row = (id: number, extra: Partial<Row> = {}): Row => ({
  id, stored_url: BLOB(`legacy/${id}-abc`), hidden: true, matched_payment_id: null, purged_at: null, category: "passport",
  storage_delete_status: "", storage_delete_error: "", extracted_json: { passport_number: "FIXTURE0" }, ...extra,
});

test("permanent deletion removes the file only for a deleted, unshared, payment-free document", async (context) => {
  const db = fakeDb([
    row(1), row(2, { hidden: false }), row(3, { matched_payment_id: 9 }),
    row(4, { stored_url: BLOB("shared") }), row(5, { stored_url: BLOB("shared"), hidden: false }),
    row(6),
  ]);
  await install(context, db.query);
  const deleted: string[] = [];
  const deps = {
    del: async (url: string) => { if (url.includes("legacy/6-")) throw new Error("BlobServiceNotAvailable"); deleted.push(url); },
    destroy: async () => { throw new Error("not expected"); },
    references: async () => new Map(),
    list: (async () => ({ blobs: [], hasMore: false })) as never,
  };
  const { purgeCustomerDocument } = await import("../src/lib/customerDocumentPurge");
  assert.deepEqual(await purgeCustomerDocument(1, "admin", deps as never), { outcome: "purged" });
  assert.deepEqual(deleted, [BLOB("legacy/1-abc")]);
  assert.deepEqual({ url: db.docs.get(1)!.stored_url, data: db.docs.get(1)!.extracted_json, status: db.docs.get(1)!.storage_delete_status },
    { url: "", data: {}, status: "deleted" }, "a tombstone without the file or the passport data");
  assert.doesNotMatch(db.audit[0].after + JSON.stringify(db.audit), /FIXTURE0|blob\.vercel-storage/, "the audit holds no file location or document data");

  assert.deepEqual(await purgeCustomerDocument(1, "admin", deps as never), { outcome: "already_purged" });
  assert.deepEqual(await purgeCustomerDocument(2, "admin", deps as never), { outcome: "not_deleted_first" }, "delete (hide) comes first");
  assert.deepEqual(await purgeCustomerDocument(3, "admin", deps as never), { outcome: "linked_to_payment" }, "payment evidence is kept");
  assert.deepEqual(await purgeCustomerDocument(4, "admin", deps as never), { outcome: "purged" });
  assert.equal(deleted.length, 1, "a file another document still uses is not deleted");
  assert.match(db.audit.at(-1)!.after, /kept_shared/);

  assert.deepEqual(await purgeCustomerDocument(6, "admin", deps as never), { outcome: "storage_failed", error: "storage_delete_failed" });
  assert.equal(db.docs.get(6)!.storage_delete_status, "failed", "visible and retried, not lost");
  assert.equal(db.docs.get(6)!.stored_url, BLOB("legacy/6-abc"), "the row keeps its file reference until deletion succeeds");
  assert.deepEqual(db.docs.get(6)!.extracted_json, { passport_number: "FIXTURE0" });
});

test("the orphan audit reports private files nothing references and deletes nothing", async (context) => {
  const db = fakeDb([row(1, { hidden: false })], [BLOB("inbox/7-0-abc")]);
  await install(context, db.query);
  const listed = [BLOB("legacy/1-abc"), BLOB("inbox/7-0-abc"), BLOB("legacy/99-old"), BLOB("_storage-check/x.txt")];
  // The audit is handed only a list function: it has no way to delete.
  const { auditPrivateStorage } = await import("../src/lib/customerDocumentPurge");
  const audit = await auditPrivateStorage({
    list: (async () => ({ hasMore: false, blobs: listed.map((url) => ({ url, pathname: new URL(url).pathname.slice(1), size: 10, uploadedAt: new Date(0) })) })) as never,
  });
  assert.deepEqual({ objects: audit.objects, referenced: audit.referenced, orphaned: audit.orphaned, missing: audit.missing },
    { objects: 4, referenced: 2, orphaned: 2, missing: 0 });
  assert.deepEqual(audit.sample.map((blob) => blob.pathname), ["customer-documents/legacy/99-old", "customer-documents/_storage-check/x.txt"]);
  const { closeNeonPool } = await import("../src/lib/neonDb");
  await closeNeonPool();
});
