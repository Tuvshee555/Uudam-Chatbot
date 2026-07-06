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
import { LoadingPanel, SectionHeading, StructuredEditor } from "./AdminShared";
import type { AnalyticsStatsData, FaqStatsData } from "./adminTabData";
import { readUrlList } from "./adminTabData";
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

export function AnalyticsTab({
  apiFetch,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const [stats, setStats] = useState<AnalyticsStatsData | null>(null);
  const [faq, setFaq] = useState<FaqStatsData | null>(null);
  const [faqPeriod, setFaqPeriod] = useState<"week" | "month" | "allTime">("week");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const res = await apiFetch("/api/admin/analytics");
        const data: { ok?: boolean; stats?: AnalyticsStatsData; faq?: FaqStatsData } =
          await res.json();
        if (cancelled) return;
        if (data?.ok && data.stats) {
          setStats(data.stats);
          setFaq(data.faq ?? null);
        } else {
          setError("Мэдээлэл ачаалж чадсангүй.");
        }
      } catch {
        if (!cancelled) setError("Мэдээлэл ачаалж чадсангүй.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  if (loading) {
    return <LoadingPanel />;
  }

  if (error || !stats) {
    return (
      <div className="py-8">
        <Alert tone="danger">{error || "Мэдээлэл ачаалж чадсангүй."}</Alert>
      </div>
    );
  }

  const STATUS_MN: Record<string, string> = {
    new_lead: "Шинэ",
    contacted: "Холбогдсон",
    booked: "Захиалсан",
    no_answer: "Хариугүй",
  };

  const dayMax = Math.max(1, ...stats.leadsByDay.map((d) => d.count));
  const tripMax = Math.max(1, ...stats.leadsByTrip.map((t) => t.count));

  return (
    <div className="space-y-6">
      <SectionHeading title="Аналитик" description="Хүсэлт болон аяллын нийлбэр статистик" />

      {/* Row 1 — 4 stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Нийт хүсэлт</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.totalLeads}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Шинэ хүсэлт</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.newLeads}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Захиалга</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.bookingLeads}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-ink-subtle">Нийт харилцагч</p>
          <p className="mt-1 text-2xl font-bold text-ink">{stats.totalContacts}</p>
        </Card>
      </div>

      {/* Row 2 — bar charts */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Өдрөөр (14 хоног)</h3>
          {stats.leadsByDay.length === 0 ? (
            <p className="text-sm text-ink-subtle">Өгөгдөл байхгүй.</p>
          ) : (
            <div className="space-y-1.5">
              {stats.leadsByDay.map((item) => {
                const pct = Math.round((item.count / dayMax) * 100);
                return (
                  <div key={item.date}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="text-ink truncate">{item.date}</span>
                      <span className="text-ink-muted ml-2 shrink-0">{item.count}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-sunken overflow-hidden">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Аяллаар</h3>
          {stats.leadsByTrip.length === 0 ? (
            <p className="text-sm text-ink-subtle">Өгөгдөл байхгүй.</p>
          ) : (
            <div className="space-y-1.5">
              {stats.leadsByTrip.map((item) => {
                const pct = Math.round((item.count / tripMax) * 100);
                return (
                  <div key={item.trip}>
                    <div className="flex justify-between text-xs mb-0.5">
                      <span className="text-ink truncate">{item.trip}</span>
                      <span className="text-ink-muted ml-2 shrink-0">{item.count}</span>
                    </div>
                    <div className="h-2 rounded-full bg-surface-sunken overflow-hidden">
                      <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Row 3 — status breakdown + active trips table */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">Статусаар</h3>
          {Object.keys(stats.leadsByStatus).length === 0 ? (
            <p className="text-sm text-ink-subtle">Өгөгдөл байхгүй.</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(stats.leadsByStatus).map(([status, count]) => (
                <div key={status} className="flex items-center justify-between text-sm">
                  <span className="text-ink">{STATUS_MN[status] ?? status}</span>
                  <span className="font-semibold text-ink">{count}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <h3 className="mb-3 text-sm font-semibold text-ink">
            Идэвхтэй аяллууд{" "}
            <span className="font-normal text-ink-muted">
              ({stats.activeTrips}/{stats.totalTrips})
            </span>
          </h3>
          {stats.topTrips.length === 0 ? (
            <p className="text-sm text-ink-subtle">Идэвхтэй аялал байхгүй.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-ink-muted">
                    <th className="pb-2 font-medium">Аяллын нэр</th>
                    <th className="pb-2 font-medium text-right">Үнэ</th>
                    <th className="pb-2 font-medium text-right">Суудал</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {stats.topTrips.map((trip) => (
                    <tr key={trip.name}>
                      <td className="py-2 pr-3 text-ink truncate max-w-[160px]">
                        {trip.name}
                      </td>
                      <td className="py-2 text-right text-ink-muted">
                        {trip.price > 0 ? trip.price.toLocaleString("en-US") : "—"}
                      </td>
                      <td className="py-2 text-right text-ink-muted">
                        {trip.seats_left}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        {/* Most asked questions */}
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-ink">
              Түгээмэл асуултууд{" "}
              <span className="font-normal text-ink-muted">
                (нийт {faq?.totalMessages ?? 0} мессеж)
              </span>
            </h3>
            <div className="inline-flex rounded-lg border border-line bg-surface-sunken p-0.5">
              {[
                { key: "week" as const, label: "7 хоног" },
                { key: "month" as const, label: "30 хоног" },
                { key: "allTime" as const, label: "Нийт" },
              ].map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => setFaqPeriod(p.key)}
                  className={cx(
                    "rounded-md px-3 py-1 text-xs font-medium transition-colors",
                    faqPeriod === p.key
                      ? "bg-surface text-ink shadow-sm"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          {(() => {
            const list = faq ? faq[faqPeriod] : [];
            if (!list || list.length === 0) {
              return (
                <p className="py-4 text-center text-sm text-ink-subtle">
                  Энэ хугацаанд асуулт бүртгэгдээгүй байна.
                </p>
              );
            }
            const max = Math.max(1, ...list.map((q) => q.count));
            return (
              <div className="space-y-2.5">
                {list.map((q, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-brand-soft text-[11px] font-bold text-brand">
                      {i + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <p className="truncate text-sm text-ink">{q.question}</p>
                        <span className="shrink-0 text-xs font-medium text-ink-muted">
                          {q.count}
                        </span>
                      </div>
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken">
                        <div
                          className="h-full rounded-full bg-brand"
                          style={{ width: `${(q.count / max) * 100}%` }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </Card>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   Seasons Tab — owner-controlled seasonal albums (e.g. Наадам, Өвөл)
   Stored in bot_settings.extra.seasons. Exactly one is active at a time;
   the active season's album is appended to the greeting, and any season's
   keywords auto-trigger its album when a customer mentions them.
   ---------------------------------------------------------------- */
type SeasonItem = {
  id: string;
  name: string;
  keywords: string[];
  photoUrls: string[];
  active: boolean;
};

function readSeasons(extra: Record<string, unknown>): SeasonItem[] {
  const raw = extra.seasons;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : Math.random().toString(36).slice(2),
      name: typeof s.name === "string" ? s.name : "",
      keywords: Array.isArray(s.keywords)
        ? (s.keywords as unknown[]).filter((k): k is string => typeof k === "string")
        : [],
      photoUrls: readUrlList(s.photoUrls),
      active: s.active === true,
    }));
}
