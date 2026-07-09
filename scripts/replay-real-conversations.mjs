#!/usr/bin/env node
/**
 * Real-conversation replay QA — pulls actual customer chat histories from
 * Neon (travel_conversations) and replays each customer's real user turns,
 * in order, against a running local /api/demo endpoint. Lets you eyeball
 * how the CURRENT bot code would answer the SAME real questions people
 * actually asked, side by side with what it answered for real at the time.
 *
 * Photo/document turns cannot be replayed (demo is text-only; passport/
 * payment-receipt classification is a webhook-only vision path) — those
 * turns are printed with the real attachment URLs + what the real bot did,
 * so you can open the photos yourself and judge the real reply quality.
 *
 * Usage:
 *   npm run dev                              # in one terminal
 *   node scripts/replay-real-conversations.mjs   # in another
 *
 * Config via env:
 *   DEMO_URL    full demo endpoint (default http://localhost:3004/api/demo)
 *   SENDER_ID   replay only this one sender_id
 *   LIMIT       max number of senders to replay (default: all real senders)
 */

import { Client } from "pg";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local the same crude way the rest of the scratch tooling does —
// no extra dependency, just NEON_DATABASE_URL.
function loadEnvLocal() {
  const path = join(__dirname, "..", ".env.local");
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
loadEnvLocal();

const DEMO_URL = process.env.DEMO_URL || "http://localhost:3004/api/demo";
const SENDER_FILTER = process.env.SENDER_ID || null;
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;

function makeConversationId(senderId) {
  return `replay-${senderId}-${Date.now()}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80).padEnd(16, "0");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function ask(text, conversationId) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(DEMO_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, conversationId }),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const waitMs = body?.reset ? Math.max(1000, body.reset - Date.now()) : 10_000;
      console.log(`     (rate limited — waiting ${Math.round(waitMs / 1000)}s)`);
      await sleep(waitMs);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    return typeof json.reply === "string" ? json.reply : JSON.stringify(json);
  }
  throw new Error("gave up after repeated 429 rate limiting");
}

const RED_FLAGS = [
  { pattern: /\bREFER\b/, label: "raw REFER token leaked" },
  { pattern: /\bSILENT\b/, label: "raw SILENT token leaked" },
  { pattern: /NEEDS_MANUAL_FIX/, label: "NEEDS_MANUAL_FIX sentinel leaked" },
  { pattern: /[ÃÂÐÑÒÓÔÕÖØÝÞ]|Ã°Å¸|ðŸ/, label: "mojibake leaked (broken emoji/encoding)" },
  { pattern: /\b(JSON|database|source_description|record)\b/i, label: "internal field/word leaked" },
  { pattern: /хүний нөөцийн менежер/i, label: "wrong staff title (HR, not travel consultant)" },
];

function checkRedFlags(reply) {
  return RED_FLAGS.filter((f) => f.pattern.test(reply)).map((f) => f.label);
}

function preview(text, n = 200) {
  return (text || "").replace(/\n/g, " ⏎ ").slice(0, n);
}

async function fetchRealSenders(client, limit) {
  const result = await client.query(
    `SELECT DISTINCT sender_id, MAX(created_at) AS last_seen, COUNT(*) AS n
     FROM travel_conversations
     WHERE sender_id ~ '^[0-9]+$'
     GROUP BY sender_id
     ORDER BY last_seen DESC
     LIMIT $1`,
    [limit === Infinity ? 1000 : limit],
  );
  return result.rows.map((r) => r.sender_id);
}

async function fetchSenderHistory(client, senderId) {
  const result = await client.query(
    `SELECT role, text, attachments, created_at
     FROM travel_conversations
     WHERE sender_id = $1
     ORDER BY id ASC`,
    [senderId],
  );
  return result.rows;
}

async function main() {
  if (!process.env.NEON_DATABASE_URL) {
    console.error("NEON_DATABASE_URL not set (checked process.env and .env.local)");
    process.exit(1);
  }

  const client = new Client({
    connectionString: process.env.NEON_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  const senderIds = SENDER_FILTER ? [SENDER_FILTER] : await fetchRealSenders(client, LIMIT);
  console.log(`Real-conversation replay → ${DEMO_URL}`);
  console.log(`${senderIds.length} real sender(s) to replay.\n`);

  let totalTurns = 0;
  let totalFlags = 0;
  let totalPhotoTurns = 0;

  for (const senderId of senderIds) {
    const rows = await fetchSenderHistory(client, senderId);
    const conversationId = makeConversationId(senderId);
    console.log(`\n${"═".repeat(70)}`);
    console.log(`SENDER ${senderId}  (${rows.length} real messages, replay id ${conversationId})`);
    console.log("═".repeat(70));

    for (const row of rows) {
      if (row.role !== "user") continue; // bot replies come from our own replay, not the real log
      const attachments = Array.isArray(row.attachments) ? row.attachments : [];
      const hasText = row.text && row.text.trim() && row.text.trim() !== "[Хэрэглэгч зураг илгээсэн]";

      if (attachments.length > 0) {
        totalPhotoTurns += 1;
        console.log(`\n  📷 REAL customer sent ${attachments.length} attachment(s) — cannot replay (vision/OCR is webhook-only):`);
        for (const a of attachments) {
          console.log(`     - ${a.type}: ${a.url}`);
        }
        if (!hasText) {
          console.log(`     (no text alongside the photo — open the URLs above to review manually)`);
          continue;
        }
      }

      if (!hasText) continue;

      totalTurns += 1;
      await sleep(600); // pace requests so we don't trip the demo endpoint's own rate limiter
      try {
        const reply = await ask(row.text, conversationId);
        const flags = checkRedFlags(reply);
        if (flags.length) totalFlags += flags.length;
        const marker = flags.length ? "✖" : "✓";
        console.log(`\n  ${marker} USER (real, ${row.created_at.toISOString().slice(0, 16)}): "${preview(row.text, 120)}"`);
        console.log(`     BOT (replayed now): ${preview(reply)}`);
        if (flags.length) console.log(`     RED FLAGS: ${flags.join("; ")}`);
      } catch (error) {
        totalFlags += 1;
        console.log(`\n  ✖ USER (real): "${preview(row.text, 120)}"`);
        console.log(`     BOT request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  console.log(`\n${"─".repeat(70)}`);
  console.log(`${senderIds.length} senders, ${totalTurns} text turns replayed, ${totalPhotoTurns} photo turns (manual review), ${totalFlags} red flags.`);
  console.log("Manual review still required for accuracy (right trip, right price, tone).");

  await client.end();
  process.exit(totalFlags > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
