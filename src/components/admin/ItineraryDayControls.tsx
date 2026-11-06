import { Icons, cx } from "@/components/ui";
import type { ItineraryDayMeals } from "@/lib/adminTypes";

const MEALS = [
  ["breakfast", "Өглөөний цай"],
  ["lunch", "Өдрийн хоол"],
  ["dinner", "Оройн хоол"],
] as const;

type MealKey = keyof ItineraryDayMeals;
type MealValue = boolean | null | undefined;

/**
 * One click moves a meal on: not stated → included → own cost → included …
 * "Not stated" (null) only ever comes from a file that does not mention the meal;
 * once someone sets it, it stays a yes or a no. Until 2026-11-05 the editor had
 * two states and a "not stated" meal became "included" on the first click.
 */
export function nextMeal(value: MealValue): boolean {
  return value === true ? false : true;
}

const STATE_TEXT = (value: MealValue) => (value === true ? "багтсан" : value === false ? "өөрийн зардлаар" : "файлд дурдаагүй");

/** The day's photo, shown for reference. It is added or changed in the Poster tab. */
export function DayPhotoPreview({ photo, title, note }: { photo?: string; title: string; note?: string }) {
  if (!photo) return null;
  return (
    <div className="mt-3 flex items-center gap-3">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={photo}
        alt={title}
        loading="lazy"
        className="h-20 w-32 shrink-0 rounded-lg border border-line object-cover"
      />
      <p className="text-xs text-ink-muted">{note ?? "Энэ өдрийн зураг. Солих эсвэл нэмэхийг Постер таб дээр хийнэ."}</p>
    </div>
  );
}

/** Breakfast / lunch / dinner as three chips: ✓ included, ✕ at the traveller's cost, ? not stated by the source. */
export function DayMealToggles({
  meals,
  onChange,
  disabled,
}: {
  meals?: ItineraryDayMeals | Record<string, MealValue>;
  onChange: (key: MealKey, next: boolean) => void;
  disabled?: boolean;
}) {
  const values = (meals || {}) as Record<string, MealValue>;
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-ink-muted">Хоол <span className="font-normal text-ink-subtle">· дарж солино: багтсан ⇄ өөрийн зардлаар</span></p>
      <div className="flex flex-wrap gap-2">
        {MEALS.map(([key, label]) => {
          const value = values[key];
          const on = value === true;
          const off = value === false;
          return (
            <button
              key={key}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              aria-label={`${label}: ${STATE_TEXT(value)}`}
              title={`${label}: ${STATE_TEXT(value)}`}
              onClick={() => onChange(key, nextMeal(value))}
              className={cx(
                "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors disabled:cursor-default disabled:opacity-70",
                on ? "border-brand bg-brand-soft text-brand"
                  : off ? "border-line-strong bg-surface text-ink-muted hover:border-brand hover:text-ink"
                    : "border-dashed border-line-strong bg-surface text-ink-subtle hover:border-brand hover:text-ink",
              )}
            >
              <span
                className={cx(
                  "flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-bold",
                  on ? "bg-brand text-white" : off ? "bg-surface-sunken text-ink-muted" : "border border-dashed border-line-strong",
                )}
                aria-hidden="true"
              >
                {on ? <Icons.check size={11} /> : off ? <Icons.close size={9} /> : "?"}
              </span>
              {label}
              <span className="text-[11px] font-normal opacity-75">{on ? "" : off ? "· өөрөө" : "· дурдаагүй"}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
