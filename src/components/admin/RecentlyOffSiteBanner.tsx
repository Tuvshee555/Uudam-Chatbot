/**
 * Trips that left the website in the last 7 days because they were left with NO departure date at
 * all (tripScheduleMaintenance archives them as "no_departure_dates"). Dates running out is normal
 * and not listed; a trip losing every date is not.
 *
 * Why (2026-11-14): a saved change emptied a live trip's dates; it was archived and left the
 * website, and nothing on any screen said so. The admin found out only by chance.
 */
import { Button, Icons } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

const WINDOW_MS = 7 * 24 * 3_600_000;

/** The archived trips that lost every date within the last 7 days, newest first. Pure. */
export function recentlyOffSite(trips: TravelTrip[], now = Date.now()): Array<{ trip: TravelTrip; at: number }> {
  return trips.flatMap((trip) => {
    const extra = (trip.extra || {}) as Record<string, unknown>;
    if (trip.status !== "archived" || extra.archived_reason !== "no_departure_dates") return [];
    const at = Date.parse(String(extra.archived_at || ""));
    return Number.isFinite(at) && now - at <= WINDOW_MS && at <= now + 60_000 ? [{ trip, at }] : [];
  }).sort((a, b) => b.at - a.at);
}

export function RecentlyOffSiteBanner({ trips, onEdit }: { trips: TravelTrip[]; onEdit: (trip: TravelTrip) => void }) {
  const items = recentlyOffSite(trips);
  if (!items.length) return null;
  return (
    <section role="alert" className="rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm leading-6 text-danger">
      <p className="flex items-start gap-2 font-semibold">
        <Icons.alert size={16} className="mt-1 shrink-0" />
        <span>Сүүлийн 7 хоногт гарах өдөргүй болж вэбсайтаас буусан {items.length} аялал</span>
      </p>
      <ul className="mt-1.5 space-y-1.5 pl-6 text-ink">
        {items.map(({ trip, at }) => (
          <li key={trip.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 font-medium">«{trip.route_name}»</span>
            <span className="text-xs text-ink-muted">{new Date(at).toLocaleDateString("mn-MN", { month: "2-digit", day: "2-digit" })}</span>
            <Button size="sm" variant="secondary" onClick={() => onEdit(trip)}>Огноо нэмэх</Button>
          </li>
        ))}
      </ul>
      <p className="mt-1.5 pl-6 text-xs text-ink-muted">Санаатай бол үл тоомсорлоно уу. Санамсаргүй бол огноо нэмэхэд дахин идэвхжинэ, эсвэл AI туслах дээрх саналыг «Буцаах»-аар буцаана.</p>
    </section>
  );
}
