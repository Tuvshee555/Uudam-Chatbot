/**
 * The day-by-day program as a numbered timeline: open a day to edit it, move it
 * up or down, delete it (with a confirm), add one. Shared by the trip editor and
 * the AI review of a trip read from a file, so both look and behave the same.
 *
 * Days are numbered by position and renumbered on every change (the editor used
 * to leave stale `day` numbers after a move or delete). The standard Ulaanbaatar
 * days of a file-read trip are locked: they follow the transport type.
 */
import React from "react";
import { Icons, cx } from "@/components/ui";
import type { ItineraryDay } from "@/lib/adminTypes";
import { DayMealToggles, DayPhotoPreview } from "../ItineraryDayControls";
import { AddRowButton, EmptyHint, Field, Group, RemoveButton, TextArea, TextInput } from "./parts";

type Day = ItineraryDay & { meal_note?: string; date?: string };
const MEAL_SHORT: Array<[keyof NonNullable<ItineraryDay["meals"]>, string]> = [["breakfast", "Өглөө"], ["lunch", "Өдөр"], ["dinner", "Орой"]];

function renumber(days: Day[]): Day[] {
  return days.map((day, index) => ({ ...day, day: index + 1 }));
}

function MealSummary({ day }: { day: Day }) {
  const meals = (day.meals || {}) as Record<string, boolean | null | undefined>;
  const stated = MEAL_SHORT.filter(([key]) => typeof meals[key] === "boolean");
  if (!stated.length) return null;
  return (
    <span className="flex shrink-0 items-center gap-2 text-[11px]">
      {stated.map(([key, label]) => (
        <span key={key} className={cx("inline-flex items-center gap-0.5", meals[key] ? "font-semibold text-brand" : "text-ink-subtle")}>
          {meals[key] ? <Icons.check size={10} /> : <Icons.close size={9} />}{label}
        </span>
      ))}
    </span>
  );
}

export function ItineraryTimeline({
  days,
  onChange,
  locked,
  showSourceDates,
  showMealNotes,
  title,
  hint,
  photoNote,
}: {
  days: Day[];
  onChange: (days: Day[]) => void;
  /** A day that may not be edited, moved or deleted (the standard Ulaanbaatar days). */
  locked?: (day: Day) => boolean;
  /** Show the calendar date a file wrote beside each day ("файлд: 11/22"). */
  showSourceDates?: boolean;
  /** Offer a "where / what is the meal" note per day. */
  showMealNotes?: boolean;
  title?: string;
  hint?: React.ReactNode;
  photoNote?: string;
}) {
  const [open, setOpen] = React.useState<Record<number, boolean>>({});
  const isLocked = (day: Day | undefined) => Boolean(day && locked?.(day));
  const isOpen = (idx: number) => open[idx] ?? (!isLocked(days[idx]) && !days[idx]?.title);
  const patch = (idx: number, next: Partial<Day>) => onChange(days.map((day, i) => (i === idx ? { ...day, ...next } : day)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= days.length || isLocked(days[to])) return;
    const next = [...days];
    [next[from], next[to]] = [next[to], next[from]];
    onChange(renumber(next));
    setOpen((current) => ({ ...current, [from]: current[to], [to]: current[from] }));
  };
  const remove = (idx: number) => {
    if (!window.confirm(`${idx + 1}-р өдрийг хасах уу?`)) return;
    onChange(renumber(days.filter((_, i) => i !== idx)));
    setOpen({});
  };
  const add = () => {
    // A new day goes before the standard return days, so the trip still ends in Ulaanbaatar.
    let at = days.length;
    while (at > 0 && isLocked(days[at - 1])) at -= 1;
    const next = [...days];
    next.splice(at, 0, { day: at + 1, title: "", description: "", hotel: "", meals: { breakfast: null, lunch: null, dinner: null } as unknown as ItineraryDay["meals"] });
    onChange(renumber(next));
    setOpen({ [at]: true });
  };
  const allOpen = days.length > 0 && days.every((_, idx) => isOpen(idx));
  const iconButton = "rounded-md p-1.5 text-ink-subtle hover:bg-surface-sunken hover:text-ink disabled:pointer-events-none disabled:opacity-30";

  return (
    <Group
      title={title ?? `${days.length} өдөр`}
      hint={hint}
      action={
        <span className="flex items-center gap-2">
          {days.length > 1 && (
            <button type="button" onClick={() => setOpen(allOpen ? Object.fromEntries(days.map((_, i) => [i, false])) : Object.fromEntries(days.map((_, i) => [i, true])))}
              className="rounded-md px-2 py-1.5 text-xs font-medium text-brand hover:bg-brand-soft">{allOpen ? "Бүгдийг хураах" : "Бүгдийг дэлгэх"}</button>
          )}
          <AddRowButton label="Өдөр нэмэх" onClick={add} />
        </span>
      }
    >
      {days.length === 0 ? <EmptyHint>Хөтөлбөр оруулаагүй байна. «Өдөр нэмэх» дарж эхлээрэй.</EmptyHint> : (
        <ol className="relative space-y-2 before:absolute before:bottom-6 before:left-4 before:top-6 before:w-px before:bg-line" aria-label="Өдрүүд">
          {days.map((d, idx) => {
            const expanded = isOpen(idx);
            const standard = isLocked(d);
            return (
              <li key={idx} className="relative pl-12">
                <span className={cx("absolute left-0 top-2.5 flex h-8 w-8 items-center justify-center rounded-full border text-sm font-bold",
                  standard ? "border-line bg-surface-sunken text-ink-muted" : "border-line bg-surface text-brand")}>{idx + 1}</span>
                <div className={cx("rounded-lg border bg-surface", standard ? "border-dashed border-line" : "border-line")}>
                  <div className="flex items-center gap-2 py-2 pl-4 pr-2">
                    <button type="button" aria-expanded={expanded} onClick={() => setOpen((o) => ({ ...o, [idx]: !expanded }))} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                          <span className="truncate text-sm font-semibold text-ink">{d.title || "Гарчиггүй өдөр"}</span>
                          {standard && <span className="rounded bg-surface-sunken px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">Стандарт өдөр</span>}
                          {showSourceDates && d.date && <span className="text-xs text-ink-subtle">файлд: {d.date}</span>}
                        </span>
                        {!expanded && <span className="block truncate text-xs text-ink-muted">{(d.description || "").replace(/\s+/g, " ").slice(0, 140) || "Тайлбаргүй"}</span>}
                      </span>
                      {!expanded && <span className="hidden sm:block"><MealSummary day={d} /></span>}
                      <Icons.chevronRight size={16} className={cx("shrink-0 text-ink-subtle transition-transform", expanded ? "-rotate-90" : "rotate-90")} />
                    </button>
                    {!standard && (
                      <span className="hidden shrink-0 items-center border-l border-line pl-1 sm:flex">
                        <button type="button" className={iconButton} disabled={idx === 0 || isLocked(days[idx - 1])} title="Дээш зөөх" aria-label={`${idx + 1}-р өдрийг дээш зөөх`} onClick={() => move(idx, idx - 1)}><Icons.chevronRight size={14} className="-rotate-90" /></button>
                        <button type="button" className={iconButton} disabled={idx === days.length - 1 || isLocked(days[idx + 1])} title="Доош зөөх" aria-label={`${idx + 1}-р өдрийг доош зөөх`} onClick={() => move(idx, idx + 1)}><Icons.chevronRight size={14} className="rotate-90" /></button>
                        <RemoveButton label={`${idx + 1}-р өдрийг хасах`} onClick={() => remove(idx)} />
                      </span>
                    )}
                  </div>
                  {expanded && (
                    <div className="space-y-4 border-t border-line px-4 pb-4 pt-4">
                      {standard ? (
                        <p className="whitespace-pre-line text-sm leading-6 text-ink-muted">{d.description}<span className="mt-2 block text-xs text-ink-subtle">Улаанбаатараас гарах, буцах стандарт өдөр. Тээврийн төрлөөс хамаарч өөрөө солигдоно.</span></p>
                      ) : (
                        <>
                          <div className="grid gap-4 sm:grid-cols-2">
                            <Field label="Гарчиг, чиглэл"><TextInput value={d.title} placeholder="ж: НИЙСЛЭЛ – ХИЛИЙН БООМТ" onChange={(e) => patch(idx, { title: e.target.value })} /></Field>
                            <Field label="Хоноглох газар"><TextInput value={d.hotel || ""} placeholder="Буудал, галт тэрэг…" onChange={(e) => patch(idx, { hotel: e.target.value })} /></Field>
                          </div>
                          <Field label="Тайлбар"><TextArea rows={4} className="min-h-28" value={d.description} placeholder="Энэ өдөр юу хийх вэ…" onChange={(e) => patch(idx, { description: e.target.value })} /></Field>
                        </>
                      )}
                      <DayMealToggles meals={d.meals} disabled={standard} onChange={(key, next) => patch(idx, { meals: { ...(d.meals || {}), [key]: next } as ItineraryDay["meals"] })} />
                      {showMealNotes && !standard && (
                        <Field label="Хоолны тайлбар" hint="Хаана, ямар хоол (заавал биш) — ж: буфет, «Сувд» ресторан.">
                          <TextInput value={d.meal_note || ""} placeholder="ж: Буфет хоол" onChange={(e) => patch(idx, { meal_note: e.target.value })} />
                        </Field>
                      )}
                      <DayPhotoPreview photo={d.photo} title={d.title || `Өдөр ${idx + 1}`} note={photoNote} />
                      {/* On a phone the move and delete buttons live here, so the day's title has the row to itself. */}
                      {!standard && (
                        <div className="flex items-center gap-1 border-t border-line pt-3 sm:hidden">
                          <button type="button" className={cx(iconButton, "flex items-center gap-1 px-2 text-xs")} disabled={idx === 0 || isLocked(days[idx - 1])} onClick={() => move(idx, idx - 1)}><Icons.chevronRight size={13} className="-rotate-90" /> Дээш</button>
                          <button type="button" className={cx(iconButton, "flex items-center gap-1 px-2 text-xs")} disabled={idx === days.length - 1 || isLocked(days[idx + 1])} onClick={() => move(idx, idx + 1)}><Icons.chevronRight size={13} className="rotate-90" /> Доош</button>
                          <span className="ml-auto"><RemoveButton label={`${idx + 1}-р өдрийг хасах`} onClick={() => remove(idx)} /></span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Group>
  );
}
