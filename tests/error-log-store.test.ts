import assert from "node:assert/strict";
import test from "node:test";
import { applyTestEnv } from "./helpers/env";
import { shouldPersistLog } from "../src/lib/observability";

async function loadStore() {
  applyTestEnv();
  return import("../src/lib/errorLogStore");
}

test("errors and warnings are persisted, ordinary info and debug logs are not", () => {
  assert.equal(shouldPersistLog("error", "openai.fallback_failed"), true);
  assert.equal(shouldPersistLog("warn", "webhook.ai_fallback_reply"), true);
  assert.equal(shouldPersistLog("info", "webhook.received"), false);
  assert.equal(shouldPersistLog("info", "request.finish"), false);
  assert.equal(shouldPersistLog("debug", "anything"), false);
});

test("info events that explain a silent bot are persisted", () => {
  assert.equal(shouldPersistLog("info", "webhook.operator_echo_pause"), true);
  assert.equal(shouldPersistLog("info", "webhook.ai_refer"), true);
  assert.equal(shouldPersistLog("info", "webhook.ai_wrong_trip_reply_suppressed"), true);
});

test("the database layer's own errors are never persisted (would loop)", () => {
  assert.equal(shouldPersistLog("error", "neon.query_retry"), false);
  assert.equal(shouldPersistLog("error", "neon.pool.error"), false);
  assert.equal(shouldPersistLog("warn", "error_log_store.write_failed"), false);
  assert.equal(shouldPersistLog("error", ""), false);
  assert.equal(shouldPersistLog("error", undefined), false);
});

test("prepareLogRow lifts the envelope fields and keeps the rest as JSON", async () => {
  const { prepareLogRow } = await loadStore();
  const row = prepareLogRow({
    ts: "2026-09-20T10:00:00.000Z",
    level: "warn",
    service: "uudam-travel-chat-bot",
    event: "webhook.ai_fallback_reply",
    requestId: "req-1",
    correlationId: "corr-1",
    senderHash: "abc123",
    message: "OpenAI request failed",
    platform: "facebook",
    openaiFallbackUsed: false,
  });
  assert.ok(row);
  assert.equal(row.level, "warn");
  assert.equal(row.event, "webhook.ai_fallback_reply");
  assert.equal(row.message, "OpenAI request failed");
  assert.equal(row.requestId, "req-1");
  assert.equal(row.correlationId, "corr-1");
  assert.equal(row.senderHash, "abc123");
  assert.deepEqual(JSON.parse(row.fields), { platform: "facebook", openaiFallbackUsed: false });
});

test("prepareLogRow falls back to customerHash and returns null for non-persistable logs", async () => {
  const { prepareLogRow } = await loadStore();
  const echo = prepareLogRow({
    level: "info",
    event: "webhook.operator_echo_pause",
    customerHash: "cust-hash",
    appId: 263902037430900,
  });
  assert.equal(echo?.senderHash, "cust-hash");
  assert.deepEqual(JSON.parse(echo!.fields), { appId: 263902037430900 });

  assert.equal(prepareLogRow({ level: "info", event: "webhook.received" }), null);
});

test("credentials that leak into error text are scrubbed before storage", async () => {
  const { prepareLogRow, scrubSecrets } = await loadStore();
  assert.equal(
    scrubSecrets("GET https://graph.facebook.com/v19.0/me?access_token=EAABsecretTOKEN123&x=1"),
    "GET https://graph.facebook.com/v19.0/me?access_token=[redacted]&x=1",
  );
  assert.equal(scrubSecrets("Authorization: Bearer abcdef1234567890"), "Authorization: Bearer [redacted]");
  assert.equal(scrubSecrets("key sk-proj-abcdef1234567890 end"), "key [redacted] end");

  const row = prepareLogRow({
    level: "error",
    event: "meta.send_failed",
    message: "failed: https://graph.facebook.com/me/messages?access_token=EAABsecretTOKEN123",
    url: "https://graph.facebook.com/me/messages?access_token=EAABsecretTOKEN123",
  });
  assert.ok(row);
  assert.doesNotMatch(row.message, /EAABsecretTOKEN123/);
  assert.doesNotMatch(row.fields, /EAABsecretTOKEN123/);
});

test("text Postgres would reject is cleaned so the row is not silently lost", async () => {
  const { sanitizeForPostgres, prepareLogRow } = await loadStore();
  // NUL characters (text) and unpaired surrogates (text + jsonb) make INSERT fail.
  assert.equal(sanitizeForPostgres("a\u0000b"), "ab");
  assert.equal(sanitizeForPostgres("ok \ud83d broken"), "ok  broken");
  assert.equal(sanitizeForPostgres("ok \ude00 broken"), "ok  broken");
  // A valid surrogate pair (a real emoji) must survive untouched.
  assert.equal(sanitizeForPostgres("hi 🙏 there"), "hi 🙏 there");
  // Mongolian text is untouched.
  assert.equal(sanitizeForPostgres("Сайн байна уу"), "Сайн байна уу");

  // JSON.stringify escapes a lone surrogate / NUL as text — jsonb rejects those.
  const row = prepareLogRow({
    level: "warn",
    event: "reply.garbled",
    message: "bad\u0000text",
    sample: "x\u0000y \ud83d z",
  });
  assert.ok(row);
  assert.equal(row.message, "badtext");
  assert.doesNotMatch(row.fields, /\\u0000/);
  assert.doesNotMatch(row.fields, /\\ud83d/i);
  assert.doesNotThrow(() => JSON.parse(row.fields));
});

test("oversized messages and field blobs are bounded", async () => {
  const { prepareLogRow } = await loadStore();
  const row = prepareLogRow({
    level: "error",
    event: "x.failed",
    message: "m".repeat(5000),
    blob: "b".repeat(50_000),
  });
  assert.ok(row);
  assert.equal(row.message.length, 1000);
  assert.ok(row.fields.length < 9000, "fields must stay bounded");
  assert.equal(JSON.parse(row.fields).truncated, true);
});

test("persisting with no database configured is a silent no-op", async () => {
  const { persistLogRecord, pruneErrorLogs, listErrorLogs, summarizeErrorLogs } = await loadStore();
  assert.doesNotThrow(() => persistLogRecord({ level: "error", event: "x.failed", message: "boom" }));
  assert.deepEqual(await pruneErrorLogs(), { expired: 0, overflow: 0 });
  assert.deepEqual(await listErrorLogs(), []);
  assert.deepEqual(await summarizeErrorLogs(), []);
});

test("retention is a week, so old problems can never pile up", async () => {
  const { ERROR_LOG_RETENTION_DAYS, ERROR_LOG_MAX_ROWS } = await loadStore();
  assert.equal(ERROR_LOG_RETENTION_DAYS, 7);
  assert.ok(ERROR_LOG_MAX_ROWS > 0 && ERROR_LOG_MAX_ROWS <= 50_000);
});
