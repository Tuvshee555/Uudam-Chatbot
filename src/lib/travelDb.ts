import { randomUUID } from "crypto";
import { getEnv } from "./env";
import { fixMojibake } from "./encoding";
import {
  logError,
  recordCounter,
} from "./observability";
import { queryNeon } from "./neonDb";
import { ensureTravelSchema } from "./travelSchema";
// Re-exported so existing importers (travelOps, googleDriveSync, travelAI, …)
// that import ensureTravelSchema from ./travelDb keep working after the split.
export { ensureTravelSchema } from "./travelSchema";
import { filterFutureDepartureDates, resolveDepartureDatesAtWrite, type ResolvedDepartureDate } from "./travelDates";
import { normalizeExtra } from "./tripExtraSchema";
import {
  normalizeTripName,
  tokenCoverageScore,
} from "./tripPhotoImport/normalize";
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
// Cap each batch at 30s. With small (4-trip) chunks a healthy call returns in
// ~15-20s; a 30s ceiling means a stuck batch fails fast and leaves budget for
// the remaining chunks instead of eating 45s. Never exceed the env timeout.
const FILE_PARSE_GEMINI_TIMEOUT_MS = Math.min(env.geminiTimeoutMs, 30_000);
// One retry max for file parsing — a 45s timeout retried twice burns 90s+
// before falling back. Keep it to a single attempt per batch.
const FILE_PARSE_GEMINI_MAX_RETRIES = 0;
const FILE_PARSE_BATCH_DELAY_MS = 500;
// The parse-file route allows maxDuration: 180s; budget most of it so a
// multi-chunk DOCX (5-6 batches) can finish all batches in one request.
const FILE_PARSE_TOTAL_BUDGET_MS = 165_000;
const FILE_PARSE_MIN_BATCH_TIMEOUT_MS = 8_000;
const FILE_PARSE_REPAIR_TIMEOUT_MS = 15_000;
const FILE_PARSE_VERIFY_TIMEOUT_MS = 45_000;
// Model used when OpenAI is the primary file parser.
const OPENAI_FILE_PARSE_MODEL =
  process.env.OPENAI_FILE_PARSE_MODEL || "gpt-4o";
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

function normalizeStoredUrlList(value: unknown): string[] {
  const toUrls = (items: unknown[]) =>
    items
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .filter((url) => url.startsWith("https://"))
      .slice(0, 20);

  if (Array.isArray(value)) return toUrls(value);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) return toUrls(parsed);
    } catch {}
  }
  return [];
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
  if (typeof input.operator_name === "string") {
    cleaned.operator_name = normalizeOperatorName(input.operator_name);
  }
  if (typeof input.route_name === "string") cleaned.route_name = input.route_name.trim();
  if (typeof input.duration_text === "string") cleaned.duration_text = input.duration_text.trim();
  if (typeof input.currency === "string" && input.currency.trim()) {
    cleaned.currency = input.currency.trim().toUpperCase();
  }
  if (Array.isArray(input.departure_dates)) {
    cleaned.departure_dates = expandMongolianDepartureDates(input.departure_dates)
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
  if (Array.isArray(input.photo_urls)) {
    cleaned.photo_urls = input.photo_urls
      .filter((url): url is string => typeof url === "string")
      .map((url) => url.trim())
      .filter((url) => url.startsWith("https://"))
      .slice(0, 20);
  }
  if (input.extra && typeof input.extra === "object" && !Array.isArray(input.extra)) {
    cleaned.extra = input.extra;
  }
  return cleaned;
}

export function expandMongolianDepartureDates(values: unknown[]): string[] {
  const result: string[] = [];
  const add = (value: string) => {
    const cleaned = value.trim();
    if (cleaned && !result.includes(cleaned)) result.push(cleaned);
  };

  // The model sometimes hallucinates a past year (e.g. 2023) onto a date that
  // the source wrote as month/day only. Anything before this year is bogus and
  // gets converted to "M сарын D" so the wrong year is never stored.
  const minValidYear = new Date().getFullYear();
  const fixHallucinatedYear = (value: string): string => {
    const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const year = Number(iso[1]);
      if (year < minValidYear) {
        return `${Number(iso[2])} сарын ${Number(iso[3])}`;
      }
    }
    return value;
  };

  for (const rawValue of values) {
    const value = fixHallucinatedYear(String(rawValue || "").trim());
    if (!value) continue;
    const monthMatches = Array.from(
      value.matchAll(/(\d{1,2})\s*(?:-?р\s*)?сарын\s*/gi),
    );
    if (monthMatches.length === 0) {
      add(value);
      continue;
    }

    const expanded: string[] = [];
    let allGroupsReadable = true;
    for (let index = 0; index < monthMatches.length; index += 1) {
      const match = monthMatches[index];
      const month = Number(match[1]);
      const start = (match.index || 0) + match[0].length;
      const end = monthMatches[index + 1]?.index ?? value.length;
      const dayText = value
        .slice(start, end)
        .replace(/[,.;\s]+$/g, "")
        .trim();
      if (
        month < 1 ||
        month > 12 ||
        !/^\d{1,2}(?:\s*,\s*\d{1,2})*$/.test(dayText)
      ) {
        allGroupsReadable = false;
        break;
      }
      const days = dayText.split(",").map((day) => Number(day.trim()));
      if (days.some((day) => day < 1 || day > 31)) {
        allGroupsReadable = false;
        break;
      }
      days.forEach((day) => expanded.push(`${month} сарын ${day}`));
    }

    if (!allGroupsReadable || expanded.length === 0) {
      add(value);
      continue;
    }
    // Preserve a recurring schedule when it shares one string with exact dates.
    if (isRecurringDepartureText(value)) {
      const recurring = value.match(
        /(?:даваа|мягмар|лхагва|пүрэв|баасан|бямба|ням)\s+гар(?:а|и)г\s+(?:бүр|болгон)|долоо\s*хоног\s+бүр|сар\s+бүр|өдөр\s+(?:бүр|болгон|тутам)/i,
      );
      add(recurring?.[0] || value);
    }
    expanded.forEach(add);
  }
  return result;
}

export function normalizeOperatorName(value: string): string {
  const trimmed = value.trim();
  const normalized = trimmed
    .toLowerCase()
    .replace(/[.,:;!?()[\]{}"']/g, "")
    .replace(/\s+/g, " ");
  if (
    normalized === "uudam" ||
    normalized === "uudam travel" ||
    normalized === "uudam travel agency"
  ) {
    return "UUDAM TRAVEL AGENCY";
  }
  return trimmed;
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
  const competingMainBrands =
    (normalized.includes("хоёр өөр") ||
      normalized.includes("two different") ||
      normalized.includes("competing")) &&
    (normalized.includes("header") ||
      normalized.includes("лого") ||
      normalized.includes("logo") ||
      normalized.includes("толгой"));
  if (competingMainBrands) return false;
  return (
    normalized.includes("uudam travel agency") ||
    normalized === "uudam travel" ||
    normalized === "travel agency"
  );
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
    // Merge into existing extra (COALESCE so null extra becomes {}) so that
    // GreetingTab and SeasonsTab don't overwrite each other's keys.
    values.push(JSON.stringify(fields.extra));
    sets.push(`extra = COALESCE(extra, '{}'::jsonb) || $${values.length}::jsonb`);
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
    photo_urls: normalizeStoredUrlList(row.photo_urls),
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
      photo_only: false,
      updated_at: new Date().toISOString(),
    };
  }
  const result = await queryNeon<Record<string, unknown>>(
    `SELECT bot_paused, pause_reason, photo_only, updated_at FROM travel_bot_control WHERE id = TRUE LIMIT 1`,
  );
  const row = result?.rows?.[0];
  const value: BotControl = {
    bot_paused: Boolean(row?.bot_paused),
    pause_reason: row?.pause_reason ? String(row.pause_reason) : null,
    photo_only: Boolean(row?.photo_only),
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
      INSERT INTO travel_bot_control (id, bot_paused, pause_reason, photo_only, updated_at)
      VALUES (TRUE, $1, $2, FALSE, NOW())
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

export async function setPhotoOnly(enabled: boolean) {
  const ready = await ensureTravelSchema();
  if (!ready) return false;
  const result = await queryNeon(
    `
      INSERT INTO travel_bot_control (id, bot_paused, pause_reason, photo_only, updated_at)
      VALUES (TRUE, FALSE, NULL, $1, NOW())
      ON CONFLICT (id)
      DO UPDATE SET
        photo_only = EXCLUDED.photo_only,
        updated_at = NOW()
    `,
    [enabled],
  );
  botControlCache = null;
  return Boolean(result);
}

export async function isBotGloballyPaused() {
  const control = await getBotControl();
  return control.bot_paused;
}

export async function isBotPhotoOnly() {
  const control = await getBotControl();
  return control.photo_only;
}

const UNPAUSED_PAGE_DEFAULT = (): BotControl => ({
  bot_paused: false,
  pause_reason: null,
  photo_only: false,
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
    photo_only: false,
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
  const departureDatesForWrite = cleaned.departure_dates || [];
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
    departure_dates: departureDatesForWrite,
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
    extra: normalizeExtra({
      ...((cleaned.extra || {}) as Record<string, unknown>),
      // Freeze the year of each departure date at write time so reads never
      // re-guess (fixes bare next-season dates being hidden as "past").
      departure_dates_resolved: resolveDepartureDatesAtWrite(departureDatesForWrite),
    }).extra,
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
  // When a full extra object is patched alongside departure_dates (the admin
  // editor always sends both), freeze the resolved ISO dates into that extra so
  // reads stop re-guessing the year. We only do this when extra is present — a
  // partial extra patch would let normalizeExtra's defaults wipe existing keys.
  if (
    Array.isArray(cleaned.departure_dates) &&
    cleaned.extra &&
    typeof cleaned.extra === "object"
  ) {
    (cleaned.extra as Record<string, unknown>).departure_dates_resolved =
      resolveDepartureDatesAtWrite(cleaned.departure_dates as string[]);
  }
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

  keys.forEach((key) => {
    const column = columnMap[key];
    if (key === "extra") {
      // Normalise then merge into existing extra (preserves keys set by AI import)
      const { extra: normalisedExtra } = normalizeExtra(
        (cleaned[key] ?? {}) as Record<string, unknown>,
      );
      values.push(JSON.stringify(normalisedExtra));
      sets.push(`${column} = COALESCE(${column}, '{}'::jsonb) || $${values.length}::jsonb`);
    } else if (JSONB_KEYS.has(key)) {
      values.push(JSON.stringify(cleaned[key] ?? []));
      const placeholder = `$${values.length}::jsonb`;
      sets.push(`${column} = ${placeholder}`);
    } else {
      values.push(cleaned[key]);
      const placeholder = key === "departure_dates" ? `$${values.length}::text[]` : `$${values.length}`;
      sets.push(`${column} = ${placeholder}`);
    }
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

export async function deleteAllTrips(): Promise<number> {
  const ready = await ensureTravelSchema();
  if (!ready) return 0;
  const result = await queryNeon(`DELETE FROM travel_trip_entries`);
  return result?.rowCount ?? 0;
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

  // Photo inventory survives DB round-trips so revisions can re-attach.
  const photo_sources = Array.isArray(input.photo_sources)
    ? input.photo_sources
        .filter((s): s is { label: string; urls: string[] } =>
          Boolean(s) && typeof s === "object" && typeof (s as { label?: unknown }).label === "string")
        .map((s) => ({
          label: s.label,
          urls: Array.isArray(s.urls)
            ? s.urls.filter((u): u is string => typeof u === "string")
            : [],
        }))
        .filter((s) => s.urls.length > 0)
    : undefined;

  return {
    summary: String(input.summary || "AI саналыг үүсгэлээ."),
    needs_confirmation: Boolean(input.needs_confirmation),
    important_reason: String(input.important_reason || ""),
    conflicts,
    conflict_items,
    actions: Array.isArray(input.actions)
      ? (input.actions as unknown[]).filter((action) => action && typeof action === "object") as AITripAction[]
      : [],
    ...(photo_sources && photo_sources.length > 0 ? { photo_sources } : {}),
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
  trips: TravelTrip[],
  operatorName?: string,
  routeName?: string,
): TravelTrip[] {
  const operator = operatorName
    ? normalizeTripName(normalizeOperatorName(operatorName))
    : "";
  const route = routeName ? normalizeTripName(routeName) : "";
  if (!operator && !route) return [];

  const matches = new Map<string, { trip: TravelTrip; score: number }>();
  for (const trip of trips) {
    const names = [
      trip.route_name,
      ...(Array.isArray(trip.extra?.aliases)
        ? (trip.extra.aliases as string[]).filter((a): a is string => typeof a === "string")
        : []),
    ].filter(Boolean);

    const tripOperator = normalizeTripName(
      normalizeOperatorName(trip.operator_name || ""),
    );

    let operatorScore = 0;
    if (operator) {
      if (tripOperator === operator) {
        operatorScore = 1;
      } else {
        const fuzzy = tokenCoverageScore(operator, trip.operator_name || "");
        if (fuzzy >= 0.8) operatorScore = 0.9;
      }
    }

    let routeScore = 0;
    if (route) {
      for (const name of names) {
        const normalizedName = normalizeTripName(name);
        if (!normalizedName) continue;
        if (normalizedName === route) {
          routeScore = 1;
          break;
        }
        if (
          normalizedName.includes(route) ||
          route.includes(normalizedName)
        ) {
          routeScore = Math.max(routeScore, 0.95);
        }
        const fuzzy = tokenCoverageScore(route, name);
        if (fuzzy > routeScore) routeScore = fuzzy;
      }
    }

    const score = operatorScore + routeScore;
    const hasOperator = Boolean(operator);
    const hasRoute = Boolean(route);
    if (hasOperator && hasRoute && score < 1.6) continue;
    if ((hasOperator || hasRoute) && score < 0.7) continue;

    const existing = matches.get(trip.id);
    if (!existing || existing.score < score) {
      matches.set(trip.id, { trip, score });
    }
  }

  return Array.from(matches.values())
    .sort((a, b) => b.score - a.score)
    .map((m) => m.trip);
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

// Re-exported so existing importers keep working; the single source of truth
// now lives in travelFastPathsSearch.ts (dependency-free, no DB/env imports)
// so fast-path reply builders can use the same check without pulling in the
// database layer.
export { isGenericConfirmationText } from "./travelFastPathsSearch";
import { isGenericConfirmationText } from "./travelFastPathsSearch";

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

// Lead capture/CRM lives in travelLeadsDb.ts (kept this file under the
// 2,000-line cap). Re-exported so existing importers keep working unchanged.
export * from "./travelLeadsDb";

export async function readKnowledgeDataFromTrips(): Promise<KnowledgeData> {
  const trips = await listTrips({ limit: 5000 });
  const settings = await getTravelBotSettings();

  const visibleTrips = trips.filter((trip) => {
    if (trip.status !== "active") return false;
    const ex = (trip.extra || {}) as Record<string, unknown>;
    if (typeof ex.customer_visible === "boolean" && !ex.customer_visible) return false;
    return true;
  });

  const categories = new Map<string, string[]>();
  for (const trip of visibleTrips) {
    const key = trip.category || "Uncategorized";
    if (!categories.has(key)) categories.set(key, []);
    categories.get(key)?.push(trip.route_name);
  }

  // Category → route-name index. Kept clean of English/sentinel filler
  // ("Varies by departure date", "Travel category", NEEDS_MANUAL_FIX) that the
  // model could echo to a customer; only the category name and its routes carry
  // meaning here, so the rest is left blank and the formatter omits it.
  const packages = Array.from(categories.entries()).map(([category, routes]) => ({
    name: category,
    duration: "",
    price: "NEEDS_MANUAL_FIX" as ProgramPrice,
    target: "",
    description: routes.join("; "),
  }));

  // Keep-if-unsure staleness gate for date-keyed price/discount groups: a
  // group whose every parseable date already passed must not be quoted to
  // customers; groups with no parseable dates (labels, recurring text) stay.
  const groupIsCurrent = (dates: unknown): boolean => {
    const list = Array.isArray(dates)
      ? dates.map((d) => String(d ?? "")).filter(Boolean)
      : [];
    if (list.length === 0) return true;
    return filterFutureDepartureDates(list).length > 0;
  };

  const modules = visibleTrips
    .map((trip) => {
    const details: string[] = [];
    // Category is the transport differentiator (газрын / шууд нислэгтэй /
    // хосолсон) — without it the bot cannot distinguish the three "Бээжин"
    // trips when a customer names only the destination.
    if (trip.category) {
      details.push(`Ангилал: ${trip.category}`);
    }
    // Past departure dates are stripped so the bot can never quote a date
    // that already happened. If nothing remains, the schedule is emitted as
    // unknown and the REFER policy sends the customer to a consultant. The
    // write-time resolved map (when present) freezes each date's year so a
    // genuine next-season departure is not mistaken for a past one.
    const resolvedDepartureDates = ((trip.extra || {}) as Record<string, unknown>)
      .departure_dates_resolved as ResolvedDepartureDate[] | undefined;
    const futureDepartureDates = filterFutureDepartureDates(
      trip.departure_dates,
      new Date(),
      resolvedDepartureDates,
    );
    if (futureDepartureDates.length) {
      // Annotate each date with its frozen ISO year (when known) so the model
      // is not left guessing whether "1 сарын 15" means this January or next.
      const resolvedMap = new Map<string, string | null>();
      for (const entry of resolvedDepartureDates || []) {
        if (entry && typeof entry.text === "string") resolvedMap.set(entry.text, entry.ymd ?? null);
      }
      const annotated = futureDepartureDates.map((text) => {
        const ymd = resolvedMap.get(text);
        return ymd ? `${text} (${ymd})` : text;
      });
      details.push(`Departure dates: ${annotated.join(", ")}`);
    }
    if (typeof trip.child_price === "number") {
      details.push(`Child price: ${trip.child_price}`);
    }
    // Emit structured price groups so the bot can answer per-date pricing questions
    const extra = (trip.extra || {}) as Record<string, unknown>;
    const priceGroups = (Array.isArray(extra.departure_date_groups) ? extra.departure_date_groups : [])
      .filter((g) => groupIsCurrent((g as Record<string, unknown>)?.dates));
    if (priceGroups.length > 0) {
      const groupText = (priceGroups as Array<Record<string, unknown>>)
        .map((g) => {
          const dates = Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
          const ap = typeof g.adult_price === "number" ? `adult ${g.adult_price}` : "";
          const cp = typeof g.child_price === "number" ? `child ${g.child_price}` : "";
          const ip = typeof g.infant_price === "number" ? `infant ${g.infant_price}` : "";
          const notes = typeof g.notes === "string" && g.notes.trim() ? ` (${g.notes.trim()})` : "";
          return `[${dates}: ${[ap, cp, ip].filter(Boolean).join(" / ")}${notes}]`;
        })
        .join("; ");
      details.push(`Price groups: ${groupText}`);
    }
    // Emit discount groups if present
    const discountGroups = (Array.isArray(extra.discount_groups) ? extra.discount_groups : [])
      .filter((g) => groupIsCurrent((g as Record<string, unknown>)?.dates));
    if (discountGroups.length > 0) {
      const discountText = (discountGroups as Array<Record<string, unknown>>)
        .map((g) => {
          const dates = Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
          const ap = typeof g.adult_price === "number" ? `adult ${g.adult_price}` : "";
          const cp = typeof g.child_price === "number" ? `child ${g.child_price}` : "";
          const ip = typeof g.infant_price === "number" ? `infant ${g.infant_price}` : "";
          return `[${dates}: ${[ap, cp, ip].filter(Boolean).join(" / ")}]`;
        })
        .join("; ");
      details.push(`Discount groups: ${discountText}`);
    }
    // Emit child age range and infant age range if stored
    if (typeof extra.child_age_range === "string" && extra.child_age_range) {
      details.push(`Child age range: ${extra.child_age_range}`);
    }
    if (typeof extra.infant_age_range === "string" && extra.infant_age_range) {
      details.push(`Infant age range: ${extra.infant_age_range}`);
    }
    // Emit admin-entered structured fields
    const aliases = Array.isArray(extra.aliases) ? (extra.aliases as string[]).filter(Boolean) : [];
    if (aliases.length > 0) details.push(`Өөр нэршил: ${aliases.join(", ")}`);
    const pgNew = (Array.isArray(extra.price_groups) ? extra.price_groups as Array<Record<string, unknown>> : [])
      .filter((g) => groupIsCurrent(g?.dates));
    if (pgNew.length > 0) {
      const pgText = pgNew.map((g) => {
        const displayDates = Array.isArray(g.display_dates) && (g.display_dates as string[]).length > 0
          ? (g.display_dates as string[]).join(", ")
          : Array.isArray(g.dates) ? (g.dates as string[]).join(", ") : String(g.dates ?? "");
        const label = typeof g.label === "string" && g.label ? `${g.label}: ` : "";
        // Use passenger_prices if present (more detailed), otherwise fallback to flat fields
        const ppArr = Array.isArray(g.passenger_prices) ? g.passenger_prices as Array<Record<string, unknown>> : [];
        let priceParts: string[];
        if (ppArr.length > 0) {
          priceParts = ppArr.map((pp) => {
            const ppLabel = typeof pp.label === "string" && pp.label ? pp.label : "Зорчигч";
            const ppAge = typeof pp.age_range === "string" && pp.age_range ? ` (${pp.age_range})` : "";
            const ppPrice = typeof pp.price === "number" ? ` ${pp.price}₮` : "";
            return `${ppLabel}${ppAge}${ppPrice}`;
          });
        } else {
          priceParts = [
            typeof g.adult_price === "number" ? `Том ${g.adult_price}₮` : "",
            typeof g.child_price === "number" ? `Хүүхэд${g.child_age ? ` (${g.child_age})` : ""} ${g.child_price}₮` : "",
            typeof g.infant_price === "number" ? `Нярай${g.infant_age ? ` (${g.infant_age})` : ""} ${g.infant_price}₮` : "",
          ].filter(Boolean);
        }
        const note = typeof g.note === "string" && g.note ? ` — ${g.note}` : "";
        return `[${label}${displayDates}: ${priceParts.filter(Boolean).join(" / ")}${note}]`;
      }).join("; ");
      details.push(`Огноо тус бүрийн үнэ: ${pgText}`);
    }
    const discNew = (Array.isArray(extra.discounts) ? extra.discounts as Array<Record<string, unknown>> : [])
      .filter((g) => groupIsCurrent(g?.dates));
    if (discNew.length > 0) {
      const discText = discNew.map((g) => {
        const dates = Array.isArray(g.dates) && (g.dates as string[]).length > 0 ? ` (${(g.dates as string[]).join(", ")})` : "";
        const label = typeof g.label === "string" && g.label ? g.label : "Хямдрал";
        const ap = typeof g.adult_price === "number" ? `Том ${g.adult_price}₮` : "";
        const cp = typeof g.child_price === "number" ? `Хүүхэд ${g.child_price}₮` : "";
        const ip = typeof g.infant_price === "number" ? `Нярай ${g.infant_price}₮` : "";
        const cond = typeof g.condition === "string" && g.condition ? ` Нөхцөл: ${g.condition}` : "";
        const note = typeof g.note === "string" && g.note ? ` — ${g.note}` : "";
        return `[${label}${dates}: ${[ap, cp, ip].filter(Boolean).join(" / ")}${cond}${note}]`;
      }).join("; ");
      details.push(`Хямдрал: ${discText}`);
    }
    const childRules = Array.isArray(extra.child_rules) ? extra.child_rules as Array<Record<string, unknown>> : [];
    if (childRules.length > 0) {
      const crText = childRules.map((r) => {
        const label = typeof r.label === "string" && r.label ? r.label : "";
        const age = typeof r.age_range === "string" && r.age_range ? r.age_range : "";
        const price = typeof r.price === "number" ? `${r.price}₮` : "";
        return [label, age, price].filter(Boolean).join(" ");
      }).join("; ");
      details.push(`Хүүхдийн насны ангилал: ${crText}`);
    }
    const extraFees = Array.isArray(extra.extra_fees) ? extra.extra_fees as Array<Record<string, unknown>> : [];
    if (extraFees.length > 0) {
      const efText = extraFees.map((f) => {
        const label = typeof f.label === "string" && f.label ? f.label : "Нэмэлт";
        const amount = typeof f.amount === "number" ? `${f.amount}${typeof f.currency === "string" ? f.currency : ""}` : "";
        return `${label}${amount ? `: ${amount}` : ""}`;
      }).join("; ");
      details.push(`Нэмэлт төлбөр: ${efText}`);
    }
    if (typeof extra.departure_rule === "string" && extra.departure_rule.trim()) {
      details.push(`Гарах өдрийн дүрэм: ${extra.departure_rule.trim()}`);
    }
    const included = Array.isArray(extra.included_items) ? (extra.included_items as string[]).filter(Boolean) : [];
    if (included.length > 0) details.push(`Багтсан: ${included.join(", ")}`);
    const excluded = Array.isArray(extra.excluded_items) ? (extra.excluded_items as string[]).filter(Boolean) : [];
    if (excluded.length > 0) details.push(`Багтаагүй: ${excluded.join(", ")}`);
    const roomPrices = Array.isArray(extra.room_prices) ? extra.room_prices as Array<Record<string, unknown>> : [];
    if (roomPrices.length > 0) {
      const rpText = roomPrices.map((r) => {
        const type = typeof r.room_type === "string" && r.room_type ? r.room_type : "Өрөө";
        const price = typeof r.price === "number" ? `${r.price}${typeof r.currency === "string" ? r.currency : ""}` : "";
        return `${type}${price ? `: ${price}` : ""}`;
      }).join("; ");
      details.push(`Өрөөний үнэ: ${rpText}`);
    }
    const impNotes = Array.isArray(extra.important_notes)
      ? (extra.important_notes as string[]).filter(Boolean).filter((note) => !isGenericConfirmationText(note))
      : [];
    if (impNotes.length > 0) details.push(`Чухал тэмдэглэл: ${impNotes.join(" | ")}`);
    // Booking terms — lets the bot answer deposit/payment/documents/visa/
    // cancellation questions from stored data instead of REFER. Empty fields
    // are omitted, so a field the trip lacks stays "unknown" → REFER.
    const bookingTerms = (extra.booking_terms || {}) as Record<string, unknown>;
    const btParts: string[] = [];
    if (typeof bookingTerms.deposit === "string" && bookingTerms.deposit.trim()) btParts.push(`Урьдчилгаа: ${bookingTerms.deposit.trim()}`);
    if (typeof bookingTerms.payment === "string" && bookingTerms.payment.trim()) btParts.push(`Төлбөрийн нөхцөл: ${bookingTerms.payment.trim()}`);
    if (typeof bookingTerms.documents === "string" && bookingTerms.documents.trim()) btParts.push(`Бүрдүүлэх бичиг баримт: ${bookingTerms.documents.trim()}`);
    if (typeof bookingTerms.visa === "string" && bookingTerms.visa.trim()) btParts.push(`Виз: ${bookingTerms.visa.trim()}`);
    if (typeof bookingTerms.cancellation === "string" && bookingTerms.cancellation.trim()) btParts.push(`Цуцлалт/буцаалт: ${bookingTerms.cancellation.trim()}`);
    if (btParts.length > 0) details.push(`Захиалгын нөхцөл: ${btParts.join(" | ")}`);
    // Emit answer_hints so the bot gets explicit expected answers per intent
    const answerHints = Array.isArray(extra.answer_hints) ? extra.answer_hints as Array<Record<string, unknown>> : [];
    if (answerHints.length > 0) {
      const hintText = answerHints.map((h) => {
        const intent = typeof h.intent === "string" ? h.intent : "";
        const qp = typeof h.question_pattern === "string" ? h.question_pattern : "";
        const expected = typeof h.expected_answer_summary === "string" ? h.expected_answer_summary : "";
        return `[${intent}: "${qp}" → ${expected}]`;
      }).join("; ");
      details.push(`Хариултын заавар: ${hintText}`);
    }
    // seats: only emit if actually known (null = unknown, 0 = sold out)
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
    if (trip.notes && !isGenericConfirmationText(trip.notes)) details.push(`Notes: ${trip.notes}`);

    return {
      name: trip.route_name,
      duration: isGenericConfirmationText(trip.duration_text) ? "" : trip.duration_text || "",
      price:
        typeof trip.adult_price === "number"
          ? trip.adult_price
          : ("NEEDS_MANUAL_FIX" as ProgramPrice),
      target: trip.operator_name,
      description: [trip.source_description, ...details]
        .filter(Boolean)
        .filter((value) => !isGenericConfirmationText(value))
        .join(" | "),
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

// Conversation & sender-session state lives in travelSessionDb.ts (kept this
// file under the 2,000-line cap). Re-exported so existing importers of
// dbGetHistory/dbTrackSender/etc. from ./travelDb keep working unchanged.
export * from "./travelSessionDb";

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
  OPENAI_FILE_PARSE_MODEL,
};
