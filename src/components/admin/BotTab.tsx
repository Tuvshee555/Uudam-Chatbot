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
import type {
  AIAction,
  AIProposal,
  AttachedFile,
  ChatButton,
  ChatMessage,
  ClarificationAnswer,
  ClarificationQuestion,
  ConflictItem,
  ControlState,
  DriveSyncDiagnostics,
  DriveSyncRecentFile,
  FlowRule,
  LeadStats,
  PageControlState,
  PauseRow,
  ProposalMsg,
  ReadinessReport,
  RecentRow,
  SettingsForm,
  StructuredRow,
  TravelBotSettings,
  TravelLead,
  TravelTrip,
} from "@/lib/adminTypes";
import {
  FIELD_LABELS,
  STATUS_LABELS,
  buildProposalClarifications,
  compactWarnings,
  describeAction,
  summarizeConflict,
} from "@/lib/adminProposalUtils";
import { SectionHeading, StructuredEditor } from "./AdminShared";
import {
  DURATIONS,
  HANDOFF_DURATION_CUSTOM,
  HANDOFF_DURATION_OPTIONS,
  MAX_AI_INPUT_CHARS,
  QUICK_ACTIONS,
  STATUS_TONE,
  asInt,
  conflictTone,
  driveSyncTone,
  formatBytes,
  formatMoney,
  formatTime,
  handoffDurationSelectValue,
  settingsToForm,
  shortId,
  splitLines,
  timeLeft,
  toStructuredRows,
} from "@/lib/adminUtils";

function greetingEnabled(settings: TravelBotSettings | null): boolean {
  const g = (settings?.extra as Record<string, unknown>)?.greeting;
  if (!g || typeof g !== "object") return true;
  return (g as Record<string, unknown>).enabled !== false;
}

function seasonsEnabled(settings: TravelBotSettings | null): boolean {
  return (settings?.extra as Record<string, unknown>)?.seasons_enabled !== false;
}

export function BotTab({
  control,
  settings,
  pageControls,
  pauseReason,
  setPauseReason,
  recentRows,
  pausedRows,
  pausedIds,
  busyKey,
  tick,
  apiFetch,
  onPauseAction,
  onSettingsChanged,
}: {
  control: ControlState | null;
  settings: TravelBotSettings | null;
  pageControls: PageControlState[];
  pauseReason: string;
  setPauseReason: (value: string) => void;
  recentRows: RecentRow[];
  pausedRows: PauseRow[];
  pausedIds: Set<string>;
  busyKey: string;
  tick: number;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onPauseAction: (
    action:
      | "pause"
      | "resume"
      | "global_pause"
      | "global_resume"
      | "page_pause"
      | "page_resume"
      | "photo_only_enable"
      | "photo_only_disable",
    senderId?: string,
    ms?: number | null,
    pageId?: string,
  ) => void;
  onSettingsChanged: () => void;
}) {
  const handoffRows = pausedRows.filter((row) => row.reason === "handoff");
  const handoffIds = new Set(handoffRows.map((row) => row.sender_id));
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  type ChatAttachment = { type: "image"; url: string; caption?: string };
  type ChatHistoryMessage = {
    role: "user" | "assistant";
    text: string;
    attachments?: ChatAttachment[];
    created_at?: string;
  };
  const [chatHistory, setChatHistory] = useState<ChatHistoryMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const toast = useToast();

  function formatChatTime(iso?: string) {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    const now = new Date();
    const isToday =
      date.getDate() === now.getDate() &&
      date.getMonth() === now.getMonth() &&
      date.getFullYear() === now.getFullYear();
    return date.toLocaleString("mn-MN", {
      month: "short",
      day: "numeric",
      ...(isToday ? {} : { year: "numeric" }),
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function openChat(senderId: string) {
    setSelectedSender(senderId);
    setChatHistory([]);
    setChatLoading(true);
    try {
      const res = await apiFetch(
        `/api/admin/conversation?sender_id=${encodeURIComponent(senderId)}`,
      );
      const data = await res.json();
      setChatHistory(Array.isArray(data.messages) ? data.messages : []);
    } catch {
      setChatHistory([]);
    } finally {
      setChatLoading(false);
    }
  }

  function displayName(row: RecentRow | PauseRow) {
    return row.display_name || shortId(row.sender_id);
  }

  async function saveRename(senderId: string) {
    const name = renameValue.trim();
    if (!name) { setRenamingId(null); return; }
    setRenameLoading(true);
    try {
      await apiFetch("/api/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", sender_id: senderId, name }),
      });
      toast.success(`"${name}" гэж хадгаллаа`);
      setRenamingId(null);
      setRenameValue("");
    } catch {
      toast.error("Хадгалахад алдаа гарлаа");
    } finally {
      setRenameLoading(false);
    }
  }

  const filteredRows = useMemo(() => {
    if (!search.trim()) return recentRows;
    const q = search.trim().toLowerCase();
    return recentRows.filter(
      (r) =>
        r.sender_id.includes(q) ||
        (r.display_name ?? "").toLowerCase().includes(q),
    );
  }, [recentRows, search]);

  if (selectedSender) {
    const row = recentRows.find((r) => r.sender_id === selectedSender);
    const isPaused = pausedIds.has(selectedSender);
    const wantsHuman = handoffIds.has(selectedSender);
    const name = row ? displayName(row) : shortId(selectedSender);
    return (
      <div className="space-y-3">
        {/* Header */}
        <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
          <button
            type="button"
            onClick={() => setSelectedSender(null)}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-line bg-surface-sunken text-ink-muted hover:border-brand hover:text-brand active:scale-95"
          >
            <Icons.chevronLeft size={18} />
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">{name}</p>
            <p className="text-xs text-ink-subtle">
              <span className="font-mono opacity-50">{shortId(selectedSender)}</span>
              {row && <><span className="mx-1 opacity-30">·</span>{formatTime(row.last_seen)}</>}
            </p>
          </div>
          {wantsHuman && <Badge tone="warning">🙋 Хүн хүсэв</Badge>}
        </div>

        {/* Big pause/resume button — easy to tap on phone */}
        {isPaused ? (
          <button
            type="button"
            disabled={busyKey === `resume:${selectedSender}`}
            onClick={() => onPauseAction("resume", selectedSender)}
            className="flex w-full items-center justify-center gap-2 rounded-2xl border border-success/50 bg-success/10 py-4 text-base font-bold text-success hover:bg-success/20 active:scale-[0.98] disabled:opacity-50"
          >
            ▶ Бот сэргээх
          </button>
        ) : (
          <div className="rounded-2xl border border-danger/30 bg-danger/5 p-3">
            <p className="mb-2 text-center text-xs font-semibold text-danger">⏸ Бот зогсоох</p>
            <div className="grid grid-cols-3 gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  disabled={busyKey === `pause:${selectedSender}`}
                  onClick={() => onPauseAction("pause", selectedSender, d.ms)}
                  className="rounded-xl border border-danger/40 bg-white py-3 text-sm font-semibold text-danger hover:bg-danger/10 active:scale-95 disabled:opacity-50"
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {isPaused && (
          <div className="flex items-center gap-2 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2.5 text-sm text-danger">
            <Icons.pause size={14} className="shrink-0" />
            Бот зогссон — та Messenger дээр гараар хариулж болно.
          </div>
        )}

        <Card className="p-4">
          {chatLoading && (
            <div className="flex justify-center py-6">
              <Spinner className="h-6 w-6 text-brand" />
            </div>
          )}
          {!chatLoading && chatHistory.length === 0 && (
            <div className="flex flex-col items-center gap-1.5 py-8 text-center">
              <p className="text-sm font-medium text-ink-subtle">Яриа харагдахгүй байна</p>
              <p className="max-w-xs text-xs text-ink-subtle opacity-60">
                Яриа 2 цагийн дараа автоматаар арилдаг. Эсвэл хэрэглэгч шинэ мессеж илгээсний дараа харагдана.
              </p>
            </div>
          )}
          {!chatLoading && chatHistory.length > 0 && (
            <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
              {chatHistory.map((msg, i) => (
                <div
                  key={i}
                  className={cx(
                    "flex gap-2.5",
                    msg.role === "user" ? "justify-start" : "flex-row-reverse justify-end",
                  )}
                >
                  <div
                    className={cx(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                      msg.role === "user"
                        ? "border-line bg-surface-sunken text-ink-subtle"
                        : "border-brand/30 bg-brand/10 text-brand",
                    )}
                    title={msg.role === "user" ? "Хэрэглэгч" : "Бот"}
                  >
                    {msg.role === "user" ? <Icons.user size={14} /> : <Icons.bot size={14} />}
                  </div>
                  <div className="max-w-[78%]">
                    <div
                      className={cx(
                        "rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm",
                        msg.role === "user"
                          ? "bg-surface-sunken text-ink"
                          : "bg-brand text-white",
                      )}
                    >
                      {msg.text ? (
                        <p className="whitespace-pre-wrap">{msg.text}</p>
                      ) : (
                        <span className="opacity-75 italic">🖼 зураг</span>
                      )}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div
                          className={cx(
                            "mt-2 grid gap-1.5",
                            msg.attachments.length === 1 ? "grid-cols-1" : "grid-cols-2",
                          )}
                        >
                          {msg.attachments.map((att, idx) => (
                            <a
                              key={idx}
                              href={att.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block overflow-hidden rounded-xl ring-1 ring-black/5 transition hover:opacity-90"
                            >
                              <img
                                src={att.url}
                                alt={att.caption || "Зураг"}
                                className="max-h-48 w-full object-cover"
                                loading="lazy"
                              />
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                    <p
                      className={cx(
                        "mt-1 text-[10px] text-ink-subtle",
                        msg.role === "user" ? "text-left" : "text-right",
                      )}
                    >
                      {formatChatTime(msg.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    );
  }

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
                    <p className="truncate text-sm font-semibold text-ink">
                      {displayName(row)}
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
          title="Зөвхөн зураг горим"
          description="Идэвхтэй үед бот ямар ч текст хариулт илгээхгүй. Харин тодорхой аялал асуувал тухайн аяллын зургуудыг дуугүйхэн илгээнэ. Зураггүй аяллыг асуувал бот огт хариулахгүй."
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            disabled={busyKey === "photo_only_enable" || busyKey === "photo_only_disable"}
            onClick={() =>
              onPauseAction(control?.photo_only ? "photo_only_disable" : "photo_only_enable")
            }
            className={cx(
              "relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50",
              control?.photo_only ? "bg-warning" : "bg-line-strong",
            )}
            aria-label={control?.photo_only ? "Унтраах" : "Асаах"}
          >
            <span
              className={cx(
                "inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
                control?.photo_only ? "translate-x-7" : "translate-x-0",
              )}
            />
          </button>
          <span className={cx("text-sm font-medium", control?.photo_only ? "text-warning" : "text-ink-muted")}>
            {control?.photo_only ? "Зөвхөн зураг горим идэвхтэй" : "Унтарсан — бот хэвийн хариулж байна"}
          </span>
        </div>
      </Card>

      <QuickToggleCard
        title="Мэндчилгээний мессеж"
        description="Унтраавал шинэ хэрэглэгчид мэндчилгээ илгээхгүй. Шууд асуултад хариулна."
        enabled={greetingEnabled(settings)}
        busyId="greeting-toggle"
        onToggle={async (next) => {
          const prevGreeting = (settings?.extra as Record<string, unknown>)?.greeting as Record<string, unknown> | undefined;
          await apiFetch("/api/admin/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { extra: { greeting: { ...prevGreeting, enabled: next } } } }),
          });
          onSettingsChanged();
        }}
      />

      <QuickToggleCard
        title="Улирлын зургийн альбом"
        description="Унтраавал улирлын зураг (наадам, өвөл гэх мэт) илгээхгүй болно."
        enabled={seasonsEnabled(settings)}
        busyId="seasons-toggle"
        onToggle={async (next) => {
          await apiFetch("/api/admin/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { extra: { seasons_enabled: next } } }),
          });
          onSettingsChanged();
        }}
      />

      <Card className="p-4">
        <SectionHeading
          title="Хуудас бүрийн төлөв"
          description="Хуудас тус бүрийн ботыг тусад нь зогсоох/сэргээх. Нэг хуудсыг зогсооход нөгөө хуудас үргэлжлүүлэн ажиллана."
        />
        <div className="mt-3 space-y-2">
          <input
            value={pauseReason}
            onChange={(e) => setPauseReason(e.target.value)}
            placeholder="Зогсоох шалтгаан (сонголттой)"
            className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-subtle focus:border-brand"
          />
        </div>
        <div className="mt-3 space-y-3">
          {pageControls.length === 0 && (
            <p className="text-sm text-ink-subtle">
              Тохируулсан хуудас алга байна.
            </p>
          )}
          {pageControls.map((page) => {
            const paused = Boolean(page.bot_paused);
            return (
              <div
                key={page.page_id}
                className="rounded-md border border-line-strong p-3"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-ink">
                      {page.display_name}
                    </p>
                    <span className="text-xs text-ink-subtle">
                      {formatTime(page.updated_at)}
                    </span>
                  </div>
                  <Badge tone={paused ? "danger" : "success"} dot>
                    {paused ? "Зогссон" : "Идэвхтэй"}
                  </Badge>
                </div>
                <div className="mt-2">
                  <button
                    type="button"
                    disabled={
                      busyKey === `page_pause:${page.page_id}` ||
                      busyKey === `page_resume:${page.page_id}`
                    }
                    onClick={() =>
                      onPauseAction(
                        paused ? "page_resume" : "page_pause",
                        undefined,
                        undefined,
                        page.page_id,
                      )
                    }
                    className={cx(
                      "relative inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50",
                      paused ? "bg-danger" : "bg-success",
                    )}
                    aria-label={paused ? "Сэргээх" : "Зогсоох"}
                  >
                    <span
                      className={cx(
                        "inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
                        paused ? "translate-x-7" : "translate-x-0",
                      )}
                    />
                  </button>
                  <span className="ml-2 text-xs text-ink-subtle">
                    {paused ? "Дарж сэргээх" : "Дарж зогсоох"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between gap-2">
          <SectionHeading
            title="Сүүлийн харилцагчид"
            description="Тодорхой хэрэглэгчийн ботыг түр зогсоох/сэргээх."
          />
          <button
            onClick={async () => {
              setBackfilling(true);
              try {
                const res = await apiFetch("/api/pause", {
                  method: "POST",
                  body: JSON.stringify({ action: "backfill_names" }),
                });
                const d = await res.json();
                toast.success(`Нэр татлаа: ${d.filled ?? 0}/${d.total ?? 0}`);
                onSettingsChanged();
              } catch {
                toast.error("Алдаа гарлаа");
              } finally {
                setBackfilling(false);
              }
            }}
            disabled={backfilling}
            className="shrink-0 rounded-md border border-border bg-surface px-3 py-1.5 text-xs text-ink-subtle hover:bg-surface-hover disabled:opacity-50"
          >
            {backfilling ? "Татаж байна…" : "Нэр татах"}
          </button>
        </div>
        {recentRows.length > 0 && (
          <div className="mt-3">
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Нэр эсвэл ID-р хайх…"
              className="w-full"
            />
          </div>
        )}
        <div className="mt-3 space-y-2">
          {recentRows.length === 0 && (
            <p className="text-sm text-ink-subtle">
              Сүүлийн харилцан яриа алга.
            </p>
          )}
          {recentRows.length > 0 && filteredRows.length === 0 && (
            <p className="text-sm text-ink-subtle">Хайлтад тохирох хэрэглэгч олдсонгүй.</p>
          )}
          {filteredRows.map((row) => {
            const isPaused = pausedIds.has(row.sender_id);
            const pauseRow = pausedRows.find(
              (p) => p.sender_id === row.sender_id,
            );
            const wantsHuman = handoffIds.has(row.sender_id);
            const name = displayName(row);
            const isRenaming = renamingId === row.sender_id;
            return (
              <div
                key={row.sender_id}
                className={cx(
                  "rounded-2xl border transition-colors",
                  wantsHuman
                    ? "border-warning/50 bg-warning-soft"
                    : isPaused
                      ? "border-danger/40 bg-danger/5"
                      : "border-line bg-surface",
                )}
              >
                {/* Top row — name + status badges + chevron */}
                <div
                  className="flex cursor-pointer items-center gap-3 px-4 py-3.5"
                  onClick={() => openChat(row.sender_id)}
                >
                  {/* Avatar circle */}
                  <div className={cx(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                    wantsHuman ? "bg-warning/20 text-warning" :
                    isPaused ? "bg-danger/15 text-danger" :
                    "bg-brand/10 text-brand",
                  )}>
                    {name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                      <span className="truncate">{name}</span>
                      {wantsHuman && (
                        <span className="shrink-0 rounded-full bg-warning px-2 py-0.5 text-[10px] font-semibold text-white">
                          🙋 Хүн хүсэв
                        </span>
                      )}
                      {isPaused && (
                        <span className="shrink-0 rounded-full bg-danger px-2 py-0.5 text-[10px] font-semibold text-white">
                          ⏸ Зогссон
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      <span className="font-mono opacity-50">{shortId(row.sender_id)}</span>
                      <span className="mx-1.5 opacity-30">·</span>
                      {formatTime(row.last_seen)}
                      {isPaused && pauseRow && tick >= 0
                        ? <span className="ml-1.5 font-medium text-danger">{timeLeft(pauseRow.expires_at)}</span>
                        : ""}
                    </p>
                  </div>
                  <Icons.chevronRight size={16} className="shrink-0 text-ink-subtle" />
                </div>

                {/* Rename inline */}
                {isRenaming && (
                  <div
                    className="flex items-center gap-2 border-t border-line/40 px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(row.sender_id);
                        if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                      }}
                      placeholder="Нэр оруулна уу…"
                      className="min-w-0 flex-1 rounded-xl border border-brand/40 bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-brand"
                    />
                    <button
                      type="button"
                      disabled={renameLoading}
                      onClick={() => void saveRename(row.sender_id)}
                      className="rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {renameLoading ? "…" : "Хадгалах"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRenamingId(null); setRenameValue(""); }}
                      className="rounded-xl border border-line px-3 py-2 text-sm text-ink-muted"
                    >
                      Болих
                    </button>
                  </div>
                )}

                {/* Action bar — pause/resume + rename */}
                {!isRenaming && (
                  <div className="flex items-center gap-2 border-t border-line/40 px-4 py-2.5">
                    {isPaused ? (
                      <button
                        type="button"
                        disabled={busyKey === `resume:${row.sender_id}`}
                        onClick={(e) => { e.stopPropagation(); onPauseAction("resume", row.sender_id); }}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-success/50 bg-success/10 py-2.5 text-sm font-semibold text-success hover:bg-success/20 active:scale-95 disabled:opacity-50"
                      >
                        ▶ Бот сэргээх
                      </button>
                    ) : (
                      <div className="flex flex-1 items-center gap-2">
                        <span className="shrink-0 text-xs text-ink-subtle">Зогсоох:</span>
                        {[
                          { label: "30 мин", ms: 30 * 60 * 1000 },
                          { label: "1 цаг", ms: 60 * 60 * 1000 },
                          { label: "Гараар", ms: null },
                        ].map((opt) => (
                          <button
                            key={opt.label}
                            type="button"
                            disabled={busyKey === `pause:${row.sender_id}`}
                            onClick={(e) => { e.stopPropagation(); onPauseAction("pause", row.sender_id, opt.ms ?? undefined); }}
                            className="flex-1 rounded-xl border border-danger/30 bg-danger/5 py-2.5 text-xs font-semibold text-danger hover:bg-danger/15 active:scale-95 disabled:opacity-50"
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenamingId(row.sender_id);
                        setRenameValue(row.display_name ?? "");
                      }}
                      className="shrink-0 rounded-xl border border-line p-2.5 text-ink-muted hover:border-brand hover:text-brand active:scale-95"
                      title="Нэр өөрчлөх"
                    >
                      <Icons.edit size={15} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}

function QuickToggleCard({
  title,
  description,
  enabled,
  busyId,
  onToggle,
}: {
  title: string;
  description: string;
  enabled: boolean;
  busyId: string;
  onToggle: (next: boolean) => Promise<void>;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function handleToggle() {
    setBusy(true);
    try {
      await onToggle(!enabled);
    } catch {
      toast.error("Хадгалахад алдаа гарлаа.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="mt-0.5 text-xs text-ink-subtle">{description}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void handleToggle()}
          className={cx(
            "relative mt-0.5 inline-flex h-7 w-14 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none disabled:opacity-50",
            enabled ? "bg-brand" : "bg-line-strong",
          )}
          aria-label={enabled ? "Унтраах" : "Асаах"}
        >
          <span
            className={cx(
              "inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200",
              enabled ? "translate-x-7" : "translate-x-0",
            )}
          />
        </button>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Settings tab
   ---------------------------------------------------------------- */
