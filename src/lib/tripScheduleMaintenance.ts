/**
 * Auto-archive / auto-reactivate of a trip by its departure dates, and the
 * write that makes it durable. Moved out of travelDb.ts (listTrips and
 * getTripById call it) so that file stays under the 2,000-line cap; travelDb
 * re-exports sanitizeTripScheduleForCurrentDate for its existing importers.
 */
import { waitUntil } from "@vercel/functions";
import { queryNeon } from "./neonDb";
import { flushWebsiteSync } from "./websiteTripSync";
import { parseTripDepartureDateText, prunePastDepartureDates, type ResolvedDepartureDate } from "./travelDates";
import { normalizeExtra } from "./tripExtraSchema";
import type { TravelTrip } from "./travelTypes";

function cloneExtra(extra: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(extra || {})) as Record<string, unknown>;
}

const DEADLINE = /(\d{1,2})\s*[/.]\s*(\d{1,2})\s*-?\s*(?:аас|ээс|оос|өөс|с)?\s*(?:өмнө|хүртэл)/iu;
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * The last day of a trip sold on request until a deadline ("12/15-аас өмнөх өдрүүдэд хамт олны захиалгаар"):
 * only when the trip has no departure date at all, and the deadline's year is written in the trip's own
 * name or notes ("… - 2026-12-15-с өмнөх …"); a yearless deadline is never guessed. Null otherwise.
 */
export function requestWindowEnd(trip: TravelTrip): string | null {
  const texts = (trip.departure_dates || []).map((value) => String(value || ""));
  if (!texts.length || texts.some((value) => parseTripDepartureDateText(value).length)) return null;
  const extra = (trip.extra || {}) as Record<string, unknown>;
  const own = [trip.route_name, trip.notes, ...(Array.isArray(extra.important_notes) ? extra.important_notes.map(String) : [])].join(" ");
  for (const value of texts) {
    const match = DEADLINE.exec(value);
    if (!match) continue;
    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = new RegExp(`(20\\d{2})\\s*[-./]\\s*0?${month}\\s*[-./]\\s*0?${day}(?!\\d)`).exec(own)?.[1]
      || new RegExp(`(20\\d{2})\\s*оны\\s*0?${month}\\s*(?:-?р\\s*)?сарын\\s*0?${day}(?!\\d)`, "iu").exec(own)?.[1];
    if (year) return `${year}-${pad2(month)}-${pad2(day)}`;
  }
  return null;
}

export function sanitizeTripScheduleForCurrentDate(
  trip: TravelTrip,
  now = new Date(),
): { trip: TravelTrip; changed: boolean } {
  const extra = cloneExtra((trip.extra || {}) as Record<string, unknown>);
  const resolved = extra.departure_dates_resolved as ResolvedDepartureDate[] | undefined;
  const pruned = prunePastDepartureDates(trip.departure_dates || [], now, resolved);
  let nextExtra = extra;
  let changed = false;

  let nextStatus = trip.status;
  const missingDepartureDates = (trip.departure_dates || []).length === 0;
  if (trip.status === "active" && (pruned.shouldArchive || missingDepartureDates)) {
    nextStatus = "archived";
    nextExtra = {
      ...nextExtra,
      archived_reason: missingDepartureDates ? "no_departure_dates" : "all_departure_dates_passed",
      archived_at: now.toISOString(),
    };
    changed = true;
  }
  // A trip sold on request until a deadline closes after it (its own reason: it never reopens by itself).
  const windowEnd = trip.status === "active" && nextStatus === "active" ? requestWindowEnd(trip) : null;
  if (windowEnd && new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10) > windowEnd) {
    nextStatus = "archived";
    nextExtra = { ...nextExtra, archived_reason: "request_window_passed", archived_at: now.toISOString() };
    changed = true;
  }
  if (
    trip.status === "archived" &&
    (extra.archived_reason === "all_departure_dates_passed" ||
      extra.archived_reason === "no_departure_dates") &&
    pruned.dates.length > 0
  ) {
    nextStatus = "active";
    nextExtra = { ...nextExtra, reactivated_at: now.toISOString() };
    delete nextExtra.archived_reason;
    delete nextExtra.archived_at;
    changed = true;
  }

  if (!changed) return { trip, changed: false };
  return {
    trip: {
      ...trip,
      status: nextStatus,
      extra: normalizeExtra(nextExtra).extra,
    },
    changed: true,
  };
}

export async function persistTripScheduleMaintenance(trips: TravelTrip[]): Promise<void> {
  if (trips.length === 0) return;

  for (const trip of trips) {
    try {
      await queryNeon(
        `
          UPDATE travel_trip_entries
          SET departure_dates = $1::text[], status = $2, extra = $3::jsonb
          WHERE id = $4
            AND (
              departure_dates IS DISTINCT FROM $1::text[]
              OR status IS DISTINCT FROM $2
              OR extra IS DISTINCT FROM $3::jsonb
            )
        `,
        [trip.departure_dates, trip.status, JSON.stringify(trip.extra || {}), trip.id],
      );
    } catch (error) {
      console.error("Persisting trip schedule maintenance failed", error);
      continue;
    }
    try {
      await flushWebsiteSync(trip.id, 1);
    } catch (error) {
      console.error("Website sync after trip schedule maintenance failed", error);
    }
  }
}

/**
 * listTrips() runs on every customer message (fast-path + AI trip lookup), so
 * the DB write and cross-database website sync that make an auto-archive or
 * auto-reactivate durable must never block that reply — the caller already
 * has the correctly-sanitized trips in memory for this response regardless.
 * The daily reminder cron re-runs listTrips() independently as a backstop, so
 * a customer message that never lands (traffic dies right after this fires)
 * still gets the maintenance persisted within a day either way.
 */
export function schedulePersistTripScheduleMaintenance(trips: TravelTrip[]): void {
  if (trips.length === 0) return;
  const work = persistTripScheduleMaintenance(trips).catch((error) =>
    console.error("Trip schedule maintenance failed", error),
  );
  try {
    waitUntil(work);
  } catch {
    // Not running on Vercel (tests, local node) — detached execution is fine.
    void work;
  }
}
