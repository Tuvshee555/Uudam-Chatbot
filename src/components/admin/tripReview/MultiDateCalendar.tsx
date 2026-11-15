import { useId, useMemo, useState } from "react";
import { Icons, cx } from "@/components/ui";
import type { DayState } from "@/lib/tripDayStates";
import { addDaysYmd, formatYmd, isYmd, mongoliaToday, weekdayOf } from "@/lib/tripReview";
import { DayStateBadge, DayStateDot, DayStatePanel } from "./DayStateControl";
import { dayStateSpoken } from "./dayStateView";

const WEEKDAYS = ["Да", "Мя", "Лх", "Пү", "Ба", "Бя", "Ня"];

type Month = { year: number; month: number };

function monthOf(ymd: string): Month {
  return { year: Number(ymd.slice(0, 4)), month: Number(ymd.slice(5, 7)) };
}

function shiftMonth({ year, month }: Month, delta: number): Month {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** The month as calendar weeks, Monday first; null pads the first and last week. */
function monthCells({ year, month }: Month): Array<string | null> {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const total = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let day = 1; day <= total; day += 1) cells.push(`${year}-${pad(month)}-${pad(day)}`);
  while (cells.length % 7) cells.push(null);
  return cells;
}

/**
 * Departure dates picked on a calendar. A trip leaves on several separate days,
 * so every click adds or removes one day — this is not a from–to range. Past
 * days cannot be picked. One more click selects every same weekday of the
 * month, because most group trips leave on the same weekday each week.
 *
 * With `onStateChange` a selected day's chip also opens its seat state (open / few seats / full);
 * the chip and the calendar day show it. A full day stays selected.
 */
export function MultiDateCalendar({
  selected,
  onChange,
  tripDays,
  disabled,
  states,
  onStateChange,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  /** Seat state per selected day (tripDayStates.dayStates). */
  states?: Record<string, DayState>;
  /** Sets one day's state; null clears it back to open. */
  onStateChange?: (day: string, next: DayState | null) => void;
  /** The trip's length in days: shows the day each departure comes back. */
  tripDays?: number;
  disabled?: boolean;
}) {
  const today = useMemo(() => mongoliaToday(), []);
  const days = useMemo(() => selected.filter(isYmd).sort(), [selected]);
  const [view, setView] = useState<Month>(() => monthOf(days.find((day) => day >= today) || days[0] || today));
  const [lastPicked, setLastPicked] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const uid = useId();
  const chipId = (day: string) => `${uid}-day-${day}`;
  const closeEditor = () => {
    const day = editing;
    setEditing(null);
    if (day) window.setTimeout(() => document.getElementById(chipId(day))?.focus(), 0);
  };
  const cells = useMemo(() => monthCells(view), [view]);
  const chosen = new Set(days);
  const canGoBack = `${view.year}-${pad(view.month)}` > today.slice(0, 7);

  const toggle = (ymd: string) => {
    if (chosen.has(ymd)) {
      onChange(days.filter((day) => day !== ymd));
      setLastPicked(null);
      if (editing === ymd) setEditing(null);
    } else {
      onChange([...days, ymd].sort());
      setLastPicked(ymd);
    }
  };

  // "Every Saturday of this month": offered for the weekday just picked.
  const anchor = lastPicked && monthOf(lastPicked).year === view.year && monthOf(lastPicked).month === view.month ? lastPicked : null;
  const sameWeekday = anchor
    ? cells.filter((cell): cell is string => !!cell && cell >= today && weekdayOf(cell) === weekdayOf(anchor) && !chosen.has(cell))
    : [];

  return (
    <div className="grid min-w-0 gap-6 sm:grid-cols-[20rem_minmax(0,1fr)]">
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center justify-between">
          <button type="button" disabled={disabled || !canGoBack} onClick={() => setView((current) => shiftMonth(current, -1))}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken disabled:opacity-30" aria-label="Өмнөх сар">
            <Icons.chevronLeft size={16} />
          </button>
          <p className="text-[15px] font-semibold text-ink" aria-live="polite">{view.year} оны {view.month}-р сар</p>
          <button type="button" disabled={disabled} onClick={() => setView((current) => shiftMonth(current, 1))}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken disabled:opacity-30" aria-label="Дараах сар">
            <Icons.chevronRight size={16} />
          </button>
        </div>
        <div className="mt-2 grid grid-cols-7 gap-y-1 text-center" role="grid" aria-label="Гарах өдөр сонгох календарь">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday} className="flex h-7 items-center justify-center text-[12px] font-semibold text-ink-muted">{weekday}</span>
          ))}
          {cells.map((cell, index) => {
            if (!cell) return <span key={`pad-${index}`} />;
            const on = chosen.has(cell);
            const past = cell < today;
            const state = on ? states?.[cell] : undefined;
            return (
              <button
                key={cell}
                type="button"
                role="gridcell"
                aria-selected={on}
                aria-label={`${formatYmd(cell)}, ${weekdayOf(cell)}${on ? ` — сонгосон${dayStateSpoken(state)}` : ""}`}
                disabled={disabled || (past && !on)}
                onClick={() => toggle(cell)}
                className={cx(
                  "relative mx-auto flex h-9 w-9 items-center justify-center rounded-full text-[15px] tabular-nums transition-colors",
                  on ? "bg-brand font-semibold text-white hover:bg-brand-hover"
                    : past ? "text-ink-subtle/60"
                      : "text-ink hover:bg-brand-soft hover:text-brand",
                  !on && cell === today && "ring-1 ring-inset ring-brand/50",
                )}
              >
                {Number(cell.slice(8))}
                <DayStateDot state={state} />
              </button>
            );
          })}
        </div>
        {sameWeekday.length > 0 && anchor && (
          <button type="button" disabled={disabled} onClick={() => { onChange([...days, ...sameWeekday].sort()); setLastPicked(null); }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-brand-border px-2 py-1.5 text-[13px] font-medium text-brand transition-colors hover:bg-brand-soft">
            <Icons.plus size={13} /> Энэ сарын бүх {weekdayOf(anchor)} гарагийг нэмэх ({sameWeekday.length})
          </button>
        )}
      </div>

      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">
          {days.length ? `Сонгосон ${days.length} өдөр` : <span className="font-normal text-ink-muted">Календариас гарах өдрөө дарж сонгоно. Хэдэн ч өдөр сонгож болно.</span>}
        </p>
        {days.length > 0 && onStateChange && (
          <p className="mt-0.5 text-[13px] leading-5 text-ink-muted">Өдөр дээр дарж «Цөөн суудал» эсвэл «Дүүрсэн» гэж тэмдэглэнэ.</p>
        )}
        {days.length > 0 && (
          <ul className="mt-2.5 flex flex-wrap gap-2" aria-label="Сонгосон гарах өдрүүд">
            {days.map((day) => {
              const state = states?.[day];
              const open = editing === day;
              return (
                <li key={day} className={cx("inline-flex min-h-9 max-w-full items-center gap-1 rounded-[18px] border py-0.5 pl-3 pr-1 text-[14px] font-medium",
                  open ? "border-brand bg-brand-soft text-brand ring-2 ring-brand/20"
                    : state?.state === "full" ? "border-danger/35 bg-danger-soft text-danger"
                      : day < today ? "border-warning/40 bg-warning-soft text-warning" : "border-brand-border bg-brand-soft text-brand")}>
                  <button type="button" id={chipId(day)} className="flex min-w-0 items-center gap-1.5 rounded-md text-left hover:underline"
                    aria-expanded={onStateChange ? open : undefined}
                    aria-label={onStateChange ? `${formatYmd(day)}, ${weekdayOf(day)}${dayStateSpoken(state)}. Суудлын төлөв солих` : undefined}
                    title={onStateChange ? "Суудлын төлөв солих" : "Календарьт харах"}
                    onClick={() => { setView(monthOf(day)); if (onStateChange) setEditing(open ? null : day); }}>
                    <span className="min-w-0">{formatYmd(day)} · {weekdayOf(day)}</span>
                    <DayStateBadge state={state} />
                    {onStateChange && <Icons.chevronRight size={13} className={cx("shrink-0 transition-transform", open ? "-rotate-90" : "rotate-90")} />}
                  </button>
                  <button type="button" disabled={disabled} onClick={() => toggle(day)} aria-label={`${formatYmd(day)} хасах`}
                    className="flex h-7 w-7 items-center justify-center rounded-full transition-colors hover:bg-danger-soft hover:text-danger">
                    <Icons.close size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {editing && chosen.has(editing) && onStateChange && (
          <DayStatePanel dayLabel={`${formatYmd(editing)} · ${weekdayOf(editing)}`} state={states?.[editing]} disabled={disabled}
            onChange={(next) => onStateChange(editing, next)} onClose={closeEditor} />
        )}
        {days.length > 0 && tripDays && tripDays > 1 && (
          <p className="mt-3 text-[13px] leading-5 text-ink-muted">
            {formatYmd(days[0])}-нд гарвал <span className="font-medium text-ink">{formatYmd(addDaysYmd(days[0], tripDays - 1))}</span>-нд буцаж ирнэ ({tripDays} өдөр).
          </p>
        )}
      </div>
    </div>
  );
}
