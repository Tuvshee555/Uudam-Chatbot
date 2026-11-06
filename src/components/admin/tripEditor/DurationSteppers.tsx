import { formatDuration, parseDuration } from "../TripEditorParts";
import { CountInput } from "./parts";

/** Nights are always fewer than days ("5 өдөр 7 шөнө" is refused at save and the bot drops the nights). */
export function clampNights(days: number | null | undefined, nights: number | null | undefined): number | null {
  if (nights == null) return null;
  return days == null ? Math.max(0, nights) : Math.max(0, Math.min(nights, days - 1));
}

/**
 * Days and nights as two steppers ("9 өдөр 8 шөнө"). Nights follow days (one
 * fewer) until someone changes them by hand, and never reach the day count. The
 * same control in the trip editor and in the AI review of a trip read from a file.
 */
export function DurationSteppers({ value, onChange, missing, disabled }: { value: string; onChange: (text: string) => void; missing?: boolean; disabled?: boolean }) {
  const { days, nights } = parseDuration(value || "");
  return (
    <div className="grid grid-cols-2 gap-2" aria-disabled={disabled}>
      <CountInput ariaLabel="Өдөр" unit="өдөр" min={1} max={60} value={days} missing={missing} onChange={(next) => {
        if (disabled) return;
        const nightsFollowed = nights == null || days == null || nights === days - 1;
        onChange(formatDuration(next, nightsFollowed && next != null ? Math.max(0, next - 1) : clampNights(next, nights)));
      }} />
      <CountInput ariaLabel="Шөнө" unit="шөнө" min={0} max={days != null ? Math.max(0, days - 1) : 60} value={nights} missing={missing}
        onChange={(next) => { if (!disabled) onChange(formatDuration(days, clampNights(days, next))); }} />
    </div>
  );
}

/** "9 өдөр 8 шөнө" after the program gained or lost `delta` days: both numbers move together. */
export function shiftDuration(value: string, dayCount: number, delta: number): string {
  const { nights } = parseDuration(value || "");
  return formatDuration(dayCount, nights == null ? Math.max(0, dayCount - 1) : clampNights(dayCount, nights + delta));
}
