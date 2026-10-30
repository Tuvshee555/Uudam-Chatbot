import { useMemo, useState, useSyncExternalStore } from "react";
import { Badge, Button, Card, EmptyState, IconButton, Icons, Input, Select, Skeleton, Spinner, Textarea, cx } from "@/components/ui";
import { StatCard, TabHeader } from "./AdminShared";
import type { LeadCrmStatus, LeadStats, TravelLead } from "@/lib/adminTypes";
import { formatTime } from "@/lib/adminUtils";
import { ATTENTION_DAYS, TIER_LABELS, compareLeadsByAttention, leadAttention, type LeadAttention } from "@/lib/leadAttention";

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

export function LeadsDashboard({ stats }: { stats: LeadStats }) {
  const platformLabel = (p: string) =>
    p === "instagram" ? "Instagram" : p === "facebook" ? "Facebook" : p;

  // Build a continuous 7-day series (fill gaps with 0) for the mini bar chart.
  const days: Array<{ day: string; count: number; label: string }> = [];
  const byDay = new Map(stats.daily.map((d) => [d.day, d.count]));
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push({
      day: key,
      count: byDay.get(key) ?? 0,
      label: `${d.getMonth() + 1}/${d.getDate()}`,
    });
  }
  const maxCount = Math.max(1, ...days.map((d) => d.count));

  const cards = [
    { label: "Шинэ хүсэлт", value: stats.new_count, tone: "text-danger" },
    { label: "Өнөөдөр", value: stats.today, tone: "text-brand" },
    { label: "7 хоногт", value: stats.last7days, tone: "text-ink" },
    { label: "Нийт", value: stats.total, tone: "text-ink" },
  ];

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {cards.map((c) => (
          <StatCard key={c.label} label={c.label} value={c.value} tone={c.tone} />
        ))}
      </div>

      <Card className="p-3.5">
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
        <Card className="p-3.5">
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
  stats,
  loading,
  onRefresh,
  onMarkSeen,
  onUpdateStatus,
  onAssign,
  broadcastMessage,
  broadcastSending,
  broadcastResult,
  onBroadcastChange,
  onBroadcastSend,
}: {
  leads: TravelLead[];
  stats: LeadStats | null;
  loading: boolean;
  onRefresh: () => void;
  onMarkSeen: (lead: TravelLead) => void;
  onUpdateStatus: (lead: TravelLead, status: LeadCrmStatus) => void;
  onAssign: (lead: TravelLead, assignee: string) => void;
  broadcastMessage: string;
  broadcastSending: boolean;
  broadcastResult: { sent: number; failed: number } | null;
  onBroadcastChange: (msg: string) => void;
  onBroadcastSend: () => void;
}) {
  const [search, setSearch] = useState("");
  // Opens on what needs a person: the customer waiting on an answer first (leadAttention.ts).
  const [view, setView] = useState<"attention" | "all" | "unread" | "booking" | "human">("attention");
  const [status, setStatus] = useState<LeadCrmStatus | "all">("all");
  const attentionById = useMemo(() => new Map(leads.map((lead) => [lead.id, leadAttention(lead)])), [leads]);
  const filteredLeads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("mn-MN");
    return leads.filter((lead) => {
      if (view === "attention" && !attentionById.get(lead.id)?.needsAttention) return false;
      if (view === "unread" && lead.status !== "new") return false;
      if (view === "booking" && lead.kind !== "booking") return false;
      if (view === "human" && lead.kind === "booking") return false;
      if (status !== "all" && (lead.lead_status ?? "new_lead") !== status) return false;
      return !query || [lead.customer_message, lead.contact_phone, lead.sender_id]
        .some((value) => value?.toLocaleLowerCase("mn-MN").includes(query));
    }).sort((a, b) => compareLeadsByAttention(attentionById.get(a.id)!, attentionById.get(b.id)!));
  }, [attentionById, leads, search, status, view]);
  const views = [
    { value: "attention", label: "Анхаарах", count: leads.filter((lead) => attentionById.get(lead.id)?.needsAttention).length },
    { value: "all", label: "Бүгд", count: leads.length },
    { value: "unread", label: "Үзээгүй", count: leads.filter((lead) => lead.status === "new").length },
    { value: "booking", label: "Захиалга", count: leads.filter((lead) => lead.kind === "booking").length },
    { value: "human", label: "Зөвлөхтэй ярих", count: leads.filter((lead) => lead.kind !== "booking").length },
  ] as const;
  const hasFilters = Boolean(search.trim()) || status !== "all" || (view !== "all" && view !== "attention");

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

      {stats && <LeadsDashboard stats={stats} />}

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold text-ink">Харилцагчийн хүсэлтүүд</h2>
            <p className="mt-1 text-sm text-ink-muted">Зурвасыг уншаад, холбогдсон эсэхийг тэмдэглээрэй.</p>
          </div>
          <p className="shrink-0 text-sm tabular-nums text-ink-muted" role="status">
            {filteredLeads.length} / {leads.length} хүсэлт
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
            label="Хүсэлт хайх"
            type="search"
            placeholder="Зурвас, утас эсвэл хэрэглэгчийн дугаар"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select label="Холбогдсон төлөв" value={status} onChange={(event) => setStatus(event.target.value as LeadCrmStatus | "all")}>
            <option value="all">Бүх төлөв</option>
            {(Object.entries(CRM_STATUS_LABELS) as [LeadCrmStatus, string][]).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
      </Card>

      {loading && leads.length === 0 ? (
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
              <Button variant="secondary" onClick={() => { setSearch(""); setStatus("all"); setView("all"); }}>Шүүлтүүр арилгах</Button>
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-3" aria-busy={loading}>
          {filteredLeads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              attention={attentionById.get(lead.id)!}
              onMarkSeen={() => onMarkSeen(lead)}
              onUpdateStatus={(status) => onUpdateStatus(lead, status)}
              onAssign={(assignee) => onAssign(lead, assignee)}
            />
          ))}
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

// Whether staff were pinged for the lead (Telegram), as recorded by staffAlerts.ts.
const NOTIFY_BADGES: Record<string, { tone: "success" | "danger" | "warning"; label: string }> = {
  sent: { tone: "success", label: "Ажилтанд мэдэгдсэн" },
  failed: { tone: "danger", label: "Мэдэгдэл очоогүй" },
  no_channel: { tone: "warning", label: "Мэдэгдэх суваг алга" },
};

function LeadCard({
  lead,
  attention,
  onMarkSeen,
  onUpdateStatus,
  onAssign,
}: {
  lead: TravelLead;
  attention: LeadAttention;
  onMarkSeen: () => void;
  onUpdateStatus: (status: LeadCrmStatus) => void;
  onAssign: (assignee: string) => void;
}) {
  const [assignee, setAssignee] = useState(lead.assigned_to ?? "");
  const notifyBadge = NOTIFY_BADGES[lead.notify_status ?? ""];
  const isNew = lead.status === "new";
  const isBooking = lead.kind === "booking";
  const channel = lead.platform === "instagram" ? "Instagram" : "Facebook";
  const crmStatus: LeadCrmStatus = lead.lead_status ?? "new_lead";
  const waiting = attention.needsAttention && attention.tier === "waiting";

  return (
    <Card
      className={cx(
        "p-4 sm:p-5",
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
          {notifyBadge && <Badge tone={notifyBadge.tone}>{notifyBadge.label}</Badge>}
          {lead.assigned_to && <Badge tone="success">Хариуцагч: {lead.assigned_to}</Badge>}
        </div>
        {/* CRM status badge */}
        <Badge tone={CRM_STATUS_TONES[crmStatus]}>
          {CRM_STATUS_LABELS[crmStatus]}
        </Badge>
      </div>

      {attention.latestNote && (
        <p className={cx("mt-4 whitespace-pre-wrap break-words rounded-xl border px-4 py-3 text-sm font-medium leading-relaxed [overflow-wrap:anywhere]",
          waiting ? "border-danger bg-danger-soft text-ink" : "border-line bg-surface text-ink")}>
          Сүүлийн мессеж: {attention.latestNote}
        </p>
      )}

      <p className="mt-4 whitespace-pre-wrap break-words rounded-xl bg-surface-sunken px-4 py-3 text-sm leading-relaxed text-ink [overflow-wrap:anywhere]">
        {lead.customer_message || "Текст зурвас үлдээгээгүй байна."}
      </p>

      {lead.contact_phone && (
        <p className="mt-3 text-sm font-medium text-ink">
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

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
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
