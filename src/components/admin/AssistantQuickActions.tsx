import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

export type QuickActionKind = "cancel" | "seats" | "food";

type ActionKey = QuickActionKind | "price" | "new";

const ACTIONS: Array<{ key: ActionKey; label: string; hint: string }> = [
  { key: "new", label: "Шинэ аялал", hint: "Аяллаа хэрхэн нэмэх вэ?" },
  { key: "price", label: "Үнэ өөрчлөх", hint: "Аль аяллын үнийг засах вэ?" },
  { key: "seats", label: "Суудал шинэчлэх", hint: "Аль аяллын суудлыг шинэчлэх вэ?" },
  { key: "food", label: "Хоол", hint: "Аль аяллын хоолны мэдээллийг засах вэ?" },
  { key: "cancel", label: "Аялал цуцлах", hint: "Аль аяллыг цуцлах вэ?" },
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
  const panelId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const seatsRef = useRef<HTMLInputElement>(null);
  const actionRefs = useRef<Partial<Record<ActionKey, HTMLButtonElement | null>>>({});
  const [action, setAction] = useState<ActionKey | null>(null);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<TravelTrip | null>(null);
  const [seats, setSeats] = useState("");

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return trips
      .filter((trip) => trip.status !== "archived" && !(action === "cancel" && trip.status === "cancelled"))
      .filter((trip) => !needle || trip.route_name.toLowerCase().includes(needle))
      .sort((a, b) => a.route_name.localeCompare(b.route_name, "mn"));
  }, [trips, search, action]);

  const reset = (restoreFocus = true) => {
    if (restoreFocus && action) actionRefs.current[action]?.focus();
    setAction(null);
    setSearch("");
    setPicked(null);
    setSeats("");
  };
  const choose = (key: ActionKey) => {
    if (busy) return;
    if (action === key) return reset();
    setAction(key);
    setSearch("");
    setPicked(null);
    setSeats("");
  };
  const active = ACTIONS.find((entry) => entry.key === action);
  const seatsNumber = seats.trim() === "" ? NaN : Number(seats);
  const seatsValid = Number.isInteger(seatsNumber) && seatsNumber >= 0 && seatsNumber <= 1000;

  useEffect(() => {
    if (picked && action === "seats") seatsRef.current?.focus();
    else if (action && action !== "new" && !picked) searchRef.current?.focus();
  }, [action, picked]);

  return (
    <div onKeyDown={(event) => {
      if (event.key === "Escape" && action) { event.preventDefault(); reset(); }
    }}>
      <div className="scroll-area flex gap-1.5 overflow-x-auto px-3 pt-3 pb-0.5" role="group" aria-label="Аяллын түгээмэл өөрчлөлтүүд">
        {ACTIONS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            ref={(element) => { actionRefs.current[entry.key] = element; }}
            disabled={busy}
            onClick={() => choose(entry.key)}
            aria-pressed={action === entry.key}
            aria-expanded={action === entry.key}
            aria-controls={action === entry.key ? panelId : undefined}
            className={cx(
              "flex min-h-8 shrink-0 items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50",
              action === entry.key
                ? "border-brand-border bg-brand-soft text-brand"
                : "border-line bg-surface text-ink-muted hover:border-brand-border hover:bg-brand-soft hover:text-brand",
            )}
          >
            {entry.key === "new" && <Icons.plus size={12} />}
            {entry.label}
          </button>
        ))}
      </div>

      {active && (
        <section id={panelId} className="mx-3 mt-2 rounded-xl border border-line bg-canvas/60 p-3 sm:p-3.5" aria-label={active.label}>
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold leading-5 text-ink">{picked ? picked.route_name : active.hint}</p>
            <button type="button" onClick={() => reset()} aria-label="Шуурхай өөрчлөлтийг хаах" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-muted hover:bg-surface-sunken hover:text-ink">
              <Icons.close size={15} />
            </button>
          </div>
          {action === "new" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => { reset(false); onNewTrip(); }}>
                <Icons.plus size={14} /> Хоосон маягт нээх
              </Button>
              <span className="text-xs leading-5 text-ink-muted">Эсвэл постер, үнийн жагсаалтаа хавсаргаарай. Би уншаад санал бэлдье.</span>
            </div>
          ) : !picked ? (
            <>
              <label htmlFor={`${panelId}-search`} className="sr-only">Аяллын нэрээр хайх</label>
              <div className="relative mb-2">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-muted"><Icons.search size={15} /></span>
                <input
                  ref={searchRef}
                  id={`${panelId}-search`}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Аяллын нэрээр хайх…"
                  className="h-10 w-full rounded-lg border border-line-strong bg-surface pl-9 pr-3 text-sm text-ink placeholder:text-ink-muted focus:border-brand"
                />
              </div>
              <ul className="scroll-area max-h-52 space-y-1 overflow-y-auto" aria-label="Сонгох аяллууд">
                {candidates.slice(0, 40).map((trip) => (
                  <li key={trip.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (action === "price") { reset(false); onEditPrice(trip); return; }
                        setPicked(trip);
                        setSeats(typeof trip.seats_left === "number" ? String(trip.seats_left) : "");
                      }}
                      className="flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-ink hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="min-w-0 wrap-break-word font-medium">{trip.route_name}</span>
                      <span className="shrink-0 rounded-full bg-surface px-2 py-0.5 text-[11px] text-ink-muted">{STATUS_LABEL[trip.status] || "Төлөв тодорхойгүй"}</span>
                    </button>
                  </li>
                ))}
                {candidates.length === 0 && <li className="px-2.5 py-3 text-sm leading-6 text-ink-muted">{search.trim() ? "Ийм нэртэй аялал олдсонгүй. Нэрээ товчилж хайгаарай." : "Энэ өөрчлөлтийг хийх аялал алга. Эхлээд шинэ аялал нэмээрэй."}</li>}
              </ul>
              {candidates.length > 40 && <p className="mt-2 text-xs leading-5 text-ink-muted">Эхний 40 аяллыг харууллаа. Нэрээр хайж сонголтоо нарийсгаарай.</p>}
            </>
          ) : (
            <div className="space-y-2.5">
              <button type="button" disabled={busy} onClick={() => setPicked(null)} className="rounded text-xs font-medium text-brand hover:text-brand-hover disabled:opacity-50">Өөр аялал сонгох</button>
              {action === "cancel" && (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => { onQuick("cancel", picked); reset(); }}>
                  Цуцлах санал үүсгэх
                </Button>
              )}
              {action === "seats" && (
                <div className="flex flex-wrap items-center gap-2">
                  <label htmlFor={`${panelId}-seats`} className="text-sm text-ink-muted">Үлдсэн суудал</label>
                  <input
                    ref={seatsRef}
                    id={`${panelId}-seats`}
                    type="number"
                    min={0}
                    max={1000}
                    step={1}
                    disabled={busy}
                    inputMode="numeric"
                    value={seats}
                    onChange={(event) => setSeats(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && seatsValid && !busy) { onQuick("seats", picked, seatsNumber); reset(); } }}
                    aria-label="Үлдсэн суудал"
                    className="h-10 w-24 rounded-lg border border-line-strong bg-surface px-3 text-sm text-ink focus:border-brand"
                  />
                  <Button size="sm" disabled={busy || !seatsValid} onClick={() => { onQuick("seats", picked, seatsNumber); reset(); }}>
                    Санал үүсгэх
                  </Button>
                </div>
              )}
              {action === "food" && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant={picked.has_food ? "secondary" : "primary"} disabled={busy} onClick={() => { onQuick("food", picked, true); reset(); }}>
                    Хоол багтсан
                  </Button>
                  <Button size="sm" variant={picked.has_food ? "primary" : "secondary"} disabled={busy} onClick={() => { onQuick("food", picked, false); reset(); }}>
                    Хоол багтаагүй
                  </Button>
                </div>
              )}
              <p className="text-xs leading-5 text-ink-muted">Саналыг хянаад хадгалахад аяллын мэдээлэл өөрчлөгдөнө.</p>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
