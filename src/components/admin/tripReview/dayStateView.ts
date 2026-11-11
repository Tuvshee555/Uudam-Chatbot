/**
 * How a departure day's seat state reads in the new-trip review (UI only; the data lives in
 * src/lib/tripDayStates.ts). Open with no seat count says nothing: it is the ordinary day.
 *
 * Pure.
 */
import type { DayState, SeatState } from "@/lib/tripDayStates";

export type DayStateTone = "full" | "low" | "count";

/** The badge on a day chip, or null for an ordinary open day. */
export function dayStateBadge(state: DayState | undefined): { text: string; tone: DayStateTone } | null {
  if (!state) return null;
  if (state.state === "full") return { text: "Дүүрсэн", tone: "full" };
  if (state.state === "low") return { text: state.seats !== null ? `${state.seats} суудал` : "Цөөн суудал", tone: "low" };
  return state.seats !== null ? { text: `${state.seats} суудал`, tone: "count" } : null;
}

/** The words a screen reader adds after a day ("— дүүрсэн"); empty for an ordinary open day. */
export function dayStateSpoken(state: DayState | undefined): string {
  const badge = dayStateBadge(state);
  return badge ? ` — ${badge.text.toLocaleLowerCase("mn")}` : "";
}

export const SEAT_STATE_OPTIONS: Array<{ value: SeatState; label: string }> = [
  { value: "open", label: "Нээлттэй" },
  { value: "low", label: "Цөөн суудал" },
  { value: "full", label: "Дүүрсэн" },
];

/** A seat count typed by the admin: whole and at least 1, or null (no count, just «Цөөн суудал»). */
export function seatsFromInput(raw: string): number | null {
  const digits = raw.replace(/[^\d]/g, "").slice(0, 3);
  const value = digits ? Number(digits) : NaN;
  return Number.isInteger(value) && value >= 1 ? value : null;
}

/** The state a choice in the menu sets; the seat count is kept when it still means something. */
export function chosenState(choice: SeatState, current: DayState | undefined): DayState {
  if (choice === "full") return { state: "full", seats: null };
  return { state: choice, seats: choice === "low" ? current?.seats ?? null : null };
}
