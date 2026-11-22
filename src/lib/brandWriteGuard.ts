/**
 * A secondary brand (brand.ts) shares the primary's database but must never change what the primary
 * owns: the trip catalogue, bot settings and controls, posters, catalogues, partner/website sync rows,
 * the website's own tables. Its deployment answers its own customers, so it may write only the
 * per-customer tables below.
 *
 * Every statement a secondary deployment sends through a guarded pool is classified first. A write to
 * any other table is NOT sent: it answers like a write that matched nothing (rowCount 0, no rows) and
 * is logged once per table. Idempotent schema statements (CREATE … IF NOT EXISTS, ALTER TABLE … ADD
 * COLUMN IF NOT EXISTS) pass, since both deployments run the same commit. The primary is never guarded.
 */
import type { Pool, PoolClient } from "pg";
import { getBrand } from "./brand";
import { logWarn } from "./observability";

/** Tables a secondary deployment writes while answering its own customers. Everything else is read-only. */
export const SECONDARY_WRITABLE_TABLES = new Set([
  "travel_senders",
  "travel_conversations",
  "travel_leads",
  "travel_messages",
  "travel_customer_documents",
  "travel_customer_document_audit",
  "travel_customer_memories",
  "travel_conversation_attachments",
  "travel_outbound_messages",
  "travel_echo_events",
  "travel_ad_referrals",
  "travel_ai_usage",
  "travel_error_logs",
  "travel_sweep_lock",
  "travel_page_control",
]);

export type WriteVerdict =
  | { allowed: true }
  | { allowed: false; command: string; tables: string[] };

function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

function tableName(raw: string): string {
  const parts = raw.replace(/"/g, "").split(".");
  return (parts[parts.length - 1] || "").toLowerCase();
}

const NAME = String.raw`((?:"[^"]+"|\w+)(?:\.(?:"[^"]+"|\w+))?)`;
const WRITE_TARGETS: Array<{ command: string; pattern: RegExp }> = [
  { command: "INSERT", pattern: new RegExp(String.raw`\bINSERT\s+INTO\s+` + NAME, "gi") },
  { command: "UPDATE", pattern: new RegExp(String.raw`(?<!\b(?:DO|FOR|KEY)\s+)\bUPDATE\s+(?:ONLY\s+)?` + NAME, "gi") },
  { command: "DELETE", pattern: new RegExp(String.raw`\bDELETE\s+FROM\s+(?:ONLY\s+)?` + NAME, "gi") },
  { command: "TRUNCATE", pattern: new RegExp(String.raw`\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?` + NAME, "gi") },
  { command: "MERGE", pattern: new RegExp(String.raw`\bMERGE\s+INTO\s+` + NAME, "gi") },
];

/** Whether a secondary deployment may send this statement. */
export function classifyBrandWrite(sql: string): WriteVerdict {
  const text = stripSqlNoise(sql);
  // TRUNCATE empties both brands' rows, so it is never a secondary's to send, whatever the table.
  if (/\b(?:DROP|TRUNCATE|COPY|GRANT|REVOKE|VACUUM|REINDEX|CLUSTER|COMMENT\s+ON)\b/i.test(text)) {
    return { allowed: false, command: "DDL", tables: [] };
  }
  if (/\bCREATE\b/i.test(text) && !/\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX(?:\s+CONCURRENTLY)?|EXTENSION)\s+IF\s+NOT\s+EXISTS\b/i.test(text)) {
    return { allowed: false, command: "CREATE", tables: [] };
  }
  if (/\bALTER\s+TABLE\b/i.test(text)) {
    const rest = text.replace(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi, " ");
    if (/\b(?:ADD|RENAME|ALTER\s+COLUMN|TYPE|VALIDATE|OWNER|DISABLE|ENABLE|ATTACH|DETACH|INHERIT)\b/i.test(rest.replace(/\bALTER\s+TABLE\b/gi, " "))) {
      return { allowed: false, command: "ALTER", tables: [] };
    }
  }
  const blocked = new Set<string>();
  let command = "";
  for (const target of WRITE_TARGETS) {
    target.pattern.lastIndex = 0;
    for (const match of text.matchAll(target.pattern)) {
      // An unreadable target is treated as foreign: fail safe.
      const name = tableName(match[1] || "") || "(unknown)";
      if (SECONDARY_WRITABLE_TABLES.has(name)) continue;
      blocked.add(name);
      command ||= target.command;
    }
  }
  return blocked.size ? { allowed: false, command, tables: Array.from(blocked) } : { allowed: true };
}

const loggedBlocks = new Set<string>();
function reportBlocked(verdict: Extract<WriteVerdict, { allowed: false }>) {
  const key = `${verdict.command}:${verdict.tables.join(",")}`;
  if (loggedBlocks.has(key)) return;
  loggedBlocks.add(key);
  logWarn("brand_write_guard.blocked", { brand: getBrand().key, command: verdict.command, tables: verdict.tables.join(",") });
}

type GuardedClient = PoolClient & { __brandWriteGuard?: true };
type QueryCallback = (error: Error | null, result: unknown) => void;

function guardClient(client: GuardedClient): void {
  if (client.__brandWriteGuard) return;
  client.__brandWriteGuard = true;
  const original = client.query.bind(client) as (...args: unknown[]) => unknown;
  (client as unknown as { query: (...args: unknown[]) => unknown }).query = (...args: unknown[]) => {
    const config = args[0] as string | { text?: unknown; callback?: unknown } | undefined;
    const text = typeof config === "string" ? config : typeof config?.text === "string" ? config.text : null;
    if (text != null) {
      const verdict = classifyBrandWrite(text);
      if (!verdict.allowed) {
        reportBlocked(verdict);
        const result = { command: verdict.command, rowCount: 0, rows: [], fields: [], oid: 0 };
        const callback = [args[1], args[2], typeof config === "object" ? config?.callback : undefined]
          .find((value): value is QueryCallback => typeof value === "function");
        if (callback) {
          process.nextTick(() => callback(null, result));
          return undefined;
        }
        return Promise.resolve(result);
      }
    }
    return original(...args);
  };
}

/** Guards every connection of this pool when this deployment is a secondary brand; no-op for the primary. */
export function installBrandWriteGuard(pool: Pool): void {
  if (getBrand().isPrimary) return;
  pool.on("connect", (client) => guardClient(client as GuardedClient));
}

/** Test hook: guard one client directly. */
export const __guardClientForTests = guardClient;
