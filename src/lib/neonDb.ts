import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from "pg";
import { installBrandWriteGuard } from "./brandWriteGuard";
import { isSecondaryBrand } from "./brand";
import { inBrandAdminMode } from "./brandAdminMode";
import { getEnv } from "./env";
import { logError, logInfo, recordCounter } from "./observability";

const env = getEnv();
let pool: Pool | null = null;
// A secondary brand's admin requests use their own connections without the write guard: its admin
// edits the shared catalogue like the primary's admin (brandAdminMode.ts). Chosen per call, in the
// caller's context, so the guard never depends on which request a pooled connection last served.
let adminPool: Pool | null = null;

function normalizeConnectionString(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    const sslmode = url.searchParams.get("sslmode");
    const useLibpqCompat = url.searchParams.get("uselibpqcompat");
    if (
      sslmode &&
      ["prefer", "require", "verify-ca"].includes(sslmode) &&
      useLibpqCompat !== "true"
    ) {
      url.searchParams.set("sslmode", "verify-full");
    }
    return url.toString();
  } catch {
    return connectionString;
  }
}

function createPool(connectionString: string, guarded = true): Pool {
  const p = new Pool({
    connectionString: normalizeConnectionString(connectionString),
    max: 6,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Without this, a query on a socket the server has silently half-closed
    // (Neon idles connections out from under the pool) can hang until the OS
    // TCP timeout — which reads as "stuck saving forever" in the admin UI.
    // Bounding it here turns that into a normal, retryable error instead.
    statement_timeout: 20_000,
    options: "-c client_encoding=UTF8",
  });
  // A secondary brand's deployment reads the shared catalogue but writes only its own customers' rows.
  if (guarded) installBrandWriteGuard(p);
  return p;
}

// "Connection terminated unexpectedly" / ECONNRESET fire when the pool hands
// out a connection Neon already closed server-side — the query itself never
// reached Postgres, so a retry on a fresh connection is safe even for writes.
function isRetryableConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /Connection terminated unexpectedly/i.test(message) ||
    /ECONNRESET/i.test(message) ||
    /server closed the connection/i.test(message)
  );
}

// A Vercel Preview deployment opens no database unless an isolated one (its own Neon
// branch, never Production) is configured and marked with PREVIEW_DATABASE_ISOLATED=1.
let previewRefusalLogged = false;

function getPool() {
  if (!env.neonDatabaseUrl) return null;
  if (process.env.VERCEL_ENV === "preview" && process.env.PREVIEW_DATABASE_ISOLATED !== "1") {
    if (!previewRefusalLogged) {
      previewRefusalLogged = true;
      logError("neon.preview_database_refused", { hint: "Preview needs its own database branch and PREVIEW_DATABASE_ISOLATED=1." });
    }
    return null;
  }
  if (isSecondaryBrand() && inBrandAdminMode()) {
    if (!adminPool) {
      adminPool = createPool(env.neonDatabaseUrl, false);
      adminPool.on("error", (error) => {
        logError("neon.pool.error", { message: error instanceof Error ? error.message : String(error), pool: "brand_admin" });
      });
    }
    return adminPool;
  }
  if (!pool) {
    pool = createPool(env.neonDatabaseUrl);
    pool.on("error", (error) => {
      logError("neon.pool.error", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    logInfo("neon.pool.initialized", { configured: true });
  }
  return pool;
}

export function isNeonConfigured() {
  return Boolean(env.neonDatabaseUrl);
}

export async function queryNeon<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T> | null> {
  const db = getPool();
  if (!db) return null;
  recordCounter("neon.query_total", 1);
  try {
    return await db.query<T>(text, params);
  } catch (error) {
    if (!isRetryableConnectionError(error)) throw error;
    logError("neon.query_retry", {
      message: error instanceof Error ? error.message : String(error),
    });
    recordCounter("neon.query_retry_total", 1);
    // One retry on a fresh connection — the dead socket never reached
    // Postgres, so this can't double-apply a write.
    return await db.query<T>(text, params);
  }
}

export async function withNeonClient<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | null> {
  const db = getPool();
  if (!db) return null;
  const client = await db.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export async function closeNeonPool(): Promise<void> {
  const pools = [pool, adminPool].filter((value): value is Pool => value != null);
  pool = null;
  adminPool = null;
  await Promise.all(pools.map((value) => value.end()));
}
