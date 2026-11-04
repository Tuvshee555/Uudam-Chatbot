import { useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Card, EmptyState, IconButton, Icons, Input, Select, Skeleton, Spinner, Textarea, cx } from "@/components/ui";
import { StatCard, TabHeader } from "./AdminShared";
import type { LeadCrmStatus, LeadStats, TravelLead } from "@/lib/adminTypes";
import { formatTime } from "@/lib/adminUtils";
import { ATTENTION_DAYS, TIER_LABELS, compareLeadsByAttention, leadAttention, type LeadAttention, type LeadAttentionSummary } from "@/lib/leadAttention";

/** Browser notifications for this dashboard: only ever shown while it is open in a browser. */
function NotificationToggle() {
  const [asked, setAsked] = useState<NotificationPermission | null>(null);
  const current = useSyncExternalStore(() => () => {},
    () => (typeof Notification === "undefined" ? "unsupported" : Notification.permission), () => "unsupported" as const);
  const permission = asked ?? current;
  const setPermission = setAsked;
  if (permission === "unsupported") return null;
  if (permission === "granted") return <Badge tone="success">Мэдэгдэл асаалттай</Badge>;
  if (permission === "denied") return <Badge tone="neutral">Мэдэгдэл хаалттай (хөтчийн тохиргоо)</Badge>;
  return (
    <Button size="sm" variant="secondary" onClick={() => void Notification.requestPermission().then(setPermission)}>
      Мэдэгдэл асаах
    </Button>
  );
}

/** Ulaanbaatar calendar date (YYYY-MM-DD), the day staff and the stats query count by. */
function ulaanbaatarDay(date: Date): string {
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Ulaanbaatar" });
}

export function LeadsDashboard({ stats, attention }: { stats: LeadStats; attention?: LeadAttentionSummary | null }) {
  const platformLabel = (p: string) =>
    p === "instagram" ? "Instagram" : p === "facebook" ? "Facebook" : p;

  // Build a continuous 7-day series (fill gaps with 0) for the mini bar chart.
  const days: Array<{ day: string; count: number; label: string }> = [];
  const byDay = new Map(stats.daily.map((d) => [d.day, d.count]));
  const today = new Date();
  for (let i = 6; i >= 0; i -= 1) {
    const key = ulaanbaatarDay(new Date(today.getTime() - i * 86_400_000));
    const [, month, day] = key.split("-");
    days.push({
      day: key,
      count: byDay.get(key) ?? 0,
      label: `${Number(month)}/${Number(day)}`,
    });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  // The same "needs a person now" number as the nav badge, not every unread lead ever.
  const cards = [
    attention
      ? { label: "Анхаарах", value: attention.needsAttention, tone: attention.waiting > 0 ? "text-danger" : "text-ink",
        description: attention.waiting > 0 ? `${attention.waiting} нь хариу хүлээж байна` : "Сүүлийн хоногуудын үзээгүй хүсэлт" }
      : { label: "Үзээгүй", value: stats.new_count, tone: "text-ink", description: "Бүх цаг үеийн" },
    { label: "Өнөөдөр", value: stats.today, tone: "text-brand", description: "Улаанбаатарын цагаар" },
    { label: "7 хоногт", value: stats.last7days, tone: "text-ink", description: undefined },
    { label: "Нийт", value: stats.total, tone: "text-ink", description: undefined },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {cards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} description={c.description} />
        ))}
      </div>

      {/* Phones go straight from the numbers to the list; the chart and channels are for desktop. */}
      <Card className="hidden p-3.5 sm:block">
        <p className="mb-3 text-sm font-medium text-ink">
          Сүүлийн 7 хоногийн хүсэлт
        </p>
        <div className="flex h-28 items-end justify-between gap-1.5">
          {days.map((d, index) => (
            <div
              key={d.day}
              className="group flex flex-1 flex-col items-center gap-1"
              title={`${d.label}: ${d.count}`}
              role="img"
              aria-label={`${d.label}: ${d.count} хүсэлт`}
            >
              <span className="text-xs font-medium tabular-nums text-ink-muted">
                {d.count > 0 ? d.count : ""}
              </span>
              <div
                className={cx(
                  "w-full rounded-t-md bg-gradient-to-t transition-all duration-300 group-hover:from-brand group-hover:to-brand-hover",
                  index === days.length - 1
                    ? "from-brand to-brand-hover"
                    : "from-brand/40 to-brand/55",
                )}
                style={{
                  height: `${Math.max(4, (d.count / maxCount) * 80)}px`,
                }}
              />
              <span
                className={cx(
                  "text-[10px] tabular-nums",
                  index === days.length - 1
                    ? "font-semibold text-brand"
                    : "text-ink-muted",
                )}
              >
                {d.label}
              </span>
            </div>
          ))}
        </div>
      </Card>

      {stats.by_platform.length > 0 && (
        <Card className="hidden p-3.5 sm:block">
          <p className="mb-2 text-sm font-medium text-ink">Сувгаар</p>
          <div className="flex flex-wrap gap-2">
            {stats.by_platform.map((p) => (
              <span
                key={p.platform}
                className="rounded-md border border-line bg-surface-sunken px-2.5 py-1 text-xs text-ink"
              >
                {platformLabel(p.platform)}:{" "}
                <span className="font-semibold tabular-nums">{p.count}</span>
              </span>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

export function LeadsTab({
  leads,
  total,
  loaded,
  stats,
  attention,
  loading,
  query,
  onQueryChange,
  onLoadMore,
  onRefresh,
  onMarkSeen,
  onUpdateStatus,
  onAssign,
  onSetBotPaused,
  broadcastMessage,
  broadcastSending,
  broadcastResult,
  onBroadcastChange,
  onBroadcastSend,
}: {
  leads: TravelLead[];
  /** Leads on the server matching the search (all leads without one); `leads` is what is loaded. */
  total: number;
  /** False until the first page arrives, so "0" is never shown for "not loaded yet". */
  loaded: boolean;
  stats: LeadStats | null;
  /** The nav badge's summary, so the headline number matches it. */
  attention?: LeadAttentionSummary | null;
  loading: boolean;
  /** Server-side search over every lead (message, phone, sender, assignee, history). */
  query: string;
  onQueryChange: (value: string) => void;
  onLoadMore: () => void;
  onRefresh: () => void;
  onMarkSeen: (lead: TravelLead) => void;
  onUpdateStatus: (lead: TravelLead, status: LeadCrmStatus) => void;
  onAssign: (lead: TravelLead, assignee: string) => void;
  onSetBotPaused: (lead: TravelLead, paused: boolean) => void;
  broadcastMessage: string;
  broadcastSending: boolean;
  broadcastResult: { sent: number; failed: number } | null;
  onBroadcastChange: (msg: string) => void;
  onBroadcastSend: () => void;
}) {
  // Opens on what needs a person: the customer waiting on an answer first (leadAttention.ts).
  const [view, setView] = useState<"attention" | "all" | "unread" | "booking" | "human">("attention");
  const [status, setStatus] = useState<LeadCrmStatus | "all">("all");
  const searching = Boolean(query.trim());
  const attentionById = useMemo(() => new Map(leads.map((lead) => [lead.id, leadAttention(lead)])), [leads]);
  // Text search runs on the server over every lead; these chips narrow what is loaded.
  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      if (view === "attention" && !attentionById.get(lead.id)?.needsAttention) return false;
      if (view === "unread" && lead.status !== "new") return false;
      if (view === "booking" && lead.kind !== "booking") return false;
      if (view === "human" && lead.kind === "booking") return false;
      return status === "all" || (lead.lead_status ?? "new_lead") === status;
    }).sort((a, b) => compareLeadsByAttention(attentionById.get(a.id)!, attentionById.get(b.id)!));
  }, [attentionById, leads, status, view]);
  const remaining = Math.max(0, total - leads.length);
  const views = [
    { value: "attention", label: "Анхаарах", count: leads.filter((lead) => attentionById.get(lead.id)?.needsAttention).length },
    { value: "all", label: "Бүгд", count: leads.length },
    { value: "unread", label: "Үзээгүй", count: leads.filter((lead) => lead.status === "new").length },
    { value: "booking", label: "Захиалга", count: leads.filter((lead) => lead.kind === "booking").length },
    { value: "human", label: "Зөвлөхтэй ярих", count: leads.filter((lead) => lead.kind !== "booking").length },
  ] as const;
  const hasFilters = searching || status !== "all" || (view !== "all" && view !== "attention");

  return (
    <div className="space-y-5">
      <TabHeader
        icon={<Icons.user size={20} />}
        title="Хүсэлтүүд"
        description="Хүнтэй ярих хүсэлт болон захиалгын сонирхол гаргасан хэрэглэгчид."
        actions={
          <>
            <NotificationToggle />
            <IconButton label="Хүсэлтүүдийг шинэчлэх" onClick={onRefresh} disabled={loading}>
              {loading ? <Spinner /> : <Icons.refresh size={17} />}
            </IconButton>
          </>
        }
      />

      {stats && !searching && <LeadsDashboard stats={stats} attention={attention} />}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold text-ink">Харилцагчийн хүсэлтүүд</h2>
            <p className="mt-1 text-sm text-ink-muted">Зурвасыг уншаад, холбогдсон эсэхийг тэмдэглээрэй.</p>
          </div>
          <p className="shrink-0 text-sm tabular-nums text-ink-muted" role="status">
            {!loaded ? "Ачаалж байна…" : `${filteredLeads.length} харагдаж байна · ${leads.length < total ? `${leads.length} / ${total} ачааллаа` : `${total} ${searching ? "олдсон" : "нийт"}`}`}
          </p>
        </div>
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Хүсэлтийн төрөл">
          {views.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={view === item.value}
              onClick={() => setView(item.value)}
              className={cx(
                "inline-flex min-h-10 items-center gap-2 rounded-full border px-3.5 py-2 text-sm font-medium transition-colors",
                view === item.value
                  ? "border-brand-border bg-brand-soft text-brand"
                  : "border-line bg-surface text-ink-muted hover:border-brand-border hover:text-ink",
              )}
            >
              {item.label}
              <span className="tabular-nums">{item.count}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(11rem,14rem)]">
          <Input
            label="Хүсэлт хайх (бүх хүсэлтээс)"
            type="search"
            placeholder="Зурвас, утас, хариуцагч эсвэл хэрэглэгчийн дугаар"
            value={query}
            onChange={(event) => {
              const next = event.target.value;
              onQueryChange(next);
              // An old request is not "needing attention": a search shows every match.
              if (next.trim() && view === "attention") setView("all");
            }}
          />
          <Select label="Холбогдсон төлөв" value={status} onChange={(event) => setStatus(event.target.value as LeadCrmStatus | "all")}>
            <option value="all">Бүх төлөв</option>
            {(Object.entries(CRM_STATUS_LABELS) as [LeadCrmStatus, string][]).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
      </Card>

      {!loaded || (loading && leads.length === 0) ? (
        <div className="space-y-3" role="status" aria-label="Хүсэлтүүдийг ачаалж байна">
          {[0, 1, 2].map((item) => (
            <Card key={item} className="space-y-4 p-5">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-9 w-48" />
            </Card>
          ))}
          <span className="sr-only">Хүсэлтүүдийг ачаалж байна…</span>
        </div>
      ) : filteredLeads.length === 0 ? (
        <Card className="p-5">
          <EmptyState
            icon={hasFilters ? <Icons.search size={26} /> : <Icons.user size={26} />}
            title={hasFilters ? "Тохирох хүсэлт олдсонгүй" : view === "attention" ? "Анхаарах хүсэлт алга" : "Одоогоор хүсэлт алга"}
            description={hasFilters ? "Өөр үгээр хайх эсвэл шүүлтүүрээ арилгаарай."
              : view === "attention" ? `Сүүлийн ${ATTENTION_DAYS} хоногт үзээгүй хүсэлт алга. Бусдыг «Бүгд» хэсгээс харна уу.`
                : "Хэрэглэгч зөвлөхтэй ярих эсвэл захиалга хийх сонирхол гаргавал энд харагдана."}
          />
          {hasFilters && (
            <div className="flex justify-center pb-4">
              <Button variant="secondary" onClick={() => { onQueryChange(""); setStatus("all"); setView("all"); }}>Шүүлтүүр арилгах</Button>
            </div>
          )}
          {remaining > 0 && (
            <div className="flex justify-center pb-4">
              <Button variant="secondary" loading={loading} onClick={onLoadMore}>Өмнөх хүсэлтүүдээс хайх ({remaining})</Button>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-2.5" aria-busy={loading}>
          {filteredLeads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              attention={attentionById.get(lead.id)!}
              onMarkSeen={() => onMarkSeen(lead)}
              onUpdateStatus={(status) => onUpdateStatus(lead, status)}
              onAssign={(assignee) => onAssign(lead, assignee)}
              onSetBotPaused={(paused) => onSetBotPaused(lead, paused)}
            />
          ))}
          {remaining > 0 && (
            <div className="flex flex-col items-center gap-1.5 py-2">
              <Button variant="secondary" loading={loading} disabled={loading} onClick={onLoadMore}>
                Цааш ачаалах ({remaining} үлдсэн)
              </Button>
              <p className="text-xs text-ink-muted">Шүүлтүүр зөвхөн ачаалсан хүсэлтүүдэд үйлчилнэ. Хайлт бүх хүсэлтээс хайна.</p>
            </div>
          )}
        </div>
      )}

      <details className="group rounded-xl border border-line bg-surface shadow-sm">
        <summary className="flex min-h-16 cursor-pointer list-none items-center justify-between gap-3 p-4 sm:px-5 [&::-webkit-details-marker]:hidden">
          <span>
            <span className="block font-semibold text-ink">Нийт хэрэглэгчид мессеж илгээх</span>
            <span className="mt-1 block text-sm text-ink-muted">Facebook Messenger-ийн хэрэглэгчдэд илгээнэ.</span>
          </span>
          <Icons.chevronRight className="shrink-0 text-ink-muted transition-transform group-open:rotate-90" />
        </summary>
        <div className="space-y-3 border-t border-line p-4 sm:p-5">
          <p className="text-sm text-ink-muted">Урьд нь бидэнтэй зурвас бичсэн бүх хэрэглэгчид ижил мессеж очно.</p>
          <Textarea
            label="Илгээх мессеж"
            rows={3}
            value={broadcastMessage}
            onChange={(event) => onBroadcastChange(event.target.value)}
            placeholder="Мэдэгдлээ энд бичээрэй…"
            disabled={broadcastSending}
          />
          {broadcastResult && (
            <p className="text-sm text-ink-muted" role="status">
              Сүүлийн илгээлтээр {broadcastResult.sent} мессеж амжилттай илгээгдсэн. {broadcastResult.failed > 0 ? `${broadcastResult.failed} хэрэглэгчид илгээж чадсангүй.` : ""}
            </p>
          )}
          <div className="flex justify-end">
            <Button disabled={!broadcastMessage.trim() || broadcastSending} loading={broadcastSending} onClick={onBroadcastSend}>
              <Icons.send size={15} />
              Мессеж илгээх
            </Button>
          </div>
        </div>
      </details>
    </div>
  );
}

const CRM_STATUS_LABELS: Record<LeadCrmStatus, string> = {
  new_lead: "Шинэ",
  contacted: "Холбогдсон",
  booked: "Захиалсан",
  no_answer: "Хариу өгөөгүй",
};

const CRM_STATUS_TONES: Record<LeadCrmStatus, "neutral" | "warning" | "success" | "danger"> = {
  new_lead: "neutral",
  contacted: "warning",
  booked: "success",
  no_answer: "danger",
};

// Who stopped the bot for this customer and when: a consultant's Messenger reply (phone app or
// Business Suite on a computer) or "Би хариулна" here.
const TAKEOVER_SOURCES: Record<string, string> = { staff_mobile: "утаснаас", staff_web: "компьютерээс" };

function takeoverLabel(lead: TravelLead): string {
  const at = lead.bot_paused_at ? formatTime(lead.bot_paused_at) : "";
  const who = lead.bot_pause_reason === "operator_reply"
    ? `Зөвлөх ${TAKEOVER_SOURCES[lead.bot_takeover_source ?? ""] ?? "Messenger-ээс"} хариулсан`
    : lead.bot_pause_reason === "manual" ? "«Би хариулна» дарсан" : "Зөвлөх хариулна";
  return `Бот зогссон — ${who}${at ? ` · ${at}` : ""}`;
}

function LeadCard({
  lead,
  attention,
  onMarkSeen,
  onUpdateStatus,
  onAssign,
  onSetBotPaused,
}: {
  lead: TravelLead;
  attention: LeadAttention;
  onMarkSeen: () => void;
  onUpdateStatus: (status: LeadCrmStatus) => void;
  onAssign: (assignee: string) => void;
  onSetBotPaused: (paused: boolean) => void;
}) {
  // The bot's own marker after a booking request does not stop it; a person's pause does.
  const humanOwned = Boolean(lead.bot_paused) && lead.bot_pause_reason !== "booked_customer";
  const [assignee, setAssignee] = useState(lead.assigned_to ?? "");
  const isNew = lead.status === "new";
  const isBooking = lead.kind === "booking";
  const channel = lead.platform === "instagram" ? "Instagram" : "Facebook";
  const crmStatus: LeadCrmStatus = lead.lead_status ?? "new_lead";
  const waiting = attention.needsAttention && attention.tier === "waiting";

  return (
    <Card
      className={cx(
        "p-3.5 sm:p-4",
        isNew && "border-brand-border",
        waiting && "border-danger",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {attention.needsAttention && (
            <Badge tone={waiting ? "danger" : "brand"} dot>{TIER_LABELS[attention.tier]}</Badge>
          )}
          {attention.tier === "staff" && <Badge tone="success">{TIER_LABELS.staff}</Badge>}
          <Badge tone={isBooking ? "success" : "warning"} dot>
            {isBooking ? "Захиалгын сонирхол" : "Зөвлөхтэй ярих хүсэлт"}
          </Badge>
          <span className="text-xs text-ink-muted">{channel}</span>
          {isNew && <Badge tone="brand">Үзээгүй</Badge>}
          {lead.assigned_to && <Badge tone="success">Хариуцагч: {lead.assigned_to}</Badge>}
          {humanOwned && <Badge tone="warning">{takeoverLabel(lead)}</Badge>}
        </div>
        {/* CRM status badge */}
        <Badge tone={CRM_STATUS_TONES[crmStatus]}>
          {CRM_STATUS_LABELS[crmStatus]}
        </Badge>
      </div>

      {attention.latestNote && (
        <p className={cx("mt-3 whitespace-pre-wrap break-words rounded-lg border px-3.5 py-2.5 text-sm font-medium leading-relaxed [overflow-wrap:anywhere]",
          waiting ? "border-danger bg-danger-soft text-ink" : "border-line bg-surface text-ink")}>
          Сүүлийн мессеж: {attention.latestNote}
        </p>
      )}

      <p className="mt-2.5 whitespace-pre-wrap break-words rounded-lg bg-surface-sunken px-3.5 py-2.5 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
        {lead.customer_message || "Текст зурвас үлдээгээгүй байна."}
      </p>

      {lead.contact_phone && (
        <p className="mt-2 text-sm font-medium text-ink">
          Холбогдох утас:{" "}
          <a href={`tel:${lead.contact_phone}`} className="inline-flex min-h-10 items-center rounded-md px-2 font-semibold text-brand underline decoration-brand/30 underline-offset-4 hover:decoration-brand">
            {lead.contact_phone}
          </a>
        </p>
      )}

      {lead.context && (
        <details className="mt-2">
          <summary className="cursor-pointer rounded-md py-2 text-sm font-medium text-ink-muted">
            Харилцааны түүх
          </summary>
          <p className="mt-1 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-line bg-canvas/60 px-4 py-3 text-sm leading-relaxed text-ink-muted [overflow-wrap:anywhere]">
            {lead.context}
          </p>
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
        <span className="text-xs leading-relaxed text-ink-muted">
          {formatTime(lead.created_at)}
          {attention.lastActivityAt > new Date(Date.parse(lead.created_at) + 60_000).toISOString() && ` · сүүлд ${formatTime(attention.lastActivityAt)}`}
          {" "}· Хэрэглэгч …{lead.sender_id.slice(-6)}
        </span>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <input
            value={assignee}
            onChange={(event) => setAssignee(event.target.value)}
            onBlur={() => { if (assignee.trim() !== (lead.assigned_to ?? "")) onAssign(assignee.trim()); }}
            placeholder="Хариуцагч"
            maxLength={80}
            aria-label="Хүсэлтийг хариуцах зөвлөх"
            className="min-h-10 w-full rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-brand sm:w-36"
          />
          {/* CRM status selector */}
          <select
            value={crmStatus}
            onChange={(e) => onUpdateStatus(e.target.value as LeadCrmStatus)}
            className="min-h-10 flex-1 rounded-md border border-line-strong bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-brand sm:flex-none"
            aria-label="Хүсэлтийн холбогдсон төлөв"
          >
            {(Object.entries(CRM_STATUS_LABELS) as [LeadCrmStatus, string][]).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={() => onSetBotPaused(!humanOwned)}
            title={humanOwned ? "Бот энэ хэрэглэгчид дахин хариулна" : "Бот энэ хэрэглэгчид хариулахаа зогсооно; та хариулна"}>
            {humanOwned ? "Ботод буцаах" : "Би хариулна"}
          </Button>
          {isNew && (
            <Button size="sm" variant="secondary" onClick={onMarkSeen}>
              <Icons.check size={15} />
              Үзсэн болгох
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ----------------------------------------------------------------
   Bot tab
   ---------------------------------------------------------------- */
