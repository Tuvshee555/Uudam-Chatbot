import { useEffect, useState, type ReactNode } from "react";
import { Alert, Badge, Button, Card, Icons, Skeleton, cx } from "@/components/ui";
import { ADMIN_ISSUE_LABELS, type AnalyticsResponse, type CoverageTopic, type OverviewData, type SilenceReason } from "@/lib/adminAnalyticsTypes";
import type { TabKey } from "@/lib/adminTypes";
import { TabHeader } from "./AdminShared";

/**
 * The owner's first screen, about the bot's answers: how many people wrote and how many the
 * bot answered, why it stayed silent for the rest, the questions it could not answer, which
 * topics the trip data covers, what people looked at. Staff sell by hand from the Meta inbox,
 * so leads are records here — never a call queue or an alert to act on.
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

const SILENCE_LABELS: Record<SilenceReason, { label: string; help: string }> = {
  no_data: { label: "Мэдээлэлд хариулт байгаагүй", help: "Асуултын хариу аяллын мэдээлэлд алга" },
  not_found: { label: "Асуусан аялал олдоогүй", help: "Манайд байхгүй чиглэл эсвэл танигдаагүй нэр" },
  unclear_trip: { label: "Аль аялал болох нь тодорхойгүй", help: "Бот буруу аялал хэлэхээс сэргийлж хариулаагүй" },
  sold_out: { label: "Дүүрсэн аялал асуусан", help: "Суудал дүүрсэн огноо, аялал" },
  asked_person: { label: "Хүнтэй ярихыг хүссэн", help: "«Зөвлөхтэй холбогдох», «хариу өгнө үү» гэх мэт" },
  media: { label: "Зураг, дуут мессеж", help: "Бот танихгүй зураг эсвэл дуу" },
  payment: { label: "Төлбөр, дансны асуулт", help: "Дансыг зөвлөх өөрөө илгээнэ" },
  ai_outage: { label: "AI үйлчилгээ тасарсан", help: "OpenAI ажиллаагүй үед ирсэн мессеж" },
  other: { label: "Бусад", help: "Бусад шалтгаан" },
};

const TOPIC_LABELS: Record<CoverageTopic, string> = {
  price: "Үнэ", dates: "Гарах өдөр", program: "Өдрийн хөтөлбөр", hotel: "Зочид буудал",
  includes: "Үнэд багтсан зүйл", documents: "Виз, бичиг баримт", terms: "Урьдчилгаа, цуцлалт", photos: "Зураг",
};

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-surface-sunken/60 px-4 py-5 text-sm leading-6 text-ink-muted">{children}</p>;
}

function SectionTitle({ title, hint, action }: { title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 sm:flex-1">
        <h3 className="text-sm font-semibold text-ink">{title}</h3>
        {hint && <p className="mt-1 text-xs leading-5 text-ink-muted">{hint}</p>}
      </div>
      {action && <div className="shrink-0 self-start">{action}</div>}
    </div>
  );
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

/** A headline number, what it means in one line, and the change against the previous period. */
function Kpi({ label, value, detail, change }: { label: string; value: number; detail: ReactNode; change?: number | null }) {
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">{label}</p>
      <div className="mt-3 flex items-baseline gap-2">
        <span className="text-[32px] font-extrabold leading-none tracking-tight tabular-nums text-ink">{number(value)}</span>
        {change != null && Number.isFinite(change) && change !== 0 && (
          <span className={cx("inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-semibold tabular-nums", change > 0 ? "bg-success-soft text-success" : "bg-surface-sunken text-ink-muted")}
            aria-label={`Өмнөх хугацаанаас ${Math.abs(change)}% ${change > 0 ? "өссөн" : "буурсан"}`}>
            {change > 0 ? "▲" : "▼"} {Math.abs(change)}%
          </span>
        )}
      </div>
      <p className="mt-2 text-xs leading-5 text-ink-muted">{detail}</p>
    </Card>
  );
}

/** People who wrote, per day: one series in the brand colour; the day's split is in the tooltip. */
function DailyChart({ days }: { days: OverviewData["daily"] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(1, ...days.map((day) => day.customers));
  const busiest = days.reduce((best, day, index) => (day.customers > days[best].customers ? index : best), 0);
  const dense = days.length > 10;
  return (
    <div className="relative flex flex-1 flex-col pt-5">
      <div className="flex min-h-48 flex-1 items-end gap-0.5 border-b border-line sm:gap-1.5 lg:min-h-60" role="list" aria-label="Өдөр бүр бичсэн хүний тоо">
        {days.map((day, index) => {
          const active = hover === index;
          return (
            <div key={day.date} role="listitem" tabIndex={0}
              aria-label={`${shortDay(day.date)}: ${day.customers} хүн бичсэн, бот ${day.answered} хүнд хариулсан, ${day.handedOff} нь зөвлөхөд үлдсэн`}
              onMouseEnter={() => setHover(index)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(index)} onBlur={() => setHover(null)}
              className="group relative flex h-full min-w-0 flex-1 cursor-default flex-col items-center justify-end outline-none">
              {index === busiest && day.customers > 0 && hover === null && (
                <span className="mb-1 text-[11px] font-semibold tabular-nums text-ink-muted">{day.customers}</span>
              )}
              <div className={cx("relative w-full max-w-9 rounded-t-[4px] transition-colors", active ? "bg-brand" : "bg-brand/75 group-hover:bg-brand")}
                style={{ height: `${Math.max(day.customers ? 3 : 0, (day.customers / max) * 100)}%` }}>
                {active && (
                  <div className={cx("pointer-events-none absolute bottom-full z-10 mb-2 w-max rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg",
                    index > days.length / 2 ? "right-0" : "left-0")}>
                    <p className="font-semibold text-ink">{shortDay(day.date)} · {weekday(day.date)}</p>
                    <p className="mt-1 tabular-nums text-ink-muted"><span className="font-semibold text-ink">{day.customers}</span> хүн бичсэн</p>
                    <p className="tabular-nums text-ink-muted">Бот <span className="font-semibold text-ink">{day.answered}</span> хүнд хариулсан</p>
                    <p className="tabular-nums text-ink-muted"><span className="font-semibold text-ink">{day.handedOff}</span> нь зөвлөхөд үлдсэн</p>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-0.5 sm:gap-1.5" aria-hidden="true">
        {days.map((day, index) => (
          <span key={day.date} className="min-w-0 flex-1 text-center text-[10px] tabular-nums text-ink-muted">
            {/* A long period labels every 7th day counted back from today, so labels never collide. */}
            {!dense ? <>{shortDay(day.date)}<br />{weekday(day.date)}</> : (days.length - 1 - index) % 7 === 0 ? shortDay(day.date) : ""}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A labelled row with a proportional bar: one series, the value printed beside it. */
function BarRow({ label, help, value, max, suffix, tone = "brand", title }: {
  label: ReactNode; help?: string; value: number; max: number; suffix?: string; tone?: "brand" | "warning"; title?: string;
}) {
  return (
    <li className="min-w-0">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 truncate text-ink" title={title}>{label}</span>
        <span className="shrink-0 font-semibold tabular-nums text-ink">{number(value)}{suffix && <span className="font-normal text-ink-muted"> {suffix}</span>}</span>
      </div>
      {help && <p className="truncate text-[11px] text-ink-muted">{help}</p>}
      <div className="mt-1.5 h-2 rounded-full bg-surface-sunken" aria-hidden="true">
        <div className={cx("h-2 rounded-full", tone === "warning" ? "bg-warning" : "bg-brand/80")} style={{ width: `${Math.max(2, (value / Math.max(1, max)) * 100)}%` }} />
      </div>
    </li>
  );
}

function SilenceReasons({ reasons, total }: { reasons: OverviewData["silenceReasons"]; total: number }) {
  if (!reasons.length) return <EmptyNote>Энэ хугацаанд бот бичсэн бүх хүнд хариулсан.</EmptyNote>;
  const max = Math.max(...reasons.map((reason) => reason.count));
  return (
    <ol className="space-y-3.5">
      {reasons.map(({ reason, count }) => (
        <BarRow key={reason} value={count} max={max} tone={reason === "ai_outage" ? "warning" : "brand"}
          label={<>{reason === "ai_outage" && <Icons.alert size={13} className="mr-1 inline text-warning" />}{SILENCE_LABELS[reason].label}</>}
          help={SILENCE_LABELS[reason].help} />
      ))}
      <p className="pt-1 text-[11px] leading-5 text-ink-subtle">Нийт {number(total)} удаа. Эдгээрт зөвлөх Messenger-ээс хариулна — бот таамаглаж хариулахгүй.</p>
    </ol>
  );
}

function Unanswered({ items }: { items: OverviewData["unanswered"] }) {
  if (!items.length) return <EmptyNote>Энэ хугацаанд мэдээлэл дутсанаас хариулж чадаагүй асуулт алга.</EmptyNote>;
  return (
    <ol className="divide-y divide-line">
      {items.map((item, index) => (
        <li key={`${item.at}-${index}`} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0 flex-1">
            <p className="wrap-break-word text-sm leading-6 text-ink">{item.question}</p>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
              <span>{snapshotTime(item.at)}</span>
              <span aria-hidden="true">·</span>
              <span>{SILENCE_LABELS[item.reason].label}</span>
            </p>
          </div>
          {item.topic && <Badge className="mt-0.5 shrink-0">{TOPIC_LABELS[item.topic]}</Badge>}
        </li>
      ))}
    </ol>
  );
}

/** For each topic customers ask about, how many active trips hold the answer. */
function Coverage({ coverage, activeTrips }: { coverage: OverviewData["coverage"]; activeTrips: number }) {
  if (!activeTrips) return <EmptyNote>Идэвхтэй аялал алга.</EmptyNote>;
  return (
    <ol className="space-y-3">
      {coverage.map(({ topic, trips, asked }) => {
        const missing = trips === 0;
        return (
          <li key={topic} className="min-w-0">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate text-ink">{TOPIC_LABELS[topic]}</span>
              <span className={cx("shrink-0 tabular-nums", missing ? "text-warning" : "text-ink-muted")}>
                <span className={cx("font-semibold", missing ? "text-warning" : "text-ink")}>{number(trips)}</span> / {number(activeTrips)} аялал
              </span>
            </div>
            <div className="mt-1.5 h-2 rounded-full bg-surface-sunken" aria-hidden="true">
              <div className="h-2 rounded-full bg-brand/80" style={{ width: `${(trips / activeTrips) * 100}%` }} />
            </div>
            {(missing || asked > 0) && (
              <p className={cx("mt-1 text-[11px] leading-4", missing ? "text-warning" : "text-ink-muted")}>
                {missing && "Аль ч аялалд алга — асуувал бот хариулахгүй, зөвлөх хариулна."}
                {missing && asked > 0 && " "}
                {asked > 0 && `Энэ хугацаанд ${number(asked)} асуулт хариугүй үлдсэн.`}
              </p>
            )}
          </li>
        );
      })}
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
  // Labels follow the numbers on screen: while another period loads, the old snapshot stays
  // (dimmed) under its own period, never under the newly selected one.
  const shownDays = snapshot?.periodDays ?? periodDays;
  const switching = loading && Boolean(snapshot) && shownDays !== periodDays;
  const periodLabel = shownDays === 7 ? "Сүүлийн 7 хоног" : "Сүүлийн 30 хоног";
  const silenceTotal = overview ? overview.silenceReasons.reduce((sum, reason) => sum + reason.count, 0) : 0;

  return (
    <div className="space-y-5" aria-busy={loading}>
      <TabHeader
        title="Тойм"
        description="Хэдэн хүн бичиж, бот хэрхэн хариулсан, юуг сонирхож байгаа нь."
        actions={
          <>
            <Segmented label="Хугацаа" value={periodDays}
              onChange={(days) => { setPeriodDays(days); setFaqPeriod(days === 7 ? "week" : "month"); }}
              options={[{ value: 7, label: "7 хоног" }, { value: 30, label: "30 хоног" }]} />
            <Button variant="secondary" size="sm" loading={loading} onClick={() => setRefresh((value) => value + 1)}>
              {!loading && <Icons.refresh size={15} />} Шинэчлэх
            </Button>
          </>
        }
      />

      {error && <Alert tone="danger">{error}{snapshot && " Доор хамгийн сүүлд ачаалсан мэдээллийг харуулж байна."}</Alert>}
      {Boolean(snapshot?.warnings?.length) && <Alert tone="warning">Тоймын зарим хэсгийг ачаалж чадсангүй. Шинэчилнэ үү.</Alert>}
      {overview && overview.aiOutages24h > 0 && (
        <Alert tone="danger">
          Сүүлийн 24 цагт AI үйлчилгээ {number(overview.aiOutages24h)} удаа тасарч, бот хариулж чадаагүй
          {overview.lastAiOutageAt ? ` (сүүлд ${snapshotTime(overview.lastAiOutageAt)})` : ""}. OpenAI-ийн төлбөр, кредитийг шалгана уу.
        </Alert>
      )}

      {!snapshot && loading && (
        <div role="status" aria-label="Тойм ачаалж байна" className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{Array.from({ length: 4 }, (_, index) => <Skeleton key={index} className="h-32 rounded-xl" />)}</div>
          <Skeleton className="h-64 rounded-xl" />
        </div>
      )}

      {snapshot && (
        <div className={cx("space-y-5 transition-opacity", switching && "pointer-events-none opacity-50")}>
          {overview ? (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Kpi label="Бичсэн хүн" value={overview.customers} change={change}
                detail={`${periodLabel} · өмнөх ${shownDays} хоногт ${number(overview.previousCustomers)}`} />
              <Kpi label="Бот хариулсан" value={overview.answeredCustomers}
                detail={answeredShare == null ? "Энэ хугацаанд бичсэн хүн алга" : `Бичсэн хүмүүсийн ${answeredShare}% нь хариу авсан`} />
              <Kpi label="Зөвлөхөд үлдсэн" value={overview.handedOff}
                detail="Бот хариулаагүй, зөвлөх Messenger-ээс хариулна" />
              <Kpi label="Утсаа үлдээсэн" value={overview.phoneLeads}
                detail={`Захиалгын хүсэлт ${number(overview.bookingRequests)}`} />
            </div>
          ) : <EmptyNote>Энэ хугацааны тоог ачаалж чадсангүй. Шинэчилнэ үү.</EmptyNote>}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Card className="flex min-w-0 flex-col p-4 sm:p-5">
              <SectionTitle title="Өдөр бүр бичсэн хүн" hint={`${periodLabel} · Улаанбаатарын цагаар · баганан дээр очиж дэлгэрэнгүйг харна`} />
              {!overview ? <EmptyNote>Өдрийн мэдээлэл ачаалагдсангүй.</EmptyNote>
                : overview.customers === 0 ? <EmptyNote>Энэ хугацаанд хэн ч бичээгүй байна.</EmptyNote>
                  : <DailyChart days={overview.daily} />}
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <SectionTitle title="Бот яагаад хариулаагүй вэ" hint="Зөвлөхөд үлдсэн яриа, шалтгаанаар" />
              {overview ? <SilenceReasons reasons={overview.silenceReasons} total={silenceTotal} /> : <EmptyNote>Мэдээлэл ачаалагдсангүй.</EmptyNote>}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 p-4 sm:p-5">
              <SectionTitle title="Хариулж чадаагүй асуултууд"
                hint="Хамгийн сүүлийнх нь эхэндээ. Хариуг нь аяллын мэдээлэлд нэмбэл бот дараагийн удаа өөрөө хариулна." />
              {overview ? <Unanswered items={overview.unanswered} /> : <EmptyNote>Мэдээлэл ачаалагдсангүй.</EmptyNote>}
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <SectionTitle title="Бот юуг хариулж чадах вэ" hint="Сэдэв тус бүрээр мэдээлэлтэй идэвхтэй аялал. Бот зөвхөн аяллын мэдээллээс хариулна."
                action={<Button variant="ghost" size="sm" onClick={() => onNavigate("trips")}>Аяллууд <Icons.chevronRight size={14} /></Button>} />
              {overview ? <Coverage coverage={overview.coverage} activeTrips={overview.activeTrips} /> : <EmptyNote>Мэдээлэл ачаалагдсангүй.</EmptyNote>}
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card className="min-w-0 p-4 sm:p-5">
              <SectionTitle title="Хамгийн их үзсэн аяллууд" hint={`${periodLabel} · аяллын карт, үнэ эсвэл зургаар нь тодорхой асуусан хүн`} />
              {!overview ? <EmptyNote>Аяллын мэдээлэл ачаалагдсангүй.</EmptyNote>
                : overview.tripDemand.length === 0 ? <EmptyNote>Энэ хугацаанд тодорхой аялал асуусан хүн алга.</EmptyNote> : (
                  <ol className="space-y-3">
                    {overview.tripDemand.map((trip) => (
                      <BarRow key={trip.trip} label={trip.trip} title={trip.trip} value={trip.customers} suffix="хүн"
                        max={Math.max(...overview.tripDemand.map((item) => item.customers))} />
                    ))}
                  </ol>
                )}
            </Card>

            <Card className="min-w-0 p-4 sm:p-5">
              <SectionTitle title="Хүмүүсийн бичсэн зүйл" hint="Товч дарсан, мэндэлсэн мессежийг оруулаагүй"
                action={<Segmented label="Асуултын хугацаа" value={faqPeriod} onChange={setFaqPeriod}
                  options={[{ value: "week", label: "7 хоног" }, { value: "month", label: "30 хоног" }, { value: "allTime", label: "Нийт" }]} />} />
              {!faq ? <EmptyNote>Асуултын мэдээлэл ачаалагдсангүй.</EmptyNote> : questions.length === 0 ? <EmptyNote>Энэ хугацаанд асуулт бүртгэгдээгүй байна.</EmptyNote> : (
                <ol className="divide-y divide-line">
                  {questions.map((question, index) => (
                    <li key={`${index}-${question.question}`} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
                      <span className="mt-0.5 w-4 shrink-0 text-xs tabular-nums text-ink-subtle">{index + 1}</span>
                      <p className="min-w-0 flex-1 wrap-break-word text-sm leading-6 text-ink">{question.question}</p>
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
                        : `Сүүлийн 24 цагт ${number(attention.errors24h)} техникийн алдаа бүртгэгдсэн`}
                  </p>
                  {attention && attention.recentIssues.length > 0 && (
                    <p className="mt-0.5 truncate text-xs text-ink-muted">
                      {[...new Set(attention.recentIssues.map((issue) => ADMIN_ISSUE_LABELS[issue.event] ?? "Техникийн алдаа"))].slice(0, 3).join(" · ")}
                    </p>
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
        </div>
      )}
    </div>
  );
}
