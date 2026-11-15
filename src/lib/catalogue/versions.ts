/**
 * Immutable PDF versions, the "currently published" pointer, rollback and pruning.
 *
 * A version is never edited after it is saved: regenerating always creates a new row with the
 * next version number for its edition. Status moves draft -> published -> superseded, and the
 * database guarantees at most one published row per edition (partial unique index), so the
 * pointer cannot split even if two admins publish at the same moment.
 *
 * Bytes live in Neon (BYTEA): no Blob token, no Cloudinary raw ACL, and a version stays
 * fetchable after any redeploy or serverless restart.
 */
import { createHash } from "node:crypto";
import type {
  CatalogueEdition,
  CatalogueSnapshot,
  CatalogueVersionMeta,
  CatalogueVersionStatus,
  CatalogueWarning,
  RenderedCatalogue,
} from "./types";
import {
  CATALOGUE_MAX_PDF_BYTES,
  CatalogueStoreError,
  catalogueNowIso,
  catalogueQuery,
  catalogueTransaction,
  cleanActor,
  isCatalogueEdition,
  isUuid,
  newCatalogueId,
  newCataloguePublicToken,
  PUBLIC_TOKEN_RE,
  toIso,
  ulaanbaatarDay,
  writeAudit,
  catalogueNow,
  type CatalogueQuery,
} from "./schema";

const EDITION_FILE_PREFIX: Record<CatalogueEdition, string> = {
  quick: "UUDAM_Corporate",
  complete: "UUDAM_Complete",
  preview: "UUDAM_Preview",
};

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** "UUDAM_Corporate_2026-11-06_v3.pdf". `day` is the snapshot's Asia/Ulaanbaatar day. */
export function buildVersionFileName(edition: CatalogueEdition, day: string, versionNo: number): string {
  return `${EDITION_FILE_PREFIX[edition]}_${day}_v${versionNo}.pdf`;
}

type VersionRow = {
  id: string;
  edition: string;
  version_no: number | string;
  file_name: string;
  status: string;
  size_bytes: number | string;
  page_count: number | string;
  sha256: string;
  content_hash: string;
  trip_count: number | string;
  warnings: unknown;
  public_token: string;
  generated_at: unknown;
  generated_by: string | null;
  published_at: unknown;
  published_by: string | null;
};

/** Everything except the heavy columns (bytes, snapshot). */
const META_COLUMNS = `id, edition, version_no, file_name, status, size_bytes, page_count, sha256, content_hash,
  trip_count, warnings, public_token, generated_at, generated_by, published_at, published_by`;

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asWarnings(value: unknown): CatalogueWarning[] {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? (parsed as CatalogueWarning[]) : [];
}

export function rowToVersionMeta(row: VersionRow): CatalogueVersionMeta {
  return {
    id: row.id,
    edition: row.edition as CatalogueEdition,
    versionNo: Number(row.version_no),
    fileName: row.file_name,
    status: row.status as CatalogueVersionStatus,
    sizeBytes: Number(row.size_bytes),
    pageCount: Number(row.page_count),
    sha256: row.sha256,
    contentHash: row.content_hash,
    tripCount: Number(row.trip_count),
    generatedAt: toIso(row.generated_at) ?? "",
    generatedBy: row.generated_by,
    publishedAt: toIso(row.published_at),
    publishedBy: row.published_by,
    publicToken: row.public_token,
    warnings: asWarnings(row.warnings),
  };
}

function mergeWarnings(...lists: Array<readonly CatalogueWarning[] | undefined>): CatalogueWarning[] {
  const seen = new Set<string>();
  const out: CatalogueWarning[] = [];
  for (const list of lists) {
    for (const warning of list ?? []) {
      if (!warning || typeof warning !== "object") continue;
      const key = `${warning.code}|${warning.severity}|${warning.tripId ?? ""}|${warning.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(warning);
    }
  }
  return out;
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isPdf(bytes: unknown): bytes is Buffer {
  return Buffer.isBuffer(bytes) && bytes.length > 8 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

// ---------------------------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------------------------

/**
 * Store a freshly rendered catalogue as the next DRAFT version of its edition. Drafts are visible
 * to admins only (the public file route refuses them) until publishVersion.
 */
export async function saveDraftVersion(input: {
  edition: CatalogueEdition;
  snapshot: CatalogueSnapshot;
  rendered: RenderedCatalogue;
  actor: string | null;
}): Promise<CatalogueVersionMeta> {
  const { edition, snapshot, rendered } = input;
  if (!isCatalogueEdition(edition)) throw new CatalogueStoreError("invalid_input", "Unknown catalogue edition");
  if (!snapshot || snapshot.edition !== edition) {
    throw new CatalogueStoreError("invalid_input", "Snapshot edition does not match the requested edition");
  }
  const pdf = rendered?.pdf;
  if (!isPdf(pdf)) throw new CatalogueStoreError("invalid_pdf", "Rendered output is not a PDF file");
  if (pdf.length > CATALOGUE_MAX_PDF_BYTES) {
    throw new CatalogueStoreError("pdf_too_large", "PDF is larger than Messenger accepts", {
      sizeBytes: pdf.length,
      limitBytes: CATALOGUE_MAX_PDF_BYTES,
    });
  }
  const pageImages = Array.isArray(rendered.pageImages) ? rendered.pageImages.filter(Buffer.isBuffer) : [];
  const warnings = mergeWarnings(snapshot.warnings, rendered.warnings);
  const sha256 = sha256Hex(pdf);
  const actor = cleanActor(input.actor);
  const generatedAt = catalogueNowIso();
  const day = ISO_DAY_RE.test(snapshot.asOfDay) ? snapshot.asOfDay : ulaanbaatarDay(catalogueNow());
  const id = newCatalogueId();
  const publicToken = newCataloguePublicToken();
  const pageCount = Number.isInteger(rendered.pageCount) && rendered.pageCount > 0 ? rendered.pageCount : pageImages.length;

  return catalogueTransaction(async (query) => {
    // Serialises version numbering per edition; UNIQUE (edition, version_no) is the backstop.
    await query(`/* cat:version_lock */ SELECT pg_advisory_xact_lock(hashtext($1))`, [`catalogue_version:${edition}`]);
    const next = await query<{ next_no: number | string }>(
      `/* cat:version_next_no */ SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no
       FROM catalogue_versions WHERE edition = $1`,
      [edition],
    );
    const versionNo = Number(next.rows[0]?.next_no ?? 1);
    const fileName = buildVersionFileName(edition, day, versionNo);
    await query(
      `/* cat:version_insert */ INSERT INTO catalogue_versions
        (id, edition, version_no, file_name, status, bytes, size_bytes, page_count, sha256, content_hash,
         trip_count, snapshot, warnings, public_token, generated_at, generated_by)
       VALUES ($1,$2,$3,$4,'draft',$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14::timestamptz,$15)`,
      [
        id,
        edition,
        versionNo,
        fileName,
        pdf,
        pdf.length,
        pageCount,
        sha256,
        String(snapshot.contentHash ?? ""),
        Array.isArray(snapshot.trips) ? snapshot.trips.length : 0,
        JSON.stringify(snapshot),
        JSON.stringify(warnings),
        publicToken,
        generatedAt,
        actor,
      ],
    );
    for (let index = 0; index < pageImages.length; index++) {
      await query(
        `/* cat:page_insert */ INSERT INTO catalogue_version_pages (version_id, page_no, jpeg) VALUES ($1,$2,$3)`,
        [id, index + 1, pageImages[index]],
      );
    }
    await writeAudit(query, {
      action: "generate",
      actor,
      edition,
      versionId: id,
      detail: { versionNo, sizeBytes: pdf.length, pageCount, tripCount: snapshot.trips?.length ?? 0, warnings: warnings.length },
    });
    return {
      id,
      edition,
      versionNo,
      fileName,
      status: "draft" as const,
      sizeBytes: pdf.length,
      pageCount,
      sha256,
      contentHash: String(snapshot.contentHash ?? ""),
      tripCount: Array.isArray(snapshot.trips) ? snapshot.trips.length : 0,
      generatedAt,
      generatedBy: actor,
      publishedAt: null,
      publishedBy: null,
      publicToken,
      warnings,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------------------------

export async function listVersions(edition?: CatalogueEdition, limit = 50): Promise<CatalogueVersionMeta[]> {
  const cap = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  if (edition !== undefined && !isCatalogueEdition(edition)) return [];
  const result = edition
    ? await catalogueQuery<VersionRow>(
        `/* cat:versions_list_edition */ SELECT ${META_COLUMNS} FROM catalogue_versions
         WHERE edition = $1 ORDER BY version_no DESC LIMIT $2`,
        [edition, cap],
      )
    : await catalogueQuery<VersionRow>(
        `/* cat:versions_list_all */ SELECT ${META_COLUMNS} FROM catalogue_versions
         ORDER BY generated_at DESC, version_no DESC LIMIT $1`,
        [cap],
      );
  return result.rows.map(rowToVersionMeta);
}

export async function getVersionMeta(id: string): Promise<CatalogueVersionMeta | null> {
  if (!isUuid(id)) return null;
  const result = await catalogueQuery<VersionRow>(
    `/* cat:version_meta */ SELECT ${META_COLUMNS} FROM catalogue_versions WHERE id = $1`,
    [id],
  );
  return result.rows[0] ? rowToVersionMeta(result.rows[0]) : null;
}

/** Admin download route: any status, including drafts. Never wire this to a public route. */
export async function getVersionPdf(id: string): Promise<{ bytes: Buffer; meta: CatalogueVersionMeta } | null> {
  if (!isUuid(id)) return null;
  const result = await catalogueQuery<VersionRow & { bytes: Buffer }>(
    `/* cat:version_pdf */ SELECT ${META_COLUMNS}, bytes FROM catalogue_versions WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { bytes: row.bytes, meta: rowToVersionMeta(row) };
}

export async function getVersionPageImage(id: string, page: number): Promise<Buffer | null> {
  if (!isUuid(id) || !Number.isInteger(page) || page < 1) return null;
  const result = await catalogueQuery<{ jpeg: Buffer }>(
    `/* cat:page_get */ SELECT jpeg FROM catalogue_version_pages WHERE version_id = $1 AND page_no = $2`,
    [id, page],
  );
  return result.rows[0]?.jpeg ?? null;
}

export async function getVersionSnapshot(id: string): Promise<CatalogueSnapshot | null> {
  if (!isUuid(id)) return null;
  const result = await catalogueQuery<{ snapshot: unknown }>(
    `/* cat:version_snapshot */ SELECT snapshot FROM catalogue_versions WHERE id = $1`,
    [id],
  );
  const snapshot = parseJson(result.rows[0]?.snapshot);
  return snapshot && typeof snapshot === "object" ? (snapshot as CatalogueSnapshot) : null;
}

export async function getPublished(edition: CatalogueEdition): Promise<CatalogueVersionMeta | null> {
  if (!isCatalogueEdition(edition)) return null;
  const result = await catalogueQuery<VersionRow>(
    `/* cat:published_get */ SELECT ${META_COLUMNS} FROM catalogue_versions
     WHERE edition = $1 AND status = 'published' LIMIT 1`,
    [edition],
  );
  return result.rows[0] ? rowToVersionMeta(result.rows[0]) : null;
}

/**
 * Metadata for the public file route. Only PUBLISHED and SUPERSEDED versions are reachable by
 * token: a draft stays admin-only, and a superseded file keeps working so links already sent to
 * customers do not die when a newer version is published.
 */
export async function getPublicFileMetaByToken(token: string): Promise<CatalogueVersionMeta | null> {
  if (typeof token !== "string" || !PUBLIC_TOKEN_RE.test(token)) return null;
  const result = await catalogueQuery<VersionRow>(
    `/* cat:public_meta */ SELECT ${META_COLUMNS} FROM catalogue_versions
     WHERE public_token = $1 AND status IN ('published','superseded')`,
    [token],
  );
  return result.rows[0] ? rowToVersionMeta(result.rows[0]) : null;
}

export async function getPublicFileByToken(
  token: string,
): Promise<{ bytes: Buffer; meta: CatalogueVersionMeta } | null> {
  if (typeof token !== "string" || !PUBLIC_TOKEN_RE.test(token)) return null;
  const result = await catalogueQuery<VersionRow & { bytes: Buffer }>(
    `/* cat:public_file */ SELECT ${META_COLUMNS}, bytes FROM catalogue_versions
     WHERE public_token = $1 AND status IN ('published','superseded')`,
    [token],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { bytes: row.bytes, meta: rowToVersionMeta(row) };
}

// ---------------------------------------------------------------------------------------------
// Publish / rollback
// ---------------------------------------------------------------------------------------------

type Activation = { mode: "publish" | "rollback"; acknowledgeWarnings: boolean };

async function activateVersion(id: string, actor: string | null, activation: Activation): Promise<CatalogueVersionMeta> {
  if (!isUuid(id)) throw new CatalogueStoreError("version_not_found", "Version not found");
  const by = cleanActor(actor);

  return catalogueTransaction(async (query: CatalogueQuery) => {
    const peek = await query<{ edition: string }>(
      `/* cat:version_edition */ SELECT edition FROM catalogue_versions WHERE id = $1`,
      [id],
    );
    const peekEdition = peek.rows[0]?.edition;
    if (!peekEdition) throw new CatalogueStoreError("version_not_found", "Version not found");

    // One publisher per edition at a time. Lock first, then read the row we will change.
    await query(`/* cat:publish_lock */ SELECT pg_advisory_xact_lock(hashtext($1))`, [`catalogue_publish:${peekEdition}`]);
    const found = await query<VersionRow>(
      `/* cat:version_for_update */ SELECT ${META_COLUMNS} FROM catalogue_versions WHERE id = $1 FOR UPDATE`,
      [id],
    );
    const row = found.rows[0];
    if (!row) throw new CatalogueStoreError("version_not_found", "Version not found");
    const meta = rowToVersionMeta(row);

    if (meta.edition === "preview") {
      throw new CatalogueStoreError("preview_not_publishable", "The preview sample is never published to customers");
    }
    if (meta.status === "published") return meta; // idempotent: a double click changes nothing
    if (activation.mode === "rollback" && meta.status !== "superseded") {
      throw new CatalogueStoreError(
        "rollback_requires_previous_version",
        "Only a version that was published before can be rolled back to",
      );
    }

    const blocking = meta.warnings.filter((warning) => warning.severity === "blocking");
    if (activation.mode === "publish" && blocking.length > 0 && !activation.acknowledgeWarnings) {
      throw new CatalogueStoreError("blocking_warnings", "Version has blocking warnings that must be acknowledged", {
        warnings: blocking,
      });
    }

    const publishedAt = catalogueNowIso();
    // Order matters: the partial unique index allows one published row per edition at every
    // statement, so the old pointer is released before the new one is taken.
    const superseded = await query<{ id: string }>(
      `/* cat:publish_supersede */ UPDATE catalogue_versions SET status = 'superseded'
       WHERE edition = $1 AND status = 'published' AND id <> $2 RETURNING id`,
      [meta.edition, id],
    );
    await query(
      `/* cat:publish_activate */ UPDATE catalogue_versions
       SET status = 'published', published_at = $2::timestamptz, published_by = $3 WHERE id = $1`,
      [id, publishedAt, by],
    );
    await writeAudit(query, {
      action: activation.mode,
      actor: by,
      edition: meta.edition,
      versionId: id,
      detail: {
        versionNo: meta.versionNo,
        supersededVersionId: superseded.rows[0]?.id ?? null,
        acknowledgedBlockingWarnings: activation.mode === "publish" ? blocking.length : 0,
      },
    });
    return { ...meta, status: "published" as const, publishedAt, publishedBy: by };
  });
}

/**
 * Make a version the live one for its edition. Refuses a version that carries blocking warnings
 * unless the caller explicitly acknowledges them. The previous published version becomes
 * "superseded" in the same transaction, so there is never a moment with two (or zero, on failure).
 */
export async function publishVersion(
  id: string,
  actor: string | null,
  opts: { acknowledgeWarnings?: boolean } = {},
): Promise<CatalogueVersionMeta> {
  return activateVersion(id, actor, { mode: "publish", acknowledgeWarnings: Boolean(opts.acknowledgeWarnings) });
}

/**
 * Put an older, previously published version back live. The warning gate does not run again: it
 * was already published once, by a person, with the warnings in front of them.
 */
export async function rollbackTo(id: string, actor: string | null): Promise<CatalogueVersionMeta> {
  return activateVersion(id, actor, { mode: "rollback", acknowledgeWarnings: true });
}

// ---------------------------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------------------------

/**
 * Keep the `keep` newest versions of each edition and delete the rest, EXCEPT a published row,
 * which is never deleted whatever its age. Page images and cached Messenger attachment ids go with
 * the version (ON DELETE CASCADE). Returns how many versions were deleted.
 */
export async function pruneOldVersions(keep = 20): Promise<{ deleted: number }> {
  const keepCount = Math.max(1, Math.trunc(Number(keep)) || 20);
  return catalogueTransaction(async (query) => {
    const removed = await query<{ id: string; edition: string }>(
      `/* cat:versions_prune */ DELETE FROM catalogue_versions WHERE id IN (
         SELECT id FROM (
           SELECT id, status, ROW_NUMBER() OVER (PARTITION BY edition ORDER BY version_no DESC) AS rn
           FROM catalogue_versions
         ) ranked WHERE rn > $1 AND status <> 'published'
       ) RETURNING id, edition`,
      [keepCount],
    );
    if (removed.rows.length > 0) {
      await writeAudit(query, {
        action: "prune",
        actor: null,
        detail: { deleted: removed.rows.length, keep: keepCount },
      });
    }
    return { deleted: removed.rows.length };
  });
}

// ---------------------------------------------------------------------------------------------
// Audit read (admin history)
// ---------------------------------------------------------------------------------------------

export type CatalogueAuditEntry = {
  id: number;
  action: string;
  actor: string | null;
  edition: CatalogueEdition | null;
  versionId: string | null;
  detail: Record<string, unknown>;
  at: string;
};

export async function listCatalogueAudit(limit = 50): Promise<CatalogueAuditEntry[]> {
  const cap = Math.min(Math.max(Math.trunc(Number(limit)) || 50, 1), 200);
  const result = await catalogueQuery<{
    id: number | string;
    action: string;
    actor: string | null;
    edition: string | null;
    version_id: string | null;
    detail: unknown;
    at: unknown;
  }>(
    `/* cat:audit_list */ SELECT id, action, actor, edition, version_id, detail, at
     FROM catalogue_audit ORDER BY at DESC, id DESC LIMIT $1`,
    [cap],
  );
  return result.rows.map((row) => {
    const detail = parseJson(row.detail);
    return {
      id: Number(row.id),
      action: row.action,
      actor: row.actor,
      edition: isCatalogueEdition(row.edition) ? row.edition : null,
      versionId: row.version_id,
      detail: detail && typeof detail === "object" ? (detail as Record<string, unknown>) : {},
      at: toIso(row.at) ?? "",
    };
  });
}
