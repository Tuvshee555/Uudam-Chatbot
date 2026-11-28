import { parseDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelTypes";

export type DepartureAvailability = { date: string; status: string; seatsLeft: number | null };

export function departureAvailability(trip: TravelTrip): DepartureAvailability[] {
  const rows = trip.extra?.website_departure_availability;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is DepartureAvailability => Boolean(row && typeof row === "object" &&
    typeof row.date === "string" && typeof row.status === "string"));
}

export function departureIsClosed(row: DepartureAvailability): boolean {
  return ["SOLD_OUT", "PAUSED", "CANCELLED", "DEPARTED"].includes(row.status) || row.seatsLeft === 0;
}

export function withBookableDepartureDates(trip: TravelTrip, now = new Date()): TravelTrip {
  const rows = departureAvailability(trip);
  if (!rows.length) return trip;
  const closed = new Set(rows.filter(departureIsClosed).map((row) => row.date));
  const resolved = trip.extra?.departure_dates_resolved;
  const dates = trip.departure_dates.flatMap((text) => {
    const frozen = Array.isArray(resolved) ? resolved.find((row) => row?.text === text)?.ymd : null;
    const parsed = frozen ? [frozen] : parseDepartureDateText(text, now);
    if (!parsed.length || parsed.every((date) => !closed.has(date))) return [text];
    return parsed.filter((date) => !closed.has(date));
  });
  const future = rows.filter((row) => row.date >= now.toISOString().slice(0, 10));
  const allClosed = trip.status === "active" && future.length > 0 && future.every(departureIsClosed);
  // Cancelled rows do not decide between full and paused: copied-year rows (a weekly trip's September dates
  // repeated into later years, all CANCELLED) next to departures that are all SOLD_OUT read as "paused", and the
  // customer was told the trip was inactive while staff said it was full (live 2026-11-17).
  const held = future.filter((row) => row.status !== "CANCELLED");
  const status = !allClosed ? trip.status
    : !held.length ? "cancelled"
      : held.every((row) => row.status === "SOLD_OUT" || row.seatsLeft === 0) ? "sold_out" : "paused";
  return { ...trip, departure_dates: dates,
    status };
}

/**
 * A date shows its seat count to customers only at this many seats left or fewer (owner, 2026-11-28); a bigger
 * count is the admin's own tally. Same number as the website's SHOW_SEATS_AT_MOST (uudam-booking-web/src/lib/departures.ts).
 */
export const SHOW_SEATS_AT_MOST = 10;

/** The seat count a customer may see (1..SHOW_SEATS_AT_MOST), or null. */
export function shownSeatsLeft(seatsLeft: number | null | undefined): number | null {
  return typeof seatsLeft === "number" && Number.isInteger(seatsLeft) && seatsLeft > 0 && seatsLeft <= SHOW_SEATS_AT_MOST ? seatsLeft : null;
}

/** Few seats on this one date and still bookable: staff picked «Цөөн суудал», or typed 10 or fewer seats left. */
export function departureIsLow(row: DepartureAvailability): boolean {
  return !departureIsClosed(row) && (row.status === "ALMOST_FULL" || shownSeatsLeft(row.seatsLeft) !== null);
}

/** Upcoming dates with few seats (the flag, or a count of 10 or fewer). */
export function lowSeatDates(trip: TravelTrip, today = new Date().toISOString().slice(0, 10)): Set<string> {
  return new Set(departureAvailability(trip).filter((row) => row.date >= today && departureIsLow(row)).map((row) => row.date));
}

/** The note beside one date: "4 суудал үлдсэн" (10 or fewer typed), "цөөн суудал" (the flag alone), or "". */
export function dateSeatNote(trip: TravelTrip, date: string): string {
  const row = departureAvailability(trip).find((entry) => entry.date === date);
  if (!row || !departureIsLow(row)) return "";
  const shown = shownSeatsLeft(row.seatsLeft);
  return shown !== null ? `${shown} суудал үлдсэн` : "цөөн суудал";
}

/** How a bookable date's availability reads in a reply: open, "N суудал үлдсэн" (10 or fewer), or few seats. */
export function openDateWording(availability: { seatsLeft: number | null; low?: boolean }): string {
  const shown = shownSeatsLeft(availability.seatsLeft);
  if (shown !== null) return `захиалга нээлттэй, ${shown} суудал үлдсэн`;
  if (availability.low) return "захиалга нээлттэй, цөөн суудал үлдсэн";
  return "захиалга нээлттэй";
}
