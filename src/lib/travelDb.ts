import { randomUUID } from "crypto";
import { getEnv } from "./env";
import { fixMojibake } from "./encoding";
import {
  logError,
  recordCounter,
} from "./observability";
import { queryNeon, withNeonClient } from "./neonDb";
import type {
  DiscountPolicy,
  FAQItem,
  KnowledgeData,
  ProgramPrice,
  SpecialOffer,
  VerifiedCredential,
} from "./businessData";
import type {
  TripStatus,
  TravelTrip,
  BotControl,
  PageControl,
  ChatButton,
  TravelBotSettings,
  TravelBotSettingsUpdate,
  TripMutationFields,
  AITripAction,
  ConflictSeverity,
  ConflictItem,
  AIChangeProposal,
  AIProposalFailureResponse,
  TripMatchSnapshot,
  LeadKind,
  LeadCrmStatus,
  TravelLead,
  LeadStats,
  BroadcastRecord,
} from "./travelTypes";

const env = getEnv();
const AI_CHANGE_GEMINI_TIMEOUT_MS = Math.max(env.geminiTimeoutMs, 45_000);
const AI_CHANGE_GEMINI_MAX_RETRIES = 0;
const AI_CHANGE_REPAIR_TIMEOUT_MS = 15_000;
const FILE_PARSE_MODEL =
  process.env.GEMINI_FILE_PARSE_MODEL || "gemini-2.5-flash";
const FILE_PARSE_VERIFY =
  (process.env.GEMINI_FILE_PARSE_VERIFY || "false").toLowerCase() === "true";
const FILE_PARSE_VERIFY_TIMEOUT_MS = 45_000;
const FILE_PARSE_GEMINI_TIMEOUT_MS = env.geminiTimeoutMs;
const FILE_PARSE_GEMINI_MAX_RETRIES = Math.min(env.geminiMaxRetries, 1);
const FILE_PARSE_BATCH_DELAY_MS = 800;
const FILE_PARSE_TOTAL_BUDGET_MS = 120_000;
const FILE_PARSE_MIN_BATCH_TIMEOUT_MS = 8_000;
const FILE_PARSE_REPAIR_TIMEOUT_MS = 15_000;
let schemaEnsured = false;
let schemaPromise: Promise<boolean> | null = null;
let botControlCache:
  | { value: BotControl; expiresAt: number }
  | null = null;
// Per-page pause control, cached 5s like the legacy single-row control.
const pageControlCache = new Map<string, { value: BotControl; expiresAt: number }>();
let botSettingsCache:
  | { value: TravelBotSettings; expiresAt: number }
  | null = null;

function parseInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/,/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function coerceTripStatus(value: unknown): TripStatus {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "cancelled") return "cancelled";
  if (normalized === "sold_out") return "sold_out";
  if (normalized === "draft") return "draft";
  return "active";
}

export function cleanFields(input: TripMutationFields): TripMutationFields {
  const cleaned: TripMutationFields = {};
  if (typeof input.category === "string") cleaned.category = input.category.trim();
  if (typeof input.operator_name === "string") cleaned.operator_name = input.operator_name.trim();
  if (typeof input.route_name === "string") cleaned.route_name = input.route_name.trim();
  if (typeof input.duration_text === "string") cleaned.duration_text = input.duration_text.trim();
  if (typeof input.currency === "string" && input.currency.trim()) {
    cleaned.currency = input.currency.trim().toUpperCase();
  }
  if (Array.isArray(input.departure_dates)) {
    cleaned.departure_dates = input.departure_dates
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .slice(0, 60);
  }
  if (input.adult_price === null || typeof input.adult_price === "number") {
    cleaned.adult_price = input.adult_price;
  }
  if (input.child_price === null || typeof input.child_price === "number") {
    cleaned.child_price = input.child_price;
  }
  if (input.seats_total === null || typeof input.seats_total === "number") {
    cleaned.seats_total = input.seats_total;
  }
  if (input.seats_left === null || typeof input.seats_left === "number") {
    cleaned.seats_left = input.seats_left;
  }
  if (input.has_food === null || typeof input.has_food === "boolean") {
    cleaned.has_food = input.has_food;
  }
  if (typeof input.status !== "undefined") {
    cleaned.status = coerceTripStatus(input.status);
  }
  if (typeof input.notes === "string") cleaned.notes = input.notes.trim();
  if (typeof input.hotel === "string") cleaned.hotel = input.hotel.trim();
  if (typeof input.source_description === "string") {
    cleaned.source_description = input.source_description.trim();
  }
  if (input.extra && typeof input.extra === "object" && !Array.isArray(input.extra)) {
    cleaned.extra = input.extra;
  }
  return cleaned;
}

export function isAgencyHeaderName(value: string | null | undefined): boolean {
  const normalized = normalizeLookupText(value || "");
  return (
    normalized === "uudam travel agency" ||
    normalized === "uudam travel" ||
    normalized === "travel agency" ||
    normalized === "agency"
  );
}

export function isAgencyHeaderConflict(value: string): boolean {
  const normalized = normalizeLookupText(value);
  return (
    normalized.includes("uudam travel agency") ||
    normalized === "uudam travel" ||
    normalized === "travel agency"
  );
}

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
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await client.query(`
        INSERT INTO travel_bot_control (id, bot_paused, pause_reason)
        VALUES (TRUE, FALSE, NULL)
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

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStoredText(value: unknown): string {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return "";

  const fixed = fixMojibake(trimmed).replaceAll("�", "").trim();
  const compact = fixed.replace(/\s+/g, "");
  const questionMarks = (compact.match(/\?/g) || []).length;
  if (compact.length >= 8 && questionMarks / compact.length > 0.25) {
    return "";
  }
  return fixed;
}

function normalizeStoredTextArray(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = normalizeStoredText(item);
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeTextArray(value: unknown, max = 120): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const text = asTrimmedString(item);
    if (!text) continue;
    if (out.includes(text)) continue;
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeProgramPrice(value: unknown): ProgramPrice {
  const parsed = parseInteger(value);
  return parsed == null ? ("NEEDS_MANUAL_FIX" as ProgramPrice) : parsed;
}

function normalizeSpecialOffers(value: unknown): SpecialOffer[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        name: normalizeStoredText(item.name),
        duration: normalizeStoredText(item.duration),
        price: normalizeProgramPrice(item.price),
        target: normalizeStoredText(item.target),
        description: normalizeStoredText(item.description),
        eligibility: normalizeStoredText(item.eligibility),
      };
    });
}

function normalizeDiscountPolicies(value: unknown): DiscountPolicy[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        name: normalizeStoredText(item.name),
        discount: normalizeStoredText(item.discount),
        applies_to: normalizeStoredText(item.applies_to),
        eligibility: normalizeStoredText(item.eligibility),
        description: normalizeStoredText(item.description),
        verification: normalizeStoredText(item.verification),
      };
    });
}

function normalizeVerifiedCredentials(value: unknown): VerifiedCredential[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        title: normalizeStoredText(item.title),
        issuer: normalizeStoredText(item.issuer),
        issued_on: normalizeStoredText(item.issued_on),
        description: normalizeStoredText(item.description),
      };
    });
}

function normalizeChatButtons(value: unknown): ChatButton[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 20)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        label: normalizeStoredText(item.label).slice(0, 60),
        message: normalizeStoredText(item.message).slice(0, 200),
      };
    })
    .filter((b) => b.label && b.message);
}

function normalizeFaq(value: unknown): FAQItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && typeof entry === "object")
    .slice(0, 500)
    .map((entry) => {
      const item = entry as Record<string, unknown>;
      return {
        question: normalizeStoredText(item.question),
        answer: normalizeStoredText(item.answer),
      };
    })
    .filter((item) => item.question || item.answer);
}

function normalizePauseMinutes(value: unknown): number {
  const parsed = parseInteger(value);
  if (parsed == null) return 60;
  return Math.min(Math.max(parsed, 0), 24 * 60);
}

function emptyTravelBotSettings(): TravelBotSettings {
  return {
    business_name: "",
    system_prompt: "",
    quick_info_reply: "",
    quick_info_keywords: [],
    comment_trigger_patterns: [],
    comment_public_reply: "",
    comment_dm_reply: "",
    special_offers: [],
    discount_policies: [],
    verified_credentials: [],
    faq: [],
    handoff_enabled: true,
    handoff_keywords: [],
    handoff_reply: "",
    handoff_pause_minutes: 60,
    chat_buttons: [],
    extra: {},
    updated_at: new Date().toISOString(),
  };
}

function mapBotSettingsRow(row: Record<string, unknown> | undefined): TravelBotSettings {
  if (!row) return emptyTravelBotSettings();
  return {
    business_name: normalizeStoredText(row.business_name),
    system_prompt: normalizeStoredText(row.system_prompt),
    quick_info_reply: normalizeStoredText(row.quick_info_reply),
    quick_info_keywords: normalizeStoredTextArray(row.quick_info_keywords),
    comment_trigger_patterns: normalizeStoredTextArray(row.comment_trigger_patterns),
    comment_public_reply: normalizeStoredText(row.comment_public_reply),
    comment_dm_reply: normalizeStoredText(row.comment_dm_reply),
    special_offers: normalizeSpecialOffers(row.special_offers),
    discount_policies: normalizeDiscountPolicies(row.discount_policies),
    verified_credentials: normalizeVerifiedCredentials(row.verified_credentials),
    faq: normalizeFaq(row.faq),
    handoff_enabled: row.handoff_enabled == null ? true : Boolean(row.handoff_enabled),
    handoff_keywords: normalizeStoredTextArray(row.handoff_keywords),
    handoff_reply: normalizeStoredText(row.handoff_reply),
    handoff_pause_minutes: normalizePauseMinutes(row.handoff_pause_minutes),
    chat_buttons: normalizeChatButtons(row.chat_buttons),
    extra:
      row.extra && typeof row.extra === "object" && !Array.isArray(row.extra)
        ? (row.extra as Record<string, unknown>)
        : {},
    updated_at: String(row.updated_at || new Date().toISOString()),
  };
}

export async function getTravelBotSettings(): Promise<TravelBotSettings> {
  if (botSettingsCache && botSettingsCache.expiresAt > Date.now()) {
    return botSettingsCache.value;
  }

  const ready = await ensureTravelSchema();
  if (!ready) return emptyTravelBotSettings();

  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        business_name,
        system_prompt,
        quick_info_reply,
        quick_info_keywords,
        comment_trigger_patterns,
        comment_public_reply,
        comment_dm_reply,
        special_offers,
        discount_policies,
        verified_credentials,
        faq,
        handoff_enabled,
        handoff_keywords,
        handoff_reply,
        handoff_pause_minutes,
        chat_buttons,
        extra,
        updated_at
      FROM travel_bot_settings
      WHERE id = TRUE
      LIMIT 1
    `,
  );

  const value = mapBotSettingsRow(result?.rows?.[0]);
  botSettingsCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

export async function updateTravelBotSettings(
  fields: TravelBotSettingsUpdate,
): Promise<TravelBotSettings> {
  const ready = await ensureTravelSchema();
  if (!ready) return emptyTravelBotSettings();

  const values: unknown[] = [];
  const sets: string[] = [];
  const push = (column: string, value: unknown, cast = "") => {
    values.push(value);
    sets.push(`${column} = $${values.length}${cast}`);
  };

  if (typeof fields.business_name === "string") {
    push("business_name", fields.business_name.trim());
  }
  if (typeof fields.system_prompt === "string") {
    push("system_prompt", fields.system_prompt.trim());
  }
  if (typeof fields.quick_info_reply === "string") {
    push("quick_info_reply", fields.quick_info_reply.trim());
  }
  if (typeof fields.comment_public_reply === "string") {
    push("comment_public_reply", fields.comment_public_reply.trim());
  }
  if (typeof fields.comment_dm_reply === "string") {
    push("comment_dm_reply", fields.comment_dm_reply.trim());
  }
  if (typeof fields.quick_info_keywords !== "undefined") {
    push("quick_info_keywords", normalizeTextArray(fields.quick_info_keywords), "::text[]");
  }
  if (typeof fields.comment_trigger_patterns !== "undefined") {
    push(
      "comment_trigger_patterns",
      normalizeTextArray(fields.comment_trigger_patterns),
      "::text[]",
    );
  }
  if (typeof fields.special_offers !== "undefined") {
    push("special_offers", JSON.stringify(normalizeSpecialOffers(fields.special_offers)), "::jsonb");
  }
  if (typeof fields.discount_policies !== "undefined") {
    push(
      "discount_policies",
      JSON.stringify(normalizeDiscountPolicies(fields.discount_policies)),
      "::jsonb",
    );
  }
  if (typeof fields.verified_credentials !== "undefined") {
    push(
      "verified_credentials",
      JSON.stringify(normalizeVerifiedCredentials(fields.verified_credentials)),
      "::jsonb",
    );
  }
  if (typeof fields.faq !== "undefined") {
    push("faq", JSON.stringify(normalizeFaq(fields.faq)), "::jsonb");
  }
  if (typeof fields.handoff_enabled === "boolean") {
    push("handoff_enabled", fields.handoff_enabled);
  }
  if (typeof fields.handoff_reply === "string") {
    push("handoff_reply", fields.handoff_reply.trim());
  }
  if (typeof fields.handoff_keywords !== "undefined") {
    push("handoff_keywords", normalizeTextArray(fields.handoff_keywords), "::text[]");
  }
  if (typeof fields.handoff_pause_minutes !== "undefined") {
    push("handoff_pause_minutes", normalizePauseMinutes(fields.handoff_pause_minutes));
  }
  if (typeof fields.chat_buttons !== "undefined") {
    push("chat_buttons", JSON.stringify(normalizeChatButtons(fields.chat_buttons)), "::jsonb");
  }
  if (
    typeof fields.extra !== "undefined" &&
    fields.extra &&
    typeof fields.extra === "object" &&
    !Array.isArray(fields.extra)
  ) {
    push("extra", JSON.stringify(fields.extra), "::jsonb");
  }

  if (!sets.length) {
    return getTravelBotSettings();
  }

  const result = await queryNeon<Record<string, unknown>>(
    `
      UPDATE travel_bot_settings
      SET
        ${sets.join(", ")},
        updated_at = NOW()
      WHERE id = TRUE
      RETURNING
        business_name,
        system_prompt,
        quick_info_reply,
        quick_info_keywords,
        comment_trigger_patterns,
        comment_public_reply,
        comment_dm_reply,
        special_offers,
        discount_policies,
        verified_credentials,
        faq,
        handoff_enabled,
        handoff_keywords,
        handoff_reply,
        handoff_pause_minutes,
        chat_buttons,
        extra,
        updated_at
    `,
    values,
  );

  const updated = mapBotSettingsRow(result?.rows?.[0]);
  botSettingsCache = { value: updated, expiresAt: Date.now() + 5_000 };
  return updated;
}

export function mapTripRow(row: Record<string, unknown>): TravelTrip {
  return {
    id: String(row.id || ""),
    category: normalizeStoredText(row.category),
    operator_name: normalizeStoredText(row.operator_name),
    route_name: normalizeStoredText(row.route_name),
    duration_text: normalizeStoredText(row.duration_text),
    adult_price: parseInteger(row.adult_price),
    child_price: parseInteger(row.child_price),
    currency: normalizeStoredText(row.currency) || "MNT",
    departure_dates: Array.isArray(row.departure_dates)
      ? row.departure_dates.map((value) => normalizeStoredText(value)).filter(Boolean)
      : [],
    seats_total: parseInteger(row.seats_total),
    seats_left: parseInteger(row.seats_left),
    has_food:
      typeof row.has_food === "boolean"
        ? row.has_food
        : row.has_food == null
          ? null
          : Boolean(row.has_food),
    status: coerceTripStatus(row.status),
    notes: normalizeStoredText(row.notes),
    hotel: normalizeStoredText(row.hotel),
    source_description: normalizeStoredText(row.source_description),
    photo_urls: Array.isArray(row.photo_urls)
      ? (row.photo_urls as unknown[])
          .filter((u): u is string => typeof u === "string" && u.startsWith("https://"))
          .slice(0, 20)
      : [],
    extra:
      row.extra && typeof row.extra === "object" && !Array.isArray(row.extra)
        ? (row.extra as Record<string, unknown>)
        : {},
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

export async function listTrips(options?: {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return [] as TravelTrip[];

  const search = options?.search?.trim() || null;
  const status = options?.status?.trim() || null;
  const limit = Math.min(Math.max(Number(options?.limit || 150), 1), 1000);
  const offset = Math.max(Number(options?.offset || 0), 0);

  const rows = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        id,
        category,
        operator_name,
        route_name,
        duration_text,
        adult_price,
        child_price,
        currency,
        departure_dates,
        seats_total,
        seats_left,
        has_food,
        status,
        notes,
        hotel,
        source_description,
        photo_urls,
        extra,
        created_at,
        updated_at
      FROM travel_trip_entries
      WHERE
        ($1::text IS NULL OR (
          category ILIKE '%' || $1 || '%' OR
          operator_name ILIKE '%' || $1 || '%' OR
          route_name ILIKE '%' || $1 || '%' OR
          source_description ILIKE '%' || $1 || '%'
        ))
        AND ($2::text IS NULL OR status = $2)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT $3
      OFFSET $4
    `,
    [search, status, limit, offset],
  );
  if (!rows) return [] as TravelTrip[];
  return rows.rows.map(mapTripRow);
}

export async function getTripById(id: string): Promise<TravelTrip | null> {
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT
        id,
        category,
        operator_name,
        route_name,
        duration_text,
        adult_price,
        child_price,
        currency,
        departure_dates,
        seats_total,
        seats_left,
        has_food,
        status,
        notes,
        hotel,
        source_description,
        photo_urls,
        extra,
        created_at,
        updated_at
      FROM travel_trip_entries
      WHERE id = $1
      LIMIT 1
    `,
    [id],
  );
  return result?.rows?.[0] ? mapTripRow(result.rows[0]) : null;
}

export async function getBotControl(): Promise<BotControl> {
  if (botControlCache && botControlCache.expiresAt > Date.now()) {
    return botControlCache.value;
  }
  const ready = await ensureTravelSchema();
  if (!ready) {
    return {
      bot_paused: false,
      pause_reason: null,
      updated_at: new Date().toISOString(),
    };
  }
  const result = await queryNeon<Record<string, unknown>>(
    `SELECT bot_paused, pause_reason, updated_at FROM travel_bot_control WHERE id = TRUE LIMIT 1`,
  );
  const row = result?.rows?.[0];
  const value = {
    bot_paused: Boolean(row?.bot_paused),
    pause_reason: row?.pause_reason ? String(row.pause_reason) : null,
    updated_at: String(row?.updated_at || new Date().toISOString()),
  };
  botControlCache = { value, expiresAt: Date.now() + 5_000 };
  return value;
}

export async function setBotPaused(paused: boolean, reason?: string | null) {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `
      INSERT INTO travel_bot_control (id, bot_paused, pause_reason, updated_at)
      VALUES (TRUE, $1, $2, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        bot_paused = EXCLUDED.bot_paused,
        pause_reason = EXCLUDED.pause_reason,
        updated_at = NOW()
    `,
    [paused, reason || null],
  );
  botControlCache = null;
  return Boolean(result);
}

export async function isBotGloballyPaused() {
  const control = await getBotControl();
  return control.bot_paused;
}

const UNPAUSED_PAGE_DEFAULT = (): BotControl => ({
  bot_paused: false,
  pause_reason: null,
  updated_at: new Date().toISOString(),
});

export async function getPageControl(pageId: string): Promise<BotControl> {
  const cached = pageControlCache.get(pageId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  const ready = await ensureTravelSchema();
  if (!ready) return UNPAUSED_PAGE_DEFAULT();

  const result = await queryNeon<Record<string, unknown>>(
    `SELECT bot_paused, pause_reason, updated_at FROM travel_page_control WHERE page_id = $1 LIMIT 1`,
    [pageId],
  );
  const row = result?.rows?.[0];
  const value: BotControl = {
    bot_paused: Boolean(row?.bot_paused),
    pause_reason: row?.pause_reason ? String(row.pause_reason) : null,
    updated_at: String(row?.updated_at || new Date().toISOString()),
  };
  pageControlCache.set(pageId, { value, expiresAt: Date.now() + 5_000 });
  return value;
}

export async function setPagePaused(
  pageId: string,
  paused: boolean,
  reason?: string | null,
) {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `
      INSERT INTO travel_page_control (page_id, bot_paused, pause_reason, updated_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (page_id)
      DO UPDATE SET
        bot_paused = EXCLUDED.bot_paused,
        pause_reason = EXCLUDED.pause_reason,
        updated_at = NOW()
    `,
    [pageId, paused, reason || null],
  );
  pageControlCache.delete(pageId);
  return Boolean(result);
}

export async function isPagePaused(pageId: string): Promise<boolean> {
  const control = await getPageControl(pageId);
  return control.bot_paused;
}

/** Returns one control row per configured page, in roster order. */
export async function listPageControls(): Promise<PageControl[]> {
  const roster = env.facebookPages;
  const controls = await Promise.all(
    roster.map(async (page) => {
      const control = await getPageControl(page.pageId);
      return { page_id: page.pageId, ...control };
    }),
  );
  return controls;
}

export async function upsertTrip(input: {
  id?: string;
  fields: TripMutationFields;
}) {
  const ready = await ensureTravelSchema();
  if (!ready) return null;

  const cleaned = cleanFields(input.fields);
  const routeName = cleaned.route_name?.trim() || "";
  if (!routeName || /^\(?\s*нэргүй\s+аялал\s*\)?$/i.test(routeName)) {
    throw new Error("Аяллын нэр хоосон тул хадгалсангүй.");
  }
  const id = input.id?.trim() || `trip-${randomUUID()}`;
  const row: TravelTrip = {
    id,
    category: cleaned.category || "",
    operator_name: cleaned.operator_name || "UUDAM TRAVEL AGENCY",
    route_name: routeName,
    duration_text: cleaned.duration_text || "",
    adult_price:
      typeof cleaned.adult_price === "number" ? Math.trunc(cleaned.adult_price) : null,
    child_price:
      typeof cleaned.child_price === "number" ? Math.trunc(cleaned.child_price) : null,
    currency: cleaned.currency || "MNT",
    departure_dates: cleaned.departure_dates || [],
    seats_total:
      typeof cleaned.seats_total === "number" ? Math.trunc(cleaned.seats_total) : null,
    seats_left:
      typeof cleaned.seats_left === "number" ? Math.trunc(cleaned.seats_left) : null,
    has_food:
      typeof cleaned.has_food === "boolean" || cleaned.has_food === null
        ? cleaned.has_food
        : null,
    status: coerceTripStatus(cleaned.status),
    notes: cleaned.notes || "",
    hotel: cleaned.hotel || "",
    source_description: cleaned.source_description || "",
    photo_urls: Array.isArray(cleaned.photo_urls)
      ? cleaned.photo_urls.filter((u) => typeof u === "string" && u.startsWith("https://")).slice(0, 20)
      : [],
    extra: cleaned.extra || {},
    created_at: "",
    updated_at: "",
  };

  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_trip_entries (
        id,
        category,
        operator_name,
        route_name,
        duration_text,
        adult_price,
        child_price,
        currency,
        departure_dates,
        seats_total,
        seats_left,
        has_food,
        status,
        notes,
        hotel,
        source_description,
        photo_urls,
        extra,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, NOW()
      )
      ON CONFLICT (id)
      DO UPDATE SET
        category = EXCLUDED.category,
        operator_name = EXCLUDED.operator_name,
        route_name = EXCLUDED.route_name,
        duration_text = EXCLUDED.duration_text,
        adult_price = EXCLUDED.adult_price,
        child_price = EXCLUDED.child_price,
        currency = EXCLUDED.currency,
        departure_dates = EXCLUDED.departure_dates,
        seats_total = EXCLUDED.seats_total,
        seats_left = EXCLUDED.seats_left,
        has_food = EXCLUDED.has_food,
        status = EXCLUDED.status,
        notes = EXCLUDED.notes,
        hotel = EXCLUDED.hotel,
        source_description = EXCLUDED.source_description,
        photo_urls = EXCLUDED.photo_urls,
        extra = EXCLUDED.extra,
        updated_at = NOW()
      RETURNING *
    `,
    [
      row.id,
      row.category,
      row.operator_name,
      row.route_name,
      row.duration_text,
      row.adult_price,
      row.child_price,
      row.currency,
      row.departure_dates,
      row.seats_total,
      row.seats_left,
      row.has_food,
      row.status,
      row.notes,
      row.hotel,
      row.source_description,
      JSON.stringify(row.photo_urls),
      JSON.stringify(row.extra),
    ],
  );
  return result?.rows?.[0] ? mapTripRow(result.rows[0]) : null;
}

export async function patchTrip(id: string, fields: TripMutationFields) {
  const ready = await ensureTravelSchema();
  if (!ready) return null;

  const cleaned = cleanFields(fields);
  const keys = Object.keys(cleaned) as Array<keyof TripMutationFields>;
  if (!keys.length) return null;

  const columnMap: Record<keyof TripMutationFields, string> = {
    category: "category",
    operator_name: "operator_name",
    route_name: "route_name",
    duration_text: "duration_text",
    adult_price: "adult_price",
    child_price: "child_price",
    currency: "currency",
    departure_dates: "departure_dates",
    seats_total: "seats_total",
    seats_left: "seats_left",
    has_food: "has_food",
    status: "status",
    notes: "notes",
    hotel: "hotel",
    source_description: "source_description",
    photo_urls: "photo_urls",
    extra: "extra",
  };

  const JSONB_KEYS = new Set<keyof TripMutationFields>(["extra", "photo_urls"]);

  const values: unknown[] = [];
  const sets: string[] = [];

  keys.forEach((key, index) => {
    values.push(
      JSONB_KEYS.has(key)
        ? JSON.stringify(cleaned[key] ?? (key === "photo_urls" ? [] : {}))
        : cleaned[key],
    );
    const column = columnMap[key];
    const placeholder = key === "departure_dates" ? `$${index + 1}::text[]` : `$${index + 1}`;
    const jsonbPlaceholder = JSONB_KEYS.has(key) ? `${placeholder}::jsonb` : placeholder;
    sets.push(`${column} = ${jsonbPlaceholder}`);
  });

  values.push(id);
  const result = await queryNeon<Record<string, unknown>>(
    `
      UPDATE travel_trip_entries
      SET
        ${sets.join(", ")},
        updated_at = NOW()
      WHERE id = $${values.length}
      RETURNING *
    `,
    values,
  );
  return result?.rows?.[0] ? mapTripRow(result.rows[0]) : null;
}

export async function deleteTrip(id: string): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `DELETE FROM travel_trip_entries WHERE id = $1`,
    [id],
  );
  return (result?.rowCount ?? 0) > 0;
}

export async function resolveTripIdByMatch(match?: {
  operator_name?: string;
  route_name?: string;
}) {
  if (!match?.route_name && !match?.operator_name) return { id: null, conflict: null as string | null };
  const operator = match.operator_name?.trim() || null;
  const route = match.route_name?.trim() || null;
  const found = await queryNeon<{ id: string }>(
    `
      SELECT id
      FROM travel_trip_entries
      WHERE
        ($1::text IS NULL OR operator_name ILIKE $1)
        AND ($2::text IS NULL OR route_name ILIKE $2)
      ORDER BY updated_at DESC
      LIMIT 2
    `,
    [operator, route],
  );
  if (!found || found.rows.length === 0) {
    return { id: null, conflict: "Matching trip not found." };
  }
  if (found.rows.length > 1) {
    return { id: null, conflict: "Multiple trips match the same operator/route." };
  }
  return { id: found.rows[0].id, conflict: null as string | null };
}

export function cleanAIText(text: string): string {
  return text.replace(/```json|```/gi, "").trim();
}

export function estimateInlineBytes(data?: string | null): number {
  if (!data) return 0;
  return Math.floor((data.length * 3) / 4);
}

export function parseJsonFromModel(text: string): AIChangeProposal | null {
  const cleaned = cleanAIText(text);
  try {
    return JSON.parse(cleaned) as AIChangeProposal;
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as AIChangeProposal;
      } catch {
        return null;
      }
    }
    return null;
  }
}

export function proposalFallbackFromRawText(text: string): AIChangeProposal {
  const cleaned = cleanAIText(text).trim();
  const preview = cleaned.slice(0, 900);
  return {
    summary: preview
      ? "AI returned text, but it was not valid JSON yet."
      : "AI did not return valid JSON.",
    needs_confirmation: true,
    important_reason:
      "The uploaded files were read, but the model response could not be converted into the required action format automatically.",
    conflicts: preview
      ? [`Raw AI output preview: ${preview}`]
      : ["AI response was empty or not valid JSON."],
    actions: [],
  };
}

export function normalizeProposal(input: AIChangeProposal | null): AIChangeProposal {
  if (!input) {
    return {
      summary: "AI хариуг parse хийж чадсангүй.",
      needs_confirmation: true,
      important_reason: "JSON бүтэц буруу байсан тул баталгаажуулалт шаардлагатай.",
      conflicts: ["AI хариу JSON биш байна."],
      conflict_items: [{ text: "AI хариу JSON биш байна.", severity: "blocker" as const }],
      actions: [],
    };
  }

  // Parse structured conflict_items when the model provides them.
  // Fall back to the flat conflicts array for backwards compatibility.
  const validSeverities = new Set(["info", "warning", "blocker"]);
  const conflict_items: ConflictItem[] = Array.isArray(input.conflict_items)
    ? input.conflict_items
        .filter((item: unknown) => item && typeof item === "object")
        .map((item: Record<string, unknown>) => ({
          text: String((item as Record<string, unknown>).text || ""),
          severity: validSeverities.has(String((item as Record<string, unknown>).severity))
            ? (String((item as Record<string, unknown>).severity) as ConflictSeverity)
            : "warning",
          type: typeof (item as Record<string, unknown>).type === "string"
            ? String((item as Record<string, unknown>).type)
            : undefined,
        }))
        .filter((item) => item.text)
    : // No structured items — wrap flat conflicts as "blocker" so old behavior preserved.
      (Array.isArray(input.conflicts)
        ? (input.conflicts as unknown[])
            .map((value) => String(value))
            .filter(Boolean)
            .map((text) => ({ text, severity: "blocker" as ConflictSeverity }))
        : []);

  const conflicts = conflict_items.map((item) => item.text);

  return {
    summary: String(input.summary || "AI саналыг үүсгэлээ."),
    needs_confirmation: Boolean(input.needs_confirmation),
    important_reason: String(input.important_reason || ""),
    conflicts,
    conflict_items,
    actions: Array.isArray(input.actions)
      ? (input.actions as unknown[]).filter((action) => action && typeof action === "object") as AITripAction[]
      : [],
  };
}

export function getAIProposalFailureResponse(
  proposal: AIChangeProposal | undefined,
): AIProposalFailureResponse | null {
  if (!proposal || proposal.actions.length > 0) return null;

  const text = [
    proposal.summary,
    proposal.important_reason,
    ...(proposal.conflicts || []),
  ]
    .join(" ")
    .toLowerCase();

  if (
    /\b429\b|rate.?limit|quota|resource.?exhausted/.test(text)
  ) {
    return {
      statusCode: 429,
      error:
        "AI service is temporarily rate limited. Please wait a minute and try again.",
      retry_after_ms: 60_000,
    };
  }

  if (/timeout|timed out|etimedout/.test(text)) {
    return {
      statusCode: 504,
      error:
        "AI service took too long to answer. Please try again with a shorter instruction.",
      retry_after_ms: 20_000,
    };
  }

  if (/circuit|upstream|temporarily|took too long|could not finish reading batch/.test(text)) {
    return {
      statusCode: 503,
      error: "AI service is temporarily unavailable. Please try again shortly.",
      retry_after_ms: 30_000,
    };
  }

  return null;
}

export function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const cleaned = String(value || "").trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
  }
  return result;
}

export function normalizeLookupText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

export function normalizeDateText(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed.replace(/[./]/g, "-");
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(normalized);
  if (!match) return trimmed;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    !Number.isInteger(year) ||
    !Number.isInteger(month) ||
    !Number.isInteger(day) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return trimmed;
  }

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// Phrases that describe a repeating departure schedule rather than a single
// calendar date. Kept in sync with the client copy in admin.tsx — update both.
export const RECURRING_DEPARTURE_TOKENS = [
  // Daily — the common "өдөр бүр / daily / everyday" the admin asks for.
  "өдөр бүр",
  "өдөр болгон",
  "өдөр тутам",
  "daily",
  "every day",
  "everyday",
  // Weekly / per-weekday.
  "гараг бүр",
  "долоо хоног бүр",
  "долоохоног бүр",
  "every week",
  "weekly",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
  "даваа",
  "мягмар",
  "лхагва",
  "пүрэв",
  "баасан",
  "бямба",
  "ням",
  // Monthly / periodic.
  "сар бүр",
  "monthly",
  "every month",
  "хоног тутам",
];

export function isRecurringDepartureText(value: string): boolean {
  const normalized = normalizeLookupText(value);
  if (!normalized) return false;
  return RECURRING_DEPARTURE_TOKENS.some((token) => normalized.includes(token));
}

export function findTripMatches(
  trips: TripMatchSnapshot[],
  operatorName?: string,
  routeName?: string,
): TripMatchSnapshot[] {
  const operator = operatorName ? normalizeLookupText(operatorName) : "";
  const route = routeName ? normalizeLookupText(routeName) : "";
  if (!operator && !route) return [];

  return trips.filter((trip) => {
    const tripOperator = normalizeLookupText(trip.operator_name || "");
    const tripRoute = normalizeLookupText(trip.route_name || "");
    if (operator && tripOperator !== operator) return false;
    if (route && tripRoute !== route) return false;
    return true;
  });
}

export function buildConflictLabel(routeName?: string, operatorName?: string): string {
  if (routeName && operatorName) return `"${routeName}" / "${operatorName}"`;
  if (routeName) return `"${routeName}"`;
  if (operatorName) return `"${operatorName}"`;
  return "энэ аялал";
}

export function isReasonableMoney(value: number | null | undefined) {
  return value == null || (Number.isFinite(value) && value >= 0 && value <= 100_000_000);
}

export function isReasonableSeats(value: number | null | undefined) {
  return value == null || (Number.isFinite(value) && value >= 0 && value <= 10_000);
}

export function isGenericConfirmationText(value: string | null | undefined): boolean {
  const normalized = normalizeLookupText(value || "");
  if (!normalized) return true;
  return (
    normalized.includes("файлнаас шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("шинэ аяллын мэдээлэл уншигдсан") ||
    normalized.includes("баталгаажуулалт шаардлагатай") ||
    normalized.includes("баталгаажуулах шаардлагатай") ||
    (normalized.includes("new trip") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("confirmation")) ||
    (normalized.includes("file") && normalized.includes("review"))
  );
}

export function isOptionalAddOnCostConflict(value: string): boolean {
  const normalized = normalizeLookupText(value);
  const mentionsForeignCost =
    normalized.includes("cny") ||
    normalized.includes("yuan") ||
    normalized.includes("юань");
  if (!mentionsForeignCost) return false;
  return (
    normalized.includes("optional") ||
    normalized.includes("add-on") ||
    normalized.includes("addon") ||
    normalized.includes("extra") ||
    normalized.includes("нэмэлт төлбөр") ||
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("хөтөлбөрт багтаагүй") ||
    normalized.includes("ганцаараа орох") ||
    normalized.includes("single room")
  );
}

export function isDocumentedMealExceptionConflict(value: string): boolean {
  const normalized = normalizeLookupText(value);
  const mentionsMeal =
    normalized.includes("хоол") ||
    normalized.includes("цай") ||
    normalized.includes("meal") ||
    normalized.includes("breakfast") ||
    normalized.includes("lunch") ||
    normalized.includes("dinner");
  if (!mentionsMeal) return false;
  return (
    normalized.includes("өөрийн зардлаар") ||
    normalized.includes("өөрсдийн зардлаар") ||
    normalized.includes("өөрөө") ||
    normalized.includes("чөлөөт өдөр") ||
    normalized.includes("байдаггүй") ||
    normalized.includes("байхгүй") ||
    normalized.includes("not included") ||
    normalized.includes("own expense") ||
    normalized.includes("free day")
  );
}

export function isCompleteCleanAction(action: AITripAction): boolean {
  const verb = String(action.action || "").trim().toLowerCase();
  const fields = action.fields || {};
  const hasTarget = Boolean(action.trip_id || action.match?.route_name || action.match?.operator_name);
  if (verb === "patch") return hasTarget && Object.keys(fields).length > 0;
  if (verb !== "upsert") return false;

  const routeName = fields.route_name?.trim() || action.match?.route_name?.trim() || "";
  const operatorName = fields.operator_name?.trim() || action.match?.operator_name?.trim() || "";
  const hasPrice =
    typeof fields.adult_price === "number" || typeof fields.child_price === "number";
  const hasDates =
    Array.isArray(fields.departure_dates) && fields.departure_dates.length > 0;
  const hasDuration = Boolean(fields.duration_text?.trim());

  return Boolean(routeName && operatorName && hasPrice && hasDates && hasDuration);
}

/* ----------------------------------------------------------------
   Leads — human-handoff requests and booking-intent captures
   ---------------------------------------------------------------- */

const VALID_CRM_STATUSES: LeadCrmStatus[] = ["new_lead", "contacted", "booked", "no_answer"];

function mapLeadRow(row: Record<string, unknown>): TravelLead {
  const kind = row.kind === "booking" ? "booking" : "handoff";
  const rawCrm = String(row.lead_status || "new_lead");
  const lead_status: LeadCrmStatus = (VALID_CRM_STATUSES as string[]).includes(rawCrm)
    ? (rawCrm as LeadCrmStatus)
    : "new_lead";
  return {
    id: Number(row.id),
    kind,
    platform: String(row.platform || ""),
    sender_id: String(row.sender_id || ""),
    customer_message: String(row.customer_message || ""),
    contact_phone: String(row.contact_phone || ""),
    context: String(row.context || ""),
    status: row.status === "seen" ? "seen" : "new",
    lead_status,
    created_at: String(row.created_at || ""),
    seen_at: row.seen_at ? String(row.seen_at) : null,
  };
}

/**
 * Returns true if an unresolved lead of the same kind already exists for this
 * sender within the lookback window — used to avoid spamming duplicate leads
 * when a customer sends several intent messages in a row.
 */
export async function hasRecentOpenLead(
  senderId: string,
  kind: LeadKind,
  withinMs = 6 * 60 * 60 * 1000,
): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM travel_leads
      WHERE sender_id = $1
        AND kind = $2
        AND status = 'new'
        AND created_at > NOW() - ($3::int * INTERVAL '1 millisecond')
    `,
    [senderId, kind, withinMs],
  );
  return Number(result?.rows?.[0]?.count || 0) > 0;
}

export async function createLead(input: {
  kind: LeadKind;
  platform: string;
  senderId: string;
  customerMessage: string;
  contactPhone?: string;
  context?: string;
}): Promise<TravelLead | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_leads (
        kind, platform, sender_id, customer_message, contact_phone, context, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, 'new')
      RETURNING *
    `,
    [
      input.kind,
      input.platform,
      input.senderId,
      input.customerMessage.slice(0, 2000),
      (input.contactPhone || "").slice(0, 40),
      (input.context || "").slice(0, 4000),
    ],
  );
  return result?.rows?.[0] ? mapLeadRow(result.rows[0]) : null;
}

export async function listLeads(limit = 50): Promise<TravelLead[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const result = await queryNeon<Record<string, unknown>>(
    `
      SELECT *
      FROM travel_leads
      ORDER BY (status = 'new') DESC, created_at DESC
      LIMIT $1
    `,
    [safeLimit],
  );
  return result?.rows ? result.rows.map(mapLeadRow) : [];
}

export async function countNewLeads(): Promise<number> {
  const ready = await ensureTravelSchema();
  if (!ready) return 0;
  const result = await queryNeon<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM travel_leads WHERE status = 'new'`,
  );
  return Number(result?.rows?.[0]?.count || 0);
}

export async function markLeadSeen(id: number): Promise<boolean> {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `UPDATE travel_leads SET status = 'seen', seen_at = NOW() WHERE id = $1`,
    [id],
  );
  return (result?.rowCount ?? 0) > 0;
}

export async function updateLeadStatus(
  id: number,
  leadStatus: LeadCrmStatus,
): Promise<boolean> {
  if (!(VALID_CRM_STATUSES as string[]).includes(leadStatus)) return false;
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `UPDATE travel_leads SET lead_status = $1, status = 'seen', seen_at = COALESCE(seen_at, NOW()) WHERE id = $2`,
    [leadStatus, id],
  );
  return (result?.rowCount ?? 0) > 0;
}

/** Aggregated lead numbers for the dashboard. Safe defaults if DB is absent. */
export async function getLeadStats(): Promise<LeadStats> {
  const empty: LeadStats = {
    total: 0,
    new_count: 0,
    today: 0,
    last7days: 0,
    last30days: 0,
    by_platform: [],
    by_kind: [],
    daily: [],
  };
  const ready = await ensureTravelSchema();
  if (!ready) return empty;

  const [totals, platforms, kinds, daily] = await Promise.all([
    queryNeon<{
      total: string;
      new_count: string;
      today: string;
      last7days: string;
      last30days: string;
    }>(`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE status = 'new')::text AS new_count,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('day', NOW()))::text AS today,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '7 days')::text AS last7days,
        COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::text AS last30days
      FROM travel_leads
    `),
    queryNeon<{ platform: string; count: string }>(`
      SELECT COALESCE(NULLIF(platform, ''), 'unknown') AS platform, COUNT(*)::text AS count
      FROM travel_leads
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ kind: string; count: string }>(`
      SELECT COALESCE(NULLIF(kind, ''), 'handoff') AS kind, COUNT(*)::text AS count
      FROM travel_leads
      GROUP BY 1
      ORDER BY COUNT(*) DESC
    `),
    queryNeon<{ day: string; count: string }>(`
      SELECT to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day, COUNT(*)::text AS count
      FROM travel_leads
      WHERE created_at >= NOW() - INTERVAL '7 days'
      GROUP BY 1
      ORDER BY 1
    `),
  ]);

  const t = totals?.rows?.[0];
  return {
    total: Number(t?.total || 0),
    new_count: Number(t?.new_count || 0),
    today: Number(t?.today || 0),
    last7days: Number(t?.last7days || 0),
    last30days: Number(t?.last30days || 0),
    by_platform: (platforms?.rows || []).map((r) => ({
      platform: r.platform,
      count: Number(r.count || 0),
    })),
    by_kind: (kinds?.rows || []).map((r) => ({
      kind: r.kind,
      count: Number(r.count || 0),
    })),
    daily: (daily?.rows || []).map((r) => ({
      day: r.day,
      count: Number(r.count || 0),
    })),
  };
}

export async function readKnowledgeDataFromTrips(): Promise<KnowledgeData> {
  const trips = await listTrips({ limit: 5000 });
  const settings = await getTravelBotSettings();

  const categories = new Map<string, string[]>();
  for (const trip of trips) {
    const key = trip.category || "Uncategorized";
    if (!categories.has(key)) categories.set(key, []);
    categories.get(key)?.push(trip.route_name);
  }

  const packages = Array.from(categories.entries()).map(([category, routes]) => ({
    name: category,
    duration: "Varies by departure date",
    price: "NEEDS_MANUAL_FIX" as ProgramPrice,
    target: "Travel category",
    description: routes.join("; "),
  }));

  const modules = trips.map((trip) => {
    const details: string[] = [];
    if (trip.departure_dates.length) {
      details.push(`Departure dates: ${trip.departure_dates.join(", ")}`);
    }
    if (trip.seats_left != null) {
      details.push(`Seats left: ${trip.seats_left}`);
    }
    if (trip.seats_total != null) {
      details.push(`Seats total: ${trip.seats_total}`);
    }
    if (trip.has_food != null) {
      details.push(`Food: ${trip.has_food ? "yes" : "no"}`);
    }
    if (trip.status !== "active") {
      details.push(`Status: ${trip.status}`);
    }
    if (trip.hotel) details.push(`Hotel: ${trip.hotel}`);
    if (trip.notes) details.push(`Notes: ${trip.notes}`);

    return {
      name: trip.route_name,
      duration: trip.duration_text || "Unknown",
      price:
        typeof trip.adult_price === "number"
          ? trip.adult_price
          : ("NEEDS_MANUAL_FIX" as ProgramPrice),
      target: trip.operator_name,
      description: [trip.source_description, ...details].filter(Boolean).join(" | "),
    };
  });

  return {
    packages,
    modules,
    special_offers: settings.special_offers,
    discount_policies: settings.discount_policies,
    verified_credentials: settings.verified_credentials,
    faq: settings.faq,
    conflicts_found: [],
  };
}

export async function getDbDiagnostics() {
  const ready = await ensureTravelSchema();
  if (!ready) {
    return {
      configured: Boolean(env.neonDatabaseUrl),
      schemaReady: false,
      trips: 0,
      lastUpdatedAt: null as string | null,
      settingsConfigured: false,
      settingsUpdatedAt: null as string | null,
    };
  }
  const result = await queryNeon<{ count: string; max_updated_at: string | null }>(
    `
      SELECT
        COUNT(*)::text AS count,
        MAX(updated_at)::text AS max_updated_at
      FROM travel_trip_entries
    `,
  );
  const settings = await getTravelBotSettings();
  return {
    configured: Boolean(env.neonDatabaseUrl),
    schemaReady: true,
    trips: Number(result?.rows?.[0]?.count || 0),
    lastUpdatedAt: result?.rows?.[0]?.max_updated_at || null,
    settingsConfigured: Boolean(
      settings.business_name.trim() && settings.system_prompt.trim(),
    ),
    settingsUpdatedAt: settings.updated_at || null,
  };
}

export async function maybeRecordTravelMetric(action: string) {
  recordCounter("travel.ops.action_total", 1, { action });
}

/* ----------------------------------------------------------------
   Broadcast
   ---------------------------------------------------------------- */

/** Returns unique Messenger sender_ids from leads (opted-in by having engaged). */
export async function getMessengerRecipients(
  platform: "facebook" | "instagram" = "facebook",
  limit = 2000,
): Promise<string[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 5000);
  const result = await queryNeon<{ sender_id: string }>(
    `
      SELECT DISTINCT sender_id
      FROM travel_leads
      WHERE platform = $1
        AND sender_id <> ''
      ORDER BY sender_id
      LIMIT $2
    `,
    [platform, safeLimit],
  );
  return (result?.rows || []).map((r) => r.sender_id).filter(Boolean);
}

export async function createBroadcastRecord(
  message: string,
  platform: string,
): Promise<BroadcastRecord | null> {
  const ready = await ensureTravelSchema();
  if (!ready) return null;
  const result = await queryNeon<Record<string, unknown>>(
    `
      INSERT INTO travel_broadcasts (message, platform, status)
      VALUES ($1, $2, 'sending')
      RETURNING *
    `,
    [message.slice(0, 2000), platform],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  return {
    id: Number(row.id),
    message: String(row.message || ""),
    platform: String(row.platform || ""),
    sent_count: Number(row.sent_count || 0),
    failed_count: Number(row.failed_count || 0),
    status: String(row.status || "pending"),
    created_at: String(row.created_at || ""),
    finished_at: row.finished_at ? String(row.finished_at) : null,
  };
}

export async function finalizeBroadcast(
  id: number,
  sentCount: number,
  failedCount: number,
): Promise<void> {
  const ready = await ensureTravelSchema();
  if (!ready) return;
  await queryNeon(
    `
      UPDATE travel_broadcasts
      SET sent_count = $1, failed_count = $2, status = 'done', finished_at = NOW()
      WHERE id = $3
    `,
    [sentCount, failedCount, id],
  );
}

export async function listBroadcasts(limit = 20): Promise<BroadcastRecord[]> {
  const ready = await ensureTravelSchema();
  if (!ready) return [];
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  const result = await queryNeon<Record<string, unknown>>(
    `SELECT * FROM travel_broadcasts ORDER BY created_at DESC LIMIT $1`,
    [safeLimit],
  );
  return (result?.rows || []).map((row) => ({
    id: Number(row.id),
    message: String(row.message || ""),
    platform: String(row.platform || ""),
    sent_count: Number(row.sent_count || 0),
    failed_count: Number(row.failed_count || 0),
    status: String(row.status || "pending"),
    created_at: String(row.created_at || ""),
    finished_at: row.finished_at ? String(row.finished_at) : null,
  }));
}

export {
  AI_CHANGE_GEMINI_TIMEOUT_MS,
  AI_CHANGE_GEMINI_MAX_RETRIES,
  AI_CHANGE_REPAIR_TIMEOUT_MS,
  FILE_PARSE_MODEL,
  FILE_PARSE_VERIFY,
  FILE_PARSE_VERIFY_TIMEOUT_MS,
  FILE_PARSE_GEMINI_TIMEOUT_MS,
  FILE_PARSE_GEMINI_MAX_RETRIES,
  FILE_PARSE_BATCH_DELAY_MS,
  FILE_PARSE_TOTAL_BUDGET_MS,
  FILE_PARSE_MIN_BATCH_TIMEOUT_MS,
  FILE_PARSE_REPAIR_TIMEOUT_MS,
};
