#!/usr/bin/env node
/**
 * One-time (or re-runnable) backfill for the "Mimic Myself" tone-sample pool.
 *
 * Pulls real past Messenger conversations from Meta's Conversations API for
 * every configured page, keeps only messages actually TYPED BY THE ADMIN
 * (excludes the bot's own past replies by cross-checking travel_conversations,
 * and excludes attachment-only/empty messages), redacts anything that looks
 * like a customer phone number, and inserts the result into
 * travel_admin_messages via the same dbAppendAdminMessage() path the live
 * webhook uses — so redaction and the 300-row cap are applied identically.
 *
 * Bounded on purpose: scans at most MAX_CONVERSATIONS most-recently-active
 * conversations and MAX_MESSAGES_PER_CONVERSATION messages each, and stops
 * early once MAX_SAMPLES_TO_COLLECT human-authored messages are found — this
 * is a tone-reference sample pool, not an archive, and the target table
 * already caps at 300 rows.
 *
 * Usage: node --import tsx scripts/backfill-admin-tone-samples.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

// Loads .env.local/.env into process.env BEFORE the dynamic imports in
// main() run. Deliberately not a static top-level import of env.ts/travelDb
// — those get evaluated (and call getEnv(), which throws if unset) before
// any of this file's own statements run, so env vars set here would be too
// late. A shell `source .env.local` was tried first and turned out to be
// unreliable — the Neon connection string contains an unescaped `&`
// (`...&channel_binding=require`), which bash's `source` sometimes parses
// as a background-job operator and silently drops the rest of the value.
// Parsing the file in-process sidesteps that entirely.
function loadEnvFile(path: string) {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) continue;
    const key = trimmed.slice(0, eqIndex).trim();
    if (!key || process.env[key] != null) continue;
    let value = trimmed.slice(eqIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
loadEnvFile(resolve(process.cwd(), ".env.local"));
loadEnvFile(resolve(process.cwd(), ".env"));

const GRAPH_VERSION = "v19.0";
const MAX_CONVERSATIONS = 60;
const MAX_MESSAGES_PER_CONVERSATION = 40;
const MAX_SAMPLES_TO_COLLECT = 250;
const MIN_TEXT_LENGTH = 8;
const BOT_ECHO_TIME_WINDOW_MS = 10_000;
const REQUEST_DELAY_MS = 150;

// The Conversations API surfaces Meta's OWN system/template text alongside
// real page-sent messages — ad-click and comment-reply context strings, and
// Meta's default ad-opener greeting. None of these were typed by the admin;
// they must never enter the tone-sample pool. Matched loosely since these
// are fixed English template fragments, easy to tell apart from her
// Mongolian writing.
const META_BOILERPLATE_RE =
  /(https?:\/\/|responding to a user comment|replied to an ad\.?$|please let us know how we can help you|replied to your automated|Messaging settings)/i;
const HAS_CYRILLIC_RE = /[А-Яа-яЁёӨөҮү]/;

function isLikelyMetaBoilerplate(text: string): boolean {
  if (META_BOILERPLATE_RE.test(text)) return true;
  // Every phrase caught above is a known fixed template — but Meta adds new
  // ones. Her real writing is consistently Cyrillic; a message of any real
  // length with zero Cyrillic characters is almost certainly another Meta
  // system string, not something she typed, even if this exact wording
  // hasn't been seen before.
  if (text.length > 20 && !HAS_CYRILLIC_RE.test(text)) return true;
  return false;
}

type GraphMessage = {
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
};

type GraphConversation = {
  id: string;
  participants?: { data?: Array<{ id?: string; name?: string }> };
  messages?: { data?: GraphMessage[]; paging?: { next?: string } };
};

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function graphGet<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`Graph API error ${res.status}: ${body.slice(0, 300)}`);
    return null;
  }
  return (await res.json()) as T;
}

async function main() {
  const { getEnv } = await import("../src/lib/env");
  const { dbGetHistory, dbAppendAdminMessage, dbGetRecentAdminMessages } = await import(
    "../src/lib/travelDb"
  );
  const rowCountBefore = (await dbGetRecentAdminMessages(50)).length;

  const env = getEnv();
  if (env.facebookPages.length === 0) {
    console.error("No FACEBOOK_PAGES configured — nothing to backfill.");
    return;
  }

  let totalScanned = 0;
  let totalBotEchoesSkipped = 0;
  let totalBoilerplateSkipped = 0;
  let totalCollected = 0;
  const seenInThisRun = new Set<string>();
  // Cache of assistant-reply rows already fetched per customer, so we don't
  // re-query the same conversation's bot history twice.
  const assistantCache = new Map<string, Array<{ text: string; created_at: string }>>();

  for (const page of env.facebookPages) {
    if (totalCollected >= MAX_SAMPLES_TO_COLLECT) break;
    console.log(`\n=== Page ${page.pageId} ===`);

    let url =
      `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(page.pageId)}/conversations` +
      `?fields=${encodeURIComponent(`participants,messages.limit(${MAX_MESSAGES_PER_CONVERSATION}){message,from,created_time}`)}` +
      `&limit=25&access_token=${encodeURIComponent(page.token)}`;

    let conversationsScanned = 0;
    while (url && conversationsScanned < MAX_CONVERSATIONS && totalCollected < MAX_SAMPLES_TO_COLLECT) {
      const page_ = await graphGet<{ data: GraphConversation[]; paging?: { next?: string } }>(url);
      if (!page_) break;

      for (const conv of page_.data || []) {
        if (conversationsScanned >= MAX_CONVERSATIONS || totalCollected >= MAX_SAMPLES_TO_COLLECT) break;
        conversationsScanned++;

        const customer = (conv.participants?.data || []).find((p) => p.id !== page.pageId);
        const customerId = customer?.id;
        if (!customerId) continue;

        if (!assistantCache.has(customerId)) {
          const history = await dbGetHistory(customerId);
          assistantCache.set(
            customerId,
            history
              .filter((row) => row.role === "assistant")
              .map((row) => ({ text: row.text.trim().toLowerCase(), created_at: row.created_at })),
          );
        }
        const assistantRows = assistantCache.get(customerId) || [];

        for (const msg of conv.messages?.data || []) {
          totalScanned++;
          if (msg.from?.id !== page.pageId) continue; // customer's own message, not admin's
          const text = (msg.message || "").trim();
          if (text.length < MIN_TEXT_LENGTH) continue;
          if (isLikelyMetaBoilerplate(text)) {
            totalBoilerplateSkipped++;
            continue;
          }

          const normalized = text.toLowerCase();
          const msgTimeMs = msg.created_time ? new Date(msg.created_time).getTime() : NaN;
          const isBotEcho = assistantRows.some((row) => {
            if (row.text === normalized) return true;
            if (!Number.isNaN(msgTimeMs)) {
              const rowTimeMs = new Date(row.created_at).getTime();
              if (Math.abs(rowTimeMs - msgTimeMs) <= BOT_ECHO_TIME_WINDOW_MS) return true;
            }
            return false;
          });
          if (isBotEcho) {
            totalBotEchoesSkipped++;
            continue;
          }
          if (seenInThisRun.has(normalized)) continue;
          seenInThisRun.add(normalized);

          await dbAppendAdminMessage(customerId, text);
          totalCollected++;
          if (totalCollected >= MAX_SAMPLES_TO_COLLECT) break;
        }
      }

      url = page_.paging?.next || "";
      if (url) await wait(REQUEST_DELAY_MS);
    }
  }

  // Don't trust the increment counter alone — it fires even when the DB
  // write silently no-ops (e.g. a broken connection string). Read the table
  // back to confirm rows actually landed.
  const rowCountAfter = (await dbGetRecentAdminMessages(50)).length;

  console.log("\n=== Backfill summary ===");
  console.log(`Messages scanned:          ${totalScanned}`);
  console.log(`Bot echoes excluded:       ${totalBotEchoesSkipped}`);
  console.log(`Meta boilerplate excluded: ${totalBoilerplateSkipped}`);
  console.log(`Human samples attempted:   ${totalCollected}`);
  console.log(`Row count before:          ${rowCountBefore}`);
  console.log(`Row count after (capped at 50 by the read limit): ${rowCountAfter}`);
  if (totalCollected > 0 && rowCountAfter === rowCountBefore) {
    console.error(
      "WARNING: rows were 'collected' but the table's row count did not change — writes likely failed silently (check DB connectivity).",
    );
  }
}

main().catch((error) => {
  console.error("Backfill failed:", error);
  process.exit(1);
});
