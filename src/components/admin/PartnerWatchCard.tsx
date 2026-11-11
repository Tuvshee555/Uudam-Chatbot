import { useEffect, useState } from "react";
import { Badge, Button, Card, Icons, cx } from "@/components/ui";
import type { WatchOverview, WatchOverviewTrip } from "@/lib/partnerWatch/store";

/**
 * «Тойм» card for the partner watch (src/lib/partnerWatch): trips made from a partner's page whose
 * page now says something else. Seat states were already applied (listed as such); every other
 * change waits for the admin, each with a button that opens the AI туслах with the instruction
 * written out, which he reviews and sends himself.
 */

const MAX_TRIPS = 6;
const MAX_LINES = 5;

function checkedTime(value: string | null) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat("mn-MN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Ulaanbaatar" }).format(date)
    : "—";
}

function TripChanges({ trip, onAskAssistant }: { trip: WatchOverviewTrip; onAskAssistant?: (instruction: string) => void }) {
  const [open, setOpen] = useState(false);
  const lines = open ? trip.pending : trip.pending.slice(0, MAX_LINES);
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 text-sm font-semibold text-ink">{trip.route_name}</p>
        <span className="text-[11px] tabular-nums text-ink-subtle">шалгасан {checkedTime(trip.checked_at)}</span>
      </div>
      {!trip.ok && (
        <p className="mt-1 text-xs leading-5 text-warning">Хуудсыг уншиж чадсангүй: {trip.error || "тодорхойгүй алдаа"}</p>
      )}
      {lines.length > 0 && (
        <ul className="mt-1.5 space-y-1.5">
          {lines.map((item, index) => (
            <li key={`${item.kind}-${item.date}-${index}`} className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 text-sm leading-6 text-ink">
                <span className="wrap-break-word">{item.text}</span>
                {item.reason && <span className="block text-xs leading-5 text-ink-muted">{item.reason}</span>}
              </div>
              {item.instruction && onAskAssistant && (
                <Button variant="secondary" size="sm" className="shrink-0 self-start" onClick={() => onAskAssistant(item.instruction)}>
                  <Icons.ai size={14} /> AI туслахаар засах
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {trip.pending.length > MAX_LINES && (
        <button type="button" onClick={() => setOpen((value) => !value)} className="mt-1.5 text-xs font-semibold text-brand hover:underline">
          {open ? "Хураах" : `Бусад ${trip.pending.length - MAX_LINES} өөрчлөлт`}
        </button>
      )}
    </li>
  );
}

export function PartnerWatchCard({ apiFetch, onAskAssistant, refresh = 0 }: {
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
  onAskAssistant?: (instruction: string) => void;
  refresh?: number;
}) {
  const [watch, setWatch] = useState<WatchOverview | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void apiFetch("/api/admin/partner-watch", { signal: controller.signal })
      .then(async (response) => {
        const json = await response.json().catch(() => null) as { ok?: boolean; watch?: WatchOverview } | null;
        if (!response.ok || !json?.watch) throw new Error("partner_watch_unavailable");
        setFailed(false);
        setWatch(json.watch);
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [apiFetch, refresh]);

  // Nothing is watched yet (no trip was made from a partner's page): the card stays away.
  if (failed || !watch || (watch.watched === 0 && watch.applied.length === 0)) return null;
  const changed = watch.trips.filter((trip) => trip.pending.length > 0 || !trip.ok);
  const shown = changed.slice(0, MAX_TRIPS);
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{changed.length ? "Хамтрагчийн хуудас өөрчлөгдсөн" : "Хамтрагчийн хуудас"}</h3>
          <p className="mt-1 text-xs leading-5 text-ink-muted">
            Хамтрагчийн хуудаснаас нэмсэн {watch.watched} аяллыг 6 цаг тутам тулгана. Суудлын төлөв автоматаар шинэчлэгдэнэ; үнэ, огноог та шийднэ.
          </p>
        </div>
        <Badge tone={changed.length ? "warning" : "success"} dot>
          {changed.length ? `${changed.length} аялал` : "Таарч байна"}
        </Badge>
      </div>

      {shown.length > 0 ? (
        <ul className="divide-y divide-line">
          {shown.map((trip) => <TripChanges key={trip.trip_id} trip={trip} onAskAssistant={onAskAssistant} />)}
        </ul>
      ) : (
        <p className="flex items-center gap-2 rounded-lg bg-surface-sunken/60 px-3 py-2.5 text-sm text-ink-muted">
          <Icons.check size={15} className="text-success" /> Бүх хуудас манайхтай таарч байна · сүүлд {checkedTime(watch.last_checked_at)}
        </p>
      )}
      {changed.length > MAX_TRIPS && <p className="mt-2 text-xs text-ink-muted">Дахиад {changed.length - MAX_TRIPS} аялалд өөрчлөлт бий.</p>}

      {watch.applied.length > 0 && (
        <div className={cx("mt-4 border-t border-line pt-3")}>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-ink-muted">Автоматаар шинэчилсэн (7 хоног)</p>
          <ul className="space-y-1">
            {watch.applied.slice(0, 8).map((entry) => (
              <li key={`${entry.trip_id}-${entry.checked_at}`} className="text-sm leading-6 text-ink">
                <span className="font-medium">{entry.route_name}</span>
                <span className="text-ink-muted"> · {entry.lines.join("; ")} · {checkedTime(entry.checked_at)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
