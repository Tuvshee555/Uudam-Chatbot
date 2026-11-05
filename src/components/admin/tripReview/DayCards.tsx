import { useState } from "react";
import { Icons, cx } from "@/components/ui";
import { MEAL_KEYS, MEAL_LABELS, dayMeals, nextMealState, type MealKey, type MealState } from "@/lib/tripReview";
import { isTransitDay, type ItineraryDay } from "@/lib/tripTransitDays";
import { TextArea, TextInput } from "../tripEditor/parts";

const SHORT: Record<MealKey, string> = { breakfast: "Өглөө", lunch: "Өдөр", dinner: "Орой" };
const STATE_TITLE = (state: MealState) => (state === true ? "багтсан" : state === false ? "өөрийн зардлаар" : "файлд дурдаагүй");

/** A small Cloudinary rendition (other hosts as they are). */
export function thumb(url: string, width: number, height: number): string {
  return url.includes("res.cloudinary.com/") && url.includes("/upload/")
    ? url.replace("/upload/", `/upload/c_fill,w_${width},h_${height},q_auto,f_auto/`)
    : url;
}

function MealGlyph({ state, size = 12 }: { state: MealState; size?: number }) {
  if (state === true) return <Icons.check size={size} />;
  if (state === false) return <Icons.close size={size - 1} />;
  return <span className="text-[11px] font-bold leading-none">?</span>;
}

/** The day's three meals at a glance, as the website shows them: ✓ included, ✕ own cost; a meal the file does not mention is left out. */
function MealSummary({ day }: { day: ItineraryDay }) {
  const meals = dayMeals(day);
  const stated = MEAL_KEYS.filter((key) => meals[key] !== null);
  if (!stated.length) return <span className="text-xs text-ink-subtle">хоол дурдаагүй</span>;
  return (
    <span className="flex flex-wrap items-center justify-end gap-x-2.5 gap-y-0.5 text-xs">
      {stated.map((key) => (
        <span key={key} className={cx("inline-flex items-center gap-1", meals[key] ? "font-medium text-brand" : "text-ink-subtle")} title={`${MEAL_LABELS[key]}: ${STATE_TITLE(meals[key])}`}>
          <MealGlyph state={meals[key]} size={11} />
          {SHORT[key]}
        </span>
      ))}
    </span>
  );
}

/** One meal: a click moves it included → own cost → not stated. */
function MealChip({ meal, state, onClick, disabled }: { meal: MealKey; state: MealState; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={`${MEAL_LABELS[meal]}: ${STATE_TITLE(state)}. Дарж солино.`}
      title="Дарж солино: багтсан → өөрийн зардлаар → дурдаагүй"
      className={cx(
        "inline-flex h-9 items-center gap-2 rounded-full border pl-1.5 pr-3.5 text-[13px] font-medium transition-colors disabled:cursor-default",
        state === true ? "border-brand bg-brand-soft text-brand"
          : state === false ? "border-line-strong bg-surface text-ink-muted"
            : "border-dashed border-line-strong bg-surface text-ink-subtle",
        !disabled && "hover:border-brand",
      )}
    >
      <span className={cx("flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
        state === true ? "bg-brand text-white" : state === false ? "bg-surface-sunken text-ink-muted" : "border border-dashed border-line-strong")} aria-hidden="true">
        <MealGlyph state={state} />
      </span>
      <span className="text-left leading-4">
        {MEAL_LABELS[meal]}
        <span className="block text-[11px] font-normal opacity-80">{STATE_TITLE(state)}</span>
      </span>
    </button>
  );
}

/**
 * The program, one row per day. A row shows the day's title, the start of its
 * text and its meals; opened, everything the file said about that day can be
 * corrected. The standard Ulaanbaatar days follow the transport type and are
 * not edited here.
 */
export function DayCards({ days, onChange, disabled }: { days: ItineraryDay[]; onChange: (days: ItineraryDay[]) => void; disabled?: boolean }) {
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const patch = (index: number, next: Partial<ItineraryDay>) => onChange(days.map((day, i) => (i === index ? { ...day, ...next } : day)));
  const allOpen = days.length > 0 && days.every((_, index) => open[index]);
  // Days are numbered by position: adding, moving or removing one renumbers the rest.
  const renumber = (list: ItineraryDay[]) => list.map((day, index) => ({ ...day, day: index + 1 }));
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= days.length) return;
    const next = [...days];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(renumber(next));
    setOpen((current) => ({ ...current, [index]: current[target], [target]: current[index] }));
  };
  const remove = (index: number) => {
    onChange(renumber(days.filter((_, i) => i !== index)));
    setOpen({});
  };
  const add = () => {
    // A new day goes before the standard return days, so the trip still ends in Ulaanbaatar.
    let at = days.length;
    while (at > 0 && isTransitDay(days[at - 1])) at -= 1;
    const next = [...days];
    next.splice(at, 0, { title: "", description: "", meals: { breakfast: null, lunch: null, dinner: null } });
    onChange(renumber(next));
    setOpen({ [at]: true });
  };
  const iconButton = "flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-ink-subtle transition-colors hover:bg-surface-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-30";

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1 text-brand"><Icons.check size={11} /> багтсан</span>
          <span className="inline-flex items-center gap-1"><Icons.close size={10} /> өөрийн зардлаар</span>
          <span className="inline-flex items-center gap-1 text-ink-subtle"><span className="font-bold">?</span> файлд дурдаагүй</span>
        </p>
        <button type="button" onClick={() => setOpen(allOpen ? {} : Object.fromEntries(days.map((_, index) => [index, true])))}
          className="rounded px-1.5 py-1 text-xs font-medium text-brand hover:bg-brand-soft">
          {allOpen ? "Бүгдийг хураах" : "Бүгдийг дэлгэх"}
        </button>
      </div>
      <ol className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
        {days.map((day, index) => {
          const standard = isTransitDay(day);
          const isOpen = Boolean(open[index]);
          const meals = dayMeals(day);
          const number = day.day ?? index + 1;
          return (
            <li key={index}>
              <div className="flex items-start">
              <button type="button" onClick={() => setOpen((current) => ({ ...current, [index]: !isOpen }))} aria-expanded={isOpen}
                className="flex min-w-0 flex-1 items-start gap-3 py-3 pl-3.5 pr-2 text-left transition-colors hover:bg-canvas/60">
                <span className={cx("mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold tabular-nums",
                  standard ? "bg-surface-sunken text-ink-muted" : "bg-brand text-white")}>{number}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="text-sm font-semibold text-ink">{day.title || `${number}-р өдөр`}</span>
                    {standard && <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Стандарт өдөр</span>}
                    {day.date && <span className="text-xs text-ink-subtle">файлд: {day.date}</span>}
                  </span>
                  {!isOpen && day.description && <span className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-ink-muted">{day.description}</span>}
                </span>
                {!isOpen && <span className="mt-1 hidden shrink-0 sm:block"><MealSummary day={day} /></span>}
                <Icons.chevronRight size={15} className={cx("mt-1.5 shrink-0 text-ink-subtle transition-transform", isOpen && "rotate-90")} />
              </button>
              {!standard && (
                <span className="flex shrink-0 items-center gap-0.5 py-2 pr-2">
                  <button type="button" className={iconButton} disabled={disabled || index === 0 || isTransitDay(days[index - 1])} onClick={() => move(index, -1)} aria-label={`${number}-р өдрийг дээш`} title="Дээш">
                    <Icons.chevronRight size={14} className="-rotate-90" />
                  </button>
                  <button type="button" className={iconButton} disabled={disabled || index === days.length - 1 || isTransitDay(days[index + 1])} onClick={() => move(index, 1)} aria-label={`${number}-р өдрийг доош`} title="Доош">
                    <Icons.chevronRight size={14} className="rotate-90" />
                  </button>
                  <button type="button" className={cx(iconButton, "hover:bg-danger-soft hover:text-danger")} disabled={disabled} onClick={() => remove(index)} aria-label={`${number}-р өдрийг хасах`} title="Өдрийг хасах">
                    <Icons.trash size={14} />
                  </button>
                </span>
              )}
              </div>
              {!isOpen && <div className="px-3.5 pb-2.5 pl-[3.25rem] sm:hidden"><MealSummary day={day} /></div>}

              {isOpen && (
                <div className="space-y-3 border-t border-line/70 bg-canvas/40 px-3.5 py-3.5 sm:pl-[3.25rem]">
                  {standard ? (
                    <p className="whitespace-pre-line text-[13px] leading-6 text-ink-muted">{day.description}</p>
                  ) : (
                    <>
                      <TextInput aria-label={`${number}-р өдрийн гарчиг`} value={day.title || ""} disabled={disabled} onChange={(e) => patch(index, { title: e.target.value })} />
                      <TextArea aria-label={`${number}-р өдрийн хөтөлбөр`} value={day.description || ""} disabled={disabled} onChange={(e) => patch(index, { description: e.target.value })} />
                    </>
                  )}
                  <div>
                    <div className="flex flex-wrap gap-2">
                      {MEAL_KEYS.map((meal) => (
                        <MealChip key={meal} meal={meal} state={meals[meal]} disabled={disabled || standard}
                          onClick={() => patch(index, { meals: { ...meals, [meal]: nextMealState(meals[meal]) } })} />
                      ))}
                    </div>
                    {!standard && (
                      <TextInput className="mt-2" aria-label={`${number}-р өдрийн хоолны тайлбар`} placeholder="Хоолны газар, төрөл (заавал биш) — ж: буфет" value={day.meal_note || ""} disabled={disabled}
                        onChange={(e) => patch(index, { meal_note: e.target.value })} />
                    )}
                  </div>
                  {!standard && (
                    <label className="flex items-center gap-2.5 text-[13px] text-ink-muted">
                      <span className="shrink-0">Буудал</span>
                      <TextInput aria-label={`${number}-р өдрийн буудал`} placeholder="Тухайн шөнө буудаллах газар (заавал биш)" value={day.hotel || ""} disabled={disabled} onChange={(e) => patch(index, { hotel: e.target.value })} />
                    </label>
                  )}
                  {day.photo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={thumb(day.photo, 320, 200)} alt={`${number}-р өдрийн зураг`} loading="lazy" className="h-24 w-40 rounded-lg border border-line object-cover" />
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ol>
      <button type="button" disabled={disabled} onClick={add}
        className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-md border border-dashed border-line-strong px-3 text-sm font-medium text-ink-muted transition-colors hover:border-brand hover:bg-brand-soft/40 hover:text-brand disabled:opacity-50">
        <Icons.plus size={14} /> Өдөр нэмэх
      </button>
    </div>
  );
}
