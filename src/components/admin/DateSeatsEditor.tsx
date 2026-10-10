import { useMemo, useState } from "react";
import { cx, useToast } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

type SeatState = "open" | "low" | "full";
type Row = { date: string; state: SeatState | "paused" };

const OPTIONS: Array<{ value: SeatState; label: string; on: string }> = [
  { value: "open", label: "Нээлттэй", on: "bg-brand-soft text-brand" },
  { value: "low", label: "Цөөн суудал", on: "bg-warning-soft text-warning" },
  { value: "full", label: "Дүүрсэн", on: "bg-danger-soft text-danger" },
];
const WEEKDAYS = ["Ням", "Даваа", "Мягмар", "Лхагва", "Пүрэв", "Баасан", "Бямба"];

function label(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return `${m}-р сарын ${d} · ${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}`;
}

/** The trip's upcoming dates and what each one currently is, from the live website rows. */
function rowsOf(trip: TravelTrip): Row[] {
  const today = new Date().toISOString().slice(0, 10);
  const raw = Array.isArray(trip.extra?.website_departure_availability) ? trip.extra.website_departure_availability : [];
  return raw.flatMap((entry): Row[] => {
    const row = entry as { date?: unknown; status?: unknown; seatsLeft?: unknown };
    if (typeof row.date !== "string" || row.date < today) return [];
    const status = String(row.status || "").toUpperCase();
    if (status === "CANCELLED" || status === "DEPARTED") return [];
    const state: Row["state"] = status === "ALMOST_FULL" ? "low"
      : status === "SOLD_OUT" || row.seatsLeft === 0 ? "full"
        : status === "PAUSED" ? "paused" : "open";
    return [{ date: row.date, state }];
  }).sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * "Цөөн суудал" is set on one date, not on the trip: the website and the bot
 * show it beside that date only. A click is saved immediately.
 */
export function DateSeatsEditor({
  trip,
  apiFetch,
}: {
  trip: TravelTrip;
  apiFetch: (url: string, init?: RequestInit) => Promise<Response>;
}) {
  const toast = useToast();
  const initial = useMemo(() => rowsOf(trip), [trip]);
  const [states, setStates] = useState<Record<string, Row["state"]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const rows = initial.map((row) => ({ ...row, state: states[row.date] ?? row.state }));
  const lowCount = rows.filter((row) => row.state === "low").length;

  async function choose(date: string, state: SeatState) {
    const before = rows.find((row) => row.date === date)?.state;
    if (busy || before === state) return;
    setBusy(date);
    setStates((current) => ({ ...current, [date]: state }));
    try {
      const response = await apiFetch("/api/admin/departure-seats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tripId: trip.id, date, state }),
      });
      if (!response.ok) throw new Error("save failed");
      toast.success(`${label(date)} — ${OPTIONS.find((option) => option.value === state)?.label}`);
    } catch {
      setStates((current) => ({ ...current, [date]: before ?? "open" }));
      toast.error("Хадгалахад алдаа гарлаа.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="mt-5 border-t border-line pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-ink">Огноо бүрийн суудал</h3>
        {lowCount > 0 && <span className="text-xs font-medium text-warning">{lowCount} өдөр «Цөөн суудал» гэж харагдаж байна</span>}
      </div>
      <p className="mt-1 text-xs text-ink-subtle">
        «Цөөн суудал» гэж сонгосон өдөр л вебсайт болон чатбот дээр тэр өдрийн хажууд харагдана. Бусад өдрөөр харагдахгүй.
        Дарсан даруйдаа хадгалагдана.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-ink-muted">
          Вебсайтад нийтлэгдсэн гарах өдөр алга. Огноогоо хадгалж, аяллаа идэвхтэй болгосны дараа энд сонгоно.
        </p>
      ) : (
        <ul className="mt-3 max-h-72 divide-y divide-line overflow-y-auto border-y border-line">
          {rows.map((row) => (
            <li key={row.date} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0 text-sm">
                <span className="font-medium text-ink">{label(row.date)}</span>
                {row.state === "paused" && <span className="ml-2 text-xs text-ink-muted">Түр хаасан</span>}
              </span>
              <span role="radiogroup" aria-label={`${label(row.date)} суудлын төлөв`} className="inline-flex overflow-hidden rounded-lg border border-line-strong">
                {OPTIONS.map((option) => {
                  const active = row.state === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={busy === row.date}
                      onClick={() => void choose(row.date, option.value)}
                      className={cx(
                        "border-r border-line-strong px-3 py-1.5 text-xs font-medium transition-colors last:border-r-0 disabled:opacity-60",
                        active ? option.on : "bg-surface text-ink-muted hover:bg-surface-sunken",
                      )}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
