import Head from "next/head";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Icons,
  Input,
  Modal,
  Select,
  Spinner,
  Textarea,
  cx,
  useToast,
} from "@/components/ui";

/* ----------------------------------------------------------------
   Types
   ---------------------------------------------------------------- */
type TripStatus = "active" | "cancelled" | "sold_out" | "draft";

type TravelTrip = {
  id: string;
  category: string;
  operator_name: string;
  route_name: string;
  duration_text: string;
  adult_price: number | null;
  child_price: number | null;
  currency: string;
  departure_dates: string[];
  seats_total: number | null;
  seats_left: number | null;
  has_food: boolean | null;
  status: TripStatus;
  notes: string;
  source_description: string;
  updated_at: string;
};

type PauseRow = {
  sender_id: string;
  paused_at: string;
  expires_at: string | null;
  reason?: string;
};

type RecentRow = { sender_id: string; last_seen: string };

type ControlState = {
  bot_paused: boolean;
  pause_reason: string | null;
  updated_at: string;
};

type TravelBotSettings = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string[];
  comment_trigger_patterns: string[];
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: Record<string, unknown>[];
  discount_policies: Record<string, unknown>[];
  verified_credentials: Record<string, unknown>[];
  faq: Record<string, unknown>[];
  handoff_enabled: boolean;
  handoff_keywords: string[];
  handoff_reply: string;
  handoff_pause_minutes: number;
  updated_at: string;
};

type StructuredRow = Record<string, string>;

type SettingsForm = {
  business_name: string;
  system_prompt: string;
  quick_info_reply: string;
  quick_info_keywords: string;
  comment_trigger_patterns: string;
  comment_public_reply: string;
  comment_dm_reply: string;
  special_offers: StructuredRow[];
  discount_policies: StructuredRow[];
  verified_credentials: StructuredRow[];
  faq: StructuredRow[];
  handoff_enabled: boolean;
  handoff_keywords: string;
  handoff_reply: string;
  handoff_pause_minutes: string;
};

type AIAction = {
  action: string;
  trip_id?: string;
  match?: { operator_name?: string; route_name?: string };
  fields?: Record<string, unknown>;
};

type AIProposal = {
  summary: string;
  needs_confirmation: boolean;
  important_reason: string;
  conflicts: string[];
  actions: AIAction[];
};

type ClarificationOption = {
  label: string;
  answer: string;
};

type ClarificationQuestion = {
  id: string;
  prompt: string;
  detail?: string;
  options: ClarificationOption[];
  allowCustom?: boolean;
  customPlaceholder?: string;
};

type ClarificationAnswer = {
  questionId: string;
  prompt: string;
  answer: string;
};

type AdminMsg = {
  id: string;
  role: "admin";
  text: string;
  fileNames?: string[];
};
type ProposalMsg = {
  id: string;
  role: "assistant";
  kind: "proposal";
  proposal: AIProposal;
  requestId: number | null;
  instruction: string;
  status: "pending" | "applied" | "cancelled" | "error";
  confirmChecked: boolean;
  resultText?: string;
  clarifications: ClarificationQuestion[];
  clarificationAnswers: ClarificationAnswer[];
  answeredClarificationIds: string[];
  customReply: string;
};
type NoteMsg = {
  id: string;
  role: "assistant";
  kind: "note";
  text: string;
  tone: "info" | "error" | "success";
};
type ChatMessage = AdminMsg | ProposalMsg | NoteMsg;

type AttachedFile = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
};

type TabKey = "assistant" | "trips" | "bot" | "leads" | "settings";

type TravelLead = {
  id: number;
  kind: "handoff" | "booking";
  platform: string;
  sender_id: string;
  customer_message: string;
  contact_phone: string;
  context: string;
  status: "new" | "seen";
  created_at: string;
  seen_at: string | null;
};

type DriveSyncRecentFile = {
  file_id: string;
  file_name: string;
  last_status: string;
  last_error: string;
  request_id: number | null;
  updated_at: string;
};

type DriveSyncDiagnostics = {
  enabled: boolean;
  configured: boolean;
  folder_id: string | null;
  service_account_email: string | null;
  interval_minutes: number;
  file_limit: number;
  state: {
    status: "idle" | "running" | "success" | "warning" | "error";
    last_checked_at: string | null;
    last_synced_at: string | null;
    last_error: string;
    last_summary: string;
    last_run_id: string;
    files_examined: number;
    files_changed: number;
    files_applied: number;
    files_blocked: number;
    updated_at: string | null;
  };
  recent_files: DriveSyncRecentFile[];
};

/* ----------------------------------------------------------------
   Constants & helpers
   ---------------------------------------------------------------- */
const SECRET_KEY = "travel_admin_secret";
const SECRET_TS_KEY = "travel_admin_secret_ts";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const ADMIN_AUTO_REFRESH_MS =
  process.env.NODE_ENV === "development" ? 0 : 45_000;
const ACCEPT_FILES =
  ".xlsx,.xlsm,.csv,.pdf,.png,.jpg,.jpeg,.webp,.gif,.txt,image/*,application/pdf";

const STATUS_LABELS: Record<TripStatus, string> = {
  active: "Идэвхтэй",
  cancelled: "Цуцлагдсан",
  sold_out: "Суудал дууссан",
  draft: "Ноорог",
};

const STATUS_TONE: Record<TripStatus, "success" | "danger" | "warning" | "neutral"> =
  {
    active: "success",
    cancelled: "danger",
    sold_out: "warning",
    draft: "neutral",
  };

const FIELD_LABELS: Record<string, string> = {
  category: "Ангилал",
  operator_name: "Оператор",
  route_name: "Маршрут",
  duration_text: "Хугацаа",
  adult_price: "Том хүний үнэ",
  child_price: "Хүүхдийн үнэ",
  currency: "Валют",
  departure_dates: "Гарах өдөр",
  seats_total: "Нийт суудал",
  seats_left: "Үлдсэн суудал",
  has_food: "Хоол",
  status: "Төлөв",
  notes: "Тэмдэглэл",
  source_description: "Эх сурвалж",
};

const DURATIONS: Array<{ label: string; ms: number | null }> = [
  { label: "10 мин", ms: 10 * 60 * 1000 },
  { label: "30 мин", ms: 30 * 60 * 1000 },
  { label: "1 цаг", ms: 60 * 60 * 1000 },
  { label: "∞", ms: null },
];

const HANDOFF_DURATION_OPTIONS = [
  { label: "30 минут", value: "30" },
  { label: "1 цаг", value: "60" },
  { label: "2 цаг", value: "120" },
  { label: "Гараар сэргээх хүртэл", value: "0" },
] as const;

const HANDOFF_DURATION_CUSTOM = "custom";

const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
  { label: "Аялал цуцлах", prompt: "Дараах аяллыг цуцал: " },
  { label: "Суудал шинэчлэх", prompt: "Дараах аяллын үлдсэн суудлыг шинэчил: " },
  { label: "Үнэ өөрчлөх", prompt: "Дараах аяллын үнийг өөрчил: " },
  { label: "Хоол", prompt: "Дараах аяллын хоолны мэдээллийг өөрчил: " },
  {
    label: "Шинэ аялал",
    prompt:
      "Шинэ аялал нэм. Оператор: , Маршрут: , Хугацаа: , Том хүний үнэ: , Гарах өдөр: ",
  },
];

let idCounter = 0;
function uid(): string {
  idCounter += 1;
  return `m${Date.now().toString(36)}${idCounter}`;
}

function getSecretStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  return window.sessionStorage;
}

const TEST_BOT_CONVERSATION_KEY = "uudam_admin_testbot_conversation_id";

function getTestBotConversationId(): string {
  if (typeof window === "undefined") return "";
  const existing = window.sessionStorage.getItem(TEST_BOT_CONVERSATION_KEY);
  if (existing) return existing;
  const nextId =
    typeof window.crypto?.randomUUID === "function"
      ? window.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 18)}`;
  window.sessionStorage.setItem(TEST_BOT_CONVERSATION_KEY, nextId);
  return nextId;
}

function isEditableElement(element: Element | null): boolean {
  if (!element) return false;
  return element.matches(
    'input, textarea, select, [contenteditable="true"], [role="textbox"]',
  );
}

function asInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function shortId(value: string): string {
  return value.length <= 14 ? value : `…${value.slice(-12)}`;
}

function timeLeft(expiresAt: string | null): string {
  if (!expiresAt) return "∞";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Дууссан";
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return minutes <= 0 ? `${seconds}с` : `${minutes}м ${seconds}с`;
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("mn-MN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function driveSyncTone(
  status: DriveSyncDiagnostics["state"]["status"] | undefined,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "success") return "success";
  if (status === "warning" || status === "running") return "warning";
  if (status === "error") return "danger";
  return "neutral";
}

function toStructuredRows(value: unknown): StructuredRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row: StructuredRow = {};
      for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
        row[key] = typeof val === "string" ? val : val == null ? "" : String(val);
      }
      return row;
    });
}

function settingsToForm(settings: TravelBotSettings): SettingsForm {
  return {
    business_name: settings.business_name || "",
    system_prompt: settings.system_prompt || "",
    quick_info_reply: settings.quick_info_reply || "",
    quick_info_keywords: (settings.quick_info_keywords || []).join("\n"),
    comment_trigger_patterns: (settings.comment_trigger_patterns || []).join("\n"),
    comment_public_reply: settings.comment_public_reply || "",
    comment_dm_reply: settings.comment_dm_reply || "",
    special_offers: toStructuredRows(settings.special_offers),
    discount_policies: toStructuredRows(settings.discount_policies),
    verified_credentials: toStructuredRows(settings.verified_credentials),
    faq: toStructuredRows(settings.faq),
    handoff_enabled: settings.handoff_enabled !== false,
    handoff_keywords: (settings.handoff_keywords || []).join("\n"),
    handoff_reply: settings.handoff_reply || "",
    handoff_pause_minutes: String(settings.handoff_pause_minutes ?? 60),
  };
}

function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function handoffDurationSelectValue(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "60";
  return HANDOFF_DURATION_OPTIONS.some((option) => option.value === trimmed)
    ? trimmed
    : HANDOFF_DURATION_CUSTOM;
}

function describeAction(action: AIAction): {
  verb: string;
  target: string;
  changes: string[];
} {
  const verbRaw = String(action.action || "").toLowerCase();
  const verb =
    verbRaw === "cancel"
      ? "Цуцлах"
      : verbRaw === "upsert"
        ? action.trip_id
          ? "Шинэчлэх"
          : "Шинэ аялал нэмэх"
        : verbRaw === "patch"
          ? "Шинэчлэх"
          : verbRaw || "Үйлдэл";
  const target =
    action.match?.route_name ||
    action.fields?.route_name?.toString() ||
    action.match?.operator_name ||
    action.trip_id ||
    "аялал";
  const fields = action.fields || {};
  const changes: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value == null || value === "") continue;
    const label = FIELD_LABELS[key] || key;
    if (key === "has_food") {
      changes.push(`${label}: ${value ? "Байгаа" : "Байхгүй"}`);
    } else if (key === "status") {
      changes.push(
        `${label}: ${STATUS_LABELS[value as TripStatus] || String(value)}`,
      );
    } else if (key === "departure_dates" && Array.isArray(value)) {
      changes.push(`${label}: ${value.join(", ")}`);
    } else {
      changes.push(`${label}: ${String(value)}`);
    }
  }
  return { verb, target: String(target), changes };
}

function formatMoneyValue(
  amount: number | null | undefined,
  currency?: unknown,
): string {
  if (amount == null || !Number.isFinite(amount)) return "unknown";
  const code = typeof currency === "string" && currency.trim() ? currency.trim() : "";
  return `${amount.toLocaleString("en-US")}${code ? ` ${code}` : ""}`;
}

function extractQuotedValues(text: string): string[] {
  const matches = Array.from(text.matchAll(/['"]([^'"]+)['"]/g));
  const values = matches
    .map((match) => match[1]?.trim() || "")
    .filter(Boolean);
  return Array.from(new Set(values));
}

function normalizeReviewText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function summarizeConflict(detail: string): string {
  const normalized = normalizeReviewText(detail);
  const quoted = extractQuotedValues(detail);
  const subject = quoted[0] || "Энэ аялал";

  if (normalized.includes("хүүхдийн үнэ") || normalized.includes("child price")) {
    return `${subject}: хүүхдийн болон том хүний үнэ зөрүүтэй байна.`;
  }
  if (normalized.includes("юань") || normalized.includes("cny") || normalized.includes("валют")) {
    return `${subject}: үнэ хэдэн валютаар орж ирсэн байна.`;
  }
  if (normalized.includes("хоол") || normalized.includes("meal")) {
    return `${subject}: хоол багтсан эсэх нь тодорхойгүй байна.`;
  }
  if (
    normalized.includes("batch failed") ||
    normalized.includes("503") ||
    normalized.includes("upstream")
  ) {
    return "Зарим файл түр уншигдаагүй байна.";
  }
  if (
    normalized.includes("6-р сард") ||
    normalized.includes("7-р сард") ||
    normalized.includes("8-р сард")
  ) {
    return `${subject}: сар бүрийн үнэ өөр байна.`;
  }
  return `${subject}: нэмэлт шалгалт хэрэгтэй.`;
}

function buildProposalClarifications(
  proposal: AIProposal,
  answeredIds: string[] = [],
): ClarificationQuestion[] {
  const questions: ClarificationQuestion[] = [];
  const seen = new Set(answeredIds);
  const coveredConflictChecks: Array<(normalized: string) => boolean> = [];

  function pushQuestion(question: ClarificationQuestion | null) {
    if (!question) return;
    if (seen.has(question.id)) return;
    seen.add(question.id);
    questions.push(question);
  }

  proposal.actions.forEach((action, index) => {
    const fields = action.fields || {};
    const routeName =
      fields.route_name?.toString().trim() ||
      action.match?.route_name?.trim() ||
      `аялал ${index + 1}`;
    const adultPrice =
      typeof fields.adult_price === "number" ? fields.adult_price : null;
    const childPrice =
      typeof fields.child_price === "number" ? fields.child_price : null;
    const currency =
      typeof fields.currency === "string" ? fields.currency : undefined;
    if (adultPrice != null && childPrice != null && childPrice > adultPrice) {
      const routeKey = normalizeReviewText(routeName);
      coveredConflictChecks.push(
        (normalized) =>
          normalized.includes(routeKey) &&
          (normalized.includes("хүүхдийн үнэ") ||
            normalized.includes("child price") ||
            normalized.includes("том хүний үнэ")),
      );
      pushQuestion({
        id: `child-price:${routeName}`,
        prompt: `"${routeName}" аяллын хүүхдийн үнэ ${formatMoneyValue(childPrice, currency)} байгаа ч том хүний үнэ ${formatMoneyValue(adultPrice, currency)} байна. Ингэж үлдээх үү?`,
        options: [
          {
            label: "Тийм, ингэж үлдээх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}, том хүний үнийг ${adultPrice} гэж үлдээ.`,
          },
          {
            label: "Том хүний үнээр тэнцүүлэх",
            answer: `"${routeName}" аяллын хүүхдийн үнийг ${childPrice}-н оронд ${adultPrice} болгон өөрчил.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: `"${routeName}" аяллын зөв үнэ эсвэл зааварчилга бичнэ үү`,
      });
    }
  });

  proposal.conflicts.forEach((conflict, index) => {
    const detail = conflict.trim();
    if (!detail) return;
    const normalized = normalizeReviewText(detail);
    if (coveredConflictChecks.some((check) => check(normalized))) return;
    const quoted = extractQuotedValues(conflict);
    // The first quoted value is usually the trip/route the conflict is about.
    const subject = quoted[0] || "";
    const subjectTag = subject ? `"${subject}" аяллын ` : "";

    if (
      normalized.includes("file") ||
      normalized.includes("файлын нэр") ||
      normalized.includes("operator") ||
      normalized.includes("оператор") ||
      normalized.includes("брэнд")
    ) {
      const detected = quoted[0] || "файлын нэр";
      const operator = quoted[1] || "илэрсэн оператор";
      pushQuestion({
        id: `operator-mismatch:${index}`,
        prompt: "Брэнд/операторын нэр зөрчилтэй байна. Аль нэрийг хэрэглэх вэ?",
        detail,
        options: [
          {
            label: `"${operator}" хэрэглэх`,
            answer: `Операторыг "${operator}" гэж үлдээнэ үү. (Зөрчил: ${detail})`,
          },
          {
            label: `"${detected}" хэрэглэх`,
            answer: `Операторыг "${detected}" болгоно уу. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Зөв оператор эсвэл брэндийн нэрийг бичнэ үү",
      });
      return;
    }

    if (normalized.includes("хөтөлбөртэй") && normalized.includes("чөлөөт")) {
      pushQuestion({
        id: `plan-choice:${index}`,
        prompt: `${subjectTag}аялалд хөтөлбөртэй болон чөлөөт гэсэн хоёр үнэ байна. Аль нь үндсэн үнэ вэ?`,
        detail,
        options: [
          {
            label: "Хөтөлбөртэй хувилбар",
            answer: `${subjectTag}хөтөлбөртэй хувилбарыг үндсэн үнэ болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Чөлөөт хувилбар",
            answer: `${subjectTag}чөлөөт хувилбарыг үндсэн үнэ болгон хэрэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Аль хувилбарыг хэрэглэхийг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("хоол") ||
      normalized.includes("meal") ||
      normalized.includes("day 7")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("хоол") || value.includes("meal")),
      );
      pushQuestion({
        id: `meal-conflict:${index}`,
        prompt: `${subjectTag}хоолны мэдээлэл зөрчилтэй байна. Хоол багтсан уу?`,
        options: [
          {
            label: "Тийм, багтсан",
            answer: `${subjectTag}хоолыг багтсан гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
          {
            label: "Үгүй, багтаагүй",
            answer: `${subjectTag}хоолыг багтаагүй гэж тэмдэглэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хоолны зөв дүрмийг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("явах өдөр тодорхойгүй") ||
      normalized.includes("огноо") ||
      normalized.includes("departure date")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("огноо") || value.includes("departure date")),
      );
      pushQuestion({
        id: `date-conflict:${index}`,
        prompt: `${subjectTag}гарах өдрийг тодорхойлж чадсангүй. Юу хийх вэ?`,
        options: [
          {
            label: "Огноогүй үлдээх",
            answer: `${subjectTag}гарах өдөргүйгээр саналд хэвээр нь үлдээ. (Зөрчил: ${detail})`,
          },
          {
            label: "Энэ аяллыг хасах",
            answer: `${subjectTag}гарах өдөр нь тодорхойгүй тул санал болгохгүй. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрэглэх гарах өдрийг бичнэ үү (ж: 2026-06-15)",
      });
      return;
    }

    if (
      normalized.includes("юань") ||
      normalized.includes("cny") ||
      normalized.includes("валют")
    ) {
      const subjectKey = normalizeReviewText(subject || detail);
      coveredConflictChecks.push(
        (value) =>
          value.includes(subjectKey) &&
          (value.includes("юань") || value.includes("cny") || value.includes("валют")),
      );
      pushQuestion({
        id: `currency-conflict:${index}`,
        prompt: `${subjectTag}үнэ хэдэн валютаар орж ирсэн байна. Аль валютаар хадгалах вэ?`,
        options: [
          {
            label: "MNT-г үлдээх",
            answer: `${subjectTag}үнийг MNT-ээр хадгал. CNY үнэ байвал саналд бүү ашигла.`,
          },
          {
            label: "CNY-г үлдээх",
            answer: `${subjectTag}үнийг CNY-ээр хадгал. MNT үнэ байвал саналд бүү ашигла.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Аль үнэ, аль валютыг хэрэглэхийг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("6-р сард") ||
      normalized.includes("7-р сард") ||
      normalized.includes("8-р сард") ||
      normalized.includes("сард") && normalized.includes("үнэ")
    ) {
      pushQuestion({
        id: `seasonal-price:${index}`,
        prompt: `${subjectTag}сараас хамаараад өөр үнэтэй байна. Үүнийг яаж хадгалах вэ?`,
        options: [
          {
            label: "Сарын ялгааг үлдээх",
            answer: `${subjectTag}сарын ялгаатай үнийг тусад нь тайлбар/тэмдэглэлд хадгалж, буруу тэгшлэхгүй.`,
          },
          {
            label: "Нэг үнэ болгох",
            answer: `${subjectTag}нэг үндсэн үнэ сонгож үлдээ. Сарын ялгаатай үнийг одоохондоо ашиглахгүй.`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Сар бүрийн үнийг хэрхэн хадгалахыг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("хоёр маршрут") ||
      normalized.includes("two route") ||
      normalized.includes("ижил")
    ) {
      pushQuestion({
        id: `duplicate-route:${index}`,
        prompt: "Ижил маршруттай боловч мэдээлэл нь зөрүүтэй хоёр аялал илэрлээ. Юу хийх вэ?",
        options: [
          {
            label: "Тусдаа үлдээх",
            answer: `Эдгээрийг тусдаа аялал болгон үлдээ. (Зөрчил: ${detail})`,
          },
          {
            label: "Нэг болгон нэгтгэх",
            answer: `Эдгээрийг нэг аялал болгон нэгтгэ. (Зөрчил: ${detail})`,
          },
        ],
        allowCustom: true,
        customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
      });
      return;
    }

    if (
      normalized.includes("batch failed") ||
      normalized.includes("upstream") ||
      normalized.includes("503")
    ) {
      return;
    }

    // Any conflict that doesn't match a known category still gets surfaced —
    // never silently drop a flagged conflict.
    pushQuestion({
      id: `conflict:${index}`,
      prompt: "Энэ зөрчлийг хэрхэн зохицуулах вэ?",
      options: [
        {
          label: "Илэрсэнээр нь үлдээх",
          answer: `Дараах зөрчлийг илэрсэн хэвээр нь үлдээ: ${detail}`,
        },
        {
          label: "Болгоомжтой засах",
          answer: `Дараах зөрчлийг болгоомжтой хянаж засна уу: ${detail}`,
        },
      ],
      allowCustom: true,
      customPlaceholder: "Хэрхэн зохицуулахыг бичнэ үү",
    });
  });

  if (questions.length === 0 && proposal.needs_confirmation) {
    const fallbackReason =
      proposal.important_reason ||
      proposal.conflicts[0] ||
      "Нэг зүйл баталгаажуулах шаардлагатай байна.";
    pushQuestion({
      id: "final-confirmation",
      prompt: fallbackReason,
      options: [
        {
          label: "Илэрсэнээр хэрэглэх",
          answer: "Илэрсэн утгуудыг одоогийн саналд байгаагаар нь хэвээр үлдээ.",
        },
        {
          label: "Болгоомжтой хянан засах",
          answer: "Тодорхойгүй утгуудыг хэвээр үлдээхгүй; саналыг илүү болгоомжтойгоор засна уу.",
        },
      ],
      allowCustom: true,
      customPlaceholder: "Хэрэглэх тодруулгыг бичнэ үү",
    });
  }

  return questions.slice(0, 4);
}

/* ----------------------------------------------------------------
   Small presentational components
   ---------------------------------------------------------------- */
function SectionHeading({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

function StructuredEditor({
  title,
  addLabel,
  fields,
  rows,
  onChange,
}: {
  title: string;
  addLabel: string;
  fields: Array<{ key: string; label: string }>;
  rows: StructuredRow[];
  onChange: (rows: StructuredRow[]) => void;
}) {
  function update(index: number, key: string, value: string) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: value } : row)));
  }
  function remove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }
  function add() {
    const blank: StructuredRow = {};
    for (const field of fields) blank[field.key] = "";
    onChange([...rows, blank]);
  }
  return (
    <div className="rounded-lg border border-line bg-surface-sunken p-3">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <Button size="sm" variant="secondary" onClick={add}>
          <Icons.plus size={15} />
          {addLabel}
        </Button>
      </div>
      <div className="mt-2 space-y-2">
        {rows.length === 0 && (
          <p className="text-xs text-ink-subtle">Хоосон байна.</p>
        )}
        {rows.map((row, index) => (
          <div
            key={index}
            className="rounded-md border border-line bg-surface p-2.5"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              {fields.map((field) => (
                <label key={field.key} className="block">
                  <span className="text-xs font-medium text-ink-muted">
                    {field.label}
                  </span>
                  <input
                    className="mt-1 h-9 w-full rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink focus:border-brand"
                    value={row[field.key] || ""}
                    onChange={(e) => update(index, field.key, e.target.value)}
                  />
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => remove(index)}
                className="text-danger"
              >
                <Icons.trash size={15} />
                Устгах
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Page
   ---------------------------------------------------------------- */
const BLANK_TRIP_DRAFT: Record<string, string> = {
  category: "",
  operator_name: "",
  route_name: "",
  duration_text: "",
  adult_price: "",
  child_price: "",
  currency: "MNT",
  seats_total: "",
  seats_left: "",
  departure_dates: "",
  status: "active",
  has_food: "unknown",
  notes: "",
  source_description: "",
};

export default function AdminPage() {
  const toast = useToast();

  const [secret, setSecret] = useState("");
  const [secretDraft, setSecretDraft] = useState("");
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [openAccess, setOpenAccess] = useState(false);
  const [dbInfo, setDbInfo] = useState<{
    configured: boolean;
    schemaReady: boolean;
    trips: number;
    lastUpdatedAt: string | null;
  } | null>(null);
  const [driveSync, setDriveSync] = useState<DriveSyncDiagnostics | null>(null);

  const [tab, setTab] = useState<TabKey>("assistant");
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState("");
  const [tick, setTick] = useState(0);

  const [trips, setTrips] = useState<TravelTrip[]>([]);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [control, setControl] = useState<ControlState | null>(null);
  const [pausedRows, setPausedRows] = useState<PauseRow[]>([]);
  const [recentRows, setRecentRows] = useState<RecentRow[]>([]);
  const [pauseReason, setPauseReason] = useState("");

  const [settings, setSettings] = useState<TravelBotSettings | null>(null);
  const [settingsForm, setSettingsForm] = useState<SettingsForm | null>(null);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    {
      id: "intro",
      role: "assistant",
      kind: "note",
      tone: "info",
      text:
        "Сайн байна уу! Аяллын мэдээллээ энд шуурхай өөрчилнө. Бичгээр зааварчилж болно (ж: «Бангкок аяллыг цуцал»), эсвэл прайс жагсаалт (Excel, PDF, зураг) хавсаргаарай. Би уншаад өөрчлөлтийг санал болгоно — та зөвшөөрвөл шууд хадгална.",
    },
  ]);
  const [aiInput, setAiInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [aiBusyLabel, setAiBusyLabel] = useState("");

  const [editingTrip, setEditingTrip] = useState<TravelTrip | null>(null);
  const [isNewTrip, setIsNewTrip] = useState(false);
  const [tripDraft, setTripDraft] = useState<Record<string, string>>(
    BLANK_TRIP_DRAFT,
  );
  const [deletingTrip, setDeletingTrip] = useState<TravelTrip | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const [leads, setLeads] = useState<TravelLead[]>([]);
  const [newLeadCount, setNewLeadCount] = useState(0);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const secretRef = useRef(secret);
  const searchRef = useRef(search);
  const statusFilterRef = useRef(statusFilter);

  useEffect(() => {
    secretRef.current = secret;
  }, [secret]);

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    statusFilterRef.current = statusFilter;
  }, [statusFilter]);

  const fetchWithAdmin = useCallback(
    async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      if (secretRef.current.trim()) {
        headers.set("x-admin-secret", secretRef.current.trim());
      }
      return fetch(url, { ...init, headers });
    },
    [],
  );

  const readJsonSafe = useCallback(async (response: Response) => {
    const raw = await response.text();
    if (!raw) return {} as Record<string, unknown>;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return { error: raw.slice(0, 300) } as Record<string, unknown>;
    }
  }, []);

  const loadTrips = useCallback(
    async (
      nextSearch = searchRef.current,
      nextStatusFilter = statusFilterRef.current,
      options: { showLoading?: boolean } = {},
    ) => {
      if (options.showLoading) setLoading(true);
      try {
        const tripRes = await fetchWithAdmin(
          `/api/admin/trips?search=${encodeURIComponent(
            nextSearch,
          )}&status=${encodeURIComponent(nextStatusFilter)}&limit=300`,
        );
        if (tripRes.status === 401) {
          setRequiresAuth(true);
          return;
        }

        const tripJson = await tripRes.json();
        setRequiresAuth(false);
        setTrips(Array.isArray(tripJson?.trips) ? tripJson.trips : []);
        setControl((tripJson?.control as ControlState) || null);
      } catch {
        toast.error("Аяллын мэдээлэл ачаалж чадсангүй.");
      } finally {
        if (options.showLoading) setLoading(false);
      }
    },
    [fetchWithAdmin, toast],
  );

  const loadPauseState = useCallback(async () => {
    try {
      const pauseRes = await fetchWithAdmin("/api/pause");
      if (pauseRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }

      const pauseJson = await pauseRes.json().catch(() => ({}));
      setRequiresAuth(false);
      setControl(pauseJson?.control || null);
      setPausedRows(Array.isArray(pauseJson?.paused) ? pauseJson.paused : []);
      setRecentRows(Array.isArray(pauseJson?.recent) ? pauseJson.recent : []);
      return true;
    } catch {
      toast.error("Ботын төлөв ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, toast]);

  const loadSettingsState = useCallback(async () => {
    try {
      const settingsRes = await fetchWithAdmin("/api/admin/settings");
      if (settingsRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }

      const settingsJson = await settingsRes.json().catch(() => ({}));
      setRequiresAuth(false);
      if (settingsJson?.settings) {
        setSettings(settingsJson.settings as TravelBotSettings);
        setSettingsForm((prev) =>
          prev ? prev : settingsToForm(settingsJson.settings as TravelBotSettings),
        );
      }
      return true;
    } catch {
      toast.error("Тохиргоо ачаалж чадсангүй.");
      return false;
    }
  }, [fetchWithAdmin, toast]);

  const loadLeadsState = useCallback(async (options: { showLoading?: boolean } = {}) => {
    if (options.showLoading) setLoading(true);
    try {
      const leadsRes = await fetchWithAdmin("/api/admin/leads");
      if (leadsRes.status === 401) {
        setRequiresAuth(true);
        return false;
      }

      const leadsJson = await leadsRes.json().catch(() => ({}));
      setRequiresAuth(false);
      setLeads(Array.isArray(leadsJson?.leads) ? leadsJson.leads : []);
      setNewLeadCount(
        typeof leadsJson?.new_count === "number" ? leadsJson.new_count : 0,
      );
      return true;
    } catch {
      toast.error("Хүсэлтүүд ачаалж чадсангүй.");
      return false;
    } finally {
      if (options.showLoading) setLoading(false);
    }
  }, [fetchWithAdmin, toast]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const systemRes = await fetchWithAdmin("/api/admin/system");
      if (systemRes.status === 401) {
        setRequiresAuth(true);
        setLoading(false);
        return;
      }
      const systemJson = await systemRes.json();
      const nextOpenAccess = Boolean(systemJson?.open_access);
      const authorized = Boolean(systemJson?.authorized);
      setOpenAccess(nextOpenAccess);
      if (!nextOpenAccess && !authorized) {
        setRequiresAuth(true);
        setDbInfo(null);
        setDriveSync(null);
        setLoading(false);
        return;
      }

      setRequiresAuth(false);
      setDbInfo(systemJson?.db || null);
      setDriveSync((systemJson?.drive_sync as DriveSyncDiagnostics) || null);
      setLoading(false);

      await Promise.all([
        loadTrips(searchRef.current, statusFilterRef.current),
        loadPauseState(),
        loadSettingsState(),
        loadLeadsState(),
      ]);
    } catch {
      toast.error("Системийн өгөгдөл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [
    fetchWithAdmin,
    loadLeadsState,
    loadPauseState,
    loadSettingsState,
    loadTrips,
    toast,
  ]);

  const syncDriveNow = useCallback(async () => {
    setBusyKey("drive-sync");
    try {
      const res = await fetchWithAdmin("/api/admin/drive-sync", {
        method: "POST",
      });
      const json = (await readJsonSafe(res)) as {
        diagnostics?: DriveSyncDiagnostics;
        summary?: string;
      };
      if (json.diagnostics) setDriveSync(json.diagnostics);
      if (!res.ok) {
        throw new Error(json.summary || "Google Drive синк хийх үед алдаа гарлаа.");
      }
      toast.success(json.summary || "Google Drive синк дууслаа.");
      await loadAll();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Google Drive синк хийх үед алдаа гарлаа.",
      );
    } finally {
      setBusyKey("");
    }
  }, [fetchWithAdmin, loadAll, readJsonSafe, toast]);

  useEffect(() => {
    const storage = getSecretStorage();
    if (!storage) return;
    const stored = storage.getItem(SECRET_KEY) || "";
    const ts = Number(storage.getItem(SECRET_TS_KEY) || "0");
    if (stored && Date.now() - ts < SESSION_TTL_MS) {
      secretRef.current = stored;
      setSecret(stored);
      setSecretDraft(stored);
    } else if (stored) {
      storage.removeItem(SECRET_KEY);
      storage.removeItem(SECRET_TS_KEY);
    }
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    if (requiresAuth || (!openAccess && !secret.trim())) return;
    const timer = window.setTimeout(() => {
      void loadTrips(search, statusFilter, { showLoading: true });
    }, 350);
    return () => window.clearTimeout(timer);
  }, [loadTrips, openAccess, requiresAuth, search, secret, statusFilter]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (ADMIN_AUTO_REFRESH_MS <= 0) return;
    const refresh = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      if (typeof document !== "undefined" && isEditableElement(document.activeElement)) {
        return;
      }
      if (
        isNewTrip ||
        editingTrip != null ||
        deletingTrip ||
        confirmClear ||
        busyKey ||
        aiInput.trim() ||
        attachedFiles.length > 0 ||
        dragOver
      ) {
        return;
      }
      void loadAll();
    }, ADMIN_AUTO_REFRESH_MS);
    return () => clearInterval(refresh);
  }, [
    aiInput,
    attachedFiles.length,
    busyKey,
    confirmClear,
    deletingTrip,
    dragOver,
    editingTrip,
    isNewTrip,
    loadAll,
  ]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages]);

  const pausedIds = useMemo(
    () => new Set(pausedRows.map((row) => row.sender_id)),
    [pausedRows],
  );
  const handoffRows = useMemo(
    () => pausedRows.filter((row) => row.reason === "handoff"),
    [pausedRows],
  );

  /* ---------------- auth ---------------- */
  async function applySecret() {
    const nextSecret = secretDraft.trim();
    if (!nextSecret) return;
    const storage = getSecretStorage();
    if (storage) {
      storage.setItem(SECRET_KEY, nextSecret);
      storage.setItem(SECRET_TS_KEY, String(Date.now()));
    }
    secretRef.current = nextSecret;
    setSecret(nextSecret);
    await loadAll();
  }

  /* ---------------- AI assistant ---------------- */
  function pushMessage(message: ChatMessage) {
    setChatMessages((prev) => [...prev, message]);
  }

  async function readAttachedFile(file: File): Promise<AttachedFile> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("read failed"));
      reader.readAsDataURL(file);
    });

    return {
      id: `${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      mimeType: file.type || "",
      dataUrl,
    };
  }

  async function attachFiles(files: FileList | File[]) {
    const inputFiles = Array.from(files);
    if (inputFiles.length === 0) return;

    try {
      const nextFiles = await Promise.all(
        inputFiles.map((file) => readAttachedFile(file)),
      );
      setAttachedFiles((prev) => {
        const existing = new Set(prev.map((file) => file.id));
        const deduped = nextFiles.filter((file) => !existing.has(file.id));
        return [...prev, ...deduped];
      });
    } catch {
      toast.error("Нэг буюу хэд хэдэн файлыг уншиж чадсангүй.");
    }
  }

  function removeAttachedFile(fileId: string) {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== fileId));
  }

  async function sendAssistant() {
    const text = aiInput.trim();
    const files = attachedFiles;
    if (!text && files.length === 0) return;
    if (busyKey === "ai-send") return;

    pushMessage({
      id: uid(),
      role: "admin",
      text: text || "Файл орууллаа",
      fileNames: files.map((file) => file.name),
    });
    setAiInput("");
    setAttachedFiles([]);
    setBusyKey("ai-send");
    setAiBusyLabel(
      files.length > 0
        ? `${files.length} файл уншиж байна… (хэдэн секунд)`
        : "AI хариу бэлдэж байна…",
    );

    try {
      let data: { proposal?: AIProposal; request_id?: number; error?: string };
      if (files.length > 0) {
        const res = await fetchWithAdmin("/api/admin/parse-file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            uploads: files.map((file) => ({
              filename: file.name,
              mimeType: file.mimeType,
              dataBase64: file.dataUrl,
            })),
            note: text,
          }),
        });
        const json = await readJsonSafe(res);
        data = json as typeof data;
        if (!res.ok) {
          if (res.status === 413) {
            throw new Error(
              "Нийт хэмжээ сервер эсвэл байршуулалтын платформын зөвшөөрсөн хэмжээнээс хэтэрлээ.",
            );
          }
          throw new Error(data?.error || "Файлуудыг боловсруулж чадсангүй.");
        }
      } else {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: text }),
        });
        const json = await readJsonSafe(res);
        data = json as typeof data;
        if (!res.ok) {
          throw new Error(data?.error || "AI санал үүсгэж чадсангүй.");
        }
      }

      const proposal = data.proposal;
      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error(
          "AI хэрэгжих санал буцааж чадсангүй. Илүү тодорхой зааварчилгаар дахин оролдоно уу.",
        );
      }
      if (proposal.actions.length === 0) {
        pushMessage({
          id: uid(),
          role: "assistant",
          kind: "note",
          tone: "info",
          text:
            proposal.summary ||
            "Өөрчлөх зүйл олдсонгүй. Илүү дэлгэрэнгүй зааварчилга эсвэл өөр файл оруулна уу.",
        });
        return;
      }
      const fileInstruction =
        files.length > 0
          ? text
            ? `[File] ${files.map((f) => f.name).join(", ")} - ${text}`
            : `[File] ${files.map((f) => f.name).join(", ")}`
          : text;
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "proposal",
        proposal,
        requestId:
          typeof data.request_id === "number" ? data.request_id : null,
        instruction: fileInstruction,
        status: "pending",
        confirmChecked: false,
        clarifications: buildProposalClarifications(proposal),
        clarificationAnswers: [],
        answeredClarificationIds: [],
        customReply: "",
      });
    } catch (err) {
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "note",
        tone: "error",
        text:
          err instanceof TypeError
            ? "Сервер хариу өгөхөөс өмнө байршуулалт амжилтгүй болсон. Сүлжээ, браузер эсвэл платформын бодит request limit-д хүрсэн байж магадгүй."
            : err instanceof Error
              ? err.message
              : "Алдаа гарлаа.",
      });
    } finally {
      setBusyKey("");
    }
  }
  function setProposalMessage(id: string, patch: Partial<ProposalMsg>) {
    setChatMessages((prev) =>
      prev.map((message) =>
        message.id === id && "kind" in message && message.kind === "proposal"
          ? { ...message, ...patch }
          : message,
      ),
    );
  }

  async function answerClarification(
    message: ProposalMsg,
    question: ClarificationQuestion,
    answer: string,
  ) {
    const trimmed = answer.trim();
    if (!trimmed) return;

    setBusyKey(`clarify-${message.id}`);
    try {
      let proposal: AIProposal | undefined;
      let newRequestId: number | null = message.requestId;

      if (message.requestId != null) {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: message.requestId,
            clarification: trimmed,
          }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            String(json?.message || json?.error || "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
      } else {
        // No DB record — regenerate with combined instruction + clarification.
        const combined = [
          message.instruction,
          ...message.clarificationAnswers.map(
            (qa) => `${qa.prompt}: ${qa.answer}`,
          ),
          `${question.prompt}: ${trimmed}`,
        ]
          .filter(Boolean)
          .join("\n");
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction: combined }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            String(json?.message || json?.error || "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
        if (typeof json?.request_id === "number") {
          newRequestId = json.request_id as number;
        }
      }

      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error("AI засварласан санал буцааж чадсангүй.");
      }

      const nextAnsweredIds = [
        ...message.answeredClarificationIds,
        question.id,
      ];
      setProposalMessage(message.id, {
        proposal,
        requestId: newRequestId,
        clarifications: buildProposalClarifications(proposal, nextAnsweredIds),
        clarificationAnswers: [
          ...message.clarificationAnswers,
          {
            questionId: question.id,
            prompt: question.prompt,
            answer: trimmed,
          },
        ],
        answeredClarificationIds: nextAnsweredIds,
        customReply: "",
        confirmChecked: false,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Саналыг засаж чадсангүй.",
      );
    } finally {
      setBusyKey("");
    }
  }

  async function applyProposal(message: ProposalMsg) {
    setBusyKey(`apply-${message.id}`);
    try {
      const body =
        message.requestId != null
          ? { request_id: message.requestId, apply: true, confirm: true }
          : {
              apply: true,
              confirm: true,
              proposal_direct: message.proposal,
              instruction: message.instruction,
            };
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        throw new Error(json?.message || json?.error || "Хэрэгжүүлж чадсангүй.");
      }
      setProposalMessage(message.id, {
        status: "applied",
        resultText: Array.isArray(json?.results)
          ? json.results.join(" • ")
          : json?.message || "Амжилттай.",
      });
      toast.success("Өөрчлөлт хадгалагдлаа. Бот шинэ мэдээллээр хариулна.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Алдаа гарлаа.",
      });
      toast.error("Хэрэгжүүлэхэд алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }

  async function submitClarificationForm(
    message: ProposalMsg,
    answers: Record<string, string>,
  ) {
    // Build a combined clarification string from all answered questions.
    // Include each question's conflict detail so the AI knows exactly which
    // trip/conflict the admin's answer applies to.
    const combined = message.clarifications
      .map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        if (!answer) return "";
        const context = q.detail ? ` [Зөрчил: ${q.detail}]` : "";
        return `${q.prompt}${context} → ${answer}`;
      })
      .filter(Boolean)
      .join("\n");
    if (!combined.trim()) return;

    // Re-use answerClarification with the first question as the anchor.
    // The combined text carries all answers so the AI sees the full picture.
    const firstQ = message.clarifications[0];
    if (firstQ) {
      await answerClarification(message, firstQ, combined);
    }
  }

  /* ---------------- bot control ---------------- */
  async function runPauseAction(
    action: "pause" | "resume" | "global_pause" | "global_resume",
    senderId?: string,
    durationMs?: number | null,
  ) {
    setBusyKey(`${action}:${senderId || "global"}`);
    try {
      const body: Record<string, unknown> = { action };
      if (senderId) body.sender_id = senderId;
      if (durationMs != null) body.duration_ms = durationMs;
      if (action === "global_pause") body.reason = pauseReason || null;
      const res = await fetchWithAdmin("/api/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json?.error || "Үйлдэл амжилтгүй.");
      }
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Үйлдэл амжилтгүй.");
    } finally {
      setBusyKey("");
    }
  }

  /* ---------------- trips ---------------- */
  function beginCreateTrip() {
    setIsNewTrip(true);
    setEditingTrip(null);
    setTripDraft({ ...BLANK_TRIP_DRAFT });
  }

  function beginEditTrip(trip: TravelTrip) {
    setIsNewTrip(false);
    setEditingTrip(trip);
    setTripDraft({
      category: trip.category || "",
      operator_name: trip.operator_name || "",
      route_name: trip.route_name || "",
      duration_text: trip.duration_text || "",
      adult_price: trip.adult_price == null ? "" : String(trip.adult_price),
      child_price: trip.child_price == null ? "" : String(trip.child_price),
      currency: trip.currency || "MNT",
      seats_total: trip.seats_total == null ? "" : String(trip.seats_total),
      seats_left: trip.seats_left == null ? "" : String(trip.seats_left),
      departure_dates: (trip.departure_dates || []).join(", "),
      status: trip.status || "active",
      has_food:
        trip.has_food == null ? "unknown" : trip.has_food ? "true" : "false",
      notes: trip.notes || "",
      source_description: trip.source_description || "",
    });
  }

  const tripModalOpen = isNewTrip || editingTrip != null;

  function closeTripModal() {
    setEditingTrip(null);
    setIsNewTrip(false);
  }

  async function saveTrip() {
    const fields = {
      category: tripDraft.category || "",
      operator_name: tripDraft.operator_name || "",
      route_name: tripDraft.route_name || "",
      duration_text: tripDraft.duration_text || "",
      adult_price: asInt(tripDraft.adult_price || ""),
      child_price: asInt(tripDraft.child_price || ""),
      currency: tripDraft.currency || "MNT",
      seats_total: asInt(tripDraft.seats_total || ""),
      seats_left: asInt(tripDraft.seats_left || ""),
      status: tripDraft.status || "active",
      has_food:
        tripDraft.has_food === "unknown"
          ? null
          : tripDraft.has_food === "true",
      notes: tripDraft.notes || "",
      departure_dates: (tripDraft.departure_dates || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      source_description: tripDraft.source_description || "",
    };
    if (!fields.route_name.trim() && !fields.operator_name.trim()) {
      toast.error("Маршрут эсвэл операторын нэр оруулна уу.");
      return;
    }
    if (isNewTrip) {
      const duplicate = trips.find(
        (t) =>
          t.operator_name.trim().toLowerCase() ===
            fields.operator_name.trim().toLowerCase() &&
          t.route_name.trim().toLowerCase() ===
            fields.route_name.trim().toLowerCase(),
      );
      if (duplicate) {
        toast.error(
          `"${fields.operator_name} — ${fields.route_name}" нэртэй аялал аль хэдийн байна. Засах товч дарж шинэчилнэ үү.`,
        );
        return;
      }
    }
    setBusyKey("save-trip");
    try {
      const res = await fetchWithAdmin("/api/admin/trips", {
        method: isNewTrip ? "POST" : "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          isNewTrip ? { fields } : { id: editingTrip?.id, fields },
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || "Хадгалж чадсангүй.");
      toast.success(isNewTrip ? "Шинэ аялал нэмэгдлээ." : "Аялал шинэчлэгдлээ.");
      closeTripModal();
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  async function confirmDeleteTrip() {
    if (!deletingTrip) return;
    setBusyKey(`delete-trip-${deletingTrip.id}`);
    const trip = deletingTrip;
    setDeletingTrip(null);
    try {
      const res = await fetchWithAdmin(
        `/api/admin/trips?id=${encodeURIComponent(trip.id)}`,
        { method: "DELETE" },
      );
      const json = await readJsonSafe(res);
      if (!res.ok) throw new Error(String(json?.error || "Устгаж чадсангүй."));
      toast.success(`"${trip.route_name || trip.operator_name}" устгагдлаа.`);
      await loadTrips(searchRef.current, statusFilterRef.current, {
        showLoading: true,
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Устгаж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  async function markLeadSeen(lead: TravelLead) {
    // Optimistic update so the badge/list react instantly.
    setLeads((prev) =>
      prev.map((item) =>
        item.id === lead.id ? { ...item, status: "seen" } : item,
      ),
    );
    setNewLeadCount((count) => Math.max(0, count - 1));
    try {
      const res = await fetchWithAdmin("/api/admin/leads", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lead.id }),
      });
      if (!res.ok) throw new Error("failed");
    } catch {
      toast.error("Тэмдэглэж чадсангүй. Дахин оролдоно уу.");
      await loadLeadsState({ showLoading: true });
    }
  }

  /* ---------------- settings ---------------- */
  async function saveSettings() {
    if (!settingsForm) return;
    setBusyKey("save-settings");
    try {
      const fields = {
        business_name: settingsForm.business_name.trim(),
        system_prompt: settingsForm.system_prompt.trim(),
        quick_info_reply: settingsForm.quick_info_reply.trim(),
        quick_info_keywords: splitLines(settingsForm.quick_info_keywords),
        comment_trigger_patterns: splitLines(
          settingsForm.comment_trigger_patterns,
        ),
        comment_public_reply: settingsForm.comment_public_reply.trim(),
        comment_dm_reply: settingsForm.comment_dm_reply.trim(),
        special_offers: settingsForm.special_offers,
        discount_policies: settingsForm.discount_policies,
        verified_credentials: settingsForm.verified_credentials,
        faq: settingsForm.faq,
        handoff_enabled: settingsForm.handoff_enabled,
        handoff_keywords: splitLines(settingsForm.handoff_keywords),
        handoff_reply: settingsForm.handoff_reply.trim(),
        handoff_pause_minutes: asInt(settingsForm.handoff_pause_minutes) ?? 60,
      };
      const res = await fetchWithAdmin("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || "Тохиргоо хадгалж чадсангүй.");
      if (json?.settings) {
        setSettings(json.settings as TravelBotSettings);
        setSettingsForm(settingsToForm(json.settings as TravelBotSettings));
      }
      toast.success("Тохиргоо хадгалагдлаа.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
    }
  }

  /* ---------------- render ---------------- */
  const botPaused = Boolean(control?.bot_paused);

  if (requiresAuth || (!openAccess && !secret.trim())) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-canvas px-4">
        <Head>
          <title>Админ — нэвтрэх</title>
        </Head>
        <Card className="w-full max-w-sm p-6">
          <h1 className="text-lg font-semibold text-ink">Админ удирдлага</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Үргэлжлүүлэхийн тулд админ нууц үгээ оруулна уу.
          </p>
          <div className="mt-4 space-y-3">
            <Input
              type="password"
              placeholder="Админ нууц үг"
              value={secretDraft}
              onChange={(e) => setSecretDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void applySecret();
              }}
            />
            <Button block onClick={() => void applySecret()}>
              Нэвтрэх
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  const tabs: Array<{
    key: TabKey;
    label: string;
    icon: ReactNode;
    badge?: number;
  }> = [
    { key: "assistant", label: "AI Туслах", icon: <Icons.ai size={17} /> },
    { key: "trips", label: "Аяллууд", icon: <Icons.trips size={17} /> },
    { key: "bot", label: "Бот удирдлага", icon: <Icons.control size={17} /> },
    {
      key: "leads",
      label: "Хүсэлтүүд",
      icon: <Icons.alert size={17} />,
      badge: newLeadCount,
    },
    { key: "settings", label: "Тохиргоо", icon: <Icons.settings size={17} /> },
  ];

  return (
    <div className="min-h-dvh bg-canvas pb-16">
      <Head>
        <title>Аяллын удирдлагын самбар</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>

      {/* Header */}
      <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
        <div className="mx-auto w-full max-w-3xl px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-ink">
                Аяллын удирдлага
              </h1>
              <p className="truncate text-xs text-ink-subtle">
                {settings?.business_name || "Аяллын чатбот"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {handoffRows.length > 0 && (
                <button type="button" onClick={() => setTab("bot")}>
                  <Badge tone="warning" dot>
                    🙋 {handoffRows.length}
                  </Badge>
                </button>
              )}
              <Badge tone={botPaused ? "danger" : "success"} dot>
                {botPaused ? "Зогссон" : "Идэвхтэй"}
              </Badge>
              <Badge tone={dbInfo?.configured ? "neutral" : "danger"}>
                {dbInfo?.trips ?? trips.length} аялал
              </Badge>
            </div>
          </div>

          {/* Tabs */}
          <nav className="scroll-area -mx-1 mt-3 flex gap-1 overflow-x-auto">
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setTab(item.key)}
                className={cx(
                  "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                  tab === item.key
                    ? "bg-brand text-white"
                    : "text-ink-muted hover:bg-surface-sunken",
                )}
              >
                {item.icon}
                {item.label}
                {item.badge != null && item.badge > 0 && (
                  <span
                    className={cx(
                      "ml-0.5 inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold",
                      tab === item.key
                        ? "bg-white text-brand"
                        : "bg-danger text-white",
                    )}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-4">
        {botPaused && (
          <div className="mb-4">
            <Alert tone="warning">
              Бот түр зогссон байна. Хэрэглэгчид автомат хариу авахгүй.{" "}
              {control?.pause_reason ? `Шалтгаан: ${control.pause_reason}` : ""}
            </Alert>
          </div>
        )}

        {!dbInfo?.configured && (
          <div className="mb-4">
            <Alert tone="danger">
              Өгөгдлийн сан холбогдоогүй байна. Мэдээлэл хадгалагдахгүй.
            </Alert>
          </div>
        )}

        {tab === "assistant" && (
          <AssistantTab
            messages={chatMessages}
            aiInput={aiInput}
            setAiInput={setAiInput}
            attachedFiles={attachedFiles}
            onRemoveAttachedFile={removeAttachedFile}
            dragOver={dragOver}
            setDragOver={setDragOver}
            busy={busyKey === "ai-send"}
            busyLabel={aiBusyLabel}
            applyBusyId={busyKey.startsWith("apply-") ? busyKey.slice(6) : ""}
            clarifyBusyId={
              busyKey.startsWith("clarify-") ? busyKey.slice(8) : ""
            }
            onSend={() => void sendAssistant()}
            onApply={(message) => void applyProposal(message)}
            onSubmitClarificationForm={(message, answers) =>
              void submitClarificationForm(message, answers)
            }
            onCancelProposal={(id) =>
              setProposalMessage(id, { status: "cancelled" })
            }
            onToggleConfirm={(id, value) =>
              setProposalMessage(id, { confirmChecked: value })
            }
            onPickFile={() => fileInputRef.current?.click()}
            onDropFiles={(files) => void attachFiles(files)}
            chatEndRef={chatEndRef}
            inputRef={inputRef}
          />
        )}

        {tab === "trips" && (
          <TripsTab
            trips={trips}
            search={search}
            setSearch={setSearch}
            statusFilter={statusFilter}
            setStatusFilter={setStatusFilter}
            loading={loading}
            onRefresh={() =>
              void loadTrips(searchRef.current, statusFilterRef.current, {
                showLoading: true,
              })
            }
            onCreate={beginCreateTrip}
            onEdit={beginEditTrip}
            onDelete={(trip) => setDeletingTrip(trip)}
          />
        )}

        {tab === "bot" && (
          <BotTab
            control={control}
            pauseReason={pauseReason}
            setPauseReason={setPauseReason}
            recentRows={recentRows}
            pausedRows={pausedRows}
            pausedIds={pausedIds}
            busyKey={busyKey}
            tick={tick}
            onPauseAction={(action, senderId, ms) =>
              void runPauseAction(action, senderId, ms)
            }
          />
        )}

        {tab === "leads" && (
          <LeadsTab
            leads={leads}
            loading={loading}
            onRefresh={() => void loadLeadsState({ showLoading: true })}
            onMarkSeen={(lead) => void markLeadSeen(lead)}
          />
        )}

        {tab === "settings" && settingsForm && (
          <SettingsTab
            form={settingsForm}
            setForm={setSettingsForm}
            updatedAt={settings?.updated_at}
            busy={busyKey === "save-settings"}
            driveSync={driveSync}
            syncBusy={busyKey === "drive-sync"}
            onSyncDriveNow={() => void syncDriveNow()}
            onSave={() => void saveSettings()}
            onRequestClear={() => setConfirmClear(true)}
          />
        )}
      </main>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_FILES}
        multiple
        className="hidden"
        onChange={(e) => {
          const files = e.target.files;
          if (files?.length) void attachFiles(files);
          e.target.value = "";
        }}
      />

      {/* Trip edit / create modal */}
      <Modal
        open={tripModalOpen}
        onClose={closeTripModal}
        title={isNewTrip ? "Шинэ аялал нэмэх" : "Аялал засах"}
        description={
          isNewTrip ? undefined : editingTrip?.route_name || undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={closeTripModal}>
              Болих
            </Button>
            <Button
              loading={busyKey === "save-trip"}
              onClick={() => void saveTrip()}
            >
              Хадгалах
            </Button>
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Маршрут"
            value={tripDraft.route_name}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, route_name: e.target.value }))
            }
          />
          <Input
            label="Оператор"
            value={tripDraft.operator_name}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, operator_name: e.target.value }))
            }
          />
          <Input
            label="Ангилал"
            value={tripDraft.category}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, category: e.target.value }))
            }
          />
          <Input
            label="Хугацаа (ж: 5ш6ө)"
            value={tripDraft.duration_text}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, duration_text: e.target.value }))
            }
          />
          <Input
            label="Том хүний үнэ"
            inputMode="numeric"
            value={tripDraft.adult_price}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, adult_price: e.target.value }))
            }
          />
          <Input
            label="Хүүхдийн үнэ"
            inputMode="numeric"
            value={tripDraft.child_price}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, child_price: e.target.value }))
            }
          />
          <Select
            label="Валют"
            value={tripDraft.currency}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, currency: e.target.value }))
            }
          >
            <option value="MNT">MNT (₮)</option>
            <option value="CNY">CNY (юань)</option>
            <option value="USD">USD ($)</option>
          </Select>
          <Select
            label="Төлөв"
            value={tripDraft.status}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, status: e.target.value }))
            }
          >
            <option value="active">Идэвхтэй</option>
            <option value="cancelled">Цуцлагдсан</option>
            <option value="sold_out">Суудал дууссан</option>
            <option value="draft">Ноорог</option>
          </Select>
          <Input
            label="Нийт суудал"
            inputMode="numeric"
            value={tripDraft.seats_total}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, seats_total: e.target.value }))
            }
          />
          <Input
            label="Үлдсэн суудал"
            inputMode="numeric"
            value={tripDraft.seats_left}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, seats_left: e.target.value }))
            }
          />
          <Select
            label="Хоол"
            value={tripDraft.has_food}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, has_food: e.target.value }))
            }
          >
            <option value="unknown">Тодорхойгүй</option>
            <option value="true">Багтсан</option>
            <option value="false">Багтаагүй</option>
          </Select>
          <Input
            label="Гарах өдөр (таслалаар)"
            value={tripDraft.departure_dates}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, departure_dates: e.target.value }))
            }
          />
        </div>
        <div className="mt-3">
          <Textarea
            label="Эх сурвалжийн тайлбар"
            rows={2}
            value={tripDraft.source_description}
            onChange={(e) =>
              setTripDraft((p) => ({
                ...p,
                source_description: e.target.value,
              }))
            }
          />
        </div>
        <div className="mt-3">
          <Textarea
            label="Тэмдэглэл"
            rows={2}
            value={tripDraft.notes}
            onChange={(e) =>
              setTripDraft((p) => ({ ...p, notes: e.target.value }))
            }
          />
        </div>
      </Modal>

      {/* Delete trip confirmation modal */}
      <Modal
        open={deletingTrip != null}
        onClose={() => setDeletingTrip(null)}
        title="Аяллыг устгах уу?"
        description={`"${deletingTrip?.route_name || deletingTrip?.operator_name}" — энэ үйлдлийг буцаах боломжгүй.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDeletingTrip(null)}>
              Болих
            </Button>
            <Button
              variant="danger"
              loading={busyKey.startsWith("delete-trip-")}
              onClick={() => void confirmDeleteTrip()}
            >
              Устгах
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Устгасны дараа бот энэ аяллын мэдээллийг хариултдаа ашиглахгүй болно.
        </p>
      </Modal>

      {/* Clear settings confirmation modal */}
      <Modal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Текст цэвэрлэх үү?"
        description="Түлхүүр үгийн хариу, FAQ, тусгай санал болон бусад мэдээллийг устгана."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              Болих
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmClear(false);
                setSettingsForm((prev) =>
                  prev
                    ? {
                        ...prev,
                        quick_info_reply: "",
                        quick_info_keywords: "",
                        comment_trigger_patterns: "",
                        comment_public_reply: "",
                        comment_dm_reply: "",
                        faq: [],
                        special_offers: [],
                        discount_policies: [],
                        verified_credentials: [],
                      }
                    : prev,
                );
              }}
            >
              Цэвэрлэх
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-muted">
          Системийн зааварчилга болон бизнесийн нэр хадгалагдана.
        </p>
      </Modal>
    </div>
  );
}

/* ----------------------------------------------------------------
   Assistant tab
   ---------------------------------------------------------------- */
function AssistantTab({
  messages,
  aiInput,
  setAiInput,
  attachedFiles,
  onRemoveAttachedFile,
  dragOver,
  setDragOver,
  busy,
  busyLabel,
  applyBusyId,
  clarifyBusyId,
  onSend,
  onApply,
  onSubmitClarificationForm,
  onCancelProposal,
  onToggleConfirm,
  onPickFile,
  onDropFiles,
  chatEndRef,
  inputRef,
}: {
  messages: ChatMessage[];
  aiInput: string;
  setAiInput: (value: string) => void;
  attachedFiles: AttachedFile[];
  onRemoveAttachedFile: (fileId: string) => void;
  dragOver: boolean;
  setDragOver: (value: boolean) => void;
  busy: boolean;
  busyLabel: string;
  applyBusyId: string;
  clarifyBusyId: string;
  onSend: () => void;
  onApply: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
  onPickFile: () => void;
  onDropFiles: (files: FileList | File[]) => void;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const attachedTotalBytes = attachedFiles.reduce(
    (sum, file) => sum + Math.floor((file.dataUrl.length * 3) / 4),
    0,
  );

  return (
    <div className="space-y-4">
      <Card
        className={cx(
          "flex flex-col overflow-hidden",
          dragOver && "ring-2 ring-brand",
        )}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const files = e.dataTransfer.files;
          if (files?.length) onDropFiles(files);
        }}
      >
        <div className="scroll-area max-h-[55dvh] min-h-70 space-y-3 overflow-y-auto p-3.5">
          {messages.map((message) => (
            <ChatBubbleV2
              key={message.id}
              message={message}
              applyBusy={applyBusyId === message.id}
              clarifyBusy={clarifyBusyId === message.id}
              onApply={onApply}
              onSubmitClarificationForm={onSubmitClarificationForm}
              onCancelProposal={onCancelProposal}
              onToggleConfirm={onToggleConfirm}
            />
          ))}
          {busy && (
            <div className="flex justify-start">
              <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-line bg-surface px-4 py-3 shadow-sm">
                <div className="flex items-center gap-1">
                  {[0, 1, 2].map((n) => (
                    <span
                      key={n}
                      className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
                      style={{ animationDelay: `${n * 0.15}s` }}
                    />
                  ))}
                </div>
                {busyLabel && (
                  <span className="text-xs text-ink-muted">{busyLabel}</span>
                )}
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        <div className="scroll-area flex gap-1.5 overflow-x-auto border-t border-line bg-surface-sunken px-3 py-2">
          {QUICK_ACTIONS.map((action) => (
            <button
              key={action.label}
              type="button"
              onClick={() => {
                setAiInput(action.prompt);
                inputRef.current?.focus();
              }}
              className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-muted hover:border-brand hover:text-brand"
            >
              {action.label}
            </button>
          ))}
        </div>

        {attachedFiles.length > 0 && (
          <div className="flex items-center justify-between border-t border-line bg-surface-sunken px-3 py-2">
            <span className="text-xs text-ink-muted">
              {attachedFiles.length} файл бэлэн • ~{formatBytes(attachedTotalBytes)}
            </span>
            <button
              type="button"
              onClick={() => attachedFiles.forEach((file) => onRemoveAttachedFile(file.id))}
              className="text-xs font-medium text-brand hover:opacity-70"
            >
              Арилгах
            </button>
          </div>
        )}

        <div className="flex items-end gap-2 border-t border-line p-2.5">
          <button
            type="button"
            onClick={onPickFile}
            aria-label="Attach files"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
          >
            <Icons.plus size={18} />
          </button>
          <textarea
            ref={inputRef}
            value={aiInput}
            onChange={(e) => setAiInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
            }}
            rows={1}
            placeholder="Ж: «Бангкок аяллыг цуцал» эсвэл прайс жагсаалт файл хавсаргах"
            className="scroll-area max-h-32 min-h-10 flex-1 resize-none rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
          />
          <Button
            onClick={onSend}
            disabled={busy || (!aiInput.trim() && attachedFiles.length === 0)}
            className="h-10 shrink-0"
          >
            Илгээх
          </Button>
        </div>
      </Card>

      <p className="px-1 text-xs text-ink-subtle">
        Excel болон CSV файлыг AI уншихад тохиромжтой хүснэгт болгоно. PDF, зураг, текст файл нэгэн зэрэг хавсаргаж болно. Маш том файл дээр браузер, сервер эсвэл AI provider-ийн бодит limit нөлөөлж магадгүй.
      </p>

    </div>
  );
}
function ChatBubbleV2({
  message,
  applyBusy,
  clarifyBusy,
  onApply,
  onSubmitClarificationForm,
  onCancelProposal,
  onToggleConfirm: _onToggleConfirm,
}: {
  message: ChatMessage;
  applyBusy: boolean;
  clarifyBusy: boolean;
  onApply: (message: ProposalMsg) => void;
  onSubmitClarificationForm: (
    message: ProposalMsg,
    answers: Record<string, string>,
  ) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
}) {
  void _onToggleConfirm;
  const [formDraft, setFormDraft] = useState<Record<string, string>>({});
  if (message.role === "admin") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">
          <p className="whitespace-pre-wrap wrap-break-word">{message.text}</p>
        </div>
      </div>
    );
  }

  if (message.kind === "note") {
    const tone =
      message.tone === "error"
        ? "danger"
        : message.tone === "success"
          ? "success"
          : "info";
    return (
      <div className="max-w-[92%]">
        <Alert tone={tone}>{message.text}</Alert>
      </div>
    );
  }

  const { proposal } = message;
  const previewActions = proposal.actions.slice(0, 4).map(describeAction);
  const hiddenActionCount = Math.max(
    0,
    proposal.actions.length - previewActions.length,
  );
  const compactWarnings = Array.from(
    new Set(proposal.conflicts.map(summarizeConflict).filter(Boolean)),
  ).slice(0, 3);
  const reviewCount = message.clarifications.length;
  const isReadyToApply = message.status === "pending" && reviewCount === 0;

  return (
    <div className="max-w-[92%]">
      <div className="rounded-xl rounded-bl-sm border border-line bg-surface p-3.5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">{proposal.summary}</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge tone="neutral">{proposal.actions.length} өөрчлөлт</Badge>
              {reviewCount > 0 ? (
                <Badge tone="warning">{reviewCount} шийдвэр хэрэгтэй</Badge>
              ) : (
                <Badge tone="success">Шууд хадгалахад бэлэн</Badge>
              )}
            </div>
          </div>
          <Badge tone={isReadyToApply ? "success" : "warning"}>
            {isReadyToApply ? "Ready" : "Review"}
          </Badge>
        </div>

        {compactWarnings.length > 0 && (
          <div className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            <p className="text-xs font-semibold text-amber-900">
              Товч шалгалт
            </p>
            <div className="mt-1 space-y-1">
              {compactWarnings.map((item) => (
                <p key={item} className="text-xs text-amber-900/90">
                  {item}
                </p>
              ))}
            </div>
          </div>
        )}

        {previewActions.length > 0 && (
          <details className="mt-3 rounded-md border border-line bg-surface-sunken px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-ink-muted">
              Өөрчлөлтийн товч жагсаалт
            </summary>
            <div className="mt-2 space-y-2">
              {previewActions.map((described, index) => (
                <div key={`${described.verb}:${described.target}:${index}`}>
                  <p className="text-sm font-medium text-ink">
                    {index + 1}. {described.verb} · {described.target}
                  </p>
                  {described.changes.length > 0 && (
                    <p className="mt-0.5 text-xs text-ink-muted">
                      {described.changes.slice(0, 2).join(" • ")}
                    </p>
                  )}
                </div>
              ))}
              {hiddenActionCount > 0 && (
                <p className="text-xs text-ink-subtle">
                  +{hiddenActionCount} нэмэлт өөрчлөлт байна.
                </p>
              )}
            </div>
          </details>
        )}

        {message.clarificationAnswers.length > 0 && (
          <details className="mt-3 rounded-md border border-line bg-brand-soft px-3 py-2">
            <summary className="cursor-pointer text-xs font-semibold text-brand">
              Өмнө сонгосон хариултууд ({message.clarificationAnswers.length})
            </summary>
            <div className="mt-2 space-y-2">
              {message.clarificationAnswers.map((item) => (
                <div key={item.questionId} className="rounded-md bg-white/70 px-2.5 py-2">
                  <p className="text-xs text-ink-muted">{item.prompt}</p>
                  <p className="mt-1 text-sm text-ink">{item.answer}</p>
                </div>
              ))}
            </div>
          </details>
        )}

        {message.status === "pending" && (
          <div className="mt-3 border-t border-line pt-3">
            {message.clarifications.length > 0 ? (
              <div className="space-y-3">
                <p className="text-xs font-semibold text-ink">Шийдвэр гаргах зүйлс</p>
                {message.clarifications.map((q) => {
                  const selected = formDraft[q.id] ?? "";
                  return (
                    <div
                      key={q.id}
                      className="rounded-md border border-line bg-surface-sunken px-3 py-3"
                    >
                      <p className="text-xs font-semibold text-ink-muted">
                        Асуулт
                      </p>
                      <p className="mt-1 text-sm font-medium text-ink">{q.prompt}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {q.options.map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            disabled={clarifyBusy}
                            onClick={() =>
                              setFormDraft((prev) => ({ ...prev, [q.id]: opt.answer }))
                            }
                            className={cx(
                              "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
                              selected === opt.answer
                                ? "border-brand bg-brand text-white"
                                : "border-line-strong bg-white text-ink hover:border-brand hover:text-brand",
                            )}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                      {q.allowCustom && (
                        <input
                          value={
                            q.options.some((o) => o.answer === selected) ? "" : selected
                          }
                          onChange={(e) =>
                            setFormDraft((prev) => ({ ...prev, [q.id]: e.target.value }))
                          }
                          placeholder={q.customPlaceholder || "Өөрийн хариуг бичнэ үү"}
                          className="mt-2 h-9 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink focus:border-brand"
                        />
                      )}
                    </div>
                  );
                })}
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    loading={clarifyBusy}
                    disabled={
                      clarifyBusy ||
                      message.clarifications.some((q) => !(formDraft[q.id] ?? "").trim())
                    }
                    onClick={() => {
                      onSubmitClarificationForm(message, formDraft);
                      setFormDraft({});
                    }}
                  >
                    Шийдвэрүүдийг хадгалах
                  </Button>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onCancelProposal(message.id)}
                  >
                    Болих
                  </Button>
                </div>
              </div>
            ) : (
              <p className="mb-2 text-xs text-ink-muted">
                {proposal.conflicts.length > 0
                  ? "Тодорхойгүй байсан зүйлсийг нарийвчилсан. Зөв харагдвал хэрэгжүүлж болно."
                  : "Бүх зүйл тодорхой байна. Өөрчлөлтийг хэрэгжүүлж болно."}
              </p>
            )}
            {message.clarifications.length === 0 && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="success"
                  loading={applyBusy}
                  onClick={() => onApply(message)}
                >
                  <Icons.check size={15} />
                  Зөвшөөрч хадгалах
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onCancelProposal(message.id)}
                >
                  Болих
                </Button>
              </div>
            )}
          </div>
        )}

        {message.status === "applied" && (
          <div className="mt-3 flex items-center gap-1.5 border-t border-line pt-2 text-xs font-medium text-success">
            <Icons.check size={14} />
            Хадгалагдлаа. {message.resultText}
          </div>
        )}
        {message.status === "cancelled" && (
          <p className="mt-3 border-t border-line pt-2 text-xs text-ink-subtle">
            Цуцлагдсан.
          </p>
        )}
        {message.status === "error" && (
          <p className="mt-3 border-t border-line pt-2 text-xs text-danger">
            {message.resultText || "Алдаа гарлаа."}
          </p>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Trips tab
   ---------------------------------------------------------------- */
function TripsTab({
  trips,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  loading,
  onRefresh,
  onCreate,
  onEdit,
  onDelete,
}: {
  trips: TravelTrip[];
  search: string;
  setSearch: (value: string) => void;
  statusFilter: string;
  setStatusFilter: (value: string) => void;
  loading: boolean;
  onRefresh: () => void;
  onCreate: () => void;
  onEdit: (trip: TravelTrip) => void;
  onDelete: (trip: TravelTrip) => void;
}) {
  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Маршрут эсвэл оператор хайх…"
              className="h-10 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
            />
            <button
              type="button"
              onClick={onRefresh}
              aria-label="Шинэчлэх"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
            >
              {loading ? <Spinner /> : <Icons.refresh size={17} />}
            </button>
          </div>
          <div className="flex gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="h-10 flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-sm text-ink focus:border-brand"
            >
              <option value="">Бүх төлөв</option>
              <option value="active">Идэвхтэй</option>
              <option value="cancelled">Цуцлагдсан</option>
              <option value="sold_out">Суудал дууссан</option>
              <option value="draft">Ноорог</option>
            </select>
            <Button onClick={onCreate} className="shrink-0">
              <Icons.plus size={16} />
              Шинэ аялал
            </Button>
          </div>
        </div>
      </Card>

      {trips.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.trips size={26} />}
            title="Аялал олдсонгүй"
            description="Шинэ аялал нэмэх, эсвэл AI Туслахаар прайс жагсаалт оруулна уу."
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {trips.map((trip) => (
            <TripCard
              key={trip.id}
              trip={trip}
              onEdit={() => onEdit(trip)}
              onDelete={() => onDelete(trip)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TripCard({
  trip,
  onEdit,
  onDelete,
}: {
  trip: TravelTrip;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const facts: string[] = [];
  if (trip.seats_left != null || trip.seats_total != null) {
    facts.push(
      `Суудал: ${trip.seats_left ?? "?"}/${trip.seats_total ?? "?"}`,
    );
  }
  if (trip.adult_price != null) {
    facts.push(`Том хүн: ${trip.adult_price.toLocaleString()}${trip.currency}`);
  }
  if (trip.child_price != null) {
    facts.push(`Хүүхэд: ${trip.child_price.toLocaleString()}${trip.currency}`);
  }
  if (trip.has_food != null) {
    facts.push(`Хоол: ${trip.has_food ? "багтсан" : "багтаагүй"}`);
  }
  if (trip.duration_text) facts.push(trip.duration_text);
  if (trip.departure_dates.length) {
    facts.push(`${trip.departure_dates.length} гарах өдөр`);
  }

  return (
    <Card className="p-3.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{trip.route_name || "—"}</p>
          <p className="text-xs text-ink-subtle">
            {trip.operator_name}
            {trip.category ? ` · ${trip.category}` : ""}
          </p>
        </div>
        <Badge tone={STATUS_TONE[trip.status]}>
          {STATUS_LABELS[trip.status]}
        </Badge>
      </div>
      {facts.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {facts.map((fact, i) => (
            <span
              key={i}
              className="rounded-md bg-surface-sunken px-2 py-0.5 text-xs text-ink-muted"
            >
              {fact}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-subtle">
          Шинэчилсэн: {formatTime(trip.updated_at)}
        </span>
        <div className="flex gap-2">
          <Button size="sm" variant="secondary" onClick={onEdit}>
            <Icons.edit size={15} />
            Засах
          </Button>
          <Button size="sm" variant="ghost" className="text-danger" onClick={onDelete}>
            <Icons.trash size={15} />
            Устгах
          </Button>
        </div>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Leads tab — human-handoff requests & booking-intent captures
   ---------------------------------------------------------------- */
function LeadsTab({
  leads,
  loading,
  onRefresh,
  onMarkSeen,
}: {
  leads: TravelLead[];
  loading: boolean;
  onRefresh: () => void;
  onMarkSeen: (lead: TravelLead) => void;
}) {
  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Хэрэглэгчийн хүсэлтүүд</p>
            <p className="text-xs text-ink-subtle">
              Хүнтэй ярих хүсэлт болон захиалгын сонирхол гаргасан хэрэглэгчид.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Шинэчлэх"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong text-ink-muted hover:border-brand hover:text-brand"
          >
            {loading ? <Spinner /> : <Icons.refresh size={17} />}
          </button>
        </div>
      </Card>

      {leads.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.alert size={26} />}
            title="Хүсэлт алга"
            description="Хэрэглэгч хүнтэй ярих эсвэл захиалга хийх сонирхол гаргавал энд харагдана."
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onMarkSeen={() => onMarkSeen(lead)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function LeadCard({
  lead,
  onMarkSeen,
}: {
  lead: TravelLead;
  onMarkSeen: () => void;
}) {
  const isNew = lead.status === "new";
  const isBooking = lead.kind === "booking";
  const channel = lead.platform === "instagram" ? "Instagram" : "Facebook";

  return (
    <Card className={cx("p-3.5", !isNew && "opacity-65")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isBooking ? "success" : "warning"} dot>
            {isBooking ? "Захиалгын сонирхол" : "Хүн ярих хүсэлт"}
          </Badge>
          <span className="text-xs text-ink-subtle">{channel}</span>
        </div>
        {isNew && (
          <Badge tone="danger">Шинэ</Badge>
        )}
      </div>

      <p className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-sm text-ink">
        {lead.customer_message || "(хоосон зурвас)"}
      </p>

      {lead.contact_phone && (
        <p className="mt-2 text-sm font-semibold text-ink">
          ☎ Утас:{" "}
          <a href={`tel:${lead.contact_phone}`} className="text-brand">
            {lead.contact_phone}
          </a>
        </p>
      )}

      {lead.context && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">
            Харилцааны түүх
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-canvas/60 px-2.5 py-2 text-xs text-ink-muted">
            {lead.context}
          </p>
        </details>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-ink-subtle">
          {formatTime(lead.created_at)} · ID …{lead.sender_id.slice(-6)}
        </span>
        {isNew ? (
          <Button size="sm" variant="secondary" onClick={onMarkSeen}>
            <Icons.check size={15} />
            Хариуцсан
          </Button>
        ) : (
          <span className="flex items-center gap-1 text-xs text-ink-subtle">
            <Icons.check size={13} />
            Харсан
          </span>
        )}
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Bot tab
   ---------------------------------------------------------------- */
function BotTab({
  control,
  pauseReason,
  setPauseReason,
  recentRows,
  pausedRows,
  pausedIds,
  busyKey,
  tick,
  onPauseAction,
}: {
  control: ControlState | null;
  pauseReason: string;
  setPauseReason: (value: string) => void;
  recentRows: RecentRow[];
  pausedRows: PauseRow[];
  pausedIds: Set<string>;
  busyKey: string;
  tick: number;
  onPauseAction: (
    action: "pause" | "resume" | "global_pause" | "global_resume",
    senderId?: string,
    ms?: number | null,
  ) => void;
}) {
  const botPaused = Boolean(control?.bot_paused);
  const handoffRows = pausedRows.filter((row) => row.reason === "handoff");
  const handoffIds = new Set(handoffRows.map((row) => row.sender_id));
  return (
    <div className="space-y-3">
      {handoffRows.length > 0 && (
        <Card className="border-warning/40 bg-warning-soft p-4">
          <div className="flex items-start gap-2">
            <span className="text-lg leading-none">🙋</span>
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink">
                Хүнтэй ярихыг хүссэн ({handoffRows.length})
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Эдгээр хэрэглэгч ажилтантай ярихыг хүссэн. Messenger дээр
                очиж хариулна уу. Бот тэдэнд автоматаар хариулахгүй.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {handoffRows.map((row) => (
              <div
                key={row.sender_id}
                className="rounded-md border border-warning/40 bg-surface p-2.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs text-ink">
                    {shortId(row.sender_id)}
                  </p>
                    <p className="text-xs text-ink-subtle">
                    Хүссэн: {formatTime(row.paused_at)} · Дуусах:{" "}
                    {tick >= 0 ? timeLeft(row.expires_at) : ""}
                    </p>
                  </div>
                <Button
                  size="sm"
                  variant="success"
                  disabled={
                    busyKey === `resume:${row.sender_id}` ||
                    busyKey === `pause:${row.sender_id}`
                  }
                  onClick={() => onPauseAction("resume", row.sender_id)}
                >
                  Ботыг сэргээх
                </Button>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {[
                    { label: "30 мин", ms: 30 * 60 * 1000 },
                    { label: "1 цаг", ms: 60 * 60 * 1000 },
                    { label: "Гараар", ms: null },
                  ].map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      disabled={
                        busyKey === `pause:${row.sender_id}` ||
                        busyKey === `resume:${row.sender_id}`
                      }
                      onClick={() =>
                        onPauseAction("pause", row.sender_id, option.ms)
                      }
                      className="rounded-md border border-warning/40 bg-warning-soft px-2 py-1 text-xs font-medium text-warning hover:border-warning"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card className="p-4">
        <SectionHeading
          title="Ботын төлөв"
          description="Мэдээлэл их хэмжээгээр шинэчлэх үед ботыг түр зогсоож болно."
        />
        <div className="mt-3 flex items-center gap-2">
          <Badge tone={botPaused ? "danger" : "success"} dot>
            {botPaused ? "Бот зогссон" : "Бот идэвхтэй"}
          </Badge>
          <span className="text-xs text-ink-subtle">
            {formatTime(control?.updated_at)}
          </span>
        </div>
        <div className="mt-3 space-y-2">
          <input
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="Зогсоох шалтгаан (сонголттой)"
            className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
          />
          <div className="flex gap-2">
            <Button
              variant="danger"
              block
              disabled={busyKey === "global_pause:global" || botPaused}
              onClick={() => onPauseAction("global_pause")}
            >
              <Icons.pause size={16} />
              Бот зогсоох
            </Button>
            <Button
              variant="success"
              block
              disabled={busyKey === "global_resume:global" || !botPaused}
              onClick={() => onPauseAction("global_resume")}
            >
              <Icons.play size={16} />
              Бот сэргээх
            </Button>
          </div>
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Сүүлийн харилцагчид"
          description="Тодорхой хэрэглэгчийн ботыг түр зогсоох/сэргээх."
        />
        <div className="mt-3 space-y-2">
          {recentRows.length === 0 && (
            <p className="text-sm text-ink-subtle">
              Сүүлийн харилцан яриа алга.
            </p>
          )}
          {recentRows.map((row) => {
            const isPaused = pausedIds.has(row.sender_id);
            const pauseRow = pausedRows.find(
              (p) => p.sender_id === row.sender_id,
            );
            const wantsHuman = handoffIds.has(row.sender_id);
            return (
              <div
                key={row.sender_id}
                className={cx(
                  "rounded-md border p-2.5",
                  wantsHuman
                    ? "border-warning/40 bg-warning-soft"
                    : "border-line bg-surface-sunken",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate font-mono text-xs text-ink">
                      {shortId(row.sender_id)}
                      {wantsHuman && (
                        <span className="shrink-0 rounded-full bg-warning-soft px-1.5 text-[10px] font-semibold text-warning">
                          🙋 хүн хүсэв
                        </span>
                      )}
                    </p>
                    <p className="text-xs text-ink-subtle">
                      {formatTime(row.last_seen)}
                      {isPaused && pauseRow
                        ? ` · ${tick >= 0 ? timeLeft(pauseRow.expires_at) : ""}`
                        : ""}
                    </p>
                  </div>
                  {isPaused ? (
                    <Button
                      size="sm"
                      variant="success"
                      disabled={busyKey === `resume:${row.sender_id}`}
                      onClick={() => onPauseAction("resume", row.sender_id)}
                    >
                      Сэргээх
                    </Button>
                  ) : (
                    <div className="flex gap-1">
                      {DURATIONS.map((duration) => (
                        <button
                          key={duration.label}
                          type="button"
                          disabled={busyKey === `pause:${row.sender_id}`}
                          onClick={() =>
                            onPauseAction("pause", row.sender_id, duration.ms)
                          }
                          className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-ink-muted hover:border-danger hover:text-danger"
                        >
                          {duration.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------
   Settings tab
   ---------------------------------------------------------------- */
function SettingsTab({
  form,
  setForm,
  updatedAt,
  busy,
  driveSync,
  syncBusy,
  onSyncDriveNow,
  onSave,
  onRequestClear,
}: {
  form: SettingsForm;
  setForm: React.Dispatch<React.SetStateAction<SettingsForm | null>>;
  updatedAt?: string;
  busy: boolean;
  driveSync: DriveSyncDiagnostics | null;
  syncBusy: boolean;
  onSyncDriveNow: () => void;
  onSave: () => void;
  onRequestClear: () => void;
}) {
  function patch(partial: Partial<SettingsForm>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  const handoffDurationMode = handoffDurationSelectValue(form.handoff_pause_minutes);
  const [showOptionalData, setShowOptionalData] = useState(false);

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <SectionHeading
          title="Google Drive Sync"
          description="Drive folder-оос өөрчлөгдсөн файлуудыг автоматаар уншиж, аюулгүй бол шууд хадгална."
          action={
            <Button size="sm" loading={syncBusy} onClick={onSyncDriveNow}>
              <Icons.refresh size={15} />
              Sync now
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={driveSync?.enabled ? "success" : "neutral"} dot>
              {driveSync?.enabled ? "Идэвхтэй" : "Унтраалттай"}
            </Badge>
            <Badge tone={driveSyncTone(driveSync?.state.status)}>
              {driveSync?.state.status || "idle"}
            </Badge>
            <span className="text-xs text-ink-subtle">
              Давтамж: {driveSync?.interval_minutes ?? 30} мин
            </span>
            <span className="text-xs text-ink-subtle">
              Дээд файл: {driveSync?.file_limit ?? 0}
            </span>
          </div>

          {!driveSync?.configured ? (
            <Alert tone="warning">
              GOOGLE_DRIVE_SYNC_ENABLED-ийг асаахаас гадна folder ID, service account
              email, private key-гээ env-д тохируулна. Дараа нь тухайн Drive folder-оо
              service account хаягтай share хийнэ.
            </Alert>
          ) : (
            <div className="rounded-lg border border-line bg-surface-sunken p-3 text-sm text-ink-muted">
              <p>Folder ID: {driveSync.folder_id || "—"}</p>
              <p>Service account: {driveSync.service_account_email || "—"}</p>
              <p>Сүүлд шалгасан: {formatTime(driveSync.state.last_checked_at)}</p>
              <p>Сүүлд дууссан: {formatTime(driveSync.state.last_synced_at)}</p>
              <p>
                Үзсэн {driveSync.state.files_examined} · Өөрчлөгдсөн{" "}
                {driveSync.state.files_changed} · Автоматаар хадгалсан{" "}
                {driveSync.state.files_applied} · Хяналт шаардлагатай{" "}
                {driveSync.state.files_blocked}
              </p>
              {driveSync.state.last_summary && (
                <p className="mt-2 whitespace-pre-wrap text-ink">
                  {driveSync.state.last_summary}
                </p>
              )}
              {driveSync.state.last_error && (
                <p className="mt-2 whitespace-pre-wrap text-danger">
                  {driveSync.state.last_error}
                </p>
              )}
            </div>
          )}

          {driveSync?.recent_files?.length ? (
            <div className="space-y-2">
              {driveSync.recent_files.slice(0, 4).map((file) => (
                <div
                  key={file.file_id}
                  className="rounded-md border border-line bg-surface px-3 py-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-ink">
                      {file.file_name || file.file_id}
                    </p>
                    <Badge tone={driveSyncTone(file.last_status as DriveSyncDiagnostics["state"]["status"])}>
                      {file.last_status}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-ink-subtle">
                    {formatTime(file.updated_at)}
                    {file.request_id ? ` · Request #${file.request_id}` : ""}
                  </p>
                  {file.last_error && (
                    <p className="mt-1 whitespace-pre-wrap text-xs text-danger">
                      {file.last_error}
                    </p>
                  )}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Үндсэн мэдээлэл"
          description={
            updatedAt
              ? `Шинэчилсэн: ${formatTime(updatedAt)}`
              : 'Бизнесийн нэр болон ботын үндсэн дүрэм.'
          }
          action={
            <Button size="sm" variant="ghost" onClick={onRequestClear}>
              Текст цэвэрлэх
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <Input
            label="Бизнесийн нэр"
            value={form.business_name}
            onChange={(e) => patch({ business_name: e.target.value })}
          />
          <Textarea
            label="Системийн зааварчилга"
            hint="Хэрэглэгчтэй харилцах ботын үндсэн дүрэм."
            rows={4}
            value={form.system_prompt}
            onChange={(e) => patch({ system_prompt: e.target.value })}
          />
          <Textarea
            label="Түлхүүр үгийн хариу"
            hint="Хэрэглэгч доорх түлхүүр үг бичвэл бот энэ хариуг автоматаар илгээнэ."
            rows={3}
            value={form.quick_info_reply}
            onChange={(e) => patch({ quick_info_reply: e.target.value })}
          />
          <Textarea
            label="Түлхүүр үгс"
            hint="Нэг мөрт нэг түлхүүр үг эсвэл хэллэг."
            rows={3}
            value={form.quick_info_keywords}
            onChange={(e) => patch({ quick_info_keywords: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Коммент автомат хариу"
          description="Facebook пост дээрх комментэд хариулах тохиргоо."
        />
        <div className="mt-3 space-y-3">
          <Textarea
            label="Коммент илэрхийлэх түлхүүр үгс"
            hint="Нэг мөрт нэг түлхүүр үг эсвэл хэллэг."
            rows={3}
            value={form.comment_trigger_patterns}
            onChange={(e) =>
              patch({ comment_trigger_patterns: e.target.value })
            }
          />
          <Textarea
            label="Нийтийн хариу (комментэд)"
            hint="Хэрэглэгчийн комментийн доор харагдах хариу."
            rows={2}
            value={form.comment_public_reply}
            onChange={(e) => patch({ comment_public_reply: e.target.value })}
          />
          <Textarea
            label="Хувийн мессеж (DM)"
            hint="Хэрэглэгчид шууд илгээх нууц хариу."
            rows={3}
            value={form.comment_dm_reply}
            onChange={(e) => patch({ comment_dm_reply: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Хүнд шилжүүлэх"
          description="Хэрэглэгч ажилтантай ярихыг хүсвэл бот зогсож, та хариулна."
        />
        <div className="mt-3 space-y-3">
          <label className="flex items-center gap-2.5 rounded-md border border-line bg-surface-sunken p-3">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={form.handoff_enabled}
              onChange={(e) => patch({ handoff_enabled: e.target.checked })}
            />
            <span className="text-sm font-medium text-ink">
              Хүнд шилжүүлэх идэвхжүүлэх
            </span>
          </label>
          <Textarea
            label="Илэрхийлэх түлхүүр үгс"
            hint="Хэрэглэгчийн мессежэд эдгээр үг байвал бот зогсч ажилтанд шилжинэ."
            rows={4}
            value={form.handoff_keywords}
            onChange={(e) => patch({ handoff_keywords: e.target.value })}
          />
          <Textarea
            label="Хэрэглэгчид илгээх хариу"
            rows={2}
            value={form.handoff_reply}
            onChange={(e) => patch({ handoff_reply: e.target.value })}
          />
          <Select
            label="Зогсоох хугацаа"
            hint="Тогтмол хугацаа сонгоно уу, эсвэл доорх минутын талбарт өөрийн утга оруулна уу."
            value={handoffDurationMode}
            onChange={(e) => {
              const next = e.target.value;
              patch({
                handoff_pause_minutes:
                  next === HANDOFF_DURATION_CUSTOM
                    ? form.handoff_pause_minutes
                    : next,
              });
            }}
          >
            {HANDOFF_DURATION_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
            <option value={HANDOFF_DURATION_CUSTOM}>Өөр хугацаа</option>
          </Select>
          <Input
            label="Зогсоох минут"
            hint="Энэ хугацааны дараа бот автоматаар сэргэнэ. 0 оруулбал гараар сэргээх болно."
            inputMode="numeric"
            value={form.handoff_pause_minutes}
            onChange={(e) => patch({ handoff_pause_minutes: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Нэмэлт ботын мэдлэг"
          description="FAQ, тусгай санал, хөнгөлөлт, итгэмжлэл нэмэхийг хүсвэл нээнэ үү."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowOptionalData((prev) => !prev)}
            >
              {showOptionalData ? 'Нуух' : 'Нээх'}
            </Button>
          }
        />
        {showOptionalData ? (
          <div className="mt-3 space-y-3">
            <StructuredEditor
              title="Түгээмэл асуулт (FAQ)"
              addLabel="Асуулт нэмэх"
              fields={[
                { key: 'question', label: 'Асуулт' },
                { key: 'answer', label: 'Хариулт' },
              ]}
              rows={form.faq}
              onChange={(rows) => patch({ faq: rows })}
            />
            <StructuredEditor
              title="Тусгай санал"
              addLabel="Санал нэмэх"
              fields={[
                { key: 'name', label: 'Нэр' },
                { key: 'duration', label: 'Хугацаа' },
                { key: 'price', label: 'Үнэ' },
                { key: 'target', label: 'Зорилтот' },
                { key: 'eligibility', label: 'Нөхцөл' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.special_offers}
              onChange={(rows) => patch({ special_offers: rows })}
            />
            <StructuredEditor
              title="Хөнгөлөлтийн бодлого"
              addLabel="Хөнгөлөлт нэмэх"
              fields={[
                { key: 'name', label: 'Нэр' },
                { key: 'discount', label: 'Хөнгөлөлт' },
                { key: 'applies_to', label: 'Хамаарах' },
                { key: 'eligibility', label: 'Нөхцөл' },
                { key: 'verification', label: 'Баталгаажуулалт' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.discount_policies}
              onChange={(rows) => patch({ discount_policies: rows })}
            />
            <StructuredEditor
              title="Итгэмжлэл"
              addLabel="Итгэмжлэл нэмэх"
              fields={[
                { key: 'title', label: 'Гарчиг' },
                { key: 'issuer', label: 'Олгогч' },
                { key: 'issued_on', label: 'Олгосон огноо' },
                { key: 'description', label: 'Тайлбар' },
              ]}
              rows={form.verified_credentials}
              onChange={(rows) => patch({ verified_credentials: rows })}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            Хуудсыг энгийн байлгахын тулд нуусан. FAQ эсвэл тусгай санал нэмэхийг хүсвэл нээнэ үү.
          </p>
        )}
      </Card>

      <div className="sticky bottom-3 z-10">
        <Button block size="lg" loading={busy} onClick={onSave}>
          Тохиргоо хадгалах
        </Button>
      </div>

      <Card className="overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-line bg-surface px-4 py-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand text-white">
            <Icons.ai size={16} />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink">Бот туршиж үзэх</p>
            <p className="text-xs text-ink-muted">Хэрэглэгч шиг асуугаад хариуг шалгаарай</p>
          </div>
          <Badge tone="success" dot className="ml-auto shrink-0">
            Идэвхтэй
          </Badge>
        </div>
        <EmbeddedTestBot />
      </Card>
    </div>
  );
}

/* ----------------------------------------------------------------
   Embedded test bot (in SettingsTab) — Messenger style
   ---------------------------------------------------------------- */
type TestChatMsg = { from: "user" | "bot"; text: string };

const TEST_SUGGESTIONS = [
  "Хөх хот аяллын үнэ хэд вэ?",
  "Ирэх сард ямар аяллууд байгаа вэ?",
  "Суудал хэд үлдсэн бэ?",
  "Хоол багтдаг уу?",
];

function EmbeddedTestBot() {
  const [messages, setMessages] = useState<TestChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [conversationId, setConversationId] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setConversationId(getTestBotConversationId());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, sending]);

  async function send(textOverride?: string) {
    const payload = (textOverride ?? input).trim();
    if (!payload || sending || !conversationId) return;
    setMessages((prev) => [...prev, { from: "user", text: payload }]);
    setInput("");
    setSending(true);
    try {
      const res = await fetch("/api/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: payload, conversationId }),
      });
      const json = await res.json();
      setMessages((prev) => [
        ...prev,
        {
          from: "bot",
          text:
            typeof json?.reply === "string" && json.reply.trim()
              ? json.reply
              : "Хариу үүсгэх үед алдаа гарлаа.",
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { from: "bot", text: "Уучлаарай, сервертэй холбогдоход алдаа гарлаа." },
      ]);
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Suggestion chips */}
      <div className="scroll-area flex gap-2 overflow-x-auto border-b border-line bg-surface-sunken px-4 py-2.5">
        {TEST_SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            disabled={sending || !conversationId}
            onClick={() => void send(s)}
            className="shrink-0 rounded-full border border-line-strong bg-surface px-3 py-1 text-xs font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>

      {/* Message area */}
      <div className="scroll-area h-72 overflow-y-auto bg-[#f0f2f5] px-4 py-4">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-brand/10 text-brand">
              <Icons.ai size={24} />
            </div>
            <p className="text-sm text-ink-muted">
              Хэрэглэгч шиг асуулт бичээрэй — бот хэрхэн хариулахыг шалгаарай.
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {messages.map((msg, i) => {
              const isUser = msg.from === "user";
              const showAvatar =
                !isUser &&
                (i === 0 || messages[i - 1]?.from === "user");
              return (
                <div
                  key={i}
                  className={cx(
                    "flex items-end gap-2",
                    isUser ? "justify-end" : "justify-start",
                  )}
                >
                  {!isUser && (
                    <div
                      className={cx(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white text-xs font-bold",
                        !showAvatar && "opacity-0",
                      )}
                    >
                      AI
                    </div>
                  )}
                  <div
                    className={cx(
                      "max-w-[75%] px-4 py-2.5 text-sm leading-relaxed",
                      isUser
                        ? "rounded-[20px] rounded-br-[4px] bg-brand text-white"
                        : "rounded-[20px] rounded-bl-[4px] bg-white text-ink shadow-sm",
                    )}
                  >
                    <p className="whitespace-pre-wrap">{msg.text}</p>
                  </div>
                </div>
              );
            })}
            {sending && (
              <div className="flex items-end gap-2 justify-start">
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand text-white text-xs font-bold">
                  AI
                </div>
                <div className="rounded-[20px] rounded-bl-[4px] bg-white px-4 py-3 shadow-sm">
                  <div className="flex items-center gap-1">
                    {[0, 1, 2].map((n) => (
                      <span
                        key={n}
                        className="h-2 w-2 animate-bounce rounded-full bg-ink-subtle"
                        style={{ animationDelay: `${n * 0.15}s` }}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input bar — Messenger style */}
      <div className="flex items-center gap-2 border-t border-line bg-surface px-3 py-2.5">
        {messages.length > 0 && (
          <button
            type="button"
            onClick={() => setMessages([])}
            title="Чат цэвэрлэх"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-ink-subtle hover:bg-surface-sunken hover:text-ink"
          >
            <Icons.trash size={16} />
          </button>
        )}
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); void send(); }
          }}
          placeholder="Мессеж бичих…"
          disabled={sending || !conversationId}
          className="h-10 min-w-0 flex-1 rounded-full border border-line-strong bg-surface-sunken px-4 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:bg-surface focus:outline-none disabled:opacity-60"
        />
        <button
          type="button"
          disabled={sending || !input.trim() || !conversationId}
          onClick={() => void send()}
          className={cx(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition-colors",
            input.trim() && !sending
              ? "bg-brand text-white hover:opacity-90"
              : "bg-surface-sunken text-ink-subtle cursor-not-allowed",
          )}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
