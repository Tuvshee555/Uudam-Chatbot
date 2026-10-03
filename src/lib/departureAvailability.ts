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
  const status = !allClosed ? trip.status
    : future.every((row) => row.status === "SOLD_OUT" || row.seatsLeft === 0) ? "sold_out"
      : future.every((row) => row.status === "CANCELLED") ? "cancelled" : "paused";
  return { ...trip, departure_dates: dates,
    status };
}
