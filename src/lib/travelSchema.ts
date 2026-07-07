/**
 * Travel database schema bootstrap.
 *
 * Extracted from travelDb.ts (which was over the 2,000-line cap). This is the
 * one-time, idempotent DDL that creates/migrates every travel_* table. It is a
 * self-contained leaf: it depends only on the Neon client, the logger, and env
 * (for per-page seeding) — no other travelDb function. Callers await
 * `ensureTravelSchema()` before their first query; the result is cached.
 */

import { getEnv } from "./env";
import { logError } from "./observability";
import { withNeonClient } from "./neonDb";

const env = getEnv();

let schemaEnsured = false;
let schemaPromise: Promise<boolean> | null = null;

export async function ensureTravelSchema() {
  if (schemaEnsured) return true;
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const created = await withNeonClient(async (client) => {
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_trip_entries (
          id TEXT PRIMARY KEY,
          category TEXT NOT NULL DEFAULT '',
          operator_name TEXT NOT NULL,
          route_name TEXT NOT NULL,
          duration_text TEXT NOT NULL DEFAULT '',
          adult_price INTEGER NULL,
          child_price INTEGER NULL,
          currency TEXT NOT NULL DEFAULT 'MNT',
          departure_dates TEXT[] NOT NULL DEFAULT '{}',
          seats_total INTEGER NULL,
          seats_left INTEGER NULL,
          has_food BOOLEAN NULL,
          status TEXT NOT NULL DEFAULT 'active',
          notes TEXT NOT NULL DEFAULT '',
          hotel TEXT NOT NULL DEFAULT '',
          source_description TEXT NOT NULL DEFAULT '',
          extra JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_trip_entries_operator
          ON travel_trip_entries (operator_name);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_trip_entries_route
          ON travel_trip_entries (route_name);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_trip_entries_status
          ON travel_trip_entries (status);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_bot_control (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          bot_paused BOOLEAN NOT NULL DEFAULT FALSE,
          pause_reason TEXT NULL,
          photo_only BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE travel_bot_control ADD COLUMN IF NOT EXISTS photo_only BOOLEAN NOT NULL DEFAULT FALSE;
      `);
      await client.query(`
        INSERT INTO travel_bot_control (id, bot_paused, pause_reason, photo_only)
        VALUES (TRUE, FALSE, NULL, FALSE)
        ON CONFLICT (id) DO NOTHING;
      `);
      // Per-page pause control. One row per Facebook page so the client can pause
      // one page (e.g. the main agency page) without silencing another (the AI page).
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_page_control (
          page_id TEXT PRIMARY KEY,
          bot_paused BOOLEAN NOT NULL DEFAULT FALSE,
          pause_reason TEXT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      // Seed a row for every configured page (idempotent).
      for (const page of env.facebookPages) {
        await client.query(
          `
            INSERT INTO travel_page_control (page_id, bot_paused, pause_reason)
            VALUES ($1, FALSE, NULL)
            ON CONFLICT (page_id) DO NOTHING;
          `,
          [page.pageId],
        );
      }
      // One-time backfill: the primary page inherits any active pause from the
      // legacy single-row control so an existing pause isn't silently lost.
      const primaryPageId = env.facebookPages[0]?.pageId;
      if (primaryPageId) {
        await client.query(
          `
            UPDATE travel_page_control AS pc
            SET bot_paused = bc.bot_paused,
                pause_reason = bc.pause_reason,
                updated_at = NOW()
            FROM travel_bot_control AS bc
            WHERE pc.page_id = $1
              AND bc.id = TRUE
              AND bc.bot_paused = TRUE
              AND pc.bot_paused = FALSE;
          `,
          [primaryPageId],
        );
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_ai_change_requests (
          id BIGSERIAL PRIMARY KEY,
          instruction TEXT NOT NULL,
          proposal_json JSONB NOT NULL,
          conflicts TEXT[] NOT NULL DEFAULT '{}',
          needs_confirmation BOOLEAN NOT NULL DEFAULT FALSE,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          applied_at TIMESTAMPTZ NULL
        );
      `);
      await client.query(`
        ALTER TABLE travel_ai_change_requests
          ADD COLUMN IF NOT EXISTS rollback_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          ADD COLUMN IF NOT EXISTS reverted_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_bot_settings (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          business_name TEXT NOT NULL DEFAULT '',
          system_prompt TEXT NOT NULL DEFAULT '',
          quick_info_reply TEXT NOT NULL DEFAULT '',
          quick_info_keywords TEXT[] NOT NULL DEFAULT '{}',
          comment_trigger_patterns TEXT[] NOT NULL DEFAULT '{}',
          comment_public_reply TEXT NOT NULL DEFAULT '',
          comment_dm_reply TEXT NOT NULL DEFAULT '',
          special_offers JSONB NOT NULL DEFAULT '[]'::jsonb,
          discount_policies JSONB NOT NULL DEFAULT '[]'::jsonb,
          verified_credentials JSONB NOT NULL DEFAULT '[]'::jsonb,
          faq JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      // Human-handoff columns — added via ALTER so existing databases migrate.
      await client.query(`
        ALTER TABLE travel_bot_settings
          ADD COLUMN IF NOT EXISTS handoff_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          ADD COLUMN IF NOT EXISTS handoff_keywords TEXT[] NOT NULL DEFAULT '{}'::text[],
          ADD COLUMN IF NOT EXISTS handoff_reply TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS handoff_pause_minutes INTEGER NOT NULL DEFAULT 60;
      `);
      // Quick-reply chat buttons — admin-managed pinned menu buttons.
      await client.query(`
        ALTER TABLE travel_bot_settings
          ADD COLUMN IF NOT EXISTS chat_buttons JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
      // Flow builder rules — keyword-triggered bot replies with optional buttons.
      await client.query(`
        ALTER TABLE travel_bot_settings
          ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;
      `);
      await client.query(`
        INSERT INTO travel_bot_settings (id)
        VALUES (TRUE)
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_leads (
          id BIGSERIAL PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'handoff',
          platform TEXT NOT NULL DEFAULT '',
          sender_id TEXT NOT NULL DEFAULT '',
          customer_message TEXT NOT NULL DEFAULT '',
          contact_phone TEXT NOT NULL DEFAULT '',
          context TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'new',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          seen_at TIMESTAMPTZ NULL
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_leads_status_created
          ON travel_leads (status, created_at DESC);
      `);
      // Migration: add lead_status CRM column (idempotent)
      await client.query(`
        ALTER TABLE travel_leads
          ADD COLUMN IF NOT EXISTS lead_status TEXT NOT NULL DEFAULT 'new_lead';
      `);
      // Migration: add photo_urls to trips (idempotent)
      await client.query(`
        ALTER TABLE travel_trip_entries
          ADD COLUMN IF NOT EXISTS photo_urls JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
      // Migration: add per-trip hotel column (idempotent)
      await client.query(`
        ALTER TABLE travel_trip_entries
          ADD COLUMN IF NOT EXISTS hotel TEXT NOT NULL DEFAULT '';
      `);
      // Inbound customer messages — powers "most asked questions" analytics.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_messages (
          id BIGSERIAL PRIMARY KEY,
          platform TEXT NOT NULL DEFAULT 'facebook',
          sender_id TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL DEFAULT '',
          norm TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS travel_messages_created_idx
          ON travel_messages (created_at DESC);
      `);
      // QPay payments (feature is OFF by default; table is harmless when unused)
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_payments (
          id BIGSERIAL PRIMARY KEY,
          invoice_id TEXT NOT NULL DEFAULT '',
          sender_invoice_no TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT 'facebook',
          sender_id TEXT NOT NULL DEFAULT '',
          customer_name TEXT NOT NULL DEFAULT '',
          trip_name TEXT NOT NULL DEFAULT '',
          amount INTEGER NOT NULL DEFAULT 0,
          currency TEXT NOT NULL DEFAULT 'MNT',
          status TEXT NOT NULL DEFAULT 'pending',
          qr_text TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          paid_at TIMESTAMPTZ NULL
        );
      `);
      // Broadcast feature: track sent broadcasts and opted-in senders
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_broadcasts (
          id BIGSERIAL PRIMARY KEY,
          message TEXT NOT NULL DEFAULT '',
          platform TEXT NOT NULL DEFAULT 'facebook',
          sent_count INTEGER NOT NULL DEFAULT 0,
          failed_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at TIMESTAMPTZ NULL
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_drive_sync_state (
          id BOOLEAN PRIMARY KEY DEFAULT TRUE,
          last_checked_at TIMESTAMPTZ NULL,
          last_synced_at TIMESTAMPTZ NULL,
          last_status TEXT NOT NULL DEFAULT 'idle',
          last_error TEXT NOT NULL DEFAULT '',
          last_summary TEXT NOT NULL DEFAULT '',
          last_run_id TEXT NOT NULL DEFAULT '',
          files_examined INTEGER NOT NULL DEFAULT 0,
          files_changed INTEGER NOT NULL DEFAULT 0,
          files_applied INTEGER NOT NULL DEFAULT 0,
          files_blocked INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        INSERT INTO travel_drive_sync_state (id)
        VALUES (TRUE)
        ON CONFLICT (id) DO NOTHING;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_drive_sync_files (
          file_id TEXT PRIMARY KEY,
          file_name TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT '',
          fingerprint TEXT NOT NULL DEFAULT '',
          modified_time TIMESTAMPTZ NULL,
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_synced_at TIMESTAMPTZ NULL,
          last_status TEXT NOT NULL DEFAULT 'seen',
          last_error TEXT NOT NULL DEFAULT '',
          request_id BIGINT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_drive_sync_files_updated
          ON travel_drive_sync_files (updated_at DESC);
      `);
      // Chat history — replaces Redis conversation store
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_conversations (
          id        BIGSERIAL PRIMARY KEY,
          sender_id TEXT NOT NULL,
          platform  TEXT NOT NULL DEFAULT 'facebook',
          role      TEXT NOT NULL,
          text      TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_conversations_sender
          ON travel_conversations (sender_id, created_at DESC);
      `);
      // Migration: store image attachments with chat history so the admin inbox can render them.
      await client.query(`
        ALTER TABLE travel_conversations
          ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
      `);
      // Customer-sent photos that need staff review: passports/documents,
      // trip screenshots/posters, or uncategorized images. Kept separate from
      // chat history so staff can search by customer without scrolling.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_customer_documents (
          id BIGSERIAL PRIMARY KEY,
          platform TEXT NOT NULL DEFAULT 'facebook',
          sender_id TEXT NOT NULL DEFAULT '',
          page_id TEXT NOT NULL DEFAULT '',
          source_url TEXT NOT NULL DEFAULT '',
          stored_url TEXT NOT NULL DEFAULT '',
          image_sha256 TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT '',
          category TEXT NOT NULL DEFAULT 'other',
          extracted_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          matched_trip_id TEXT NULL,
          status TEXT NOT NULL DEFAULT 'needs_review',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_customer_documents_sender
          ON travel_customer_documents (sender_id, created_at DESC);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_customer_documents_status
          ON travel_customer_documents (status, created_at DESC);
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_customer_documents_hash_sender
          ON travel_customer_documents (sender_id, image_sha256)
          WHERE image_sha256 <> '';
      `);
      await client.query(`
        ALTER TABLE travel_customer_documents
          ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS duplicate_of_id BIGINT NULL,
          ADD COLUMN IF NOT EXISTS matched_payment_id BIGINT NULL,
          ADD COLUMN IF NOT EXISTS auto_action TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS retention_hidden_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_customer_documents_payment
          ON travel_customer_documents (matched_payment_id)
          WHERE matched_payment_id IS NOT NULL;
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_customer_document_audit (
          id BIGSERIAL PRIMARY KEY,
          document_id BIGINT NOT NULL,
          action TEXT NOT NULL DEFAULT '',
          actor TEXT NOT NULL DEFAULT 'system',
          before_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          after_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_customer_document_audit_document
          ON travel_customer_document_audit (document_id, created_at DESC);
      `);
      // Long-term per-customer memory. Chat rows are still kept for recent
      // detail, while this table preserves durable context after pruning.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_customer_memories (
          sender_id TEXT PRIMARY KEY,
          memory_text TEXT NOT NULL DEFAULT '',
          last_conversation_id BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_customer_memories_updated
          ON travel_customer_memories (updated_at DESC);
      `);
      // Per-sender pause state + activity tracking — replaces Redis pause store
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_senders (
          sender_id       TEXT PRIMARY KEY,
          platform        TEXT NOT NULL DEFAULT 'facebook',
          display_name    TEXT NOT NULL DEFAULT '',
          last_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          msg_count       INTEGER NOT NULL DEFAULT 0,
          greeting_sent   BOOLEAN NOT NULL DEFAULT FALSE,
          season_sent_ids TEXT[] NOT NULL DEFAULT '{}'::text[],
          paused          BOOLEAN NOT NULL DEFAULT FALSE,
          pause_reason    TEXT NOT NULL DEFAULT '',
          paused_at       TIMESTAMPTZ NULL,
          expires_at      TIMESTAMPTZ NULL,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        ALTER TABLE travel_senders
          ADD COLUMN IF NOT EXISTS greeting_sent    BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS season_sent_ids  TEXT[] NOT NULL DEFAULT '{}'::text[],
          ADD COLUMN IF NOT EXISTS last_msg_at      TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS goodbye_sent_at  TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_senders_last_seen
          ON travel_senders (last_seen DESC);
      `);
      return true;
    });

    if (!created) {
      schemaEnsured = false;
      return false;
    }

    schemaEnsured = true;
    return true;
  })()
    .catch((error) => {
      schemaEnsured = false;
      logError("travel.schema.ensure_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    })
    .finally(() => {
      schemaPromise = null;
    });

  return schemaPromise;
}
