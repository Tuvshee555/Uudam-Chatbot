import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Icons, cx } from "@/components/ui";
import type { TravelTrip } from "@/lib/adminTypes";

export type QuickActionKind = "cancel" | "seats" | "food";

/** Everything the admin can start from the composer or the welcome screen. */
export type ActionKey = QuickActionKind | "price" | "new";

type ActionIcon = "plus" | "tag" | "users" | "utensils" | "ban";

export const QUICK_ACTIONS: ReadonlyArray<{
  key: ActionKey;
  label: string;
  body: string;
  question: string;
  icon: ActionIcon;
}> = [
  { key: "new", label: "Шинэ аялал нэмэх", body: "Хоосон маягт нээгдэнэ. Нэр, огноо, үнээ бөглөнө.", question: "", icon: "plus" },
  { key: "price", label: "Үнэ өөрчлөх", body: "Аяллаа сонгоод шинэ үнийг оруулна.", question: "Аль аяллын үнийг өөрчлөх вэ?", icon: "tag" },
  { key: "seats", label: "Суудал шинэчлэх", body: "Үлдсэн суудлын тоог шууд засна.", question: "Аль аяллын суудлыг шинэчлэх вэ?", icon: "users" },
  { key: "food", label: "Хоол багтсан эсэх", body: "Хоол үнэд орсон эсэхийг тэмдэглэнэ.", question: "Аль аяллын хоолны мэдээллийг засах вэ?", icon: "utensils" },
  { key: "cancel", label: "Аялал цуцлах", body: "Аяллыг цуцалсан төлөвт шилжүүлнэ.", question: "Аль аяллыг цуцлах вэ?", icon: "ban" },
];

export const STATUS_LABEL: Record<string, string> = {
  active: "Идэвхтэй", sold_out: "Дүүрсэн", paused: "Түр зогссон", draft: "Ноорог", cancelled: "Цуцлагдсан",
};

const STATUS_TONE: Record<string, string> = {
  active: "bg-success-soft text-success",
  sold_out: "bg-warning-soft text-warning",
  paused: "bg-warning-soft text-warning",
  draft: "bg-surface-sunken text-ink-muted",
  cancelled: "bg-danger-soft text-danger",
};

export function StatusPill({ status, className }: { status: string; className?: string }) {
  return (
    <span className={cx("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[status] || STATUS_TONE.draft, className)}>
      {STATUS_LABEL[status] || "Төлөв тодорхойгүй"}
    </span>
  );
}

export function ActionGlyph({ icon, size = 16, className }: { icon: ActionIcon; size?: number; className?: string }) {
  const Icon = Icons[icon];
  return <Icon size={size} className={className} />;
}

/* ----------------------------------------------------------------
   The guided step. One action is a short exchange inside the thread:
   the assistant asks which trip, then (for seats, food, cancel) asks
   for the one value. The composer is the only input throughout, so the
   admin never leaves the conversation. When the step completes the
   real admin message and proposal arrive from the page and the step
   disappears.
   ---------------------------------------------------------------- */
export type StepPhase = "trip" | "value" | "choice" | "confirm";

export type QuickStep = {
  action: Exclude<ActionKey, "new">;
  trip: TravelTrip | null;
  phase: StepPhase;
};

const MAX_LISTED = 8;

export function useQuickAction({
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
  const [step, setStep] = useState<QuickStep | null>(null);
  const [input, setInput] = useState("");

  const start = useCallback((key: ActionKey) => {
    if (busy) return;
    setInput("");
    if (key === "new") { setStep(null); onNewTrip(); return; }
    setStep({ action: key, trip: null, phase: "trip" });
  }, [busy, onNewTrip]);

  const cancel = useCallback(() => { setStep(null); setInput(""); }, []);

  const candidates = useMemo(() => {
    if (!step || step.phase !== "trip") return [];
    const needle = input.trim().toLowerCase();
    return trips
      .filter((trip) => trip.status !== "archived" && !(step.action === "cancel" && trip.status === "cancelled"))
      .filter((trip) => !needle || trip.route_name.toLowerCase().includes(needle))
      .sort((a, b) => a.route_name.localeCompare(b.route_name, "mn"));
  }, [trips, input, step]);

  const pickTrip = useCallback((trip: TravelTrip) => {
    if (!step || busy) return;
    setInput("");
    if (step.action === "price") { setStep(null); onEditPrice(trip); return; }
    if (step.action === "seats") { setStep({ ...step, trip, phase: "value" }); return; }
    if (step.action === "food") { setStep({ ...step, trip, phase: "choice" }); return; }
    setStep({ ...step, trip, phase: "confirm" });
  }, [step, busy, onEditPrice]);

  const changeTrip = useCallback(() => {
    if (!step) return;
    setInput("");
    setStep({ ...step, trip: null, phase: "trip" });
  }, [step]);

  const seatsNumber = input.trim() === "" ? NaN : Number(input);
  const seatsValid = Number.isInteger(seatsNumber) && seatsNumber >= 0 && seatsNumber <= 1000;

  const finish = useCallback((value?: number | boolean) => {
    if (!step || !step.trip || busy) return;
    const { action, trip } = step;
    setStep(null);
    setInput("");
    if (action === "seats" || action === "food" || action === "cancel") onQuick(action, trip, value);
  }, [step, busy, onQuick]);

  /** What Enter in the composer does right now, or null when it does nothing. */
  const enterAction = useMemo<(() => void) | null>(() => {
    if (!step) return null;
    if (step.phase === "trip") {
      const first = candidates[0];
      return input.trim() && first ? () => pickTrip(first) : null;
    }
    if (step.phase === "value") return seatsValid ? () => finish(seatsNumber) : null;
    return null;
  }, [step, candidates, input, pickTrip, seatsValid, seatsNumber, finish]);

  const definition = step ? QUICK_ACTIONS.find((entry) => entry.key === step.action) ?? null : null;

  return { step, definition, input, setInput, start, cancel, candidates, pickTrip, changeTrip, finish, seatsValid, seatsNumber, enterAction };
}

export type QuickActionController = ReturnType<typeof useQuickAction>;

/* ----------------------------------------------------------------
   The step as it appears in the thread: an assistant bubble that
   asks one thing and shows the choices. Styled like every other
   assistant message so it reads as part of the conversation.
   ---------------------------------------------------------------- */
export function QuickActionStep({ controller, busy }: { controller: QuickActionController; busy: boolean }) {
  const { step, definition, input, candidates, pickTrip, changeTrip, finish, cancel, seatsValid, seatsNumber } = controller;
  if (!step || !definition) return null;
  const query = input.trim();
  const listed = candidates.slice(0, MAX_LISTED);
  const hidden = candidates.length - listed.length;

  const question =
    step.phase === "trip" ? definition.question
      : step.phase === "value" ? "Хэдэн суудал үлдсэн бэ?"
        : step.phase === "choice" ? "Хоол үнэд багтсан уу?"
          : "Энэ аяллыг цуцлах уу?";

  return (
    <div className="animate-fade-up flex justify-start" role="group" aria-label={definition.label}>
      <div className="w-full min-w-0 max-w-3xl overflow-hidden rounded-2xl rounded-bl-md border border-brand-border bg-surface shadow-xs">
        <div className="flex items-start gap-3 px-4 pt-3.5 pb-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand">
            <ActionGlyph icon={definition.icon} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-brand">{definition.label}</p>
            <p className="mt-0.5 text-[15px] font-semibold leading-6 text-ink" aria-live="polite">{question}</p>
            {step.trip && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex max-w-full items-center gap-2 rounded-lg border border-line bg-canvas px-2.5 py-1 text-sm font-medium text-ink">
                  <Icons.trips size={14} className="shrink-0 text-ink-subtle" />
                  <span className="truncate">{step.trip.route_name}</span>
                  <StatusPill status={step.trip.status} />
                </span>
                <button type="button" disabled={busy} onClick={changeTrip} className="rounded text-xs font-medium text-brand hover:text-brand-hover disabled:opacity-50">
                  Солих
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={cancel}
            aria-label="Болих"
            title="Болих (Esc)"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-ink-muted transition-colors hover:bg-surface-sunken hover:text-ink"
          >
            <Icons.close size={15} />
          </button>
        </div>

        {step.phase === "trip" && (
          <div className="border-t border-line">
            <ul className="p-1.5" aria-label="Сонгох аяллууд">
              {listed.map((trip, index) => {
                const primary = Boolean(query) && index === 0;
                return (
                  <li key={trip.id}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => pickTrip(trip)}
                      className={cx(
                        "group flex min-h-11 w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm text-ink transition-colors hover:bg-brand-soft disabled:cursor-not-allowed disabled:opacity-50",
                        primary && "bg-brand-soft/70",
                      )}
                    >
                      <span className="min-w-0 wrap-break-word font-medium">{trip.route_name}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusPill status={trip.status} />
                        {primary ? (
                          <kbd className="rounded border border-brand-border bg-surface px-1.5 py-px font-sans text-[10px] font-semibold text-brand">Enter</kbd>
                        ) : (
                          <Icons.chevronRight size={14} className="text-ink-subtle opacity-0 transition-opacity group-hover:opacity-100" />
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
              {candidates.length === 0 && (
                <li className="px-3 py-5 text-center text-sm leading-6 text-ink-muted">
                  {query ? `«${query}» нэртэй аялал олдсонгүй. Нэрээ товчилж бичээрэй.` : "Энэ өөрчлөлтийг хийх аялал алга. Эхлээд шинэ аялал нэмээрэй."}
                </li>
              )}
            </ul>
            <p className="border-t border-line bg-canvas/60 px-4 py-2 text-[11px] leading-4 text-ink-muted">
              {hidden > 0
                ? `Өөр ${hidden} аялал бий. Доор нэрийг нь бичвэл жагсаалт нарийсна.`
                : "Доор нэрийг нь бичиж хайж болно."}
            </p>
          </div>
        )}

        {step.phase === "value" && step.trip && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line bg-canvas/60 px-4 py-3">
            <p className="text-sm text-ink-muted">
              Одоо <span className="font-semibold tabular-nums text-ink">{typeof step.trip.seats_left === "number" ? step.trip.seats_left : "—"}</span>
              <span className="mx-2 text-line-strong">→</span>
              <span className={cx("font-semibold tabular-nums", seatsValid ? "text-brand" : "text-ink-subtle")}>{seatsValid ? seatsNumber : "?"}</span>
            </p>
            <p className="text-[11px] leading-4 text-ink-subtle">Доор тоог бичээд Enter дарна уу. 0–1000 хооронд.</p>
          </div>
        )}

        {step.phase === "choice" && step.trip && (
          <div className="grid gap-2 border-t border-line p-3 sm:grid-cols-2">
            {[
              { value: true, label: "Хоол багтсан", body: "Аяллын үнэд хоол орно." },
              { value: false, label: "Хоол багтаагүй", body: "Хоолыг тусад нь төлнө." },
            ].map((option) => {
              const current = Boolean(step.trip?.has_food) === option.value;
              return (
                <button
                  key={String(option.value)}
                  type="button"
                  disabled={busy}
                  onClick={() => finish(option.value)}
                  className={cx(
                    "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                    current ? "border-line bg-surface hover:bg-surface-sunken/60" : "border-brand-border bg-brand-soft/50 hover:bg-brand-soft",
                  )}
                >
                  <span className={cx("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", current ? "bg-surface-sunken text-ink-muted" : "bg-brand text-white")}>
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

        {step.phase === "confirm" && step.trip && (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-canvas/60 px-4 py-3">
            <p className="text-xs leading-5 text-ink-muted">Цуцлах санал үүснэ. Хадгалахаас өмнө та хянана, буцаах боломжтой.</p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={cancel}>Болих</Button>
              <Button size="sm" variant="danger" disabled={busy} onClick={() => finish()}>
                <Icons.ban size={14} /> Цуцлах санал үүсгэх
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------
   The welcome list: the same actions, as one list the admin reads
   top to bottom. Clicking a row starts the exchange in the thread.
   ---------------------------------------------------------------- */
export function QuickActionList({ onStart, busy }: { onStart: (key: ActionKey) => void; busy: boolean }) {
  return (
    <ul className="w-full divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-xs" aria-label="Шуурхай өөрчлөлтүүд">
      {QUICK_ACTIONS.map((entry) => (
        <li key={entry.key}>
          <button
            type="button"
            disabled={busy}
            onClick={() => onStart(entry.key)}
            className="group flex w-full items-center gap-3.5 px-4 py-3 text-left transition-colors hover:bg-brand-soft/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-sunken text-ink-muted transition-colors group-hover:bg-brand-soft group-hover:text-brand">
              <ActionGlyph icon={entry.icon} size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-ink">{entry.label}</span>
              <span className="mt-0.5 block text-xs leading-5 text-ink-muted">{entry.body}</span>
            </span>
            <Icons.chevronRight size={16} className="shrink-0 text-ink-subtle transition-transform group-hover:translate-x-0.5 group-hover:text-brand" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/* ----------------------------------------------------------------
   The "+" menu in the composer: attach a file or start an action,
   from the one place the admin is already typing.
   ---------------------------------------------------------------- */
export function ComposerActionMenu({
  busy,
  onStart,
  onPickFile,
  menuId,
}: {
  busy: boolean;
  onStart: (key: ActionKey) => void;
  onPickFile: () => void;
  menuId: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!(event.target instanceof Node) || !rootRef.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); triggerRef.current?.focus(); }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const choose = (run: () => void) => { setOpen(false); run(); };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
        aria-label="Файл хавсаргах эсвэл үйлдэл эхлүүлэх"
        title="Файл хавсаргах эсвэл үйлдэл эхлүүлэх"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={cx(
          "flex h-10 w-10 items-center justify-center rounded-xl transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50",
          open ? "rotate-45 bg-ink text-white" : "text-ink-muted hover:bg-brand-soft hover:text-brand",
        )}
      >
        <Icons.plus size={18} />
      </button>
      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label="Үйлдлүүд"
          className="animate-scale-in absolute bottom-full left-0 z-20 mb-2 w-72 origin-bottom-left overflow-hidden rounded-xl border border-line bg-surface p-1.5 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => choose(onPickFile)}
            className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-brand-soft"
          >
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand text-white shadow-xs">
              <Icons.paperclip size={16} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink">Файл хавсаргах</span>
              <span className="block text-[11px] leading-4 text-ink-muted">Постер · PDF · Excel · Word</span>
            </span>
          </button>
          <div className="mx-2 my-1.5 border-t border-line" role="separator" />
          <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">Аяллын өөрчлөлт</p>
          {QUICK_ACTIONS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="menuitem"
              onClick={() => choose(() => onStart(entry.key))}
              className="group flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-brand-soft"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors group-hover:text-brand">
                <ActionGlyph icon={entry.icon} size={15} />
              </span>
              <span className="font-medium">{entry.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
