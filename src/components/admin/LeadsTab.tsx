import { Badge, Button, Card, EmptyState, Icons, Spinner, cx } from "@/components/ui";
import { StatCard } from "./AdminShared";
import type { LeadCrmStatus, LeadStats, TravelLead } from "@/lib/adminTypes";
import { formatTime } from "@/lib/adminUtils";

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
                    : "text-ink-subtle",
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
  broadcastMessage: string;
  broadcastSending: boolean;
  broadcastResult: { sent: number; failed: number } | null;
  onBroadcastChange: (msg: string) => void;
  onBroadcastSend: () => void;
}) {
  return (
    <div className="space-y-3">
      <Card className="p-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-ink">Хэрэглэгчийн хүсэлтүүд</p>
            <p className="text-xs text-ink-subtle">
              Хүнтэй ярих хүсэлт болон захиалгын сонирхол гаргасан хэрэглэгчид.
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Шинэчлэх"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line-strong bg-surface text-ink-muted transition-colors hover:border-brand hover:text-brand"
          >
            {loading ? <Spinner /> : <Icons.refresh size={17} />}
          </button>
        </div>
      </Card>

      {/* Broadcast card */}
      <Card className="p-4">
        <p className="mb-1 font-semibold text-ink">Broadcast мессеж</p>
        <p className="mb-3 text-xs text-ink-subtle">
          Урьд нь бидэнтэй мессеж бичсэн бүх хэрэглэгчид нэг мессеж илгээх. Зөвхөн Facebook Messenger-т ажилладаг.
        </p>
        <textarea
          rows={3}
          value={broadcastMessage}
          onChange={(e) => onBroadcastChange(e.target.value)}
          placeholder="Шинэ аялалын мэдэгдэл, хямдрал, урилга..."
          className="w-full rounded-lg border border-line-strong bg-surface-sunken px-3 py-2 text-sm text-ink placeholder:text-ink-subtle focus:border-brand focus:outline-none"
          disabled={broadcastSending}
        />
        {broadcastResult && (
          <p className="mt-1.5 text-xs text-ink-muted">
            Сүүлийн илгээлт: {broadcastResult.sent} амжилттай, {broadcastResult.failed} алдаа
          </p>
        )}
        <div className="mt-2 flex justify-end">
          <Button
            size="sm"
            disabled={!broadcastMessage.trim() || broadcastSending}
            loading={broadcastSending}
            onClick={onBroadcastSend}
          >
            <Icons.play size={14} />
            Broadcast илгээх
          </Button>
        </div>
      </Card>

      {stats && <LeadsDashboard stats={stats} />}

      {leads.length === 0 ? (
        <Card className="p-4">
          <EmptyState
            icon={<Icons.alert size={26} />}
            title="Хүсэлт алга"
            description="Хэрэглэгч хүнтэй ярих эсвэл захиалга хийх сонирхол гаргавал энд харагдана."
          />
        </Card>
      ) : (
        <div className="space-y-2.5">
          {leads.map((lead) => (
            <LeadCard
              key={lead.id}
              lead={lead}
              onMarkSeen={() => onMarkSeen(lead)}
              onUpdateStatus={(status) => onUpdateStatus(lead, status)}
            />
          ))}
        </div>
      )}
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

function LeadCard({
  lead,
  onMarkSeen,
  onUpdateStatus,
}: {
  lead: TravelLead;
  onMarkSeen: () => void;
  onUpdateStatus: (status: LeadCrmStatus) => void;
}) {
  const isNew = lead.status === "new";
  const isBooking = lead.kind === "booking";
  const channel = lead.platform === "instagram" ? "Instagram" : "Facebook";
  const crmStatus: LeadCrmStatus = lead.lead_status ?? "new_lead";

  return (
    <Card
      className={cx(
        "card-lift p-3.5",
        isNew && "border-l-4 border-l-brand",
        !isNew && "opacity-75",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isBooking ? "success" : "warning"} dot>
            {isBooking ? "Захиалгын сонирхол" : "Хүн ярих хүсэлт"}
          </Badge>
          <span className="text-xs text-ink-subtle">{channel}</span>
          {isNew && <Badge tone="danger">Шинэ</Badge>}
        </div>
        {/* CRM status badge */}
        <Badge tone={CRM_STATUS_TONES[crmStatus]}>
          {CRM_STATUS_LABELS[crmStatus]}
        </Badge>
      </div>

      <p className="mt-2 whitespace-pre-wrap rounded-md border border-line bg-surface-sunken px-2.5 py-2 text-sm text-ink">
        {lead.customer_message || "(хоосон зурвас)"}
      </p>

      {lead.contact_phone && (
        <p className="mt-2 text-sm font-semibold text-ink">
          ☎ Утас:{" "}
          <a href={`tel:${lead.contact_phone}`} className="text-brand">
            {lead.contact_phone}
          </a>
        </p>
      )}

      {lead.context && (
        <details className="mt-2">
          <summary className="cursor-pointer text-xs font-medium text-ink-muted">
            Харилцааны түүх
          </summary>
          <p className="mt-1 whitespace-pre-wrap rounded-md border border-line bg-canvas/60 px-2.5 py-2 text-xs text-ink-muted">
            {lead.context}
          </p>
        </details>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-ink-subtle">
          {formatTime(lead.created_at)} · ID …{lead.sender_id.slice(-6)}
        </span>
        <div className="flex items-center gap-2">
          {/* CRM status selector */}
          <select
            value={crmStatus}
            onChange={(e) => onUpdateStatus(e.target.value as LeadCrmStatus)}
            className="rounded-md border border-line-strong bg-surface px-2 py-1.5 text-xs text-ink focus:border-brand focus:outline-none"
            aria-label="Статус"
          >
            {(Object.entries(CRM_STATUS_LABELS) as [LeadCrmStatus, string][]).map(([val, label]) => (
              <option key={val} value={val}>{label}</option>
            ))}
          </select>
          {isNew && (
            <Button size="sm" variant="secondary" onClick={onMarkSeen}>
              <Icons.check size={15} />
              Хариуцсан
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
