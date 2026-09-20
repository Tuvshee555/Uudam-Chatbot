/**
 * Persistent, self-cleaning log of everything that went wrong in the bot.
 *
 * Vercel's own logs are short-lived and hard to search after a client reports
 * "the AI assistant broke yesterday". Every error/warn record (plus a few
 * "the bot went quiet on purpose" events) is copied into Postgres so the cause
 * can be looked up later, and rows older than ERROR_LOG_RETENTION_DAYS are
 * deleted automatically so the table can never grow into a storage problem.
 *
 * Fed by observability.ts (logEvent). Everything here is best-effort: a logging
 * failure must never affect a customer reply, and this module never calls the
 * observability loggers itself (that would loop back into itself).
 */

import { waitUntil } from "@vercel/functions";
import { isNeonConfigured, queryNeon } from "./neonDb";
import { shouldPersistLog } from "./observability";

export const ERROR_LOG_RETENTION_DAYS = 7;
/** Hard ceiling on stored rows, so an error storm can't outgrow the week. */
export const ERROR_LOG_MAX_ROWS = 20_000;
const MAX_INSERTS_PER_MINUTE = 120;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const MAX_MESSAGE_CHARS = 1000;
const MAX_FIELDS_CHARS = 8000;

export type PersistableLogRecord = Record<string, unknown> & {
  level?: unknown;
  event?: unknown;
};

/** Strips credentials that can leak into error text (URLs, auth headers). */
export function scrubSecrets(text: string): string {
  return text
    .replace(/(access_token=)[^&\s"'\\]+/gi, "$1[redacted]")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[redacted]");
}

/**
 * Postgres rejects NUL characters and unpaired surrogates in text/jsonb, and
 * garbled input (mojibake, broken emoji) is exactly what error logs contain.
 * Without this, those rows would fail to insert and be silently lost.
 */
export function sanitizeForPostgres(text: string): string {
  return (
    text
      // real NUL character (text columns)
      .replace(/\u0000/g, "")
      // JSON-escaped NUL inside a stringified fields blob (jsonb)
      .replace(/\\u0000/g, "")
      // JSON-escaped unpaired surrogates (jsonb)
      .replace(
        /\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})|(?<!\\ud[89ab][0-9a-f]{2})\\ud[c-f][0-9a-f]{2}/gi,
        "",
      )
      // real unpaired surrogates (text columns)
      .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, "")
  );
}

export type StoredErrorLog = {
  id: number;
  created_at: string;
  level: string;
  event: string;
  message: string;
  request_id: string;
  correlation_id: string;
  sender_hash: string;
  fields: Record<string, unknown>;
};

type Prepared = {
  level: string;
  event: string;
  message: string;
  requestId: string;
  correlationId: string;
  senderHash: string;
  fields: string;
};

const ENVELOPE_KEYS = new Set([
  "ts",
  "level",
  "service",
  "event",
  "message",
  "requestId",
  "correlationId",
  "senderHash",
  "customerHash",
]);

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** Pure shaping step (exported for tests): log record -> row values. */
export function prepareLogRow(record: PersistableLogRecord): Prepared | null {
  if (!shouldPersistLog(record.level, record.event)) return null;

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!ENVELOPE_KEYS.has(key)) rest[key] = value;
  }
  let fields = sanitizeForPostgres(scrubSecrets(JSON.stringify(rest)));
  if (fields.length > MAX_FIELDS_CHARS) {
    fields = JSON.stringify({ truncated: true, preview: fields.slice(0, MAX_FIELDS_CHARS) });
  }

  return {
    level: String(record.level),
    event: String(record.event).slice(0, 200),
    message: sanitizeForPostgres(scrubSecrets(asText(record.message))).slice(0, MAX_MESSAGE_CHARS),
    requestId: asText(record.requestId).slice(0, 100),
    correlationId: asText(record.correlationId).slice(0, 100),
    senderHash: (asText(record.senderHash) || asText(record.customerHash)).slice(0, 64),
    fields,
  };
}

let schemaReady: Promise<boolean> | null = null;

function ensureSchema(): Promise<boolean> {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    try {
      const created = await queryNeon(`
        CREATE TABLE IF NOT EXISTS travel_error_logs (
          id             BIGSERIAL PRIMARY KEY,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          level          TEXT NOT NULL,
          event          TEXT NOT NULL,
          message        TEXT NOT NULL DEFAULT '',
          request_id     TEXT NOT NULL DEFAULT '',
          correlation_id TEXT NOT NULL DEFAULT '',
          sender_hash    TEXT NOT NULL DEFAULT '',
          fields         JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
      if (!created) return false;
      await queryNeon(
        `CREATE INDEX IF NOT EXISTS idx_travel_error_logs_created ON travel_error_logs (created_at DESC)`,
      );
      await queryNeon(
        `CREATE INDEX IF NOT EXISTS idx_travel_error_logs_event ON travel_error_logs (event, created_at DESC)`,
      );
      return true;
    } catch (error) {
      console.warn(
        JSON.stringify({
          level: "warn",
          event: "error_log_store.schema_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      return false;
    }
  })().then((ok) => {
    if (!ok) schemaReady = null; // retry on the next log instead of failing forever
    return ok;
  });
  return schemaReady;
}

// Per-instance flood guard: a hot error loop must not turn into a write storm.
let windowStartedAt = 0;
let windowCount = 0;
let windowDropped = 0;
let lastPruneAt = 0;

function admitInsert(now: number): { admit: boolean; droppedToReport: number } {
  let droppedToReport = 0;
  if (now - windowStartedAt >= 60_000) {
    droppedToReport = windowDropped;
    windowStartedAt = now;
    windowCount = 0;
    windowDropped = 0;
  }
  if (windowCount >= MAX_INSERTS_PER_MINUTE) {
    windowDropped += 1;
    return { admit: false, droppedToReport };
  }
  windowCount += 1;
  return { admit: true, droppedToReport };
}

async function insertRow(row: Prepared): Promise<void> {
  await queryNeon(
    `INSERT INTO travel_error_logs
       (level, event, message, request_id, correlation_id, sender_hash, fields)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [row.level, row.event, row.message, row.requestId, row.correlationId, row.senderHash, row.fields],
  );
}

async function writeLog(record: PersistableLogRecord): Promise<void> {
  try {
    const row = prepareLogRow(record);
    if (!row) return;
    if (!isNeonConfigured()) return;
    const now = Date.now();
    const { admit, droppedToReport } = admitInsert(now);
    if (!(await ensureSchema())) return;
    if (droppedToReport > 0) {
      await insertRow({
        level: "warn",
        event: "error_log_store.flood_dropped",
        message: `${droppedToReport} log records were dropped in the previous minute (flood guard).`,
        requestId: "",
        correlationId: "",
        senderHash: "",
        fields: JSON.stringify({ dropped: droppedToReport, perMinuteLimit: MAX_INSERTS_PER_MINUTE }),
      });
    }
    if (admit) await insertRow(row);
    if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
      lastPruneAt = now;
      await pruneErrorLogs();
    }
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "error_log_store.write_failed",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/**
 * Called by observability.logEvent for every record. Returns immediately; the
 * write finishes in the background (kept alive past the response by waitUntil
 * on Vercel, a detached promise elsewhere).
 */
export function persistLogRecord(record: PersistableLogRecord): void {
  if (!shouldPersistLog(record.level, record.event)) return;
  const work = writeLog(record);
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/** Deletes rows past the retention window, then trims to the row ceiling. */
export async function pruneErrorLogs(): Promise<{ expired: number; overflow: number }> {
  if (!isNeonConfigured()) return { expired: 0, overflow: 0 };
  if (!(await ensureSchema())) return { expired: 0, overflow: 0 };
  const expired = await queryNeon(
    `DELETE FROM travel_error_logs WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')`,
    [ERROR_LOG_RETENTION_DAYS],
  );
  const overflow = await queryNeon(
    `DELETE FROM travel_error_logs
     WHERE id <= (SELECT id FROM travel_error_logs ORDER BY id DESC OFFSET $1 LIMIT 1)`,
    [ERROR_LOG_MAX_ROWS],
  );
  return { expired: expired?.rowCount ?? 0, overflow: overflow?.rowCount ?? 0 };
}

export type ErrorLogQuery = {
  hours?: number;
  level?: "error" | "warn" | "info";
  event?: string;
  search?: string;
  limit?: number;
};

function clampInt(value: unknown, fallback: number, min: number, max: number) {
  const n = typeof value === "number" ? Math.trunc(value) : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export async function listErrorLogs(query: ErrorLogQuery = {}): Promise<StoredErrorLog[]> {
  if (!isNeonConfigured() || !(await ensureSchema())) return [];
  const hours = clampInt(query.hours, 24, 1, ERROR_LOG_RETENTION_DAYS * 24);
  const limit = clampInt(query.limit, 200, 1, 500);
  const params: unknown[] = [hours];
  const where = [`created_at >= NOW() - ($1::int * INTERVAL '1 hour')`];
  if (query.level) {
    params.push(query.level);
    where.push(`level = $${params.length}`);
  }
  if (query.event) {
    params.push(query.event);
    where.push(`event = $${params.length}`);
  }
  if (query.search?.trim()) {
    params.push(`%${query.search.trim().slice(0, 100)}%`);
    where.push(
      `(message ILIKE $${params.length} OR event ILIKE $${params.length} OR fields::text ILIKE $${params.length})`,
    );
  }
  params.push(limit);
  const result = await queryNeon<StoredErrorLog>(
    `SELECT id::int AS id, created_at, level, event, message, request_id, correlation_id, sender_hash, fields
       FROM travel_error_logs
      WHERE ${where.join(" AND ")}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return (result?.rows ?? []).map((row) => ({
    ...row,
    created_at: new Date(row.created_at).toISOString(),
  }));
}

export type ErrorLogSummaryRow = {
  event: string;
  level: string;
  count: number;
  last_at: string;
};

export async function summarizeErrorLogs(hours = 24): Promise<ErrorLogSummaryRow[]> {
  if (!isNeonConfigured() || !(await ensureSchema())) return [];
  const window = clampInt(hours, 24, 1, ERROR_LOG_RETENTION_DAYS * 24);
  const result = await queryNeon<ErrorLogSummaryRow>(
    `SELECT event, level, COUNT(*)::int AS count, MAX(created_at) AS last_at
       FROM travel_error_logs
      WHERE created_at >= NOW() - ($1::int * INTERVAL '1 hour')
      GROUP BY event, level
      ORDER BY count DESC, last_at DESC
      LIMIT 60`,
    [window],
  );
  return (result?.rows ?? []).map((row) => ({
    ...row,
    last_at: new Date(row.last_at).toISOString(),
  }));
}
