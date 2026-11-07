/**
 * Neon schema and shared plumbing for the corporate catalogue store.
 *
 * Every table is prefixed `catalogue_`. The schema is created lazily and idempotently
 * (CREATE ... IF NOT EXISTS under an advisory lock, so two cold serverless instances never race),
 * the same pattern as connectedTripStore.ts.
 *
 * Every statement the store sends starts with a `/* cat:<name> *\/` comment. It costs nothing in
 * Postgres, makes slow-query logs readable, and lets the unit tests dispatch each statement to an
 * in-memory fake without parsing SQL.
 *
 * Clock and id generation are injectable (see the ...ForTests setters) so tests are deterministic.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { QueryResultRow } from "pg";
import { queryNeon, withNeonClient } from "../neonDb";
import { logError } from "../observability";
import type { CatalogueEdition } from "./types";

export type CatalogueStoreErrorCode =
  | "db_not_configured"
  | "invalid_input"
  | "version_not_found"
  | "blocking_warnings"
  | "preview_not_publishable"
  | "rollback_requires_previous_version"
  | "invalid_pdf"
  | "pdf_too_large"
  | "code_space_exhausted"
  | "config_conflict";

export class CatalogueStoreError extends Error {
  readonly code: CatalogueStoreErrorCode;
  readonly detail: Record<string, unknown> | undefined;
  constructor(code: CatalogueStoreErrorCode, message?: string, detail?: Record<string, unknown>) {
    super(message || code);
    this.name = "CatalogueStoreError";
    this.code = code;
    this.detail = detail;
  }
}

export const CATALOGUE_EDITIONS: readonly CatalogueEdition[] = ["quick", "complete", "preview"];

export function isCatalogueEdition(value: unknown): value is CatalogueEdition {
  return typeof value === "string" && (CATALOGUE_EDITIONS as readonly string[]).includes(value);
}

/** Messenger's file attachment ceiling. A bigger PDF could never be delivered, so never store it. */
export const CATALOGUE_MAX_PDF_BYTES = 25 * 1024 * 1024;

/** One statement per entry. Every CREATE must say IF NOT EXISTS (asserted by the unit test). */
export const CATALOGUE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS catalogue_versions (
    id UUID PRIMARY KEY,
    edition TEXT NOT NULL CHECK (edition IN ('quick','complete','preview')),
    version_no INT NOT NULL,
    file_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','superseded')),
    bytes BYTEA NOT NULL,
    size_bytes INT NOT NULL,
    page_count INT NOT NULL,
    sha256 TEXT NOT NULL,
    content_hash TEXT NOT NULL DEFAULT '',
    trip_count INT NOT NULL DEFAULT 0,
    snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
    warnings JSONB NOT NULL DEFAULT '[]'::jsonb,
    public_token TEXT NOT NULL UNIQUE,
    generated_at TIMESTAMPTZ NOT NULL,
    generated_by TEXT,
    published_at TIMESTAMPTZ,
    published_by TEXT,
    UNIQUE (edition, version_no)
  )`,
  // The database itself refuses a second published row for an edition.
  `CREATE UNIQUE INDEX IF NOT EXISTS catalogue_versions_one_published
    ON catalogue_versions (edition) WHERE status = 'published'`,
  `CREATE INDEX IF NOT EXISTS catalogue_versions_edition_no
    ON catalogue_versions (edition, version_no DESC)`,
  `CREATE TABLE IF NOT EXISTS catalogue_version_pages (
    version_id UUID NOT NULL REFERENCES catalogue_versions(id) ON DELETE CASCADE,
    page_no INT NOT NULL,
    jpeg BYTEA NOT NULL,
    PRIMARY KEY (version_id, page_no)
  )`,
  `CREATE TABLE IF NOT EXISTS catalogue_config (
    id SMALLINT PRIMARY KEY CHECK (id = 1),
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL,
    updated_by TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS catalogue_codes (
    trip_id TEXT PRIMARY KEY,
    seq INT NOT NULL UNIQUE,
    code TEXT NOT NULL UNIQUE,
    assigned_at TIMESTAMPTZ NOT NULL
  )`,
  // No foreign key on version_id: send history must survive pruning of old versions.
  `CREATE TABLE IF NOT EXISTS catalogue_sends (
    id UUID PRIMARY KEY,
    sender_hash TEXT NOT NULL,
    edition TEXT NOT NULL,
    version_id UUID,
    status TEXT NOT NULL DEFAULT 'claimed',
    meta_message_id TEXT,
    reason TEXT,
    retries INT NOT NULL DEFAULT 0,
    explicit_resend BOOLEAN NOT NULL DEFAULT FALSE,
    dedupe_key TEXT,
    suppressed_count INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS catalogue_sends_sender_recent
    ON catalogue_sends (sender_hash, edition, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS catalogue_sends_created
    ON catalogue_sends (created_at)`,
  // Backstop for the claim logic: one inbound message can never own two send rows.
  `CREATE UNIQUE INDEX IF NOT EXISTS catalogue_sends_dedupe
    ON catalogue_sends (sender_hash, dedupe_key) WHERE dedupe_key IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS catalogue_fb_attachments (
    version_id UUID NOT NULL REFERENCES catalogue_versions(id) ON DELETE CASCADE,
    page_id TEXT NOT NULL,
    attachment_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (version_id, page_id)
  )`,
  // No foreign key either: the audit trail outlives pruned versions.
  `CREATE TABLE IF NOT EXISTS catalogue_audit (
    id BIGSERIAL PRIMARY KEY,
    action TEXT NOT NULL,
    actor TEXT,
    edition TEXT,
    version_id UUID,
    detail JSONB,
    at TIMESTAMPTZ NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS catalogue_audit_at ON catalogue_audit (at DESC)`,
];

export const CATALOGUE_TABLES = [
  "catalogue_versions",
  "catalogue_version_pages",
  "catalogue_config",
  "catalogue_codes",
  "catalogue_sends",
  "catalogue_fb_attachments",
  "catalogue_audit",
] as const;

// ---------------------------------------------------------------------------------------------
// Clock and ids (injectable)
// ---------------------------------------------------------------------------------------------

const realClock = (): Date => new Date();
let clock: () => Date = realClock;
let uuidFactory: () => string = () => randomUUID();
let tokenFactory: () => string = () => randomBytes(24).toString("base64url");

export function catalogueNow(): Date {
  return clock();
}

export function catalogueNowIso(): string {
  return clock().toISOString();
}

export function newCatalogueId(): string {
  return uuidFactory();
}

/** 32 URL-safe characters, 192 bits. Unguessable, carries no meaning and no PII. */
export function newCataloguePublicToken(): string {
  return tokenFactory();
}

/** Tests only. Pass null to restore the real clock / generators. */
export function setCatalogueRuntimeForTests(
  overrides: { now?: (() => Date) | null; uuid?: (() => string) | null; token?: (() => string) | null } | null,
): void {
  clock = overrides?.now ?? realClock;
  uuidFactory = overrides?.uuid ?? (() => randomUUID());
  tokenFactory = overrides?.token ?? (() => randomBytes(24).toString("base64url"));
}

// ---------------------------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------------------------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PUBLIC_TOKEN_RE = /^[A-Za-z0-9_-]{24,64}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** Postgres hands back Date for timestamptz; the in-memory test fake hands back strings. */
export function toIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/** Asia/Ulaanbaatar is UTC+8 all year (no daylight saving), so the calendar day is a fixed shift. */
export function ulaanbaatarDay(date: Date): string {
  return new Date(date.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export type CatalogueQueryResult<T> = { rows: T[]; rowCount: number };
export type CatalogueQuery = <T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<CatalogueQueryResult<T>>;

function notConfigured(): CatalogueStoreError {
  return new CatalogueStoreError("db_not_configured", "Catalogue database is not configured");
}

// ---------------------------------------------------------------------------------------------
// Schema ensure
// ---------------------------------------------------------------------------------------------

let ready: Promise<void> | undefined;

/** Forget that the schema was ensured (tests, and recovery after a failed ensure). */
export function resetCatalogueSchemaForTests(): void {
  ready = undefined;
}

export function ensureCatalogueSchema(): Promise<void> {
  return (ready ??= setup().catch((error) => {
    ready = undefined;
    throw error;
  }));
}

async function setup(): Promise<void> {
  const outcome = await withNeonClient(async (client) => {
    await client.query("BEGIN");
    try {
      // Serialises concurrent cold starts: CREATE TABLE IF NOT EXISTS alone can still lose a
      // race on the catalog's unique indexes when two sessions create the same table at once.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["catalogue_schema"]);
      for (const statement of CATALOGUE_SCHEMA_STATEMENTS) {
        await client.query(`/* cat:ddl */ ${statement}`);
      }
      await client.query("COMMIT");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error is the useful one.
      }
      throw error;
    }
    return true;
  });
  if (!outcome) throw notConfigured();
}

// ---------------------------------------------------------------------------------------------
// Query helpers (every store function goes through these)
// ---------------------------------------------------------------------------------------------

export async function catalogueQuery<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<CatalogueQueryResult<T>> {
  await ensureCatalogueSchema();
  const result = await queryNeon<T>(sql, params);
  if (!result) throw notConfigured();
  return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
}

/**
 * Run `fn` in one transaction on one connection. Commits when `fn` resolves, rolls back when it
 * throws, always releases the connection.
 */
export async function catalogueTransaction<T>(fn: (query: CatalogueQuery) => Promise<T>): Promise<T> {
  await ensureCatalogueSchema();
  const outcome = await withNeonClient(async (client) => {
    await client.query("BEGIN");
    try {
      const query: CatalogueQuery = async <R extends QueryResultRow = QueryResultRow>(
        sql: string,
        params: unknown[] = [],
      ) => {
        const result = await client.query<R>(sql, params);
        return { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      };
      const value = await fn(query);
      await client.query("COMMIT");
      return { value };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        logError("catalogue.rollback_failed", {
          message: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
        });
      }
      throw error;
    }
  });
  if (!outcome) throw notConfigured();
  return outcome.value;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "23505");
}

// ---------------------------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------------------------

export type CatalogueAuditAction =
  | "generate"
  | "publish"
  | "rollback"
  | "prune"
  | "config_save"
  | "code_assign";

export async function writeAudit(
  query: CatalogueQuery,
  entry: {
    action: CatalogueAuditAction;
    actor: string | null;
    edition?: CatalogueEdition | null;
    versionId?: string | null;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  await query(
    `/* cat:audit_insert */ INSERT INTO catalogue_audit (action, actor, edition, version_id, detail, at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,
    [
      entry.action,
      cleanActor(entry.actor),
      entry.edition ?? null,
      entry.versionId ?? null,
      JSON.stringify(entry.detail ?? {}),
      catalogueNowIso(),
    ],
  );
}

/** Staff identity is an email or a short label. Cap it, strip control characters, never trust it. */
export function cleanActor(actor: string | null | undefined): string | null {
  if (typeof actor !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = actor.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return cleaned || null;
}
