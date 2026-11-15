/**
 * Which WINDOW of time a message asks about, when that window is a holiday's.
 *
 * "Цагаан сарын үеэр" becomes the real days of the coming Tsagaan Sar and a search window around
 * them (holidayCalendar.ts), and requestedDepartureScope reads it like a typed date range. A date
 * or month typed in the same message wins over the holiday ("12 сарын 30-нд … шинэ он"): then the
 * window is the date, and the holiday only says what the customer is travelling around.
 *
 * Kept apart from holidayCalendar.ts (which travelDates.ts imports) so it can read both.
 */

import { resolveHoliday, type HolidayResolution } from "./holidayCalendar";
import { requestedDepartureScope } from "./travelDates";

export type ResolvedHolidayWindow = Extract<HolidayResolution, { status: "resolved" }>;

/**
 * The resolved holiday when the departure window of `text` IS that holiday's window; null when the
 * message names no holiday, the holiday's dates are not published, or an explicit date / month /
 * range in the message took precedence over it.
 */
export function holidayWindowOf(text: string, now = new Date()): ResolvedHolidayWindow | null {
  const resolved = resolveHoliday(text, now);
  if (resolved?.status !== "resolved") return null;
  const scope = requestedDepartureScope(text, now);
  if (!scope || scope.kind !== "range") return null;
  return scope.startYmd === resolved.window[0] && scope.endYmd === resolved.window[1] ? resolved : null;
}
