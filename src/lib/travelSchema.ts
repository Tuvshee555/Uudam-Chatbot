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
      // Seed a row for every configured page (idempotent). Only the production deployment does:
      // local scripts run against the production database with placeholder page ids left rows
      // such as "000000000000000" and "fixture-page" there (P2-5). A missing row means "not paused".
      for (const page of process.env.VERCEL_ENV === "production" ? env.facebookPages : []) {
        await client.query(
          `
            INSERT INTO travel_page_control (page_id, bot_paused, pause_reason)
            VALUES ($1, FALSE, NULL)
            ON CONFLICT (page_id) DO NOTHING;
          `,
          [page.pageId],
        );
      }
      // Retire the legacy global pause. Per-page controls are authoritative.
      // The old migration copied a true global flag into the primary page on
      // EVERY schema initialization, so clicking Resume only worked until the
      // next request initialized the schema and paused the page again.
      const primaryPageId = env.facebookPages[0]?.pageId;
      if (primaryPageId) {
        await client.query(
          `
            UPDATE travel_page_control AS pc
            SET bot_paused = FALSE,
                pause_reason = NULL,
                updated_at = NOW()
            FROM travel_bot_control AS bc
            WHERE pc.page_id = $1
              AND bc.id = TRUE
              AND bc.bot_paused = TRUE;
          `,
          [primaryPageId],
        );
      }
      await client.query(`
        UPDATE travel_bot_control
        SET bot_paused = FALSE,
            pause_reason = NULL,
            updated_at = NOW()
        WHERE id = TRUE
          AND bot_paused = TRUE;
      `);
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
      // Whether staff were pinged for a lead (staffAlerts.ts) and who took it (Leads tab).
      await client.query(`
        ALTER TABLE travel_leads
          ADD COLUMN IF NOT EXISTS notify_status TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS notify_error TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS assigned_to TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMPTZ NULL;
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
      // Migration: infant fare is a first-class tier next to adult/child, not
      // something buried inside a per-date price group (idempotent)
      await client.query(`
        ALTER TABLE travel_trip_entries
          ADD COLUMN IF NOT EXISTS infant_price INTEGER NULL;
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
      // Migration: consultant replies read from the Page thread are stored as role 'staff' so
      // the admin inbox can tell AI from human. The Meta message id keeps each one stored once
      // across repeated thread reads; bot/model paths never read 'staff' rows (travelSessionDb).
      await client.query(`
        ALTER TABLE travel_conversations
          ADD COLUMN IF NOT EXISTS mid TEXT;
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_conversations_mid
          ON travel_conversations (mid) WHERE mid IS NOT NULL;
      `);
      // Admin's own Messenger replies (operator echoes), captured as a style
      // reference pool for the "Mimic Myself" tone toggle. Kept separate from
      // travel_conversations — that table's rows feed turn-by-turn prompt history
      // ('user'/'assistant') and the admin inbox ('staff'); this is a flat sample pool.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_admin_messages (
          id BIGSERIAL PRIMARY KEY,
          sender_id TEXT NOT NULL DEFAULT '',
          text TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_admin_messages_created
          ON travel_admin_messages (created_at DESC);
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
          ADD COLUMN IF NOT EXISTS event_key TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS attachment_index INTEGER NOT NULL DEFAULT -1,
          ADD COLUMN IF NOT EXISTS attachment_id TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS content_sha256 TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS ingest_status TEXT NOT NULL DEFAULT 'stored',
          ADD COLUMN IF NOT EXISTS ingest_attempts INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS ingest_retry_at TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS ingest_error TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_travel_customer_documents_event_attachment
          ON travel_customer_documents (platform, page_id, sender_id, event_key, attachment_index)
          WHERE event_key <> '';
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_customer_documents_ingest_retry
          ON travel_customer_documents (ingest_retry_at, id)
          WHERE ingest_status IN ('pending', 'retry', 'processing');
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
      // Permanent deletion of a document an admin already deleted (customerDocumentPurge.ts):
      // the stored file is removed, its state recorded and retried, the row kept as a tombstone.
      await client.query(`
        ALTER TABLE travel_customer_documents
          ADD COLUMN IF NOT EXISTS storage_delete_status TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS storage_delete_error TEXT NOT NULL DEFAULT '',
          ADD COLUMN IF NOT EXISTS storage_delete_attempts INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS purged_at TIMESTAMPTZ NULL;
      `);
      // The bot's own sent messages by Meta id (outboundMessages.ts), to tell them from staff.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_outbound_messages (
          mid TEXT PRIMARY KEY,
          recipient_id TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_outbound_messages_created ON travel_outbound_messages (created_at);
      `);
      // When a consultant last replied in the Messenger thread (staffTakeover.ts).
      await client.query(`
        ALTER TABLE travel_senders ADD COLUMN IF NOT EXISTS last_staff_reply_at TIMESTAMPTZ NULL;
      `);
      // When staff last handed the conversation back to the bot ("Ботод буцаах"): consultant
      // messages at or before this do not take the conversation over again (staffTakeover.ts).
      await client.query(`
        ALTER TABLE travel_senders ADD COLUMN IF NOT EXISTS bot_released_at TIMESTAMPTZ NULL;
      `);
      // One row per message echo received during the Meta-app migration (echoObserver.ts):
      // who sent a Page message, by app id — the evidence for echo-based takeover. Shapes and
      // ids only; NEVER message text.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_echo_events (
          id BIGSERIAL PRIMARY KEY,
          page_id TEXT NOT NULL DEFAULT '',
          recipient_id TEXT NOT NULL DEFAULT '',
          mid TEXT NOT NULL DEFAULT '',
          app_id TEXT NOT NULL DEFAULT '',
          has_bot_metadata BOOLEAN NOT NULL DEFAULT FALSE,
          classification TEXT NOT NULL DEFAULT '',
          text_length INTEGER NOT NULL DEFAULT 0,
          attachment_types TEXT NOT NULL DEFAULT '',
          delivered_by TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_echo_events_created ON travel_echo_events (created_at DESC);
      `);
      // One row per historical document moved from public Cloudinary to the private store
      // (documentMigration.ts): every step's result, so a run can be retried and audited.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_document_migration (
          document_id BIGINT PRIMARY KEY,
          status TEXT NOT NULL DEFAULT 'pending',
          source TEXT NOT NULL DEFAULT '',
          old_url TEXT NOT NULL DEFAULT '',
          blob_url TEXT NOT NULL DEFAULT '',
          sha256 TEXT NOT NULL DEFAULT '',
          bytes INTEGER NOT NULL DEFAULT 0,
          detected_type TEXT NOT NULL DEFAULT '',
          error TEXT NOT NULL DEFAULT '',
          attempts INTEGER NOT NULL DEFAULT 0,
          original_deleted_at TIMESTAMPTZ NULL,
          cdn_status INTEGER NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      // Private copies of inbox attachments that are not customer documents
      // (conversation-attachment.ts resolves a signed inbox link through this table).
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_conversation_attachments (
          conversation_id BIGINT NOT NULL,
          idx INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          document_id BIGINT NULL,
          blob_url TEXT NOT NULL DEFAULT '',
          sha256 TEXT NOT NULL DEFAULT '',
          mime_type TEXT NOT NULL DEFAULT '',
          bytes INTEGER NOT NULL DEFAULT 0,
          error TEXT NOT NULL DEFAULT '',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (conversation_id, idx)
        );
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
          ADD COLUMN IF NOT EXISTS reminder_sent_at TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS get_started_at   TIMESTAMPTZ NULL,
          ADD COLUMN IF NOT EXISTS quick_info_sent_at TIMESTAMPTZ NULL;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_travel_senders_last_seen
          ON travel_senders (last_seen DESC);
      `);
      // Model spend per day, environment, model and call site (aiUsage.ts): production and
      // testing are always counted apart.
      await client.query(`
        CREATE TABLE IF NOT EXISTS travel_ai_usage (
          day               DATE NOT NULL,
          environment       TEXT NOT NULL,
          model             TEXT NOT NULL,
          source            TEXT NOT NULL,
          calls             INTEGER NOT NULL DEFAULT 0,
          prompt_tokens     BIGINT NOT NULL DEFAULT 0,
          completion_tokens BIGINT NOT NULL DEFAULT 0,
          est_cost_usd      NUMERIC(14, 6) NOT NULL DEFAULT 0,
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (day, environment, model, source)
        );
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
