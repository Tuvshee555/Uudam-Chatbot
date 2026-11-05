import { useMemo, useState } from "react";
import { Icons, cx } from "@/components/ui";
import { addDaysYmd, formatYmd, isYmd, mongoliaToday, weekdayOf } from "@/lib/tripReview";

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
 */
export function MultiDateCalendar({
  selected,
  onChange,
  tripDays,
  disabled,
}: {
  selected: string[];
  onChange: (next: string[]) => void;
  /** The trip's length in days: shows the day each departure comes back. */
  tripDays?: number;
  disabled?: boolean;
}) {
  const today = useMemo(() => mongoliaToday(), []);
  const days = useMemo(() => selected.filter(isYmd).sort(), [selected]);
  const [view, setView] = useState<Month>(() => monthOf(days.find((day) => day >= today) || days[0] || today));
  const [lastPicked, setLastPicked] = useState<string | null>(null);
  const cells = useMemo(() => monthCells(view), [view]);
  const chosen = new Set(days);
  const canGoBack = `${view.year}-${pad(view.month)}` > today.slice(0, 7);

  const toggle = (ymd: string) => {
    if (chosen.has(ymd)) {
      onChange(days.filter((day) => day !== ymd));
      setLastPicked(null);
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
    <div className="grid min-w-0 gap-5 sm:grid-cols-[19rem_minmax(0,1fr)]">
      <div className="rounded-lg border border-line bg-surface p-3">
        <div className="flex items-center justify-between">
          <button type="button" disabled={disabled || !canGoBack} onClick={() => setView((current) => shiftMonth(current, -1))}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken disabled:opacity-30" aria-label="Өмнөх сар">
            <Icons.chevronLeft size={16} />
          </button>
          <p className="text-sm font-semibold text-ink" aria-live="polite">{view.year} оны {view.month}-р сар</p>
          <button type="button" disabled={disabled} onClick={() => setView((current) => shiftMonth(current, 1))}
            className="flex h-8 w-8 items-center justify-center rounded-md text-ink-muted transition-colors hover:bg-surface-sunken disabled:opacity-30" aria-label="Дараах сар">
            <Icons.chevronRight size={16} />
          </button>
        </div>
        <div className="mt-2 grid grid-cols-7 gap-y-1 text-center" role="grid" aria-label="Гарах өдөр сонгох календарь">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday} className="flex h-7 items-center justify-center text-[11px] font-semibold uppercase tracking-wide text-ink-subtle">{weekday}</span>
          ))}
          {cells.map((cell, index) => {
            if (!cell) return <span key={`pad-${index}`} />;
            const on = chosen.has(cell);
            const past = cell < today;
            return (
              <button
                key={cell}
                type="button"
                role="gridcell"
                aria-selected={on}
                aria-label={`${formatYmd(cell)}, ${weekdayOf(cell)}${on ? " — сонгосон" : ""}`}
                disabled={disabled || (past && !on)}
                onClick={() => toggle(cell)}
                className={cx(
                  "mx-auto flex h-9 w-9 items-center justify-center rounded-full text-sm tabular-nums transition-colors",
                  on ? "bg-brand font-semibold text-white hover:bg-brand-hover"
                    : past ? "text-ink-subtle/50"
                      : "text-ink hover:bg-brand-soft hover:text-brand",
                  !on && cell === today && "ring-1 ring-inset ring-brand/50",
                )}
              >
                {Number(cell.slice(8))}
              </button>
            );
          })}
        </div>
        {sameWeekday.length > 0 && anchor && (
          <button type="button" disabled={disabled} onClick={() => { onChange([...days, ...sameWeekday].sort()); setLastPicked(null); }}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-brand-border px-2 py-1.5 text-xs font-medium text-brand transition-colors hover:bg-brand-soft">
            <Icons.plus size={12} /> Энэ сарын бүх {weekdayOf(anchor)} гарагийг нэмэх ({sameWeekday.length})
          </button>
        )}
      </div>

      <div className="min-w-0">
        <p className="text-xs font-medium text-ink-muted">
          {days.length ? `Сонгосон ${days.length} өдөр` : "Календариас гарах өдрөө дарж сонгоно. Хэдэн ч өдөр сонгож болно."}
        </p>
        {days.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Сонгосон гарах өдрүүд">
            {days.map((day) => (
              <li key={day} className={cx("inline-flex h-8 items-center gap-1.5 rounded-full border pl-3 pr-1 text-[13px] font-medium",
                day < today ? "border-warning/40 bg-warning-soft text-warning" : "border-brand-border bg-brand-soft text-brand")}>
                <button type="button" className="hover:underline" onClick={() => setView(monthOf(day))} title="Календарьт харах">
                  {formatYmd(day)} · {weekdayOf(day)}
                </button>
                <button type="button" disabled={disabled} onClick={() => toggle(day)} aria-label={`${formatYmd(day)} хасах`}
                  className="flex h-6 w-6 items-center justify-center rounded-full transition-colors hover:bg-danger-soft hover:text-danger">
                  <Icons.close size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {days.length > 0 && tripDays && tripDays > 1 && (
          <p className="mt-3 text-xs leading-5 text-ink-muted">
            {formatYmd(days[0])}-нд гарвал <span className="font-medium text-ink">{formatYmd(addDaysYmd(days[0], tripDays - 1))}</span>-нд буцаж ирнэ ({tripDays} өдөр).
          </p>
        )}
      </div>
    </div>
  );
}
