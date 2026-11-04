import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

export type QuickActionKind = "cancel" | "seats" | "food";

type ActionKey = QuickActionKind | "price" | "new";

const ACTIONS: Array<{
  key: ActionKey;
  label: string;
  hint: string;
  icon: keyof typeof Icons;
}> = [
  { key: "new", label: "Шинэ аялал", hint: "Аяллаа хэрхэн нэмэх вэ?", icon: "plus" },
  { key: "price", label: "Үнэ өөрчлөх", hint: "Аль аяллын үнийг засах вэ?", icon: "tag" },
  { key: "seats", label: "Суудал шинэчлэх", hint: "Аль аяллын суудлыг шинэчлэх вэ?", icon: "users" },
  { key: "food", label: "Хоол", hint: "Аль аяллын хоолны мэдээллийг засах вэ?", icon: "utensils" },
  { key: "cancel", label: "Аялал цуцлах", hint: "Аль аяллыг цуцлах вэ?", icon: "ban" },
];

const STATUS_LABEL: Record<string, string> = {
  active: "Идэвхтэй", sold_out: "Дүүрсэн", paused: "Түр зогссон", draft: "Ноорог", cancelled: "Цуцлагдсан",
};

const STATUS_TONE: Record<string, string> = {
  active: "bg-success-soft text-success",
  sold_out: "bg-warning-soft text-warning",
  paused: "bg-warning-soft text-warning",
  draft: "bg-surface-sunken text-ink-muted",
  cancelled: "bg-danger-soft text-danger",
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
  onPickFile,
}: {
  trips: TravelTrip[];
  busy: boolean;
  onQuick: (kind: QuickActionKind, trip: TravelTrip, value?: number | boolean) => void;
  onEditPrice: (trip: TravelTrip) => void;
  onNewTrip: () => void;
  onPickFile?: () => void;
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
  const ActiveIcon = active ? Icons[active.icon] : null;
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
      {active && ActiveIcon && (
        <section
          id={panelId}
          className="animate-scale-in mb-3 overflow-hidden rounded-xl border border-line bg-surface shadow-sm"
          aria-label={active.label}
        >
          <div className="flex items-center gap-3 border-b border-line bg-canvas/60 py-2.5 pl-3.5 pr-2">
            {picked ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => setPicked(null)}
                aria-label="Өөр аялал сонгох"
                title="Өөр аялал сонгох"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink disabled:opacity-50"
              >
                <Icons.arrowLeft size={16} />
              </button>
            ) : (
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
                <ActiveIcon size={16} />
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-5 text-ink">{picked ? picked.route_name : active.hint}</p>
              {picked && (
                <p className="text-[11px] leading-4 text-ink-muted">{active.label} · {STATUS_LABEL[picked.status] || "Төлөв тодорхойгүй"}</p>
              )}
            </div>
            <button
              type="button"
              onClick={() => reset()}
              aria-label="Шуурхай өөрчлөлтийг хаах"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
            >
              <Icons.close size={15} />
            </button>
          </div>

          {action === "new" ? (
            <div className="grid gap-2 p-3 sm:grid-cols-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => { reset(false); onNewTrip(); }}
                className="group flex items-start gap-3 rounded-xl border border-brand-border bg-brand-soft/50 p-3.5 text-left transition-colors hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white shadow-xs">
                  <Icons.plus size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">Хоосон маягт нээх</span>
                  <span className="mt-0.5 block text-xs leading-5 text-ink-muted">Нэр, огноо, үнээ өөрөө бөглөнө.</span>
                </span>
              </button>
              <button
                type="button"
                disabled={busy || !onPickFile}
                onClick={() => { reset(false); onPickFile?.(); }}
                className="group flex items-start gap-3 rounded-xl border border-line bg-surface p-3.5 text-left transition-colors hover:border-brand-border hover:bg-brand-soft/40 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-ink-muted transition-colors group-hover:bg-brand-soft group-hover:text-brand">
                  <Icons.upload size={16} />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">Постер, үнийн жагсаалт хавсаргах</span>
                  <span className="mt-0.5 block text-xs leading-5 text-ink-muted">Би уншаад санал бэлдье. Та хянаад хадгална.</span>
                </span>
              </button>
            </div>
          ) : !picked ? (
            <div className="p-3">
              <label htmlFor={`${panelId}-search`} className="sr-only">Аяллын нэрээр хайх</label>
              <div className="relative">
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
              <ul className="scroll-area mt-2 max-h-56 space-y-0.5 overflow-y-auto" aria-label="Сонгох аяллууд">
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
                      className="group flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <span className="min-w-0 wrap-break-word font-medium">{trip.route_name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[trip.status] || STATUS_TONE.draft)}>
                          {STATUS_LABEL[trip.status] || "Төлөв тодорхойгүй"}
                        </span>
                        <Icons.chevronRight size={14} className="text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                      </span>
                    </button>
                  </li>
                ))}
                {candidates.length === 0 && (
                  <li className="px-3 py-5 text-center text-sm leading-6 text-ink-muted">
                    {search.trim() ? "Ийм нэртэй аялал олдсонгүй. Нэрээ товчилж хайгаарай." : "Энэ өөрчлөлтийг хийх аялал алга. Эхлээд шинэ аялал нэмээрэй."}
                  </li>
                )}
              </ul>
              {candidates.length > 40 && <p className="mt-2 px-1 text-xs leading-5 text-ink-muted">Эхний 40 аяллыг харууллаа. Нэрээр хайж сонголтоо нарийсгаарай.</p>}
            </div>
          ) : (
            <div className="p-3.5 sm:p-4">
              {action === "cancel" && (
                <div className="flex flex-wrap items-center gap-3">
                  <Button size="sm" variant="danger" disabled={busy} onClick={() => { onQuick("cancel", picked); reset(); }}>
                    <Icons.ban size={14} /> Цуцлах санал үүсгэх
                  </Button>
                  <span className="text-xs leading-5 text-ink-muted">Хадгалахаас өмнө саналыг хянана.</span>
                </div>
              )}
              {action === "seats" && (
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label htmlFor={`${panelId}-seats`} className="mb-1.5 block text-xs font-medium text-ink-muted">
                      Үлдсэн суудал
                      {typeof picked.seats_left === "number" && <span className="font-normal text-ink-subtle"> · одоо {picked.seats_left}</span>}
                    </label>
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
                      className="h-10 w-28 rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold tabular-nums text-ink focus:border-brand"
                    />
                  </div>
                  <Button size="md" disabled={busy || !seatsValid} onClick={() => { onQuick("seats", picked, seatsNumber); reset(); }}>
                    Санал үүсгэх
                  </Button>
                </div>
              )}
              {action === "food" && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    { value: true, label: "Хоол багтсан", body: "Аяллын үнэд хоол орно." },
                    { value: false, label: "Хоол багтаагүй", body: "Хоолыг тусад нь төлнө." },
                  ].map((option) => {
                    const current = Boolean(picked.has_food) === option.value;
                    return (
                      <button
                        key={String(option.value)}
                        type="button"
                        disabled={busy}
                        onClick={() => { onQuick("food", picked, option.value); reset(); }}
                        className={cx(
                          "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                          current
                            ? "border-line bg-surface-sunken/60 hover:bg-surface-sunken"
                            : "border-brand-border bg-brand-soft/50 hover:bg-brand-soft",
                        )}
                      >
                        <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", current ? "bg-surface text-ink-muted" : "bg-brand text-white")}>
                          <Icons.utensils size={15} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-ink">
                            {option.label}
                            {current && <span className="ml-1.5 text-[11px] font-medium text-ink-muted">· одоогийнх</span>}
                          </span>
                          <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{option.body}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      <div className="scroll-area flex gap-2 overflow-x-auto pb-1" role="group" aria-label="Аяллын түгээмэл өөрчлөлтүүд">
        {ACTIONS.map((entry) => {
          const Icon = Icons[entry.icon];
          const pressed = action === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              ref={(element) => { actionRefs.current[entry.key] = element; }}
              disabled={busy}
              onClick={() => choose(entry.key)}
              aria-pressed={pressed}
              aria-expanded={pressed}
              aria-controls={pressed ? panelId : undefined}
              className={cx(
                "group flex h-9 shrink-0 items-center gap-1.5 rounded-lg border px-3 text-[13px] font-medium transition-all duration-150 active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100",
                pressed
                  ? "border-brand bg-brand text-white shadow-xs"
                  : "border-line bg-surface text-ink shadow-xs hover:border-brand-border hover:bg-brand-soft hover:text-brand",
              )}
            >
              <Icon size={14} className={pressed ? "text-white/90" : "text-ink-subtle transition-colors group-hover:text-brand"} />
              {entry.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
