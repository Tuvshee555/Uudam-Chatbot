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

type AIRecentRow = {
  id: number;
  instruction: string;
  status: string;
  created_at: string;
  applied_at: string | null;
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
  status: "pending" | "applied" | "cancelled" | "error";
  confirmChecked: boolean;
  resultText?: string;
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

type TabKey = "assistant" | "trips" | "bot" | "settings";

/* ----------------------------------------------------------------
   Constants & helpers
   ---------------------------------------------------------------- */
const SECRET_KEY = "travel_admin_secret";
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_TOTAL_FILE_BYTES = 100 * 1024 * 1024;
const MAX_ATTACH_COUNT = 20;
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
  { label: "30 min", value: "30" },
  { label: "1 hour", value: "60" },
  { label: "2 hours", value: "120" },
  { label: "Until manual resume", value: "0" },
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
  const [requiresAuth, setRequiresAuth] = useState(false);
  const [openAccess, setOpenAccess] = useState(true);
  const [dbInfo, setDbInfo] = useState<{
    configured: boolean;
    schemaReady: boolean;
    trips: number;
    lastUpdatedAt: string | null;
  } | null>(null);

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

  const [aiRecent, setAiRecent] = useState<AIRecentRow[]>([]);
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

  const [editingTrip, setEditingTrip] = useState<TravelTrip | null>(null);
  const [isNewTrip, setIsNewTrip] = useState(false);
  const [tripDraft, setTripDraft] = useState<Record<string, string>>(
    BLANK_TRIP_DRAFT,
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const fetchWithAdmin = useCallback(
    async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers || {});
      if (secret.trim()) headers.set("x-admin-secret", secret.trim());
      return fetch(url, { ...init, headers });
    },
    [secret],
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
      setRequiresAuth(false);
      setOpenAccess(Boolean(systemJson?.open_access));
      setDbInfo(systemJson?.db || null);

      const [tripRes, pauseRes, settingsRes] = await Promise.all([
        fetchWithAdmin(
          `/api/admin/trips?search=${encodeURIComponent(
            search,
          )}&status=${encodeURIComponent(statusFilter)}&limit=300`,
        ),
        fetchWithAdmin("/api/pause"),
        fetchWithAdmin("/api/admin/settings"),
      ]);

      if (
        tripRes.status === 401 ||
        pauseRes.status === 401 ||
        settingsRes.status === 401
      ) {
        setRequiresAuth(true);
        setLoading(false);
        return;
      }

      const tripJson = await tripRes.json();
      const pauseJson = await pauseRes.json().catch(() => ({}));
      const settingsJson = await settingsRes.json().catch(() => ({}));

      setTrips(Array.isArray(tripJson?.trips) ? tripJson.trips : []);
      setControl(pauseJson?.control || tripJson?.control || null);
      setPausedRows(Array.isArray(pauseJson?.paused) ? pauseJson.paused : []);
      setRecentRows(Array.isArray(pauseJson?.recent) ? pauseJson.recent : []);
      setAiRecent(Array.isArray(tripJson?.ai_recent) ? tripJson.ai_recent : []);
      if (settingsJson?.settings) {
        setSettings(settingsJson.settings as TravelBotSettings);
        setSettingsForm((prev) =>
          prev ? prev : settingsToForm(settingsJson.settings as TravelBotSettings),
        );
      }
    } catch {
      toast.error("Системийн өгөгдөл ачаалж чадсангүй.");
    } finally {
      setLoading(false);
    }
  }, [fetchWithAdmin, search, statusFilter, toast]);

  useEffect(() => {
    const stored =
      typeof window === "undefined"
        ? ""
        : localStorage.getItem(SECRET_KEY) || "";
    if (stored) setSecret(stored);
  }, []);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (ADMIN_AUTO_REFRESH_MS <= 0) return;
    const refresh = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      void loadAll();
    }, ADMIN_AUTO_REFRESH_MS);
    return () => clearInterval(refresh);
  }, [loadAll]);

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
    if (typeof window !== "undefined") {
      localStorage.setItem(SECRET_KEY, secret.trim());
    }
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

    const oversized = inputFiles.filter((file) => file.size > MAX_FILE_BYTES);
    if (oversized.length > 0) {
      toast.error("Some files are too large. Keep each upload under 100MB.");
    }

    const acceptedFiles = inputFiles.filter((file) => file.size <= MAX_FILE_BYTES);
    if (acceptedFiles.length === 0) return;

    if (attachedFiles.length + acceptedFiles.length > MAX_ATTACH_COUNT) {
      toast.error(`Keep the total attached files at ${MAX_ATTACH_COUNT} or less.`);
      return;
    }

    const currentAttachedBytes = attachedFiles.reduce(
      (sum, file) => sum + Math.floor((file.dataUrl.length * 3) / 4),
      0,
    );
    const totalBytes =
      currentAttachedBytes + acceptedFiles.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      toast.error(
        `This batch is too large (${formatBytes(totalBytes)}). Keep one request under ${formatBytes(MAX_TOTAL_FILE_BYTES)}.`,
      );
      return;
    }

    try {
      const nextFiles = await Promise.all(
        acceptedFiles.map((file) => readAttachedFile(file)),
      );
      setAttachedFiles((prev) => {
        const existing = new Set(prev.map((file) => file.id));
        const deduped = nextFiles.filter((file) => !existing.has(file.id));
        return [...prev, ...deduped];
      });
    } catch {
      toast.error("Failed to read one or more files.");
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
      text: text || "(attachment only)",
      fileNames: files.map((file) => file.name),
    });
    setAiInput("");
    setAttachedFiles([]);
    setBusyKey("ai-send");

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
              `Upload is too large for one request. Keep the total under ${formatBytes(MAX_TOTAL_FILE_BYTES)}.`,
            );
          }
          throw new Error(data?.error || "Could not process the uploaded files.");
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
          throw new Error(data?.error || "Could not generate an AI proposal.");
        }
      }

      const proposal = data.proposal;
      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error(
          "AI did not return a usable proposal. Please try again with a clearer instruction.",
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
            "No actionable changes were found. Try adding more detail or another file.",
        });
        return;
      }
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "proposal",
        proposal,
        requestId:
          typeof data.request_id === "number" ? data.request_id : null,
        status: "pending",
        confirmChecked: false,
      });
    } catch (err) {
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "note",
        tone: "error",
        text:
          err instanceof TypeError
            ? `Upload failed before the server could reply. Try fewer files or keep the total under ${formatBytes(MAX_TOTAL_FILE_BYTES)}.`
            : err instanceof Error
              ? err.message
              : "Something went wrong.",
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

  async function applyProposal(message: ProposalMsg) {
    if (message.requestId == null) {
      toast.error("Энэ саналыг хэрэгжүүлэх боломжгүй (ID алга).");
      return;
    }
    setBusyKey(`apply-${message.id}`);
    try {
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: message.requestId,
          apply: true,
          confirm: true,
        }),
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
      await loadAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Хадгалж чадсангүй.");
    } finally {
      setBusyKey("");
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
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
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

  const tabs: Array<{ key: TabKey; label: string; icon: ReactNode }> = [
    { key: "assistant", label: "AI Updates", icon: <Icons.ai size={17} /> },
    { key: "trips", label: "Trips Data", icon: <Icons.trips size={17} /> },
    { key: "bot", label: "Pause / Handoff", icon: <Icons.control size={17} /> },
    { key: "settings", label: "Bot Settings", icon: <Icons.settings size={17} /> },
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
              <Button href="/" size="sm" variant="secondary">
                Test live bot
              </Button>
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

        <div className="mb-4">
          <Alert tone="info">
            {tab === "assistant" &&
              "AI Updates is for changing trip data from text or files. It is not the customer chat. Use 'Test live bot' to test real replies."}
            {tab === "trips" &&
              "Trips Data shows the current trip records in your database. Edit them by hand here."}
            {tab === "bot" &&
              "Pause / Handoff lets you stop the bot, resume it, or hand a customer over to a human."}
            {tab === "settings" &&
              "Bot Settings controls the bot name, rules, fixed replies, comment replies, and human handoff text."}
          </Alert>
        </div>

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
            applyBusyId={busyKey.startsWith("apply-") ? busyKey.slice(6) : ""}
            onSend={() => void sendAssistant()}
            onApply={(message) => void applyProposal(message)}
            onCancelProposal={(id) =>
              setProposalMessage(id, { status: "cancelled" })
            }
            onToggleConfirm={(id, value) =>
              setProposalMessage(id, { confirmChecked: value })
            }
            onPickFile={() => fileInputRef.current?.click()}
            onDropFiles={(files) => void attachFiles(files)}
            aiRecent={aiRecent}
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
            onRefresh={() => void loadAll()}
            onCreate={beginCreateTrip}
            onEdit={beginEditTrip}
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

        {tab === "settings" && settingsForm && (
          <SettingsTab
            form={settingsForm}
            setForm={setSettingsForm}
            updatedAt={settings?.updated_at}
            busy={busyKey === "save-settings"}
            onSave={() => void saveSettings()}
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
  applyBusyId,
  onSend,
  onApply,
  onCancelProposal,
  onToggleConfirm,
  onPickFile,
  onDropFiles,
  aiRecent,
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
  applyBusyId: string;
  onSend: () => void;
  onApply: (message: ProposalMsg) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
  onPickFile: () => void;
  onDropFiles: (files: FileList | File[]) => void;
  aiRecent: AIRecentRow[];
  chatEndRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const attachedTotalBytes = attachedFiles.reduce(
    (sum, file) => sum + Math.floor((file.dataUrl.length * 3) / 4),
    0,
  );

  return (
    <div className="space-y-4">
      <Card className="p-4">
        <SectionHeading
          title="AI trip updates"
          description="Use this tab to update trips with AI from text, Excel, CSV, PDF, or photos. Nothing is saved until you approve the proposed changes."
          action={
            <Button href="/" size="sm" variant="secondary">
              Open live bot test
            </Button>
          }
        />
        <div className="mt-3 grid gap-2 text-sm text-ink-muted sm:grid-cols-3">
          <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
            1. Add a file or type an instruction.
          </div>
          <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
            2. AI reads it and prepares a safe proposal.
          </div>
          <div className="rounded-md border border-line bg-surface-sunken px-3 py-2">
            3. You approve it before any trip data changes.
          </div>
        </div>
      </Card>

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
            <ChatBubble
              key={message.id}
              message={message}
              applyBusy={applyBusyId === message.id}
              onApply={onApply}
              onCancelProposal={onCancelProposal}
              onToggleConfirm={onToggleConfirm}
            />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-ink-muted">
              <Spinner />
              AI боловсруулж байна…
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
          <div className="border-t border-line bg-brand-soft px-3 py-2">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-sm font-medium text-brand">
                <Icons.database size={15} className="text-brand" />
                {attachedFiles.length} file{attachedFiles.length === 1 ? "" : "s"} attached
              </span>
              <span className="text-xs text-brand/80">
                approx {formatBytes(attachedTotalBytes)}
              </span>
              <button
                type="button"
                onClick={() => attachedFiles.forEach((file) => onRemoveAttachedFile(file.id))}
                className="text-xs font-medium text-brand hover:opacity-70"
              >
                Clear all
              </button>
            </div>
            <div className="flex flex-wrap gap-2">
              {attachedFiles.map((file) => (
                <span
                  key={file.id}
                  className="inline-flex max-w-full items-center gap-2 rounded-full border border-brand/20 bg-white/70 px-3 py-1 text-sm text-brand"
                >
                  <span className="truncate">{file.name}</span>
                  <button
                    type="button"
                    onClick={() => onRemoveAttachedFile(file.id)}
                    aria-label={`Remove ${file.name}`}
                    className="shrink-0 hover:opacity-70"
                  >
                    <Icons.close size={14} />
                  </button>
                </span>
              ))}
            </div>
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
            placeholder="Example: update Bangkok trip seats to 3, or attach price-list files/photos"
            className="scroll-area max-h-32 min-h-10 flex-1 resize-none rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
          />
          <Button
            onClick={onSend}
            disabled={busy || (!aiInput.trim() && attachedFiles.length === 0)}
            className="h-10 shrink-0"
          >
            Send
          </Button>
        </div>
      </Card>

      <p className="px-1 text-xs text-ink-subtle">
        Excel and CSV files are converted into HTML tables for easier model reading. You can attach multiple PDFs, photos, and text files too. Keep each file under 100MB and one request under 100MB total.
      </p>

      {aiRecent.length > 0 && (
        <Card className="p-4">
          <SectionHeading
            title="Сүүлийн өөрчлөлтүүд"
            description="AI-аар хийгдсэн хүсэлтийн түүх."
          />
          <div className="mt-3 space-y-2">
            {aiRecent.slice(0, 8).map((row) => (
              <div
                key={row.id}
                className="flex items-start justify-between gap-3 rounded-md border border-line bg-surface-sunken px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink">{row.instruction}</p>
                  <p className="text-xs text-ink-subtle">
                    {formatTime(row.created_at)}
                  </p>
                </div>
                <Badge
                  tone={
                    row.status === "applied"
                      ? "success"
                      : row.status === "error"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {row.status === "applied"
                    ? "Хэрэгжсэн"
                    : row.status === "error"
                      ? "Алдаа"
                      : "Хүлээгдэж буй"}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}
function ChatBubble({
  message,
  applyBusy,
  onApply,
  onCancelProposal,
  onToggleConfirm,
}: {
  message: ChatMessage;
  applyBusy: boolean;
  onApply: (message: ProposalMsg) => void;
  onCancelProposal: (id: string) => void;
  onToggleConfirm: (id: string, value: boolean) => void;
}) {
  if (message.role === "admin") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-xl rounded-br-sm bg-brand px-3.5 py-2 text-sm text-white">
          {message.fileNames && message.fileNames.length > 0 && (
            <span className="mb-1 flex items-center gap-1.5 text-xs text-white/80">
              <Icons.database size={13} />
              {message.fileNames.join(", ")}
            </span>
          )}
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

  // proposal
  const { proposal } = message;
  return (
    <div className="max-w-[92%]">
      <div className="rounded-xl rounded-bl-sm border border-line bg-surface-sunken p-3">
        <p className="text-sm font-semibold text-ink">{proposal.summary}</p>

        {proposal.actions.map((action, index) => {
          const described = describeAction(action);
          return (
            <div
              key={index}
              className="mt-2 rounded-md border border-line bg-surface p-2.5"
            >
              <p className="text-sm font-medium text-ink">
                <span className="text-brand">{described.verb}</span> —{" "}
                {described.target}
              </p>
              {described.changes.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {described.changes.map((change, i) => (
                    <li key={i} className="text-xs text-ink-muted">
                      • {change}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}

        {proposal.conflicts.length > 0 && (
          <div className="mt-2 rounded-md bg-danger-soft px-2.5 py-2">
            {proposal.conflicts.map((conflict, i) => (
              <p key={i} className="text-xs text-danger">
                ⚠ {conflict}
              </p>
            ))}
          </div>
        )}

        {message.status === "pending" && (
          <div className="mt-3 border-t border-line pt-3">
            {proposal.needs_confirmation && (
              <label className="mb-2 flex items-start gap-2 text-xs text-ink-muted">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={message.confirmChecked}
                  onChange={(e) =>
                    onToggleConfirm(message.id, e.target.checked)
                  }
                />
                <span>
                  {message.proposal.important_reason ||
                    "Энэ нь чухал өөрчлөлт. Баталгаажуулна уу."}
                </span>
              </label>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="success"
                loading={applyBusy}
                disabled={
                  proposal.needs_confirmation && !message.confirmChecked
                }
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
            <TripCard key={trip.id} trip={trip} onEdit={() => onEdit(trip)} />
          ))}
        </div>
      )}
    </div>
  );
}

function TripCard({
  trip,
  onEdit,
}: {
  trip: TravelTrip;
  onEdit: () => void;
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
        <Button size="sm" variant="secondary" onClick={onEdit}>
          <Icons.edit size={15} />
          Засах
        </Button>
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
                    { label: "30 min", ms: 30 * 60 * 1000 },
                    { label: "1 hour", ms: 60 * 60 * 1000 },
                    { label: "Manual", ms: null },
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
  onSave,
}: {
  form: SettingsForm;
  setForm: React.Dispatch<React.SetStateAction<SettingsForm | null>>;
  updatedAt?: string;
  busy: boolean;
  onSave: () => void;
}) {
  function patch(partial: Partial<SettingsForm>) {
    setForm((prev) => (prev ? { ...prev, ...partial } : prev));
  }

  const handoffDurationMode = handoffDurationSelectValue(form.handoff_pause_minutes);
  const [showOptionalData, setShowOptionalData] = useState(false);

  function clearOldText() {
    patch({
      quick_info_reply: '',
      quick_info_keywords: '',
      comment_trigger_patterns: '',
      comment_public_reply: '',
      comment_dm_reply: '',
      faq: [],
      special_offers: [],
      discount_policies: [],
      verified_credentials: [],
    });
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <SectionHeading
          title="Basic bot info"
          description={
            updatedAt
              ? `Last updated: ${formatTime(updatedAt)}`
              : 'Main business name and core bot rules.'
          }
          action={
            <Button size="sm" variant="ghost" onClick={clearOldText}>
              Clear old text
            </Button>
          }
        />
        <div className="mt-3 space-y-3">
          <Input
            label="Business name"
            value={form.business_name}
            onChange={(e) => patch({ business_name: e.target.value })}
          />
          <Textarea
            label="System prompt"
            hint="Main rules for the customer-facing bot."
            rows={4}
            value={form.system_prompt}
            onChange={(e) => patch({ system_prompt: e.target.value })}
          />
          <Textarea
            label="Quick keyword reply"
            hint="If a customer uses one of the keywords below, the bot sends this fixed reply."
            rows={3}
            value={form.quick_info_reply}
            onChange={(e) => patch({ quick_info_reply: e.target.value })}
          />
          <Textarea
            label="Quick keywords"
            hint="One keyword or phrase per line."
            rows={3}
            value={form.quick_info_keywords}
            onChange={(e) => patch({ quick_info_keywords: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Comment auto-replies"
          description="Used for Facebook post comments."
        />
        <div className="mt-3 space-y-3">
          <Textarea
            label="Comment trigger keywords"
            hint="One keyword or phrase per line."
            rows={3}
            value={form.comment_trigger_patterns}
            onChange={(e) =>
              patch({ comment_trigger_patterns: e.target.value })
            }
          />
          <Textarea
            label="Public comment reply"
            hint="Visible reply posted under the comment."
            rows={2}
            value={form.comment_public_reply}
            onChange={(e) => patch({ comment_public_reply: e.target.value })}
          />
          <Textarea
            label="DM reply after comment"
            hint="Private message sent to the customer."
            rows={3}
            value={form.comment_dm_reply}
            onChange={(e) => patch({ comment_dm_reply: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Human handoff"
          description="If a customer asks for a person, the bot pauses and your staff can take over."
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
              Enable human handoff
            </span>
          </label>
          <Textarea
            label="Trigger words or phrases"
            hint="If the customer message contains any of these, the bot pauses and hands over to a person."
            rows={4}
            value={form.handoff_keywords}
            onChange={(e) => patch({ handoff_keywords: e.target.value })}
          />
          <Textarea
            label="Reply sent to customer"
            rows={2}
            value={form.handoff_reply}
            onChange={(e) => patch({ handoff_reply: e.target.value })}
          />
          <Select
            label="Quick duration"
            hint="Pick a ready-made handoff duration, or use the custom minutes field below."
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
            <option value={HANDOFF_DURATION_CUSTOM}>Custom</option>
          </Select>
          <Input
            label="Pause minutes"
            hint="After this time the bot resumes automatically. Use 0 for manual resume only."
            inputMode="numeric"
            value={form.handoff_pause_minutes}
            onChange={(e) => patch({ handoff_pause_minutes: e.target.value })}
          />
        </div>
      </Card>

      <Card className="p-4">
        <SectionHeading
          title="Optional extra bot knowledge"
          description="Only open this if you want FAQ, offers, discounts, or credentials."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setShowOptionalData((prev) => !prev)}
            >
              {showOptionalData ? 'Hide optional data' : 'Show optional data'}
            </Button>
          }
        />
        {showOptionalData ? (
          <div className="mt-3 space-y-3">
            <StructuredEditor
              title="FAQ"
              addLabel="Add FAQ"
              fields={[
                { key: 'question', label: 'Question' },
                { key: 'answer', label: 'Answer' },
              ]}
              rows={form.faq}
              onChange={(rows) => patch({ faq: rows })}
            />
            <StructuredEditor
              title="Special offers"
              addLabel="Add offer"
              fields={[
                { key: 'name', label: 'Name' },
                { key: 'duration', label: 'Duration' },
                { key: 'price', label: 'Price' },
                { key: 'target', label: 'Target' },
                { key: 'eligibility', label: 'Eligibility' },
                { key: 'description', label: 'Description' },
              ]}
              rows={form.special_offers}
              onChange={(rows) => patch({ special_offers: rows })}
            />
            <StructuredEditor
              title="Discount policies"
              addLabel="Add discount"
              fields={[
                { key: 'name', label: 'Name' },
                { key: 'discount', label: 'Discount' },
                { key: 'applies_to', label: 'Applies to' },
                { key: 'eligibility', label: 'Eligibility' },
                { key: 'verification', label: 'Verification' },
                { key: 'description', label: 'Description' },
              ]}
              rows={form.discount_policies}
              onChange={(rows) => patch({ discount_policies: rows })}
            />
            <StructuredEditor
              title="Verified credentials"
              addLabel="Add credential"
              fields={[
                { key: 'title', label: 'Title' },
                { key: 'issuer', label: 'Issuer' },
                { key: 'issued_on', label: 'Issued on' },
                { key: 'description', label: 'Description' },
              ]}
              rows={form.verified_credentials}
              onChange={(rows) => patch({ verified_credentials: rows })}
            />
          </div>
        ) : (
          <p className="mt-3 text-sm text-ink-muted">
            Hidden to keep this page simple. Open it only if you want the bot to answer from FAQ or special-offer data.
          </p>
        )}
      </Card>

      <div className="sticky bottom-3 z-10">
        <Button block size="lg" loading={busy} onClick={onSave}>
          Save settings
        </Button>
      </div>
    </div>
  );
}
