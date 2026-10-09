import { Icons, cx } from "@/components/ui";
import type { ItineraryDayMeals } from "@/lib/adminTypes";

const MEALS = [
  ["breakfast", "Өглөөний цай"],
  ["lunch", "Өдрийн хоол"],
  ["dinner", "Оройн хоол"],
] as const;

/** The day's photo, shown for reference. It is added or changed in the Poster tab. */
export function DayPhotoPreview({ photo, title }: { photo?: string; title: string }) {
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
      <p className="text-xs text-ink-muted">Энэ өдрийн зураг. Солих эсвэл нэмэхийг Постер таб дээр хийнэ.</p>
    </div>
  );
}

/** Breakfast / lunch / dinner as three toggle chips: filled with a check when included, dashed when not. */
export function DayMealToggles({
  meals,
  onToggle,
}: {
  meals?: ItineraryDayMeals;
  onToggle: (key: keyof ItineraryDayMeals) => void;
}) {
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-xs font-medium text-ink-muted">Багтсан хоол</p>
      <div className="flex flex-wrap gap-2">
        {MEALS.map(([key, label]) => {
          const on = Boolean(meals?.[key]);
          return (
            <button
              key={key}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(key)}
              className={cx(
                "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors",
                on
                  ? "border-brand bg-brand-soft text-brand"
                  : "border-dashed border-line-strong bg-surface text-ink-muted hover:border-brand hover:text-ink",
              )}
            >
              <span
                className={cx(
                  "flex h-4 w-4 items-center justify-center rounded-full",
                  on ? "bg-brand text-white" : "border border-line-strong",
                )}
                aria-hidden="true"
              >
                {on && <Icons.check size={11} />}
              </span>
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
