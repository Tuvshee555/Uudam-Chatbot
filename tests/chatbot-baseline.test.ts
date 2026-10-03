import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectBaseline, MAX_BYTES, MAX_ROWS, parseBaselineOptions, redactBaselineText, writePrivateBaseline, type BaselineReader } from "../scripts/lib/chatbotBaseline";

const now = new Date("2026-10-03T12:00:00Z");
function fakeDb(selected: Record<string, unknown>[] = [
  { sender_id: "customer-123", platform: "facebook", message_count: "3", text_bytes: "200", eligible_conversations: "9", eligible_messages: "30" },
], messages: Record<string, unknown>[] = [
  { sender_id: "customer-123", platform: "facebook", role: "user", text: "Question customer-123", created_at: "2026-10-02T10:00:00Z" },
  { sender_id: "customer-123", platform: "facebook", role: "assistant", text: "Ordinary answer", created_at: "2026-10-02T10:01:00Z" },
  { sender_id: "customer-123", platform: "facebook", role: "user", text: "", created_at: "2026-10-02T10:02:00Z", attachments: [{ url: "private-attachment" }] },
]) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const db: BaselineReader = { async query(sql, values) {
    calls.push({ sql, values });
    return { rows: sql.includes("COUNT(*) AS message_count") ? selected : sql.includes("SELECT c.sender_id") ? messages : [] };
  } };
  return { db, calls };
}

test("defaults and strictly bounded arguments", () => {
  assert.deepEqual(parseBaselineOptions([]), { days: 7, limit: 100 });
  assert.deepEqual(parseBaselineOptions(["--limit", "500", "--days", "30"]), { days: 30, limit: 500 });
  for (const args of [["--days"], ["--days", "0"], ["--days", "31"], ["--limit", "501"], ["--limit", "1e2"], ["--days", "7.5"], ["--days", "NaN"], ["--days", "Infinity"], ["--days", "-1"], ["--days", " 7"], ["--days", "07"], ["--days", "7;DELETE"], ["--out", "x"], ["--days", "7", "--days", "8"]]) assert.throws(() => parseBaselineOptions(args));
});

test("read-only snapshot, bounded conversation sampling, whole chronological window and counts", async () => {
  const { db, calls } = fakeDb();
  const result = await collectBaseline(db, { days: 7, limit: 100 }, now);
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-1)?.sql, "ROLLBACK");
  assert.deepEqual(calls[3].values?.slice(0, 2), ["2026-09-26T12:00:00.000Z", now.toISOString()]);
  assert.match(calls[3].sql, /GROUP BY sender_id, platform/);
  assert.match(calls[3].sql, /ORDER BY md5/);
  assert.match(calls[4].sql, /ORDER BY c.created_at ASC, c.id ASC/);
  assert.doesNotMatch(calls[4].sql, /LIMIT|attachments|SELECT \*/i);
  assert.doesNotMatch(calls.map(c => c.sql).join("\n"), /\b(?:INSERT|UPDATE|DELETE|CREATE|ALTER|error_logs)\b/i);
  assert.deepEqual(result.summary, { eligibleConversations: 9, eligibleMessages: 30, sampledConversations: 1, sampledMessages: 3, userMessages: 2, assistantMessages: 1, emptyTextMessages: 1 });
  assert.deepEqual(result.conversations[0].messages.map(m => m.role), ["user", "assistant", "user"]);
  assert.doesNotMatch(JSON.stringify(result), /customer-123|private-attachment|sender_id|attachments/);
  assert.equal(result.conversations[0].messages[1].text, "Ordinary answer");
});

test("pseudonyms change each run and distinguish stored platform keys", async () => {
  const a = await collectBaseline(fakeDb().db, { days: 7, limit: 100 }, now);
  const b = await collectBaseline(fakeDb().db, { days: 7, limit: 100 }, now);
  assert.notEqual(a.conversations[0].id, b.conversations[0].id);
  assert.match(a.conversations[0].id, /^[0-9a-f]{64}$/);
  const selected = ["facebook", "instagram"].map(platform => ({ sender_id: "same", platform, message_count: 0, text_bytes: 0, eligible_conversations: 2, eligible_messages: 0 }));
  const c = await collectBaseline(fakeDb(selected, []).db, { days: 7, limit: 100 }, now);
  assert.notEqual(c.conversations[0].id, c.conversations[1].id);
});

test("empty database window produces explicit zero counts", async () => {
  const { db, calls } = fakeDb([], []);
  const result = await collectBaseline(db, { days: 7, limit: 100 }, now);
  assert.equal(result.summary.sampledMessages, 0);
  assert.equal(result.summary.eligibleConversations, 0);
  assert.equal(calls.length, 5);
});

test("invalid inputs do not query DB", async () => {
  const { db, calls } = fakeDb();
  await assert.rejects(collectBaseline(db, { days: 31, limit: 1 }, now));
  await assert.rejects(collectBaseline(db, { days: 7, limit: 1 }, new Date("bad")));
  assert.equal(calls.length, 0);
});

test("row and byte bounds abort before fetching, without partial samples", async () => {
  for (const override of [{ message_count: MAX_ROWS + 1 }, { text_bytes: MAX_BYTES + 1 }]) {
    const { db, calls } = fakeDb([{ sender_id: "x", platform: "facebook", message_count: 1, text_bytes: 1, eligible_conversations: 1, eligible_messages: 1, ...override }]);
    await assert.rejects(collectBaseline(db, { days: 7, limit: 1 }, now), /safety bound/);
    assert.equal(calls.at(-1)?.sql, "ROLLBACK");
    assert.equal(calls.some(c => c.sql.includes("SELECT c.sender_id")), false);
  }
});

test("DB failure rolls back; malformed/mismatched rows fail closed", async () => {
  const { db, calls } = fakeDb();
  const query = db.query.bind(db);
  db.query = async (sql, values) => { if (sql.includes("SELECT c.sender_id")) throw new Error("private DB details"); return query(sql, values); };
  await assert.rejects(collectBaseline(db, { days: 7, limit: 1 }, now));
  assert.equal(calls.at(-1)?.sql, "ROLLBACK");
  await assert.rejects(collectBaseline(fakeDb(undefined, []).db, { days: 7, limit: 1 }, now), /count mismatch/);
  const invalid = fakeDb(undefined, Array.from({ length: 3 }, () => ({ role: "system" })));
  await assert.rejects(collectBaseline(invalid.db, { days: 7, limit: 1 }, now), /Invalid message/);
});

test("text scrubs known IDs, links, contact and common credentials", () => {
  const text = "customer-123 9911-2233 a@example.com https://host/private?access_token=secret postgres://u:p@host/db Bearer abc123 sk-abcdefghijklmnop password=hidden price 1,500,000";
  const scrubbed = redactBaselineText(text, ["customer-123"]);
  assert.doesNotMatch(scrubbed, /customer-123|9911|example.com|https:|postgres:|abc123|abcdefghijklmnop|hidden/);
  assert.match(scrubbed, /price 1,500,000/);
});

test("artifact is exclusively created under ignored tmp; redirected/nonignored tmp refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-test-"));
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    await assert.rejects(writePrivateBaseline(root, { private: "fixture" }));
    await writeFile(join(root, ".gitignore"), "tmp/\n");
    const path = await writePrivateBaseline(root, { private: "fixture" });
    assert.match(path, /^tmp\/chatbot-baseline-[0-9a-f-]+\.json$/);
    assert.deepEqual(JSON.parse(await readFile(join(root, path), "utf8")), { private: "fixture" });
    await assert.rejects(writePrivateBaseline(root, "x".repeat(MAX_BYTES)), /size safety bound/);
    await rm(join(root, "tmp"), { recursive: true });
    await mkdir(join(root, "redirect"));
    await symlink(join(root, "redirect"), join(root, "tmp"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(writePrivateBaseline(root, {}), /Unsafe scratch/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CLI rejects inputs without exposing raw arguments, secrets, or customer text", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/export-chatbot-baseline.ts", "--days", "private-secret"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.doesNotMatch(result.stderr, /private-secret|Error:|at main/);
  assert.match(result.stderr, /Baseline export failed/);
});
