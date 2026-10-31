import { useMemo, useRef, useState } from "react";
import { Badge, Button, Card, EmptyState, IconButton, Icons, Input, Spinner, Switch, Textarea, cx, useToast } from "@/components/ui";
import type { ControlState, CustomerDocument, PageControlState, PauseRow, RecentRow, TravelBotSettings } from "@/lib/adminTypes";
import { SectionHeading, TabHeader } from "./AdminShared";
import { ContactInfoCard } from "./ContactInfoCard";
import { contactSettingsOf } from "@/lib/contactReplies";
import { DURATIONS, formatTime, shortId, timeLeft } from "@/lib/adminUtils";

function greetingEnabled(settings: TravelBotSettings | null): boolean {
  const g = (settings?.extra as Record<string, unknown>)?.greeting;
  if (!g || typeof g !== "object") return true;
  return (g as Record<string, unknown>).enabled !== false;
}

function seasonsEnabled(settings: TravelBotSettings | null): boolean {
  return (settings?.extra as Record<string, unknown>)?.seasons_enabled !== false;
}

function goodbyeEnabled(settings: TravelBotSettings | null): boolean {
  const g = (settings?.extra as Record<string, unknown>)?.goodbye;
  if (!g || typeof g !== "object") return true;
  return (g as Record<string, unknown>).enabled !== false;
}

// Default OFF (opt-in), unlike the toggles above — turning it on changes what
// the bot says, so an admin must deliberately switch it on.
function mimicMyselfEnabled(settings: TravelBotSettings | null): boolean {
  return (settings?.extra as Record<string, unknown>)?.mimic_myself_enabled === true;
}

function reminderEnabled(settings: TravelBotSettings | null): boolean {
  return (settings?.extra as Record<string, unknown>)?.reminder_enabled !== false;
}

function reminderText(settings: TravelBotSettings | null): string {
  const v = (settings?.extra as Record<string, unknown>)?.reminder_text;
  return typeof v === "string" ? v : "";
}

function reminderPhotoUrl(settings: TravelBotSettings | null): string {
  const v = (settings?.extra as Record<string, unknown>)?.reminder_photo_url;
  return typeof v === "string" ? v : "";
}

const DOCUMENT_CATEGORY_LABELS: Record<string, string> = {
  passport: "Паспорт",
  travel_document: "Бичиг баримт",
  booking_code: "Код",
  trip_screenshot: "Аяллын дэлгэцийн зураг",
  payment_screenshot: "Төлбөр",
  other: "Бусад",
};

function compactDocValue(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(compactDocValue).filter(Boolean).join(", ");
  if (typeof value === "object") return "";
  return String(value).trim();
}

function summarizeCustomerDocument(doc: CustomerDocument): string {
  const data = doc.extracted_json || {};
  const payment = data.payment && typeof data.payment === "object"
    ? (data.payment as Record<string, unknown>)
    : {};
  const passport = data.passport && typeof data.passport === "object"
    ? (data.passport as Record<string, unknown>)
    : {};
  const booking = data.booking && typeof data.booking === "object"
    ? (data.booking as Record<string, unknown>)
    : {};
  const trip = data.trip && typeof data.trip === "object"
    ? (data.trip as Record<string, unknown>)
    : {};
  const candidates = [
    compactDocValue(data.summary),
    [compactDocValue(payment.amount), compactDocValue(payment.currency)].filter(Boolean).join(" "),
    compactDocValue(payment.reference),
    compactDocValue(booking.code),
    compactDocValue(booking.trip_name),
    compactDocValue(passport.full_name),
    compactDocValue(passport.passport_number),
    compactDocValue(trip.title),
    compactDocValue(trip.destination),
  ].filter(Boolean);
  return candidates.slice(0, 3).join(" · ");
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
  onConversationsChanged,
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
  onConversationsChanged: () => void;
}) {
  const handoffRows = pausedRows.filter((row) => row.reason === "handoff");
  const handoffIds = new Set(handoffRows.map((row) => row.sender_id));
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  type ChatAttachment = { type: "image" | "file"; url: string; caption?: string };
  type ChatHistoryMessage = {
    // "staff": a consultant's own Messenger reply, read from the Page thread — a human, not AI.
    role: "user" | "assistant" | "staff";
    text: string;
    attachments?: ChatAttachment[];
    created_at?: string;
  };
  const [chatHistory, setChatHistory] = useState<ChatHistoryMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState(false);
  const [customerDocuments, setCustomerDocuments] = useState<CustomerDocument[]>([]);
  const [customerDocumentsLoading, setCustomerDocumentsLoading] = useState(false);
  const [customerDocumentsError, setCustomerDocumentsError] = useState(false);
  const chatRequestRef = useRef(0);
  const [search, setSearch] = useState("");
  const [conversationView, setConversationView] = useState<"all" | "handoff" | "paused">("all");
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);
  const [backfilling, setBackfilling] = useState(false);
  const toast = useToast();

  async function openChat(senderId: string) {
    const request = ++chatRequestRef.current;
    setSelectedSender(senderId);
    setChatHistory([]);
    setCustomerDocuments([]);
    setChatError(false);
    setCustomerDocumentsError(false);
    setChatLoading(true);
    setCustomerDocumentsLoading(true);
    await Promise.all([
      (async () => {
        try {
          const res = await apiFetch(`/api/admin/conversation?sender_id=${encodeURIComponent(senderId)}`);
          if (!res.ok) throw new Error("Conversation request failed");
          const data = await res.json();
          if (request === chatRequestRef.current) setChatHistory(Array.isArray(data.messages) ? data.messages : []);
        } catch {
          if (request === chatRequestRef.current) setChatError(true);
        } finally {
          if (request === chatRequestRef.current) setChatLoading(false);
        }
      })(),
      (async () => {
        try {
          const params = new URLSearchParams({ sender_id: senderId, status: "all", limit: "20" });
          const res = await apiFetch(`/api/admin/customer-documents?${params.toString()}`);
          if (!res.ok) throw new Error("Document request failed");
          const data = await res.json();
          if (request === chatRequestRef.current) setCustomerDocuments(Array.isArray(data.documents) ? data.documents : []);
        } catch {
          if (request === chatRequestRef.current) setCustomerDocumentsError(true);
        } finally {
          if (request === chatRequestRef.current) setCustomerDocumentsLoading(false);
        }
      })(),
    ]);
  }

  function closeChat() {
    chatRequestRef.current += 1;
    setSelectedSender(null);
  }

  function displayName(row: RecentRow | PauseRow) {
    return row.display_name || shortId(row.sender_id);
  }

  async function saveRename(senderId: string) {
    const name = renameValue.trim();
    if (!name) { setRenamingId(null); return; }
    setRenameLoading(true);
    try {
      const res = await apiFetch("/api/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "rename", sender_id: senderId, name }),
      });
      if (!res.ok) throw new Error("Rename request failed");
      toast.success(`"${name}" гэж хадгаллаа`);
      onConversationsChanged();
      setRenamingId(null);
      setRenameValue("");
    } catch {
      toast.error("Хадгалахад алдаа гарлаа");
    } finally {
      setRenameLoading(false);
    }
  }

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return recentRows.filter(
      (r) =>
        (conversationView !== "handoff" || pausedRows.some((paused) => paused.sender_id === r.sender_id && paused.reason === "handoff")) &&
        (conversationView !== "paused" || pausedIds.has(r.sender_id)) &&
        (!q || r.sender_id.includes(q) || (r.display_name ?? "").toLowerCase().includes(q)),
    );
  }, [recentRows, search, conversationView, pausedRows, pausedIds]);

  if (selectedSender) {
    const row = recentRows.find((r) => r.sender_id === selectedSender) ?? pausedRows.find((r) => r.sender_id === selectedSender);
    const isPaused = pausedIds.has(selectedSender);
    const wantsHuman = handoffIds.has(selectedSender);
    const name = row ? displayName(row) : shortId(selectedSender);
    return (
      <div className="space-y-3">
        {/* Header */}
        <Card className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5">
          <IconButton label="Харилцагчдын жагсаалт руу буцах" onClick={closeChat}>
            <Icons.chevronLeft size={18} />
          </IconButton>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-ink">{name}</p>
            <p className="mt-1 text-xs text-ink-muted">
              <span className="font-mono">{shortId(selectedSender)}</span>
              {row && "last_seen" in row && <><span className="mx-1.5">·</span>{formatTime(row.last_seen)}</>}
            </p>
          </div>
          {isPaused && <Badge tone="neutral" dot>Бот зогссон</Badge>}
          {wantsHuman && <Badge tone="warning">Зөвлөх хүлээж байна</Badge>}
          <IconButton label="Яриаг шинэчлэх" onClick={() => void openChat(selectedSender)} disabled={chatLoading || customerDocumentsLoading}>
            {chatLoading ? <Spinner /> : <Icons.refresh size={17} />}
          </IconButton>
        </Card>

        {/* Big pause/resume button — easy to tap on phone */}
        {isPaused ? (
          <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm leading-relaxed text-ink-muted">Бот түр зогссон. Та Messenger дээр гараар хариулж болно.</p>
            <Button
              variant="secondary"
              loading={busyKey === `resume:${selectedSender}`}
              onClick={() => onPauseAction("resume", selectedSender)}
            >
              <Icons.play size={16} /> Ботыг сэргээх
            </Button>
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-sm font-semibold text-ink">Өөрөө хариулах бол ботыг түр зогсоогоорой.</p>
            <div className="mt-3 grid grid-cols-3 gap-2">
              {DURATIONS.map((d) => (
                <button
                  key={d.label}
                  type="button"
                  disabled={busyKey === `pause:${selectedSender}`}
                  onClick={() => onPauseAction("pause", selectedSender, d.ms)}
                  className="min-h-11 rounded-xl border border-line-strong bg-surface py-2 text-sm font-medium text-ink hover:border-brand-border hover:bg-brand-soft disabled:opacity-50"
                >
                  {d.label}
                </button>
              ))}
            </div>
          </Card>
        )}

        {(customerDocumentsLoading || customerDocumentsError || customerDocuments.length > 0) && (
          <Card className="p-4 sm:p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink">Ирсэн бичиг баримт, зураг</p>
                <p className="mt-1 text-sm text-ink-muted">
                  Паспорт, төлбөр, код болон аяллын дэлгэцийн зургийг эндээс нээнэ.
                </p>
              </div>
              {customerDocumentsLoading && <Spinner className="h-4 w-4 text-brand" />}
            </div>
            {customerDocumentsError && <p className="mt-3 text-sm text-ink-muted" role="status">Бичиг баримтыг ачаалж чадсангүй. Дээрх шинэчлэх товчоор дахин оролдоорой.</p>}
            {customerDocuments.length > 0 && (
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {customerDocuments.slice(0, 6).map((doc) => {
                  const imageUrl = doc.stored_url || doc.source_url;
                  const summary = summarizeCustomerDocument(doc);
                  return (
                    <a
                      key={doc.id}
                      href={imageUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex gap-3 rounded-xl border border-line bg-surface p-3 transition hover:border-brand-border hover:bg-brand-soft/30"
                    >
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={imageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-md object-cover"
                        loading="lazy"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={doc.status === "needs_review" ? "warning" : "neutral"}>
                            {DOCUMENT_CATEGORY_LABELS[doc.category] || DOCUMENT_CATEGORY_LABELS.other}
                          </Badge>
                          {doc.status === "needs_review" && (
                            <span className="text-[10px] font-medium text-warning">
                              Шалгах
                            </span>
                          )}
                        </span>
                        <span className="mt-1 line-clamp-2 block text-xs text-ink">
                          {summary || "Дэлгэрэнгүйг нээж шалгана уу."}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-ink-muted">
                          {formatTime(doc.created_at)}
                        </span>
                      </span>
                    </a>
                  );
                })}
              </div>
            )}
          </Card>
        )}

        <Card className="overflow-hidden">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <h2 className="text-sm font-semibold text-ink">Харилцан яриа</h2>
            {!chatLoading && !chatError && <span className="text-xs tabular-nums text-ink-muted">{chatHistory.length} зурвас</span>}
          </div>
          {chatLoading && (
            <div className="flex items-center justify-center gap-3 py-16 text-sm text-ink-muted" role="status">
              <Spinner className="h-5 w-5 text-brand" /> Яриаг ачаалж байна…
            </div>
          )}
          {!chatLoading && chatError && (
            <div className="px-4 pb-6 text-center" role="status">
              <EmptyState icon={<Icons.bot size={25} />} title="Яриаг ачаалж чадсангүй" description="Холболтоо шалгаад дахин оролдоорой." />
              <Button variant="secondary" onClick={() => void openChat(selectedSender)}>Дахин оролдох</Button>
            </div>
          )}
          {!chatLoading && !chatError && chatHistory.length === 0 && (
            <EmptyState icon={<Icons.bot size={25} />} title="Хадгалсан зурвас алга" description="Хэрэглэгчийн дараагийн зурвас ирэхэд энд харагдана. Өмнөх ярианы хадгалах хугацаа дууссан байж болно." />
          )}
          {!chatLoading && !chatError && chatHistory.length > 0 && (
            <div className="max-h-[65vh] space-y-5 overflow-y-auto p-4 sm:p-5" role="region" aria-label="Хадгалсан харилцан яриа" tabIndex={0}>
              {chatHistory.map((msg, i) => (
                <div
                  key={i}
                  className={cx(
                    "flex gap-2.5",
                    msg.role === "user" ? "justify-start" : "flex-row-reverse",
                  )}
                >
                  <div
                    className={cx(
                      "flex h-8 w-8 shrink-0 items-center justify-center rounded-full border",
                      msg.role === "user"
                        ? "border-line bg-surface-sunken text-ink-muted"
                        : msg.role === "staff"
                          ? "border-emerald-300 bg-emerald-50 text-emerald-700"
                          : "border-brand/30 bg-brand/10 text-brand",
                    )}
                    title={msg.role === "user" ? "Хэрэглэгч" : msg.role === "staff" ? "Ажилтан (хүн)" : "AI бот"}
                  >
                    {msg.role === "assistant" ? <Icons.bot size={14} /> : <Icons.user size={14} />}
                  </div>
                  <div className="min-w-0 max-w-[85%] sm:max-w-[78%]">
                    <p className={cx("mb-1.5 text-xs font-medium", msg.role !== "user" && "text-right", msg.role === "staff" ? "text-emerald-700" : "text-ink-muted")}>
                      {msg.role === "user" ? "Хэрэглэгч" : msg.role === "staff" ? "Ажилтан (хүн) 👤" : "AI бот 🤖"}
                    </p>
                    <div
                      className={cx(
                        "rounded-2xl px-4 py-3 text-sm leading-relaxed",
                        msg.role === "user"
                          ? "bg-surface-sunken text-ink"
                          : msg.role === "staff"
                            ? "border border-emerald-200 bg-emerald-50 text-ink"
                            : "border border-brand-border bg-brand-soft/60 text-ink",
                      )}
                    >
                      {msg.text ? (
                        <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{msg.text}</p>
                      ) : (
                        <span className="opacity-75 italic">
                          {msg.role === "staff"
                            ? "Зураг/хавсралт — Мессенжер дээр харагдана"
                            : msg.attachments?.some((att) => att.type === "file") ? "Файл" : "Зураг"}
                        </span>
                      )}
                      {msg.attachments && msg.attachments.length > 0 && (
                        <div
                          className={cx(
                            "mt-2 grid gap-1.5",
                            msg.attachments.length === 1 ? "grid-cols-1" : "grid-cols-2",
                          )}
                        >
                          {msg.attachments.map((att, idx) => {
                            if (att.type === "file") {
                              return (
                                <a
                                  key={idx}
                                  href={att.url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="block rounded-xl bg-white/90 px-3 py-2 text-xs font-semibold text-brand ring-1 ring-black/5 transition hover:bg-white"
                                >
                                  Файл нээх
                                </a>
                              );
                            }
                            return (
                              <a
                                key={idx}
                                href={att.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="block overflow-hidden rounded-xl ring-1 ring-black/5 transition hover:opacity-90"
                              >
                                <InboxImage src={att.url} alt={att.caption || "Зураг"} />
                              </a>
                            );
                          })}
                        </div>
                      )}
                    </div>
                    <p
                      className={cx(
                        "mt-1.5 text-xs text-ink-muted",
                        msg.role === "user" ? "text-left" : "text-right",
                      )}
                    >
                      {msg.created_at ? formatTime(msg.created_at) : ""}
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
    <div className="space-y-5">
      <TabHeader
        icon={<Icons.control size={20} />}
        title="Ботын хяналт"
        description="Хүнд шилжүүлэх хүсэлт, бот зогсоох/сэргээх, сүүлийн харилцан яриа."
      />
      {handoffRows.length > 0 && (
        <Card className="border-brand-border p-4 sm:p-5">
          <div className="flex items-start gap-2">
            <div className="min-w-0">
              <h2 className="text-base font-semibold text-ink">
                Ажилтанд шилжсэн яриа ({handoffRows.length})
              </h2>
              <p className="mt-0.5 text-sm text-ink-muted">
                Эдгээр ярианд бот түр зогссон. Яриаг шалгаад Messenger дээр хариулаарай.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {handoffRows.map((row) => (
              <div
                key={row.sender_id}
                className="rounded-xl border border-line bg-surface-sunken/50 p-3.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <button type="button" onClick={() => void openChat(row.sender_id)} className="min-h-10 max-w-full truncate rounded-md text-left text-sm font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand">
                      {displayName(row)}
                    </button>
                    <p className="text-xs text-ink-muted">
                      Шилжсэн: {formatTime(row.paused_at)} · Үлдсэн:{" "}
                      {tick >= 0 ? timeLeft(row.expires_at) : ""}
                    </p>
                  </div>
                <Button
                  size="sm"
                  variant="secondary"
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
                      className="min-h-10 rounded-lg border border-line-strong bg-surface px-3 py-2 text-xs font-medium text-ink-muted hover:border-brand-border hover:text-brand disabled:opacity-50"
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

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <SectionHeading
            title="Сүүлийн харилцан яриа"
            description="Яриаг нээж унших, ботыг түр зогсоох эсвэл сэргээх."
          />
          <button
            type="button"
            onClick={async () => {
              setBackfilling(true);
              try {
                const res = await apiFetch("/api/pause", {
                  method: "POST",
                  body: JSON.stringify({ action: "backfill_names" }),
                });
                const d = await res.json();
                toast.success(`Нэр татлаа: ${d.filled ?? 0}/${d.total ?? 0}`);
                onConversationsChanged();
              } catch {
                toast.error("Алдаа гарлаа");
              } finally {
                setBackfilling(false);
              }
            }}
            disabled={backfilling}
            className="min-h-10 shrink-0 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
          >
            {backfilling ? "Татаж байна…" : "Нэр татах"}
          </button>
        </div>
        {recentRows.length > 0 && (
          <div className="mt-4 space-y-4">
            <div className="flex flex-wrap gap-2" role="group" aria-label="Ярианы төлөв">
              {([
                { value: "all", label: "Бүх яриа" },
                { value: "handoff", label: "Ажилтанд шилжсэн" },
                { value: "paused", label: "Бот зогссон" },
              ] as const).map((view) => (
                <button
                  key={view.value}
                  type="button"
                  aria-pressed={conversationView === view.value}
                  onClick={() => setConversationView(view.value)}
                  className={cx("min-h-10 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors", conversationView === view.value ? "border-brand-border bg-brand-soft text-brand" : "border-line bg-surface text-ink-muted hover:border-brand-border hover:text-ink")}
                >
                  {view.label}
                </button>
              ))}
            </div>
            <Input
              label="Харилцагч хайх"
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Нэр эсвэл хэрэглэгчийн дугаар"
              className="w-full"
            />
          </div>
        )}
        <div className="mt-3 space-y-2">
          {recentRows.length === 0 && (
            <EmptyState icon={<Icons.bot size={26} />} title="Одоогоор яриа алга" description="Хэрэглэгчээс зурвас ирэхэд энд харагдана." />
          )}
          {recentRows.length > 0 && filteredRows.length === 0 && (
            <div className="text-center">
              <EmptyState icon={<Icons.search size={26} />} title="Тохирох яриа олдсонгүй" description="Өөр нэрээр хайх эсвэл ярианы төлөвөө өөрчлөөрэй." />
              <Button variant="secondary" onClick={() => { setSearch(""); setConversationView("all"); }}>Шүүлтүүр арилгах</Button>
            </div>
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
                  "overflow-hidden rounded-xl border",
                  wantsHuman
                    ? "border-brand-border bg-surface"
                    : isPaused
                      ? "border-line-strong bg-surface"
                      : "border-line bg-surface",
                )}
              >
                {/* Top row — name + status badges + chevron */}
                <button
                  type="button"
                  className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-surface-sunken/70"
                  onClick={() => void openChat(row.sender_id)}
                  aria-label={`${name} хэрэглэгчийн яриаг нээх`}
                >
                  {/* Avatar circle */}
                  <span aria-hidden="true" className={cx(
                    "flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold",
                    wantsHuman ? "bg-brand-soft text-brand" :
                    isPaused ? "bg-surface-sunken text-ink-muted" :
                    "bg-brand/10 text-brand",
                  )}>
                    {name.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold text-ink">
                      <span className="truncate">{name}</span>
                      {wantsHuman && (
                        <Badge tone="brand">Ажилтанд шилжсэн</Badge>
                      )}
                      {isPaused && (
                        <Badge tone="neutral">Бот зогссон</Badge>
                      )}
                    </span>
                    <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                      <span className="font-mono">{shortId(row.sender_id)}</span>
                      <span className="mx-1.5">·</span>
                      {formatTime(row.last_seen)}
                      {isPaused && pauseRow && tick >= 0
                        ? <span className="ml-1.5 font-medium">{timeLeft(pauseRow.expires_at)}</span>
                        : ""}
                    </span>
                  </span>
                  <Icons.chevronRight size={16} className="shrink-0 text-ink-muted" />
                </button>

                {/* Rename inline */}
                {isRenaming && (
                  <div
                    className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <input
                      autoFocus
                      aria-label="Харилцагчийн нэр"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void saveRename(row.sender_id);
                        if (e.key === "Escape") { setRenamingId(null); setRenameValue(""); }
                      }}
                      placeholder="Нэр оруулна уу…"
                      className="min-h-11 min-w-0 basis-full rounded-xl border border-brand/40 bg-surface px-3 py-2 text-sm text-ink focus:border-brand sm:flex-1 sm:basis-auto"
                    />
                    <button
                      type="button"
                      disabled={renameLoading}
                      onClick={() => void saveRename(row.sender_id)}
                      className="min-h-11 rounded-xl bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      {renameLoading ? "…" : "Хадгалах"}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setRenamingId(null); setRenameValue(""); }}
                      className="min-h-11 rounded-xl border border-line px-3 py-2 text-sm text-ink-muted"
                    >
                      Болих
                    </button>
                  </div>
                )}

                {/* Action bar — pause/resume + rename */}
                {!isRenaming && (
                  <div className="flex items-center gap-2 border-t border-line px-3 py-2.5 sm:px-4">
                    {isPaused ? (
                      <button
                        type="button"
                        disabled={busyKey === `resume:${row.sender_id}`}
                        onClick={(e) => { e.stopPropagation(); onPauseAction("resume", row.sender_id); }}
                        className="flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-line-strong bg-surface py-2.5 text-sm font-medium text-ink hover:border-brand-border hover:bg-brand-soft disabled:opacity-50"
                      >
                        <Icons.play size={15} /> Ботыг сэргээх
                      </button>
                    ) : (
                      <div className="flex flex-1 items-center gap-2">
                        <span className="hidden shrink-0 text-xs text-ink-muted sm:block">Зогсоох:</span>
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
                            aria-label={`Ботыг ${opt.label.toLowerCase()} зогсоох`}
                            className="min-h-11 flex-1 rounded-xl border border-line-strong bg-surface py-2.5 text-xs font-medium text-ink-muted hover:border-brand-border hover:bg-brand-soft disabled:opacity-50"
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
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-line text-ink-muted hover:border-brand hover:text-brand active:scale-95"
                      aria-label={`${name} хэрэглэгчийн нэрийг өөрчлөх`}
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

      <details className="group rounded-xl border border-line bg-surface shadow-sm">
        <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 p-4 sm:px-5 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block font-semibold text-ink">Ботын тохиргоо</span>
            <span className="mt-1 block text-sm text-ink-muted">Хариулах горим, мэндчилгээ, сануулга болон хуудасны төлөв.</span>
          </span>
          <Icons.chevronRight className="shrink-0 text-ink-muted transition-transform group-open:rotate-90" />
        </summary>
        <div className="space-y-3 border-t border-line p-3 sm:p-4">
      <Card className="p-4">
        <SectionHeading
          title="Зөвхөн зураг горим"
          description="Идэвхтэй үед бот ямар ч текст хариулт илгээхгүй. Харин тодорхой аялал асуувал тухайн аяллын зургуудыг дуугүйхэн илгээнэ. Зураггүй аяллыг асуувал бот огт хариулахгүй."
        />
        <div className="mt-3 flex items-center gap-3">
          <Switch
            checked={Boolean(control?.photo_only)}
            disabled={busyKey === "photo_only_enable" || busyKey === "photo_only_disable"}
            onChange={() =>
              onPauseAction(control?.photo_only ? "photo_only_disable" : "photo_only_enable")
            }
            label={control?.photo_only ? "Унтраах" : "Асаах"}
            activeClass="bg-warning"
          />
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

      <QuickToggleCard
        title="Дугаар үлдээх мессеж (идэвхгүй болсны дараа)"
        description={
          '30 минут дуугүй байсны дараа "Манай зөвлөхтэй холбогдох бол..." гэсэн утасны дугаартай мессеж илгээнэ. Унтраавал энэ мессеж илгээхгүй, гэхдээ бот 24 цагийн турш дахин хариулахгүй байх нь өөрчлөгдөхгүй.'
        }
        enabled={goodbyeEnabled(settings)}
        busyId="goodbye-toggle"
        onToggle={async (next) => {
          const prevGoodbye = (settings?.extra as Record<string, unknown>)?.goodbye as Record<string, unknown> | undefined;
          await apiFetch("/api/admin/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { extra: { goodbye: { ...prevGoodbye, enabled: next } } } }),
          });
          onSettingsChanged();
        }}
      />

      <QuickToggleCard
        title="Өөрийн өнгө аясаар хариулах"
        description="Асаавал бот таны өөрийн бичдэг Messenger хариултуудыг өнгө аясны жишээ болгон ашиглана (тоо, нэр хуулбарлахгүй, зөвхөн бичих хэв маяг). Унтраавал одоогийнх шиг хэвээр."
        enabled={mimicMyselfEnabled(settings)}
        busyId="mimic-myself-toggle"
        onToggle={async (next) => {
          await apiFetch("/api/admin/settings", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fields: { extra: { mimic_myself_enabled: next } } }),
          });
          onSettingsChanged();
        }}
      />

      <ContactInfoCard key={JSON.stringify(contactSettingsOf(settings?.extra))} settings={settings} apiFetch={apiFetch} onSettingsChanged={onSettingsChanged} />
      <ReminderCard settings={settings} apiFetch={apiFetch} onSettingsChanged={onSettingsChanged} />

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
            className="h-10 w-full rounded-md border border-line-strong bg-surface px-3 text-sm text-ink transition-colors placeholder:text-ink-muted focus:border-brand"
          />
        </div>
        <div className="mt-3 space-y-3">
          {pageControls.length === 0 && (
            <p className="text-sm text-ink-muted">
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
                    <span className="text-xs text-ink-muted">
                      {formatTime(page.updated_at)}
                    </span>
                  </div>
                  <Badge tone={paused ? "danger" : "success"} dot>
                    {paused ? "Зогссон" : "Идэвхтэй"}
                  </Badge>
                </div>
                <div className="mt-2 flex items-center gap-2">
                  <Switch
                    checked={!paused}
                    disabled={
                      busyKey === `page_pause:${page.page_id}` ||
                      busyKey === `page_resume:${page.page_id}`
                    }
                    onChange={() =>
                      onPauseAction(
                        paused ? "page_resume" : "page_pause",
                        undefined,
                        undefined,
                        page.page_id,
                      )
                    }
                    label={paused ? "Сэргээх" : "Зогсоох"}
                    activeClass="bg-success"
                  />
                  <span className="text-xs text-ink-muted">
                    {paused ? "Дарж сэргээх" : "Дарж зогсоох"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

        </div>
      </details>
    </div>
  );
}

function ReminderCard({
  settings,
  apiFetch,
  onSettingsChanged,
}: {
  settings: TravelBotSettings | null;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onSettingsChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const enabled = reminderEnabled(settings);
  const savedText = reminderText(settings);
  const photoUrl = reminderPhotoUrl(settings);

  const [textDraft, setTextDraft] = useState(savedText);
  const [textDirty, setTextDirty] = useState(false);
  const savedTextRef = useRef(savedText);
  if (savedTextRef.current !== savedText && !textDirty) {
    savedTextRef.current = savedText;
    setTextDraft(savedText);
  }

  async function patchExtra(extra: Record<string, unknown>) {
    setBusy(true);
    try {
      await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { extra } }),
      });
      onSettingsChanged();
    } catch {
      toast.error("Хадгалахад алдаа гарлаа.");
    } finally {
      setBusy(false);
    }
  }

  async function saveText() {
    setBusy(true);
    try {
      await apiFetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields: { extra: { reminder_text: textDraft.trim() } } }),
      });
      savedTextRef.current = textDraft.trim();
      setTextDirty(false);
      onSettingsChanged();
      toast.success("Сануулгын текст хадгалагдлаа.");
    } catch {
      toast.error("Хадгалахад алдаа гарлаа.");
    } finally {
      setBusy(false);
    }
  }

  async function uploadPhoto(files: FileList | File[]) {
    const file = Array.from(files)[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Зураг хэт том байна (10MB хүртэл).");
      return;
    }
    setUploading(true);
    try {
      const sigRes = await apiFetch("/api/admin/upload-image", { method: "POST" });
      if (!sigRes.ok) throw new Error("upload not configured");
      const sig = (await sigRes.json()) as {
        signature: string;
        timestamp: number;
        cloudName: string;
        apiKey: string;
        folder: string;
      };
      const fd = new FormData();
      fd.append("file", file);
      fd.append("api_key", sig.apiKey);
      fd.append("timestamp", String(sig.timestamp));
      fd.append("signature", sig.signature);
      fd.append("folder", sig.folder);
      const up = await fetch(
        `https://api.cloudinary.com/v1_1/${sig.cloudName}/image/upload`,
        { method: "POST", body: fd },
      );
      const upJson = (await up.json()) as { secure_url?: string };
      if (!up.ok || !upJson.secure_url) throw new Error("cloudinary failed");
      await patchExtra({ reminder_photo_url: upJson.secure_url });
    } catch {
      toast.error("Зураг оруулж чадсангүй.");
    } finally {
      setUploading(false);
    }
  }

  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Сануулга (12-24 цаг дуугүй байсны дараа)</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Хэрэглэгч сүүлийн мессежээс хойш 12-24 цагийн хооронд дуугүй байвал өдөрт нэг удаа
            зураг, дараа нь текст илгээнэ (өдөрт 1 удаа ажилладаг автомат ажилд хамаарна). Идэвхгүй
            болговол зураг, текст хадгалагдсан хэвээр байх ч илгээгдэхгүй.
          </p>
        </div>
        <span className="mt-0.5 shrink-0">
          <Switch
            checked={enabled}
            disabled={busy}
            onChange={() => void patchExtra({ reminder_enabled: !enabled })}
            label={enabled ? "Сануулгыг унтраах" : "Сануулгыг асаах"}
          />
        </span>
      </div>

      <div className="mt-3 space-y-3 rounded-lg border border-line bg-surface-sunken p-3">
        {/* Photo */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-muted">Зураг</p>
          {photoUrl ? (
            <div className="flex items-center gap-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt="" className="h-16 w-16 shrink-0 rounded-md object-cover" />
              <div className="flex flex-col gap-1.5">
                <button
                  type="button"
                  disabled={busy || uploading}
                  onClick={() => fileInputRef.current?.click()}
                  className="rounded-md border border-line-strong px-2.5 py-1.5 text-xs font-medium text-ink hover:border-brand hover:text-brand disabled:opacity-50"
                >
                  {uploading ? "Оруулж байна…" : "Зураг солих"}
                </button>
                <button
                  type="button"
                  disabled={busy || uploading}
                  onClick={() => void patchExtra({ reminder_photo_url: "" })}
                  className="rounded-md border border-danger/30 px-2.5 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  Зургийг устгах
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              disabled={busy || uploading}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void uploadPhoto(e.dataTransfer.files);
              }}
              onClick={() => fileInputRef.current?.click()}
              className={cx(
                "flex w-full cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed p-4 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                dragging
                  ? "border-brand bg-brand-soft"
                  : "border-line-strong bg-surface hover:border-brand",
              )}
            >
              {uploading ? (
                <span className="flex items-center gap-2 text-xs text-ink-muted">
                  <Spinner className="h-3.5 w-3.5" /> Оруулж байна…
                </span>
              ) : (
                <>
                  <span className="text-xs font-medium text-ink">
                    Зураг чирж оруулах эсвэл дарж сонгох
                  </span>
                  <span className="text-[11px] text-ink-muted">PNG, JPG, WEBP — хамгийн ихдээ 10MB</span>
                </>
              )}
            </button>
          )}
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void uploadPhoto(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {/* Text */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-ink-muted">Текст</p>
          <Textarea
            label="Сануулгын текст"
            rows={3}
            placeholder="Жишээ: Сайн байна уу! Танд тохирсон аялал байгаа эсэхийг мэдэхийг хүсвэл бидэнтэй холбогдоорой."
            value={textDraft}
            onChange={(e) => {
              setTextDraft(e.target.value);
              setTextDirty(true);
            }}
          />
          <div className="mt-2 flex items-center justify-between">
            <p className="text-xs text-ink-muted">Хоосон орхивол текст илгээгдэхгүй.</p>
            <Button
              onClick={() => void saveText()}
              disabled={busy || !textDirty}
            >
              {busy ? "Хадгалж байна…" : "Хадгалах"}
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

function QuickToggleCard({
  title,
  description,
  enabled,
  onToggle,
}: {
  title: string;
  description: string;
  enabled: boolean;
  // Kept in the props type: callers pass it as a stable identifier.
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
          <p className="mt-0.5 text-xs text-ink-muted">{description}</p>
        </div>
        <span className="mt-0.5 shrink-0">
          <Switch
            checked={enabled}
            disabled={busy}
            onChange={() => void handleToggle()}
            label={`${title}: ${enabled ? "унтраах" : "асаах"}`}
          />
        </span>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Settings tab
   ---------------------------------------------------------------- */

/**
 * An inbox photo behind its signed admin link. A link Meta has expired (never copied
 * privately) answers 410: a short note replaces the broken image.
 */
function InboxImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  if (failed || !src) {
    return <span className="block px-3 py-2 text-xs text-ink-muted">Зураг нээгдэхгүй байна (Meta-гийн холбоосын хугацаа дууссан).</span>;
  }
  return <img src={src} alt={alt} className="max-h-48 w-full object-cover" loading="lazy" onError={() => setFailed(true)} />;
}
