import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";

export type BaselineOptions = { days: number; limit: number };
export const MAX_ROWS = 100_000;
export const MAX_BYTES = 64 * 1024 * 1024;

export function parseBaselineOptions(args: string[]): BaselineOptions {
  const options = { days: 7, limit: 100 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if ((key !== "--days" && key !== "--limit") || seen.has(key)) {
      throw new Error("Use only --days and --limit, once each.");
    }
    const max = key === "--days" ? 30 : 500;
    if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > max) {
      throw new Error(key === "--days" ? "Days must be an integer from 1 to 30." : "Limit must be an integer from 1 to 500.");
    }
    seen.add(key);
    options[key === "--days" ? "days" : "limit"] = Number(value);
  }
  return options;
}

// Only the dedicated pg client implements this interface; no application DB helpers.
export interface BaselineReader {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const WINDOW = "created_at >= $1::timestamptz AND created_at < $2::timestamptz AND role IN ('user', 'assistant')";

function count(value: unknown): number {
  if (!/^[0-9]+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new Error("Invalid database count.");
  return Number(value);
}

export function redactBaselineText(text: string, senderIds: string[]): string {
  let result = text;
  for (const id of senderIds) result = result.split(id).join("[customer-id]");
  return result
    .replace(/\b(?:https?:\/\/|postgres(?:ql)?:\/\/|www\.)[^\s<>]+/gi, "[url]")
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|EAA)[A-Za-z0-9_-]{10,})/g, "[secret]")
    .replace(/\b(?:password|secret|access_token|api[_-]?key)\s*[:=]\s*\S+/gi, "[secret]")
    .replace(/(?<!\d)(?:\+?976[\s-]?)?[689]\d{3}[\s-]?\d{4}(?!\d)/g, "[phone]");
}

export async function collectBaseline(db: BaselineReader, options: BaselineOptions, now = new Date()) {
  // Validate even programmatic callers before issuing SQL.
  parseBaselineOptions(["--days", String(options.days), "--limit", String(options.limit)]);
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid export time.");
  const end = now.toISOString();
  const start = new Date(now.getTime() - options.days * 86_400_000).toISOString();
  const salt = randomBytes(32);
  let begun = false;
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    begun = true;
    await db.query("SET LOCAL statement_timeout = '20s'");
    await db.query("SET LOCAL idle_in_transaction_session_timeout = '30s'");
    const selected = await db.query(`
      SELECT sender_id, platform, COUNT(*) AS message_count,
             SUM(octet_length(text)) AS text_bytes,
             COUNT(*) OVER () AS eligible_conversations,
             SUM(COUNT(*)) OVER () AS eligible_messages
      FROM public.travel_conversations WHERE ${WINDOW}
      GROUP BY sender_id, platform
      ORDER BY md5($3 || json_build_array(platform, sender_id)::text), platform, sender_id
      LIMIT $4`, [start, end, salt.toString("hex"), options.limit]);
    const keys = selected.rows.map(row => {
      if (typeof row.sender_id !== "string" || !row.sender_id || typeof row.platform !== "string") throw new Error("Invalid conversation key.");
      return { sender_id: row.sender_id, platform: row.platform };
    });
    const expectedRows = selected.rows.reduce((n, row) => n + count(row.message_count), 0);
    if (expectedRows > MAX_ROWS) throw new Error("Sample exceeds row safety bound; reduce days or limit.");
    if (selected.rows.reduce((n, row) => n + count(row.text_bytes), 0) > MAX_BYTES) throw new Error("Sample exceeds size safety bound; reduce days or limit.");
    const messages = keys.length ? await db.query(`
      SELECT c.sender_id, c.platform, c.role, c.text, c.created_at
      FROM public.travel_conversations c
      JOIN jsonb_to_recordset($3::jsonb) AS k(sender_id text, platform text)
        ON c.sender_id = k.sender_id AND c.platform = k.platform
      WHERE ${WINDOW}
      ORDER BY c.created_at ASC, c.id ASC`, [start, end, JSON.stringify(keys)]) : { rows: [] };
    if (messages.rows.length !== expectedRows) throw new Error("Sample row count mismatch.");
    const conversations = keys.map(key => ({
      id: createHmac("sha256", salt).update(JSON.stringify([key.platform, key.sender_id])).digest("hex"),
      messages: [] as { role: "user" | "assistant"; text: string; at: string }[],
    }));
    const byKey = new Map(keys.map((key, i) => [JSON.stringify([key.platform, key.sender_id]), conversations[i]]));
    const senderIds = [...new Set(keys.map(key => key.sender_id))];
    let userMessages = 0;
    let assistantMessages = 0;
    let emptyTextMessages = 0;
    let bytes = 0;
    for (const row of messages.rows) {
      const conversation = byKey.get(JSON.stringify([row.platform, row.sender_id]));
      const at = row.created_at instanceof Date ? row.created_at : new Date(String(row.created_at));
      if (!conversation || (row.role !== "user" && row.role !== "assistant") || typeof row.text !== "string" || !Number.isFinite(at.getTime())) throw new Error("Invalid message row.");
      bytes += Buffer.byteLength(row.text, "utf8");
      if (bytes > MAX_BYTES) throw new Error("Sample exceeds size safety bound; reduce days or limit.");
      if (row.role === "user") userMessages++; else assistantMessages++;
      if (!row.text.trim()) emptyTextMessages++;
      conversation.messages.push({ role: row.role, text: redactBaselineText(row.text, senderIds), at: at.toISOString() });
    }
    const summary = {
      eligibleConversations: selected.rows.length ? count(selected.rows[0].eligible_conversations) : 0,
      eligibleMessages: selected.rows.length ? count(selected.rows[0].eligible_messages) : 0,
      sampledConversations: conversations.length, sampledMessages: messages.rows.length,
      userMessages, assistantMessages, emptyTextMessages,
    };
    await db.query("ROLLBACK");
    begun = false;
    return { version: 1, window: { start, end, days: options.days }, limit: options.limit,
      sampling: "Random conversation sample; all stored user/assistant rows within the window; no outcome filter.",
      reviewStatus: "unreviewed; counts are not accuracy or confirmed delivery", summary, conversations };
  } finally {
    salt.fill(0);
    if (begun) await db.query("ROLLBACK");
  }
}

export async function writePrivateBaseline(root: string, artifact: unknown): Promise<string> {
  const content = JSON.stringify(artifact, null, 2) + "\n";
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) throw new Error("Artifact exceeds size safety bound.");
  const base = await realpath(root);
  const tmp = join(base, "tmp");
  // Refuse a redirected scratch directory before writing customer content.
  try {
    const stats = await lstat(tmp);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Unsafe scratch directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(tmp, { mode: 0o700 });
  }
  if (resolve(await realpath(tmp)) !== resolve(tmp)) throw new Error("Unsafe scratch directory.");
  const relativePath = `tmp/chatbot-baseline-${randomUUID()}.json`;
  execFileSync("git", ["check-ignore", "--quiet", "--", relativePath], { cwd: base, stdio: "ignore" });
  const destination = join(base, relativePath);
  const file = await open(destination, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.close();
  } catch (error) {
    await file.close().catch(() => {});
    await unlink(destination);
    throw error;
  }
  return relativePath;
}
