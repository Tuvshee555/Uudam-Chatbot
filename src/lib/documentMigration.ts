import { createHash } from "node:crypto";
import { queryNeon, withNeonClient } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";
import { readCustomerImage, storeCustomerImage } from "./customerImageStorage";
import { customerImagePreviewUrl } from "./customerImageAccess";
import {
  cloudinaryConfigured, cloudinaryDestroy, cloudinaryDownload, cloudinaryResource, parseCloudinaryUrl,
  type CloudinaryAsset,
} from "./cloudinaryAdmin";
import { logError, logInfo } from "./observability";

/**
 * Moves the historical customer documents from public Cloudinary to the private Blob store,
 * then (separately) deletes each verified original. docs/document-migration-plan.md.
 *
 * Per document: download (public delivery, else Cloudinary's authenticated API), the bytes
 * must hash to the SHA-256 recorded when the customer sent them, upload privately under a
 * fixed key, read back with the token (same hash), an anonymous read must be refused, then
 * the row is switched with a compare-and-swap and the signed admin preview must return the
 * same bytes (otherwise the switch is undone). Every step is recorded in
 * travel_document_migration; a re-run continues where a document stopped and never makes a
 * second object or row. One run at a time (advisory lock). Nothing here logs a URL or bytes.
 */
export type MigrationStatus =
  | "pending" | "downloaded" | "uploaded" | "checksum_verified" | "private_verified" | "db_updated"
  | "preview_verified" | "original_deleted" | "deletion_verified" | "recovery_required" | "failed";

export type MigrationResult = { id: number; status: MigrationStatus | "skipped" | "busy"; error?: string };

const MAX_BYTES = 25 * 1024 * 1024;
const DONE: MigrationStatus[] = ["preview_verified", "original_deleted", "deletion_verified"];
const LOCK_KEY = "customer-document-migration";

type BlobRead = { statusCode: number; stream: ReadableStream | null } | null;
export type MigrationDeps = {
  fetch: typeof fetch;
  store: (buffer: Buffer, mimeType: string, key: string) => Promise<string>;
  read: (url: string) => Promise<BlobRead>;
};
const defaultDeps: MigrationDeps = {
  fetch: (...args) => fetch(...args),
  store: storeCustomerImage,
  read: async (url) => (await readCustomerImage(url)) as BlobRead,
};

const sha256 = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

async function readLimited(stream: ReadableStream | null): Promise<Buffer | null> {
  if (!stream) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); return null; }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** The type the bytes really are, for the formats customers send; "" when not recognised. */
export function detectFileType(buffer: Buffer): string {
  const head = buffer.subarray(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (head.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return "";
}

/** One run at a time across instances: a transaction-scoped lock held while `work` runs. */
async function withMigrationLock<T>(work: () => Promise<T>): Promise<T | "busy"> {
  const result = await withNeonClient(async (client) => {
    await client.query("BEGIN");
    try {
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext($1)) AS acquired", [LOCK_KEY]);
      if (!lock.rows[0]?.acquired) return "busy" as const;
      return await work();
    } finally {
      await client.query("ROLLBACK");
    }
  });
  if (result === null) throw new Error("database_unavailable");
  return result;
}

type LedgerRow = { document_id: string; status: MigrationStatus; old_url: string; blob_url: string; sha256: string; attempts: number };

async function setStep(id: number, status: MigrationStatus, fields: Record<string, string | number | null> = {}) {
  const names = Object.keys(fields);
  await queryNeon(
    `UPDATE travel_document_migration SET status=$2, ${names.map((name, i) => `${name}=$${i + 3}`).join(", ")}${names.length ? "," : ""}
       updated_at=NOW() WHERE document_id=$1`,
    [id, status, ...names.map((name) => fields[name])],
  );
}

async function fail(id: number, status: "failed" | "recovery_required", error: string): Promise<MigrationResult> {
  await setStep(id, status, { error });
  logError("document_migration.step_failed", { documentId: id, status, error });
  return { id, status, error };
}

async function download(oldUrl: string, asset: CloudinaryAsset | null, deps: MigrationDeps) {
  let source = "public_delivery";
  let response = await deps.fetch(oldUrl, { redirect: "error", signal: AbortSignal.timeout(30_000) }).catch(() => null);
  if (!response?.ok && asset && cloudinaryConfigured()) {
    await response?.body?.cancel().catch(() => {});
    source = "cloudinary_api";
    response = await cloudinaryDownload(asset, deps.fetch).catch(() => null);
  }
  if (!response?.ok) return { error: `source_unavailable_${response?.status ?? "network"}` } as const;
  const buffer = await readLimited(response.body);
  if (!buffer?.length) return { error: "source_empty_or_too_large" } as const;
  return { buffer, source } as const;
}

async function privateCopyMatches(blobUrl: string, expected: string, deps: MigrationDeps): Promise<boolean> {
  const blob = await deps.read(blobUrl).catch(() => null);
  if (!blob || blob.statusCode !== 200) return false;
  const buffer = await readLimited(blob.stream);
  return Boolean(buffer && sha256(buffer) === expected);
}

async function anonymousReadRefused(blobUrl: string, deps: MigrationDeps): Promise<boolean> {
  const response = await deps.fetch(blobUrl, { cache: "no-store", redirect: "manual", signal: AbortSignal.timeout(15_000) }).catch(() => null);
  await response?.body?.cancel().catch(() => {});
  return Boolean(response) && !response!.ok;
}

async function previewReturns(id: number, origin: string, expected: string, deps: MigrationDeps): Promise<boolean> {
  const response = await deps.fetch(`${origin}${customerImagePreviewUrl(id)}`, { redirect: "manual", signal: AbortSignal.timeout(30_000) })
    .catch(() => null);
  if (!response || response.status !== 200) { await response?.body?.cancel().catch(() => {}); return false; }
  const buffer = await readLimited(response.body);
  return Boolean(buffer && sha256(buffer) === expected);
}

type DocumentRow = { id: string; stored_url: string; mime_type: string; content_sha256: string; image_sha256: string };

async function migrateOne(doc: DocumentRow, origin: string, deps: MigrationDeps): Promise<MigrationResult> {
  const id = Number(doc.id);
  await queryNeon(
    `INSERT INTO travel_document_migration (document_id, old_url) VALUES ($1, $2) ON CONFLICT (document_id) DO NOTHING`,
    [id, doc.stored_url],
  );
  const ledger = (await queryNeon<LedgerRow>("SELECT * FROM travel_document_migration WHERE document_id=$1", [id]))?.rows[0];
  if (!ledger) return { id, status: "failed", error: "ledger_unavailable" };
  if (DONE.includes(ledger.status)) return { id, status: "skipped" };
  await queryNeon("UPDATE travel_document_migration SET attempts=attempts+1, error='', updated_at=NOW() WHERE document_id=$1", [id]);
  const oldUrl = ledger.old_url;
  const asset = parseCloudinaryUrl(oldUrl);
  if (!asset) return fail(id, "recovery_required", "unrecognised_cloudinary_url");
  const recorded = doc.content_sha256 || doc.image_sha256 || "";
  if (!recorded) return fail(id, "recovery_required", "no_recorded_checksum");

  const got = await download(oldUrl, asset, deps);
  if ("error" in got) return fail(id, "recovery_required", got.error ?? "source_unavailable");
  const checksum = sha256(got.buffer);
  if (checksum !== recorded) return fail(id, "recovery_required", "checksum_differs_from_recorded");
  // Expected size: the asset's own record, when the Admin API answers (the checksum already binds the bytes).
  const resource = cloudinaryConfigured() ? await cloudinaryResource(asset, deps.fetch).catch(() => null) : null;
  if (resource?.exists && resource.bytes !== null && resource.bytes !== got.buffer.length) {
    return fail(id, "recovery_required", "size_differs_from_cloudinary_record");
  }
  const detected = detectFileType(got.buffer);
  await setStep(id, "downloaded", { source: got.source, sha256: checksum, bytes: got.buffer.length, detected_type: detected });

  let blobUrl: string;
  try {
    blobUrl = await deps.store(got.buffer, detected || doc.mime_type || "application/octet-stream", `legacy/${id}-${checksum.slice(0, 16)}`);
  } catch (error) {
    return fail(id, "failed", error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "upload_failed");
  }
  await setStep(id, "uploaded", { blob_url: blobUrl });
  if (!await privateCopyMatches(blobUrl, checksum, deps)) return fail(id, "failed", "private_copy_checksum_mismatch");
  await setStep(id, "checksum_verified");
  if (!await anonymousReadRefused(blobUrl, deps)) return fail(id, "failed", "private_copy_publicly_readable");
  await setStep(id, "private_verified");

  const switched = await queryNeon(
    "UPDATE travel_customer_documents SET stored_url=$2, updated_at=NOW() WHERE id=$1 AND stored_url IN ($3, $2) RETURNING id",
    [id, blobUrl, oldUrl],
  );
  if (!switched?.rowCount) return fail(id, "failed", "document_changed_during_migration");
  await queryNeon(
    `INSERT INTO travel_customer_document_audit (document_id, action, actor, before_json, after_json)
     VALUES ($1, 'migrated_to_private_storage', 'migration', $2::jsonb, $3::jsonb)`,
    [id, JSON.stringify({ storage: "cloudinary" }), JSON.stringify({ storage: "private_blob", sha256: checksum })],
  );
  await setStep(id, "db_updated");

  const hidden = (await queryNeon<{ hidden: boolean }>(
    "SELECT retention_hidden_at IS NOT NULL AS hidden FROM travel_customer_documents WHERE id=$1", [id],
  ))?.rows[0]?.hidden;
  // A document hidden by deletion or retention is never previewed; its private read was checked above.
  if (!hidden && !await previewReturns(id, origin, checksum, deps)) {
    await queryNeon("UPDATE travel_customer_documents SET stored_url=$3, updated_at=NOW() WHERE id=$1 AND stored_url=$2", [id, blobUrl, oldUrl]);
    return fail(id, "failed", "admin_preview_failed_switch_undone");
  }
  await setStep(id, "preview_verified");
  logInfo("document_migration.migrated", { documentId: id, source: got.source, bytes: got.buffer.length });
  return { id, status: "preview_verified" };
}

/** Migrates up to `limit` documents still on Cloudinary, oldest first. */
export async function migrateHistoricalDocuments(input: { limit: number; origin: string; deps?: MigrationDeps }) {
  await ensureTravelSchema();
  const deps = input.deps ?? defaultDeps;
  const outcome = await withMigrationLock(async () => {
    const rows = (await queryNeon<DocumentRow>(
      `SELECT d.id, d.stored_url, d.mime_type, d.content_sha256, d.image_sha256
         FROM travel_customer_documents d
         LEFT JOIN travel_document_migration m ON m.document_id = d.id
        WHERE d.stored_url LIKE 'https://res.cloudinary.com/%'
          AND (m.document_id IS NULL
               OR (m.status NOT IN ('preview_verified', 'original_deleted', 'deletion_verified') AND m.attempts < 3))
        ORDER BY m.attempts NULLS FIRST, d.id
        LIMIT $1`, [Math.max(1, Math.min(20, input.limit))],
    ))?.rows ?? [];
    const results: MigrationResult[] = [];
    for (const row of rows) {
      results.push(await migrateOne(row, input.origin, deps).catch(async (error) =>
        fail(Number(row.id), "failed", error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : "unexpected_error")));
    }
    return results;
  });
  return outcome === "busy" ? [{ id: 0, status: "busy" as const }] : outcome;
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The same upload: account, kind, delivery type, version, public id and format all equal. */
function sameAsset(a: CloudinaryAsset | null, b: CloudinaryAsset): boolean {
  return Boolean(a) && a!.cloudName === b.cloudName && a!.resourceType === b.resourceType && a!.type === b.type
    && a!.version === b.version && a!.publicId === b.publicId && a!.format === b.format;
}

/**
 * Where else each candidate asset is referenced: every table in the schema except the
 * migration's own ledger and audit records is searched for the asset's public id.
 */
export async function otherReferences(candidates: Array<{ documentId: number; asset: CloudinaryAsset }>) {
  const found = new Map<number, string[]>(candidates.map((c) => [c.documentId, []]));
  if (!candidates.length) return found;
  const tables = (await queryNeon<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
  ))?.rows.map((row) => row.table_name) ?? [];
  if (!tables.length) throw new Error("reference_scan_unavailable");
  const skip = new Set(["travel_document_migration", "travel_customer_document_audit", "travel_error_logs"]);
  const patterns = candidates.map((c) => ({ ...c, pattern: new RegExp(`/${escapeRegExp(c.asset.publicId)}(?:\\.|"|\\?|$)`) }));
  for (const table of tables) {
    if (skip.has(table)) continue;
    const quoted = `"${table.replace(/"/g, '""')}"`;
    const isDocuments = table === "travel_customer_documents";
    const rows = (await queryNeon<{ j: string; doc_id: string | null }>(
      `SELECT row_to_json(t)::text AS j, ${isDocuments ? "t.id::text" : "NULL"} AS doc_id
         FROM ${quoted} t WHERE strpos(row_to_json(t)::text, 'res.cloudinary.com') > 0`,
    ))?.rows ?? [];
    for (const row of rows) {
      for (const candidate of patterns) {
        if (isDocuments && Number(row.doc_id) === candidate.documentId) continue;
        if (candidate.pattern.test(row.j)) found.get(candidate.documentId)!.push(table);
      }
    }
  }
  return found;
}

/**
 * Deletes the Cloudinary original of documents whose private copy is verified, one exact
 * asset at a time, after re-checking everything: the row still points at the private copy,
 * the copy still hashes right and is not public, the admin preview works, the asset's own
 * record matches the URL the document had, and nothing else references it.
 */
export async function deleteMigratedOriginals(input: { limit: number; origin: string; deps?: MigrationDeps }) {
  await ensureTravelSchema();
  const deps = input.deps ?? defaultDeps;
  if (!cloudinaryConfigured()) throw new Error("cloudinary_not_configured");
  const outcome = await withMigrationLock(async () => {
    const ledger = (await queryNeon<LedgerRow & { hidden: boolean | null; stored_url: string | null }>(
      `SELECT m.*, d.stored_url, d.retention_hidden_at IS NOT NULL AS hidden
         FROM travel_document_migration m LEFT JOIN travel_customer_documents d ON d.id = m.document_id
        WHERE m.status IN ('preview_verified', 'original_deleted') ORDER BY m.document_id LIMIT $1`,
      [Math.max(1, Math.min(20, input.limit))],
    ))?.rows ?? [];
    const candidates = ledger.map((row) => ({ row, asset: parseCloudinaryUrl(row.old_url) }));
    const references = await otherReferences(candidates.filter((c) => c.asset).map((c) => ({ documentId: Number(c.row.document_id), asset: c.asset! })));
    const results: MigrationResult[] = [];
    for (const { row, asset } of candidates) {
      const id = Number(row.document_id);
      const keep = async (error: string) => {
        await queryNeon("UPDATE travel_document_migration SET error=$2, updated_at=NOW() WHERE document_id=$1", [id, error]);
        results.push({ id, status: row.status, error });
      };
      if (!asset) { await keep("unrecognised_cloudinary_url"); continue; }
      if (row.stored_url !== row.blob_url) { await keep("document_no_longer_points_at_private_copy"); continue; }
      if (row.status === "preview_verified") {
        if (!await privateCopyMatches(row.blob_url, row.sha256, deps)) { await keep("private_copy_checksum_mismatch"); continue; }
        if (!await anonymousReadRefused(row.blob_url, deps)) { await keep("private_copy_publicly_readable"); continue; }
        if (!row.hidden && !await previewReturns(id, input.origin, row.sha256, deps)) { await keep("admin_preview_failed"); continue; }
        const shared = references.get(id) ?? [];
        if (shared.length) { await keep(`referenced_elsewhere:${[...new Set(shared)].join(",")}`); continue; }
        const record = await cloudinaryResource(asset, deps.fetch).catch((error) => error as Error);
        if (record instanceof Error) { await keep(record.message); continue; }
        if (record.exists && !sameAsset(parseCloudinaryUrl(record.secureUrl), asset)) {
          await keep("cloudinary_record_differs_from_document_url"); continue;
        }
        if (record.exists) {
          const destroyed = await cloudinaryDestroy(asset, deps.fetch).catch((error) => error as Error);
          if (destroyed instanceof Error) { await keep(destroyed.message); continue; }
        }
        await setStep(id, "original_deleted", { original_deleted_at: new Date().toISOString(), error: "" });
      }
      const after = await cloudinaryResource(asset, deps.fetch).catch((error) => error as Error);
      if (after instanceof Error || after.exists) { await keep(after instanceof Error ? after.message : "original_still_listed"); continue; }
      const cdn = await deps.fetch(row.old_url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(15_000) }).catch(() => null);
      await cdn?.body?.cancel().catch(() => {});
      await setStep(id, "deletion_verified", { cdn_status: cdn?.status ?? null, error: "" });
      logInfo("document_migration.original_deleted", { documentId: id, cdnStatus: cdn?.status ?? null });
      results.push({ id, status: "deletion_verified" });
    }
    return results;
  });
  return outcome === "busy" ? [{ id: 0, status: "busy" as const }] : outcome;
}

const ATTACHMENT_HOST = /(?:^|\.)(?:fbcdn\.net|fbsbx\.com|res\.cloudinary\.com)$/i;

/**
 * Inbox attachments (customers' photos and files in travel_conversations): one already kept
 * as a customer document is linked to it; any other is copied privately while its link still
 * works, or recorded as expired. The conversation rows themselves are never changed.
 */
export async function migrateConversationAttachments(input: { limit: number; deps?: MigrationDeps }) {
  await ensureTravelSchema();
  const deps = input.deps ?? defaultDeps;
  const outcome = await withMigrationLock(async () => {
    const rows = (await queryNeon<{ id: string; sender_id: string; attachments: Array<{ type?: string; url?: string }> }>(
      `SELECT c.id, c.sender_id, c.attachments FROM travel_conversations c
        WHERE c.role = 'user' AND jsonb_typeof(c.attachments) = 'array' AND jsonb_array_length(c.attachments) > 0
          AND (SELECT count(*) FROM travel_conversation_attachments x WHERE x.conversation_id = c.id) < jsonb_array_length(c.attachments)
        ORDER BY c.id LIMIT $1`, [Math.max(1, Math.min(50, input.limit))],
    ))?.rows ?? [];
    const results: Array<{ row: number; index: number; status: string }> = [];
    for (const row of rows) {
      for (const [index, attachment] of row.attachments.entries()) {
        const rowId = Number(row.id);
        const exists = (await queryNeon("SELECT 1 FROM travel_conversation_attachments WHERE conversation_id=$1 AND idx=$2", [rowId, index]))?.rowCount;
        if (exists) continue;
        const save = async (status: string, fields: { document_id?: number; blob_url?: string; sha256?: string; mime_type?: string; bytes?: number; error?: string } = {}) => {
          await queryNeon(
            `INSERT INTO travel_conversation_attachments (conversation_id, idx, status, document_id, blob_url, sha256, mime_type, bytes, error)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (conversation_id, idx) DO NOTHING`,
            [rowId, index, status, fields.document_id ?? null, fields.blob_url ?? "", fields.sha256 ?? "", fields.mime_type ?? "", fields.bytes ?? 0, fields.error ?? ""],
          );
          results.push({ row: rowId, index, status });
        };
        const url = String(attachment?.url || "");
        if (!url) { await save("no_url"); continue; }
        const document = (await queryNeon<{ id: string }>(
          "SELECT id FROM travel_customer_documents WHERE sender_id=$1 AND source_url=$2 ORDER BY id LIMIT 1", [row.sender_id, url],
        ))?.rows[0];
        if (document) { await save("document", { document_id: Number(document.id) }); continue; }
        let host = "";
        try { host = new URL(url).hostname; } catch { /* recorded below */ }
        if (!ATTACHMENT_HOST.test(host)) { await save("unsupported_source"); continue; }
        const response = await deps.fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) }).catch(() => null);
        if (!response?.ok) { await response?.body?.cancel().catch(() => {}); await save("source_expired", { error: `http_${response?.status ?? "network"}` }); continue; }
        const buffer = await readLimited(response.body);
        if (!buffer?.length) { await save("source_expired", { error: "empty_or_too_large" }); continue; }
        const checksum = sha256(buffer);
        const type = detectFileType(buffer) || (response.headers.get("content-type") || "application/octet-stream").split(";")[0];
        try {
          const blobUrl = await deps.store(buffer, type, `inbox/${rowId}-${index}-${checksum.slice(0, 16)}`);
          if (!await privateCopyMatches(blobUrl, checksum, deps)) { await save("failed", { error: "private_copy_checksum_mismatch" }); continue; }
          if (!await anonymousReadRefused(blobUrl, deps)) { await save("failed", { error: "private_copy_publicly_readable" }); continue; }
          await save("private", { blob_url: blobUrl, sha256: checksum, mime_type: type, bytes: buffer.length });
        } catch {
          await save("failed", { error: "upload_failed" });
        }
      }
    }
    return results;
  });
  return outcome === "busy" ? [{ row: 0, index: 0, status: "busy" }] : outcome;
}

/** Counts only: nothing locating a file. */
export async function documentMigrationSummary() {
  await ensureTravelSchema();
  const [documents, ledger, attachments] = await Promise.all([
    queryNeon<{ total: number; on_blob: number; on_cloudinary: number; hidden: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE stored_url LIKE 'https://%.blob.vercel-storage.com/%')::int AS on_blob,
              count(*) FILTER (WHERE stored_url LIKE 'https://res.cloudinary.com/%')::int AS on_cloudinary,
              count(*) FILTER (WHERE retention_hidden_at IS NOT NULL)::int AS hidden
         FROM travel_customer_documents`),
    queryNeon<{ status: string; count: number; errors: string[] }>(
      `SELECT status, count(*)::int AS count, array_remove(array_agg(DISTINCT NULLIF(error, '')), NULL) AS errors
         FROM travel_document_migration GROUP BY status ORDER BY status`),
    queryNeon<{ status: string; count: number }>(
      "SELECT status, count(*)::int AS count FROM travel_conversation_attachments GROUP BY status ORDER BY status"),
  ]);
  return {
    documents: documents?.rows[0] ?? null,
    ledger: ledger?.rows ?? [],
    attachments: attachments?.rows ?? [],
  };
}
