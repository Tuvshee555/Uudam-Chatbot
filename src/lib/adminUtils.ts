import type {
  ConflictItem,
  DriveSyncDiagnostics,
  SettingsForm,
  StructuredRow,
  TravelBotSettings,
  TripStatus,
} from "./adminTypes";

export const MAX_AI_INPUT_CHARS = 500_000;

export const STATUS_TONE: Record<
  TripStatus,
  "success" | "danger" | "warning" | "neutral"
> = {
  active: "success",
  cancelled: "danger",
  sold_out: "warning",
  draft: "neutral",
  archived: "neutral",
};

export const DURATIONS: Array<{ label: string; ms: number }> = [
  { label: "10 мин", ms: 10 * 60 * 1000 },
  { label: "30 мин", ms: 30 * 60 * 1000 },
  { label: "1 цаг", ms: 60 * 60 * 1000 },
  { label: "24 цаг", ms: 24 * 60 * 60 * 1000 },
  { label: "14 хоног", ms: 14 * 24 * 60 * 60 * 1000 },
];

export const HANDOFF_DURATION_OPTIONS = [
  { label: "30 минут", value: "30" },
  { label: "1 цаг", value: "60" },
  { label: "2 цаг", value: "120" },
  { label: "Гараар сэргээх хүртэл", value: "0" },
] as const;

export const HANDOFF_DURATION_CUSTOM = "custom";

export const QUICK_ACTIONS: Array<{ label: string; prompt: string }> = [
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

export function asInt(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatMoney(value: number | null | undefined, currency = "MNT") {
  if (typeof value !== "number") return "—";
  return `${value.toLocaleString("mn-MN")} ${currency || "MNT"}`;
}

/**
 * Mongolian date-time for every admin surface. toLocaleString("mn-MN")
 * silently falls back to ENGLISH month names ("9 Jul") on browsers without
 * Mongolian locale data — which is most of them — so the words are explicit.
 * Relative for the freshest items, year only when it differs.
 */
export function formatTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const hm = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, now)) return `Өнөөдөр ${hm}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Өчигдөр ${hm}`;
  const md = `${date.getMonth() + 1} сарын ${date.getDate()}`;
  if (date.getFullYear() === now.getFullYear()) return `${md}, ${hm}`;
  return `${date.getFullYear()} оны ${md}`;
}

export function shortId(value: string | null | undefined) {
  if (!value) return "—";
  return value.length <= 14 ? value : `…${value.slice(-12)}`;
}

export function timeLeft(expiresAt: string | null) {
  if (!expiresAt) return "гараар сэргээнэ";
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "Дууссан";
  const minutes = Math.floor(diff / 60000);
  const seconds = Math.floor((diff % 60000) / 1000);
  return minutes <= 0 ? `${seconds}с` : `${minutes}м ${seconds}с`;
}

export function splitLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function settingsToForm(settings: TravelBotSettings): SettingsForm {
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
    handoff_enabled: Boolean(settings.handoff_enabled),
    handoff_keywords: (settings.handoff_keywords || []).join("\n"),
    handoff_reply: settings.handoff_reply || "",
    handoff_pause_minutes: String(settings.handoff_pause_minutes ?? 60),
    chat_buttons: Array.isArray(settings.chat_buttons) ? settings.chat_buttons : [],
  };
}

export function toStructuredRows(value: unknown): StructuredRow[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row: StructuredRow = {};
      for (const [key, val] of Object.entries(item as Record<string, unknown>)) {
        row[key] = typeof val === "string" ? val : val == null ? "" : String(val);
      }
      return row;
    })
}

export function handoffDurationSelectValue(minutes: number | string): string {
  const value = String(minutes);
  return HANDOFF_DURATION_OPTIONS.some((option) => option.value === value)
    ? value
    : HANDOFF_DURATION_CUSTOM;
}

export function driveSyncTone(
  status: DriveSyncDiagnostics["state"]["status"] | undefined,
): "success" | "warning" | "danger" | "neutral" {
  if (status === "success") return "success";
  if (status === "warning" || status === "running") return "warning";
  if (status === "error") return "danger";
  return "neutral";
}

const TEST_BOT_CONVERSATION_KEY = "uudam_admin_testbot_conversation_id";

export function getTestBotConversationId(): string {
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

export function conflictTone(
  conflict: ConflictItem,
): "success" | "warning" | "danger" | "neutral" {
  if (conflict.severity === "blocker") return "danger";
  if (conflict.severity === "warning") return "warning";
  if (conflict.severity === "info") return "neutral";
  return "neutral";
}
