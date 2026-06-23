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

export function BotTab({
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
}: {
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
      | "page_resume",
    senderId?: string,
    ms?: number | null,
    pageId?: string,
  ) => void;
}) {
  const handoffRows = pausedRows.filter((row) => row.reason === "handoff");
  const handoffIds = new Set(handoffRows.map((row) => row.sender_id));
  const [selectedSender, setSelectedSender] = useState<string | null>(null);
  const [chatHistory, setChatHistory] = useState<{ role: string; text: string }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);

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

  if (selectedSender) {
    const row = recentRows.find((r) => r.sender_id === selectedSender);
    const isPaused = pausedIds.has(selectedSender);
    const wantsHuman = handoffIds.has(selectedSender);
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSelectedSender(null)}
            className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm text-ink-muted hover:border-brand hover:text-brand"
          >
            <Icons.chevronLeft size={14} />
            Буцах
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate font-mono text-sm font-medium text-ink">
              {shortId(selectedSender)}
            </p>
            {row && (
              <p className="text-xs text-ink-subtle">Сүүлд: {formatTime(row.last_seen)}</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {wantsHuman && <Badge tone="warning">🙋 Хүн хүсэв</Badge>}
            {isPaused ? (
              <Button
                size="sm"
                variant="success"
                disabled={busyKey === `resume:${selectedSender}`}
                onClick={() => onPauseAction("resume", selectedSender)}
              >
                Сэргээх
              </Button>
            ) : (
              <div className="flex gap-1">
                {DURATIONS.map((d) => (
                  <button
                    key={d.label}
                    type="button"
                    disabled={busyKey === `pause:${selectedSender}`}
                    onClick={() => onPauseAction("pause", selectedSender, d.ms)}
                    className="rounded-md border border-line-strong bg-surface px-2 py-1 text-xs text-ink-muted hover:border-danger hover:text-danger"
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <Card className="p-4">
          {chatLoading && (
            <div className="flex justify-center py-6">
              <Spinner className="h-6 w-6 text-brand" />
            </div>
          )}
          {!chatLoading && chatHistory.length === 0 && (
            <p className="py-6 text-center text-sm text-ink-subtle">
              Хадгалагдсан яриа олдсонгүй (Redis TTL дууссан байж болно).
            </p>
          )}
          {!chatLoading && chatHistory.length > 0 && (
            <div className="space-y-2">
              {chatHistory.map((msg, i) => (
                <div
                  key={i}
                  className={cx(
                    "flex",
                    msg.role === "user" ? "justify-start" : "justify-end",
                  )}
                >
                  <div
                    className={cx(
                      "max-w-[78%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed",
                      msg.role === "user"
                        ? "bg-surface-sunken text-ink"
                        : "bg-brand text-white",
                    )}
                  >
                    {msg.text}
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
                  "cursor-pointer rounded-xl border p-3 transition-colors hover:border-brand/40 hover:bg-surface",
                  wantsHuman
                    ? "border-warning/40 bg-warning-soft"
                    : "border-line bg-surface-sunken",
                )}
                onClick={() => openChat(row.sender_id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate font-mono text-sm text-ink">
                      {shortId(row.sender_id)}
                      {wantsHuman && (
                        <span className="shrink-0 rounded-full bg-warning px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          🙋 хүн хүсэв
                        </span>
                      )}
                      {isPaused && (
                        <span className="shrink-0 rounded-full bg-danger px-1.5 py-0.5 text-[10px] font-semibold text-white">
                          зогссон
                        </span>
                      )}
                    </p>
                    <p className="mt-0.5 text-xs text-ink-subtle">
                      {formatTime(row.last_seen)}
                      {isPaused && pauseRow
                        ? ` · ${tick >= 0 ? timeLeft(pauseRow.expires_at) : ""}`
                        : ""}
                    </p>
                  </div>
                  <Icons.chevronRight size={14} className="shrink-0 text-ink-subtle" />
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
