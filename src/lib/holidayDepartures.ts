/**
 * Which departures of a trip belong to a holiday window, most relevant first.
 *
 * One reading for everything that prints dates under a holiday question: the holiday listing
 * (catalogListing.ts), the "which trip?" fare card under it (travelFastPathsPricing.ts), and the
 * scope-aware "nothing leaves then" reply (dateNotScheduled.ts). Kept free of wording and of the
 * listing code so the pricing module can import it without a cycle.
 */

import { getTripNameHaystack } from "./travelFastPathsSearch";
import type { HolidayResolution } from "./holidayCalendar";
import { normalizeTripOffers } from "./tripOffers";
import type { TravelTrip } from "./travelTypes";

export type ResolvedHoliday = Extract<HolidayResolution, { status: "resolved" }>;

export function todayInUb(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

/** Dates a customer can still book: open or unknown, today or later, never a closed one. */
export function bookableDates(trip: TravelTrip, now: Date): string[] {
  const today = todayInUb(now);
  const availability = normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount").flatMap((offer) => offer.availability);
  const open = new Set(availability.filter((row) => row.date >= today && ["open", "unknown"].includes(row.status)).map((row) => row.date));
  for (const row of availability) if (!["open", "unknown"].includes(row.status)) open.delete(row.date);
  return [...open].sort();
}

export function tripDays(trip: TravelTrip): number | null {
  const text = trip.duration_text || "";
  const days = /(\d{1,2})\s*өдөр/iu.exec(text);
  if (days) return Number(days[1]);
  const nights = /(\d{1,2})\s*шөнө/iu.exec(text);
  return nights ? Number(nights[1]) + 1 : null;
}

export type HolidayDates = {
  /** Departures whose days touch the holiday itself (the trip is on the road during it). */
  hits: string[];
  /** Other departures inside the search window around the holiday. */
  near: string[];
  /** A trip named for the holiday keeps all of its other dates. */
  extra: string[];
  /** Every bookable departure of the trip. */
  all: string[];
  /** The trip's own title names the holiday ("… ШИНЭ ЖИЛИЙН АЯЛАЛ"). */
  namedFor: boolean;
};

/**
 * The departure dates of one trip for a holiday window: the days that touch the holiday itself, then
 * the other days inside the search window (a trip named for the holiday keeps all of its dates).
 * Pure dates, no wording.
 */
export function holidayDatesFor(trip: TravelTrip, resolution: ResolvedHoliday, now: Date): HolidayDates {
  const { period, window, ask } = resolution;
  const all = bookableDates(trip, now);
  const length = tripDays(trip) ?? 1;
  const around = ask.relation === "around";
  const namedFor = around && ask.holiday.re.test(getTripNameHaystack(trip));
  const hits = around ? all.filter((date) => date <= period.endYmd && addDays(date, length - 1) >= period.startYmd) : [];
  const near = all.filter((date) => date >= window[0] && date <= window[1] && !hits.includes(date));
  const extra = namedFor ? all.filter((date) => !hits.includes(date) && !near.includes(date)) : [];
  return { hits, near, extra, all, namedFor };
}

/**
 * The dates to print for a trip under a holiday question, calendar order: the departures that touch
 * the holiday when the trip has any (the others would only blur what "over the holiday" means), else
 * the ones inside the search window, else — a trip named for the holiday — its other dates.
 */
export function holidayDatesToShow(found: HolidayDates, limit: number): string[] {
  const pick = found.hits.length ? found.hits : found.near.length ? found.near : found.extra;
  return pick.slice(0, limit).sort();
}
