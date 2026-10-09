import { useMemo, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

export type QuickActionKind = "cancel" | "seats" | "food";

type ActionKey = QuickActionKind | "price" | "new";

const ACTIONS: Array<{ key: ActionKey; label: string; hint: string }> = [
  { key: "cancel", label: "Аялал цуцлах", hint: "Аль аяллыг цуцлах вэ?" },
  { key: "seats", label: "Суудал шинэчлэх", hint: "Аль аяллын суудлыг шинэчлэх вэ?" },
  { key: "price", label: "Үнэ өөрчлөх", hint: "Аль аяллын үнийг засах вэ?" },
  { key: "food", label: "Хоол", hint: "Аль аяллын хоолны мэдээллийг засах вэ?" },
  { key: "new", label: "Шинэ аялал", hint: "" },
];

const STATUS_LABEL: Record<string, string> = {
  active: "Идэвхтэй", sold_out: "Дүүрсэн", paused: "Түр зогссон", draft: "Ноорог", cancelled: "Цуцлагдсан",
};

/**
 * One-tap edits for the common jobs. The admin picks the trip from a list and
 * gives the one value; code builds the change, so nothing is guessed. It then
 * shows up as an ordinary proposal to review, apply and undo.
 */
export function AssistantQuickActions({
  trips,
  busy,
  onQuick,
  onEditPrice,
  onNewTrip,
}: {
  trips: TravelTrip[];
  busy: boolean;
  onQuick: (kind: QuickActionKind, trip: TravelTrip, value?: number | boolean) => void;
  onEditPrice: (trip: TravelTrip) => void;
  onNewTrip: () => void;
}) {
  const [action, setAction] = useState<ActionKey | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<TravelTrip | null>(null);
  const [seats, setSeats] = useState("");

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return trips
      .filter((trip) => trip.status !== "archived" && !(action === "cancel" && trip.status === "cancelled"))
      .filter((trip) => !needle || trip.route_name.toLowerCase().includes(needle))
      .sort((a, b) => a.route_name.localeCompare(b.route_name, "mn"))
      .slice(0, 40);
  }, [trips, search, action]);

  const reset = () => {
    setAction(null);
    setSearch("");
    setPicked(null);
    setSeats("");
  };
  const choose = (key: ActionKey) => {
    if (action === key) return reset();
    setAction(key);
    setSearch("");
    setPicked(null);
    setSeats("");
  };
  const active = ACTIONS.find((entry) => entry.key === action);
  const seatsNumber = seats.trim() === "" ? NaN : Number(seats);
  const seatsValid = Number.isInteger(seatsNumber) && seatsNumber >= 0 && seatsNumber <= 1000;

  return (
    <div>
      <div className="scroll-area flex gap-1.5 overflow-x-auto px-3 pt-2.5">
        {ACTIONS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => choose(entry.key)}
            aria-pressed={action === entry.key}
            className={cx(
              "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors duration-150",
              action === entry.key
                ? "bg-brand-soft text-brand"
                : "bg-surface-sunken text-ink-muted hover:bg-brand-soft hover:text-brand",
            )}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {active && (
        <div className="mx-3 mt-2 rounded-xl border border-line bg-surface p-3">
          {action === "new" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={() => { reset(); onNewTrip(); }}>
                <Icons.plus size={14} /> Хоосон маягт нээх
              </Button>
              <span className="text-xs text-ink-muted">эсвэл PDF / Word / зургаа энд чирж оруулбал бүх мэдээллийг нь уншина.</span>
            </div>
          ) : !picked ? (
            <>
              <div className="mb-2 flex items-center gap-2">
                <p className="text-sm font-medium text-ink">{active.hint}</p>
                <button type="button" onClick={reset} className="ml-auto text-xs text-ink-muted hover:text-ink">Хаах</button>
              </div>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Аяллын нэрээр хайх…"
                className="mb-2 h-9 w-full rounded-lg border border-line bg-surface-sunken px-3 text-sm outline-none focus:border-brand"
              />
              <ul className="max-h-52 space-y-1 overflow-y-auto">
                {candidates.map((trip) => (
                  <li key={trip.id}>
                    <button
                      type="button"
                      onClick={() => {
                        if (action === "price") { reset(); onEditPrice(trip); return; }
                        setPicked(trip);
                        setSeats(typeof trip.seats_left === "number" ? String(trip.seats_left) : "");
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-surface-sunken"
                    >
                      <span className="min-w-0 truncate">{trip.route_name}</span>
                      <span className="shrink-0 text-xs text-ink-muted">{STATUS_LABEL[trip.status] || trip.status}</span>
                    </button>
                  </li>
                ))}
                {candidates.length === 0 && <li className="px-2.5 py-2 text-sm text-ink-muted">Аялал олдсонгүй.</li>}
              </ul>
            </>
          ) : (
            <div className="space-y-2.5">
              <div className="flex items-center gap-2">
                <p className="min-w-0 truncate text-sm font-medium text-ink">{picked.route_name}</p>
                <button type="button" onClick={() => setPicked(null)} className="ml-auto shrink-0 text-xs text-ink-muted hover:text-ink">Өөр аялал</button>
              </div>
              {action === "cancel" && (
                <Button size="sm" variant="danger" disabled={busy} onClick={() => { onQuick("cancel", picked); reset(); }}>
                  Цуцлах санал үүсгэх
                </Button>
              )}
              {action === "seats" && (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    max={1000}
                    inputMode="numeric"
                    value={seats}
                    onChange={(event) => setSeats(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && seatsValid && !busy) { onQuick("seats", picked, seatsNumber); reset(); } }}
                    aria-label="Үлдсэн суудал"
                    className="h-9 w-28 rounded-lg border border-line bg-surface-sunken px-3 text-sm outline-none focus:border-brand"
                  />
                  <span className="text-sm text-ink-muted">суудал үлдсэн</span>
                  <Button size="sm" disabled={busy || !seatsValid} onClick={() => { onQuick("seats", picked, seatsNumber); reset(); }}>
                    Санал үүсгэх
                  </Button>
                </div>
              )}
              {action === "food" && (
                <div className="flex gap-2">
                  <Button size="sm" variant={picked.has_food ? "secondary" : "primary"} disabled={busy} onClick={() => { onQuick("food", picked, true); reset(); }}>
                    Хоол багтсан
                  </Button>
                  <Button size="sm" variant={picked.has_food ? "primary" : "secondary"} disabled={busy} onClick={() => { onQuick("food", picked, false); reset(); }}>
                    Хоол багтаагүй
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
