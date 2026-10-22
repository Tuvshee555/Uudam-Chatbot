import { useEffect, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Card, Icons, Skeleton, cx } from "@/components/ui";
import { ADMIN_ISSUE_LABELS, type AnalyticsResponse } from "@/lib/adminAnalyticsTypes";
import type { TabKey } from "@/lib/adminTypes";
import { StatCard, TabHeader } from "./AdminShared";

const STATUS_LABELS: Record<string, string> = {
  new_lead: "Шинэ", contacted: "Холбогдсон", booked: "Захиалсан", no_answer: "Хариугүй",
};
const KIND_LABELS: Record<string, string> = {
  booking: "Захиалгын хүсэлт", handoff: "Зөвлөхөд шилжсэн", inquiry: "Лавлагаа", contact: "Холбогдох хүсэлт",
};

function number(value: number) {
  return value.toLocaleString("mn-MN");
}

function snapshotTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("mn-MN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ulaanbaatar" }).format(date)
    : "—";
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-surface-sunken/60 px-4 py-5 text-sm leading-6 text-ink-muted">{children}</p>;
}

export function AnalyticsTab({
  apiFetch,
  onNavigate,
  onUnauthorized,
}: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onNavigate: (tab: TabKey) => void;
  onUnauthorized?: () => void;
}) {
  const [snapshot, setSnapshot] = useState<AnalyticsResponse | null>(null);
  const [periodDays, setPeriodDays] = useState<7 | 30>(7);
  const [faqPeriod, setFaqPeriod] = useState<"week" | "month" | "allTime">("week");
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        const response = await apiFetch(`/api/admin/analytics?days=${periodDays}`, { signal: controller.signal });
        if (!active) return;
        if (response.status === 401) {
          setSnapshot(null);
          setError("Нэвтрэх эрх дууссан байна. Дахин нэвтэрнэ үү.");
          onUnauthorized?.();
          return;
        }
        const data = await response.json() as AnalyticsResponse;
        if (!active) return;
        if (!response.ok || !data.ok || !data.stats) throw new Error("analytics_unavailable");
        setSnapshot(data);
      } catch {
        if (active) setError("Тойм ачаалж чадсангүй. Дахин оролдоно уу.");
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [apiFetch, onUnauthorized, periodDays, refresh]);

  const stats = snapshot?.stats;
  const activity = snapshot?.activity;
  const attention = snapshot?.attention;
  const faq = snapshot?.faq;
  const days = activity?.daily ?? [];
  const dayMax = Math.max(1, ...days.map((day) => Math.max(day.inboundMessages, day.assistantMessages)));
  const questions = faq?.[faqPeriod] ?? [];

  return (
    <div className="space-y-5" aria-busy={loading}>
      <TabHeader
        title="Тойм"
        description="Харилцааны идэвх, ажилтны анхаарах хүсэлт, системийн сүүлийн алдаа."
        actions={
          <>
            {snapshot?.generatedAt && <span className="text-xs text-ink-muted">{snapshotTime(snapshot.generatedAt)} · УБ</span>}
            <Button variant="secondary" size="sm" loading={loading} onClick={() => setRefresh((value) => value + 1)}>
              {!loading && <Icons.refresh size={15} />} Шинэчлэх
            </Button>
          </>
        }
      />

      {error && <Alert tone="danger">{error}{snapshot && " Доор хамгийн сүүлд ачаалсан мэдээллийг харуулж байна."}</Alert>}
      {Boolean(snapshot?.warnings?.length) && <Alert tone="warning">Тоймын зарим мэдээллийг ачаалж чадсангүй. Дахин шинэчилнэ үү.</Alert>}
      {attention?.staffAlertsConfigured === false && (
        <Alert tone="warning">
          <span className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-4">
            <span>Ажилтанд мэдэгдэх суваг тохируулаагүй байна. Шилжүүлгийн хүсэлтүүдийг Хүсэлтүүд хэсгээс тогтмол шалгаарай.</span>
            <Button variant="secondary" size="sm" onClick={() => onNavigate("leads")}>Хүсэлтүүд нээх <Icons.chevronRight size={14} /></Button>
          </span>
        </Alert>
      )}

      {!snapshot && loading && (
        <div role="status" aria-label="Тойм ачаалж байна" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}</div>
          <Skeleton className="h-60 rounded-xl" />
        </div>
      )}

      {stats && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-ink">Харилцааны идэвх</h2>
              <p className="mt-1 text-xs text-ink-muted">Сүүлийн {activity?.periodDays ?? periodDays} хоног · Улаанбаатарын цагаар</p>
            </div>
            <div role="group" aria-label="Харилцааны хугацаа" className="inline-flex rounded-lg border border-line bg-surface p-1">
              {([7, 30] as const).map((value) => (
                <button key={value} type="button" aria-pressed={periodDays === value} onClick={() => setPeriodDays(value)} className={cx("rounded-md px-3 py-1.5 text-xs font-semibold transition-colors", periodDays === value ? "bg-brand-soft text-brand" : "text-ink-muted hover:bg-surface-sunken")}>{value} хоног</button>
              ))}
            </div>
          </div>

          {activity ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="Харилцагчийн мессеж" value={number(activity.inboundMessages)} description={`${activity.periodDays} хоногт бүртгэгдсэн`} />
              <StatCard label="Бүртгэгдсэн хариу" value={number(activity.assistantMessages)} tone="text-brand" description="Харилцааны түүхэд хадгалагдсан" />
              <StatCard label="Идэвхтэй харилцаа" value={number(activity.activeConversations)} description="Энэ хугацаанд мессеж ирсэн" />
              <StatCard label="Зөвлөхийн шинэ хүсэлт" value={attention ? number(attention.pendingHandoffs) : "—"} tone={attention?.pendingHandoffs ? "text-warning" : undefined} description="Шинэ төлөвтэй шилжүүлгийн хүсэлт" />
            </div>
          ) : <EmptyNote>Харилцааны статистик ачаалагдсангүй. Дахин шинэчилнэ үү.</EmptyNote>}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <Card className="min-w-0 p-4 sm:p-5">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div><h3 className="text-sm font-semibold text-ink">Өдөр тутмын харилцаа</h3><p className="mt-1 text-xs text-ink-muted">Ирсэн мессеж ба түүхэд хадгалсан хариу</p></div>
                <div className="flex flex-wrap gap-3 text-[11px] text-ink-muted"><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-brand" />Мессеж</span><span className="flex items-center gap-1.5"><i className="h-2 w-2 rounded-sm bg-brand/30" />Хариу</span></div>
              </div>
              {!activity ? <EmptyNote>Харилцааны мэдээлэл ачаалагдсангүй.</EmptyNote> : activity.inboundMessages + activity.assistantMessages === 0 ? <EmptyNote>Энэ хугацаанд харилцааны мессеж бүртгэгдээгүй байна.</EmptyNote> : (
                <div className="flex h-44 gap-1 sm:gap-2" role="list" aria-label="Өдрөөрх мессеж болон хариуны тоо">
                  {days.map((day, index) => (
                    <div key={day.date} role="listitem" aria-label={`${day.date}: ${day.inboundMessages} мессеж, ${day.assistantMessages} хариу`} title={`${day.date}: ${day.inboundMessages} мессеж · ${day.assistantMessages} хариу`} className="flex min-w-0 flex-1 flex-col items-center justify-end gap-2">
                      <div className="flex h-36 w-full items-end justify-center gap-px sm:gap-1" aria-hidden="true">
                        <div className="w-1/2 max-w-5 rounded-t-sm bg-brand" style={{ height: `${day.inboundMessages / dayMax * 100}%` }} />
                        <div className="w-1/2 max-w-5 rounded-t-sm bg-brand/30" style={{ height: `${day.assistantMessages / dayMax * 100}%` }} />
                      </div>
                      <span className="h-4 text-[10px] tabular-nums text-ink-muted">{days.length <= 7 || index === 0 || index === days.length - 1 || index % 7 === 0 ? day.date.slice(5).replace("-", "/") : ""}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-4 border-t border-line pt-3 text-xs leading-5 text-ink-muted">Хариуны бүртгэл нь хүргэлт амжилттай болсон эсэх, хариуны зөв байдлыг дангаараа батлахгүй.</p>
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <h3 className="text-sm font-semibold text-ink">Одоо анхаарах</h3>
              {attention ? (
                <div className="mt-3 divide-y divide-line">
                  <AttentionLink label="Зөвлөхийн шинэ хүсэлт" count={attention.pendingHandoffs} detail={attention.oldestPendingHandoffAt ? `Хамгийн эртний: ${snapshotTime(attention.oldestPendingHandoffAt)}` : "Шинэ шилжүүлгийн хүсэлтгүй"} onClick={() => onNavigate("leads")} />
                  <AttentionLink label="Шинэ захиалгын хүсэлт" count={attention.newBookingRequests} detail="Ажилтан холбогдож баталгаажуулна" onClick={() => onNavigate("leads")} />
                  <AttentionLink label="Системийн асуудал · 24 цаг" count={attention.errors24h} detail={attention.errors24h == null ? "Алдааны бүртгэл ачаалагдсангүй" : "Алдаа, анхааруулгын бүртгэл"} onClick={() => onNavigate("errors")} />
                </div>
              ) : <div className="mt-4"><EmptyNote>Хүлээгдэж буй хүсэлтийн мэдээлэл ачаалагдсангүй.</EmptyNote></div>}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div><h3 className="text-sm font-semibold text-ink">Бүртгэгдсэн асуултууд</h3><p className="mt-1 text-xs text-ink-muted">Их асуусан сэдвээр мэдээллээ нөхөөрэй</p></div>
                <div role="group" aria-label="Асуултын хугацаа" className="inline-flex rounded-lg bg-surface-sunken p-0.5">
                  {([{ key: "week", label: "7 хоног" }, { key: "month", label: "30 хоног" }, { key: "allTime", label: "Нийт" }] as const).map((period) => <button key={period.key} type="button" aria-pressed={faqPeriod === period.key} onClick={() => setFaqPeriod(period.key)} className={cx("rounded-md px-2.5 py-1.5 text-xs font-medium", faqPeriod === period.key ? "bg-surface text-ink shadow-xs" : "text-ink-muted hover:text-ink")}>{period.label}</button>)}
                </div>
              </div>
              {!faq ? <EmptyNote>Асуултын мэдээлэл ачаалагдсангүй.</EmptyNote> : questions.length === 0 ? <EmptyNote>Энэ хугацаанд асуулт бүртгэгдээгүй байна.</EmptyNote> : (
                <ol className="divide-y divide-line">
                  {questions.map((question, index) => <li key={question.question} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"><span className="mt-0.5 w-4 shrink-0 text-xs tabular-nums text-ink-subtle">{index + 1}</span><p className="min-w-0 flex-1 break-words text-sm leading-6 text-ink">{question.question}</p><Badge className="mt-0.5 shrink-0 tabular-nums">{number(question.count)}</Badge></li>)}
                </ol>
              )}
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <div className="mb-4 flex items-center justify-between gap-3"><h3 className="text-sm font-semibold text-ink">Сүүлийн системийн асуудлууд</h3><Button variant="ghost" size="sm" onClick={() => onNavigate("errors")}>Бүртгэл <Icons.chevronRight size={14} /></Button></div>
              {!attention || attention.errors24h == null ? <EmptyNote>Алдааны мэдээлэл ачаалагдсангүй.</EmptyNote> : attention.recentIssues.length === 0 ? <EmptyNote>Сүүлийн 24 цагт системийн асуудал бүртгэгдээгүй байна.</EmptyNote> : (
                <ul className="divide-y divide-line">{attention.recentIssues.map((issue) => <li key={`${issue.level}:${issue.event}`} className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"><div className="min-w-0"><p className="break-words text-sm font-medium text-ink">{ADMIN_ISSUE_LABELS[issue.event] ?? issue.event}</p><p className="mt-1 text-xs text-ink-muted">{snapshotTime(issue.lastSeenAt)}</p></div><Badge tone={issue.level === "error" ? "danger" : "warning"} className="shrink-0">{number(issue.count)}</Badge></li>)}</ul>
              )}
            </Card>
          </div>

          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-sm font-semibold text-ink">Хүсэлт ба аяллын сан</h2><p className="mt-1 text-xs text-ink-muted">Нийт хугацааны мэдээлэл · Захиалгын хүсэлт нь баталгаажсан захиалга биш</p></div><Button variant="ghost" size="sm" onClick={() => onNavigate("leads")}>Хүсэлтүүд <Icons.chevronRight size={14} /></Button></div>
            <dl className="mt-5 grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-4">
              {[
                { label: "Нийт хүсэлт", value: stats.totalLeads },
                { label: "Шинэ хүсэлт", value: stats.newLeads },
                { label: "Захиалгын хүсэлт", value: stats.bookingLeads },
                { label: "Харилцагч", value: stats.totalContacts },
              ].map((item) => <div key={item.label}><dt className="text-xs text-ink-muted">{item.label}</dt><dd className="mt-1.5 text-xl font-bold tabular-nums text-ink">{number(item.value)}</dd></div>)}
            </dl>
            <div className="mt-5 grid gap-5 border-t border-line pt-4 sm:grid-cols-2">
              <div><p className="mb-2 text-xs font-semibold text-ink-muted">Хүсэлтийн явц</p><div className="flex flex-wrap gap-2">{Object.entries(stats.leadsByStatus).map(([status, count]) => <Badge key={status}>{STATUS_LABELS[status] ?? "Бусад"} · {number(count)}</Badge>)}{Object.keys(stats.leadsByStatus).length === 0 && <span className="text-xs text-ink-muted">Хүсэлт бүртгэгдээгүй</span>}</div></div>
              <div><p className="mb-2 text-xs font-semibold text-ink-muted">Хүсэлтийн төрөл</p><div className="flex flex-wrap gap-2">{stats.leadsByKind.map((item) => <Badge key={item.kind}>{KIND_LABELS[item.kind] ?? "Бусад"} · {number(item.count)}</Badge>)}{stats.leadsByKind.length === 0 && <span className="text-xs text-ink-muted">Хүсэлт бүртгэгдээгүй</span>}</div></div>
            </div>
            <div className="mt-4 flex items-center justify-between gap-3 border-t border-line pt-3 text-sm"><p className="text-ink-muted">Идэвхтэй аялал <span className="font-semibold tabular-nums text-ink">{number(stats.activeTrips)}</span> / {number(stats.totalTrips)}</p><Button variant="ghost" size="sm" onClick={() => onNavigate("trips")}>Аяллууд <Icons.chevronRight size={14} /></Button></div>
          </Card>
        </>
      )}
    </div>
  );
}

function AttentionLink({ label, count, detail, onClick }: { label: string; count: number | null; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-start justify-between gap-3 py-3.5 text-left first:pt-0 last:pb-0">
      <span className="min-w-0"><span className="block text-sm font-medium text-ink group-hover:text-brand">{label}</span><span className="mt-1 block text-xs leading-5 text-ink-muted">{detail}</span></span>
      <span className="flex shrink-0 items-center gap-2"><span className={cx("text-xl font-bold tabular-nums", count ? "text-warning" : "text-ink")}>{count == null ? "—" : number(count)}</span><Icons.chevronRight size={15} className="mt-1 text-ink-subtle group-hover:text-brand" /></span>
    </button>
  );
}
