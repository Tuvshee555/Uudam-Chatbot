/**
 * A departure day's seat state in the new-trip review: the badge on its chip («Дүүрсэн» red,
 * «4 суудал» / «Цөөн суудал» amber, nothing for an ordinary open day) and the small panel that
 * changes it. A full day stays selected and priced: customers see it as full.
 * Used by the calendar's selected days and by the price cards' day chips.
 */
import { useEffect, useId, useRef } from "react";
import { Icons, cx } from "@/components/ui";
import type { DayState, SeatState } from "@/lib/tripDayStates";
import { SEAT_STATE_OPTIONS, chosenState, dayStateBadge, seatsFromInput } from "./dayStateView";

export function DayStateBadge({ state, className }: { state: DayState | undefined; className?: string }) {
  const badge = dayStateBadge(state);
  if (!badge) return null;
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[12px] font-semibold leading-none",
      badge.tone === "full" ? "bg-danger text-white" : badge.tone === "low" ? "bg-warning-soft text-warning ring-1 ring-inset ring-warning/30" : "bg-surface-sunken text-ink-muted",
      className)}>
      {badge.text}
    </span>
  );
}

/** The dot a calendar day carries for its state (none for an ordinary open day). */
export function DayStateDot({ state }: { state: DayState | undefined }) {
  if (!state || state.state === "open") return null;
  return (
    <span aria-hidden="true" className={cx("pointer-events-none absolute -right-0.5 -top-0.5 h-3 w-3 rounded-full border-2 border-surface",
      state.state === "full" ? "bg-danger" : "bg-sun")} />
  );
}

/**
 * The panel under the chips for one day: open / few seats (+ optional count) / full. A choice is
 * saved at once; Escape or «Болсон» closes it and gives the focus back to the chip.
 */
export function DayStatePanel({
  dayLabel,
  state,
  onChange,
  onClose,
  disabled,
}: {
  dayLabel: string;
  state: DayState | undefined;
  /** null clears the day back to open. */
  onChange: (next: DayState | null) => void;
  onClose: () => void;
  disabled?: boolean;
}) {
  const uid = useId();
  const current: SeatState = state?.state ?? "open";
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panelRef.current?.querySelector<HTMLInputElement>("input[type=radio]:checked")?.focus();
  }, []);
  const choose = (value: SeatState) => {
    const next = chosenState(value, state);
    onChange(next.state === "open" && next.seats === null ? null : next);
  };
  return (
    <div ref={panelRef} role="group" aria-label={`${dayLabel} — суудлын төлөв`}
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}
      className="mt-2.5 rounded-lg border border-line-strong bg-surface p-3 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="min-w-0 text-sm font-semibold text-ink">{dayLabel} <span className="font-normal text-ink-muted">· суудлын төлөв</span></p>
        <button type="button" onClick={onClose} className="h-8 shrink-0 rounded-md px-3 text-sm font-semibold text-brand hover:bg-brand-soft">Болсон</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2.5">
        <fieldset className="m-0 w-full min-w-0 border-0 p-0 sm:w-auto" disabled={disabled}>
          <legend className="sr-only">Суудлын төлөв</legend>
          <div className="grid grid-cols-3 rounded-md border border-line-strong bg-surface-sunken p-0.5 sm:inline-flex">
            {SEAT_STATE_OPTIONS.map((option) => {
              const on = current === option.value;
              return (
                <label key={option.value} className="relative min-w-0 cursor-pointer">
                  <input type="radio" name={`${uid}-state`} value={option.value} checked={on} onChange={() => choose(option.value)} className="peer sr-only" />
                  <span className={cx("flex min-h-9 items-center justify-center gap-1 rounded-[7px] px-2 py-1 text-center text-[14px] font-medium leading-tight transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-brand sm:min-h-8 sm:gap-1.5 sm:px-3",
                    on ? (option.value === "full" ? "bg-danger text-white shadow-xs" : option.value === "low" ? "bg-warning-soft text-warning shadow-xs ring-1 ring-inset ring-warning/40" : "bg-surface text-ink shadow-xs")
                      : "text-ink-muted hover:text-ink")}>
                    {on && <Icons.check size={13} />}{option.label}
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
        {current === "low" && (
          <label className="flex items-center gap-2 text-sm text-ink">
            Үлдсэн суудал
            <input type="text" inputMode="numeric" disabled={disabled} value={state?.seats ?? ""} placeholder="—" aria-describedby={`${uid}-seats-hint`}
              onChange={(event) => onChange({ state: "low", seats: seatsFromInput(event.target.value) })}
              className="h-8 w-16 rounded-md border border-line-strong bg-surface px-2 text-center text-[15px] tabular-nums text-ink focus:border-brand focus:outline-none focus:ring-3 focus:ring-brand/10" />
          </label>
        )}
      </div>
      <p id={`${uid}-seats-hint`} className="mt-2 text-[13px] leading-5 text-ink-muted">
        {current === "full"
          ? "Дүүрсэн өдөр календарьт, үнэтэйгээ үлдэнэ. Сайт, бот «дүүрсэн» гэж харуулна."
          : current === "low"
            ? "Тоо нь заавал биш. Хоосон бол «Цөөн суудал» гэж харагдана."
            : "Энгийн, захиалга авч буй өдөр."}
      </p>
    </div>
  );
}
