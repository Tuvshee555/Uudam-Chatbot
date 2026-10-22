import { useEffect, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Card, Icons, Skeleton, cx } from "@/components/ui";
import { ADMIN_ISSUE_LABELS, type AnalyticsResponse, type OverviewData } from "@/lib/adminAnalyticsTypes";
import type { TabKey } from "@/lib/adminTypes";
import { TabHeader } from "./AdminShared";

/**
 * The manager's first screen: how many people wrote this period and what happened to them,
 * who still needs a call, which trips and questions came up — and only then the system.
 * It used to lead with all-time counters ("163 шинэ хүсэлт" since June), button taps as
 * "questions" and raw event names; none of it said what to do today.
 */

function number(value: number) {
  return value.toLocaleString("mn-MN");
}

function snapshotTime(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("mn-MN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ulaanbaatar" }).format(date)
    : "—";
}

function shortDay(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return `${date.getUTCMonth() + 1}/${date.getUTCDate()}`;
}

const WEEKDAYS = ["Ня", "Да", "Мя", "Лх", "Пү", "Ба", "Бя"];
function weekday(value: string) {
  return WEEKDAYS[new Date(`${value}T00:00:00Z`).getUTCDay()];
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-surface-sunken/60 px-4 py-5 text-sm leading-6 text-ink-muted">{children}</p>;
}

function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: Array<{ value: T; label: string }>; onChange: (value: T) => void; label: string;
}) {
  return (
    <div role="group" aria-label={label} className="inline-flex rounded-lg border border-line bg-surface p-0.5">
      {options.map((option) => (
        <button key={String(option.value)} type="button" aria-pressed={value === option.value} onClick={() => onChange(option.value)}
          className={cx("rounded-md px-3 py-1.5 text-xs font-semibold transition-colors", value === option.value ? "bg-brand-soft text-brand" : "text-ink-muted hover:bg-surface-sunken hover:text-ink")}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** A headline number with what it means in one line, and the change against the previous period when there is one. */
function Kpi({ label, value, detail, change }: { label: string; value: number; detail: ReactNode; change?: number | null }) {
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">{label}</p>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[32px] font-extrabold leading-none tracking-tight tabular-nums text-ink">{number(value)}</span>
        {change != null && Number.isFinite(change) && change !== 0 && (
          <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", change > 0 ? "bg-success-soft text-success" : "bg-surface-sunken text-ink-muted")}>
            {change > 0 ? "▲" : "▼"} {Math.abs(change)}%
          </span>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-ink-muted">{detail}</p>
    </Card>
  );
}

/** People who wrote, per day. One series in the brand colour; the exact numbers are in the tooltip. */
function DailyChart({ days }: { days: OverviewData["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.customers));
  const busiest = days.reduce((best, day, index) => (day.customers > days[best].customers ? index : best), 0);
  const dense = days.length > 10;
  return (
    <div className="relative pt-5">
      <div className="flex h-48 items-end gap-[2px] border-b border-line sm:gap-1.5" role="list" aria-label="Өдөр бүр бичсэн хүний тоо">
        {days.map((day, index) => {
          const active = hover === index;
          return (
            <div key={day.date} role="listitem" tabIndex={0}
              aria-label={`${shortDay(day.date)}: ${day.customers} хүн бичсэн, ${day.handedOff} нь ажилтанд шилжсэн`}
              onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(index)} onBlur={() => setHover(null)}
              className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end outline-none">
              {(index === busiest && day.customers > 0 && hover === null) && (
                <span className="mb-1 text-[11px] font-semibold tabular-nums text-ink-muted">{day.customers}</span>
              )}
              <div className={cx("w-full max-w-9 rounded-t-[4px] transition-colors", active ? "bg-brand" : "bg-brand/75 group-hover:bg-brand")}
                style={{ height: `${Math.max(day.customers ? 3 : 0, (day.customers / max) * 100)}%` }} />
              {active && (
                <div className="pointer-events-none absolute bottom-full z-10 mb-2 w-max -translate-x-0 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg">
                  <p className="font-semibold text-ink">{shortDay(day.date)} · {weekday(day.date)}</p>
                  <p className="mt-1 tabular-nums text-ink-muted"><span className="font-semibold text-ink">{day.customers}</span> хүн бичсэн</p>
                  <p className="tabular-nums text-ink-muted"><span className="font-semibold text-ink">{day.handedOff}</span> нь ажилтанд шилжсэн</p>
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-[2px] sm:gap-1.5">
        {days.map((day, index) => (
          <span key={day.date} className="min-w-0 flex-1 text-center text-[10px] tabular-nums text-ink-muted">
            {!dense || index === 0 || index === days.length - 1 || index % 7 === 0 ? (dense ? shortDay(day.date) : <>{shortDay(day.date)}<br />{weekday(day.date)}</>) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

function ActionRow({ label, count, detail, onClick }: { label: string; count: number | null; detail: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-center justify-between gap-3 rounded-lg px-3 py-3 text-left transition-colors hover:bg-surface-sunken">
      <span className="min-w-0">
        <span className="block text-sm font-semibold text-ink group-hover:text-brand">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{detail}</span>
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <span className={cx("min-w-8 rounded-lg px-2 py-1 text-center text-lg font-bold tabular-nums", count ? "bg-warning-soft text-warning" : "bg-surface-sunken text-ink-muted")}>{count == null ? "—" : number(count)}</span>
        <Icons.chevronRight size={15} className="text-ink-subtle group-hover:text-brand" />
      </span>
    </button>
  );
}

/** Trips people opened on their own (a trip card, its price, a matched screenshot) — one series, values printed. */
function TripDemand({ trips }: { trips: OverviewData["tripDemand"] }) {
  const max = Math.max(1, ...trips.map((trip) => trip.customers));
  return (
    <ol className="space-y-3">
      {trips.map((trip) => (
        <li key={trip.trip} className="min-w-0">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate text-ink" title={trip.trip}>{trip.trip}</span>
            <span className="shrink-0 tabular-nums font-semibold text-ink">{number(trip.customers)} <span className="font-normal text-ink-muted">хүн</span></span>
          </div>
          <div className="mt-1.5 h-2 rounded-full bg-surface-sunken" aria-hidden="true">
            <div className="h-2 rounded-full bg-brand/80" style={{ width: `${(trip.customers / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ol>
  );
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

  const overview = snapshot?.overview ?? null;
  const stats = snapshot?.stats;
  const attention = snapshot?.attention;
  const faq = snapshot?.faq;
  const questions = faq?.[faqPeriod] ?? [];
  const change = overview && overview.previousCustomers > 0
    ? Math.round(((overview.customers - overview.previousCustomers) / overview.previousCustomers) * 100) : null;
  const answeredShare = overview && overview.customers > 0 ? Math.min(100, Math.round((overview.answeredCustomers / overview.customers) * 100)) : null;
  const periodLabel = periodDays === 7 ? "Энэ 7 хоног" : "Сүүлийн 30 хоног";

  return (
    <div className="space-y-5" aria-busy={loading}>
      <TabHeader
        title="Тойм"
        description="Хэдэн хүн бичсэн, хэнд залгах, юу асууж байгаа нь."
        actions={
          <>
            <Segmented label="Хугацаа" value={periodDays} onChange={setPeriodDays}
              options={[{ value: 7, label: "7 хоног" }, { value: 30, label: "30 хоног" }]} />
            <Button variant="secondary" size="sm" loading={loading} onClick={() => setRefresh((value) => value + 1)}>
              {!loading && <Icons.refresh size={15} />} Шинэчлэх
            </Button>
          </>
        }
      />

      {error && <Alert tone="danger">{error}{snapshot && " Доор хамгийн сүүлд ачаалсан мэдээллийг харуулж байна."}</Alert>}
      {Boolean(snapshot?.warnings?.length) && <Alert tone="warning">Тоймын зарим хэсгийг ачаалж чадсангүй. Шинэчилнэ үү.</Alert>}

      {!snapshot && loading && (
        <div role="status" aria-label="Тойм ачаалж байна" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}</div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {snapshot && (
        <>
          {overview ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Бичсэн хүн" value={overview.customers} change={change}
                detail={`${periodLabel} · өмнөх ${periodDays} хоногт ${number(overview.previousCustomers)}`} />
              <Kpi label="Бот хариулсан" value={overview.answeredCustomers}
                detail={answeredShare == null ? "Энэ хугацаанд бичсэн хүн алга" : `Бичсэн хүмүүсийн ${answeredShare}% нь хариу авсан`} />
              <Kpi label="Ажилтанд шилжсэн" value={overview.handedOff}
                detail="Бот мэдээлэлгүй тул чимээгүй үлдэж, зөвлөхөд ирсэн" />
              <Kpi label="Утсаа үлдээсэн" value={overview.phoneLeads}
                detail={`Захиалгын хүсэлт ${number(overview.bookingRequests)}`} />
            </div>
          ) : <EmptyNote>Энэ хугацааны тоог ачаалж чадсангүй. Шинэчилнэ үү.</EmptyNote>}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="min-w-0 p-4 sm:p-5">
              <div className="mb-4">
                <h3 className="text-sm font-semibold text-ink">Өдөр бүр бичсэн хүн</h3>
                <p className="mt-1 text-xs text-ink-muted">{periodLabel} · Улаанбаатарын цагаар · баганан дээр очиж тоог харна</p>
              </div>
              {!overview ? <EmptyNote>Өдрийн мэдээлэл ачаалагдсангүй.</EmptyNote>
                : overview.customers === 0 ? <EmptyNote>Энэ хугацаанд хэн ч бичээгүй байна.</EmptyNote>
                  : <DailyChart days={overview.daily} />}
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <h3 className="text-sm font-semibold text-ink">Одоо хийх</h3>
              <p className="mt-1 text-xs text-ink-muted">Шийдсэн хүсэлтээ «Холбогдсон» болговол энд хасагдана.</p>
              {overview ? (
                <div className="-mx-3 mt-3 space-y-0.5">
                  <ActionRow label="Залгах хүн" count={overview.callBack} detail="Сүүлийн 14 хоногт утсаа үлдээсэн, хараахан холбогдоогүй" onClick={() => onNavigate("leads")} />
                  <ActionRow label="Ботын хариулж чадаагүй асуулт" count={overview.recentHandoffs} detail="Сүүлийн 14 хоногт зөвлөхөд шилжсэн" onClick={() => onNavigate("leads")} />
                  <ActionRow label="Захиалгын хүсэлт" count={overview.recentBookings} detail="Сүүлийн 14 хоногт ирсэн, баталгаажуулаагүй" onClick={() => onNavigate("leads")} />
                </div>
              ) : <div className="mt-4"><EmptyNote>Хүсэлтийн мэдээлэл ачаалагдсангүй.</EmptyNote></div>}
              {overview && overview.backlog > 0 && (
                <p className="mt-3 border-t border-line pt-3 text-xs leading-5 text-ink-muted">
                  Үүнээс гадна 14 хоногоос өмнөх <span className="font-semibold text-ink">{number(overview.backlog)}</span> хүсэлт
                  {overview.oldestBacklogAt ? ` (${snapshotTime(overview.oldestBacklogAt)}-аас хойш)` : ""} шинэ төлөвтэй хэвээр байна.
                </p>
              )}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 p-4 sm:p-5">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Хамгийн их үзсэн аяллууд</h3>
                  <p className="mt-1 text-xs text-ink-muted">{periodLabel} · аяллын карт, үнэ эсвэл зургаар нь тодорхой асуусан хүн</p>
                </div>
                <Button variant="ghost" size="sm" onClick={() => onNavigate("trips")}>Аяллууд <Icons.chevronRight size={14} /></Button>
              </div>
              {!overview ? <EmptyNote>Аяллын мэдээлэл ачаалагдсангүй.</EmptyNote>
                : overview.tripDemand.length === 0 ? <EmptyNote>Энэ хугацаанд тодорхой аялал асуусан хүн алга.</EmptyNote>
                  : <TripDemand trips={overview.tripDemand} />}
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-ink">Хүмүүсийн асуусан зүйл</h3>
                  <p className="mt-1 text-xs text-ink-muted">Товч дарсан, мэндэлсэн мессежийг оруулаагүй</p>
                </div>
                <Segmented label="Асуултын хугацаа" value={faqPeriod} onChange={setFaqPeriod}
                  options={[{ value: "week", label: "7 хоног" }, { value: "month", label: "30 хоног" }, { value: "allTime", label: "Нийт" }]} />
              </div>
              {!faq ? <EmptyNote>Асуултын мэдээлэл ачаалагдсангүй.</EmptyNote> : questions.length === 0 ? <EmptyNote>Энэ хугацаанд асуулт бүртгэгдээгүй байна.</EmptyNote> : (
                <ol className="divide-y divide-line">
                  {questions.map((question, index) => (
                    <li key={`${index}-${question.question}`} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="mt-0.5 w-4 shrink-0 text-xs tabular-nums text-ink-subtle">{index + 1}</span>
                      <p className="min-w-0 flex-1 break-words text-sm leading-6 text-ink">{question.question}</p>
                      {question.count > 1 && <Badge className="mt-0.5 shrink-0 tabular-nums">{number(question.count)}×</Badge>}
                    </li>
                  ))}
                </ol>
              )}
            </Card>
          </div>

          <Card className="p-4 sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <span className={cx("flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
                  attention?.errors24h ? "bg-warning-soft text-warning" : "bg-success-soft text-success")}>
                  {attention?.errors24h ? <Icons.alert size={17} /> : <Icons.check size={17} />}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-ink">
                    {attention?.errors24h == null ? "Системийн бүртгэл ачаалагдсангүй"
                      : attention.errors24h === 0 ? "Сүүлийн 24 цагт систем хэвийн ажилласан"
                        : `Сүүлийн 24 цагт ${number(attention.errors24h)} техникийн асуудал бүртгэгдсэн`}
                  </p>
                  {attention && attention.recentIssues.length > 0 && (
                    <p className="mt-0.5 truncate text-xs text-ink-muted">
                      {[...new Set(attention.recentIssues.map((issue) => ADMIN_ISSUE_LABELS[issue.event] ?? "Техникийн алдаа"))].slice(0, 3).join(" · ")}
                    </p>
                  )}
                  {attention?.staffAlertsConfigured === false && (
                    <p className="mt-0.5 text-xs text-ink-muted">Ажилтанд шууд мэдэгдэл очихгүй тохиргоотой — хүсэлтүүдийг энэ самбараас шалгаарай.</p>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {stats && <span className="text-xs text-ink-muted">Идэвхтэй аялал <span className="font-semibold tabular-nums text-ink">{number(stats.activeTrips)}</span> / {number(stats.totalTrips)}</span>}
                <Button variant="ghost" size="sm" onClick={() => onNavigate("errors")}>Бүртгэл <Icons.chevronRight size={14} /></Button>
              </div>
            </div>
          </Card>
          {snapshot.generatedAt && <p className="text-right text-[11px] text-ink-subtle">Шинэчилсэн: {snapshotTime(snapshot.generatedAt)} · УБ</p>}
        </>
      )}
    </div>
  );
}
