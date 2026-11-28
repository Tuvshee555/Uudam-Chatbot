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
 * Owner, 2026-11-28 (second rule that day): every seat count staff type for a date is shown to customers, on the
 * website and by the bot. A date with no count shows none, and a seat question about it goes to the consultant.
 * The state staff pick («Цөөн суудал») is shown next to the number, independently of it.
 */
export function shownSeatsLeft(seatsLeft: number | null | undefined): number | null {
  return typeof seatsLeft === "number" && Number.isInteger(seatsLeft) && seatsLeft > 0 ? seatsLeft : null;
}

/** Staff picked «Цөөн суудал» for this one date and it is still bookable. A count alone never sets it. */
export function departureIsLow(row: DepartureAvailability): boolean {
  return !departureIsClosed(row) && row.status === "ALMOST_FULL";
}

/** Upcoming dates staff marked «Цөөн суудал». */
export function lowSeatDates(trip: TravelTrip, today = new Date().toISOString().slice(0, 10)): Set<string> {
  return new Set(departureAvailability(trip).filter((row) => row.date >= today && departureIsLow(row)).map((row) => row.date));
}

/** The seat note beside one bookable date: "цөөн суудал", "19 суудал үлдсэн", both ("цөөн суудал, 19 суудал үлдсэн"), or "". */
export function dateSeatNote(trip: TravelTrip, date: string): string {
  const row = departureAvailability(trip).find((entry) => entry.date === date);
  if (!row || departureIsClosed(row)) return "";
  const shown = shownSeatsLeft(row.seatsLeft);
  return [departureIsLow(row) ? "цөөн суудал" : "", shown !== null ? `${shown} суудал үлдсэн` : ""].filter(Boolean).join(", ");
}

/** How a bookable date's availability reads in a reply: open, plus «цөөн суудал» when picked, plus the count when typed. */
export function openDateWording(availability: { seatsLeft: number | null; low?: boolean }): string {
  const shown = shownSeatsLeft(availability.seatsLeft);
  return ["захиалга нээлттэй", availability.low ? "цөөн суудал үлдсэн" : "", shown !== null ? `${shown} суудал үлдсэн` : ""].filter(Boolean).join(", ");
}
