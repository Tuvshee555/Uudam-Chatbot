import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { MAX_DATE_SEATS, parseDateSeats } from "../../../lib/departureSeats";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";
import { changeDepartureState, type DateSeatState } from "../../../lib/websiteTripSync";

const STATES: DateSeatState[] = ["open", "low", "full"];
const STATE_OF_STATUS: Record<string, DateSeatState | "paused"> = { OPEN: "open", ALMOST_FULL: "low", SOLD_OUT: "full", PAUSED: "paused" };

/**
 * One date's seats: its state ("open", "low" = few seats left on that date only, "full") and/or
 * its seat count (a number, or null to clear it). Written to the website's departure row, which
 * the website and the bot read, so the change shows up on all three at once. A count alone also
 * decides the state: none left = full, seats on a full date reopen it.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({ route: "api.admin.departure_seats", method: req.method, url: req.url });
  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.departure_seats");
    if (!allowed) return;
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    const body = (req.body || {}) as Record<string, unknown>;
    const { tripId, date, state } = body;
    if (typeof tripId !== "string" || !tripId.trim()) return res.status(400).json({ error: "tripId is required" });
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const hasState = state !== undefined && state !== null;
    if (hasState && (typeof state !== "string" || !STATES.includes(state as DateSeatState))) return res.status(400).json({ error: "state must be open, low or full" });
    const hasSeats = "seats" in body;
    const seats = hasSeats ? parseDateSeats(body.seats) : undefined;
    if (hasSeats && seats === undefined) return res.status(400).json({ error: `seats must be a whole number from 0 to ${MAX_DATE_SEATS}, or empty` });
    if (!hasState && !hasSeats) return res.status(400).json({ error: "state or seats is required" });
    // A date cannot be full with seats left, nor open with none.
    if (hasState && typeof seats === "number") {
      if (state === "full" && seats > 0) return res.status(400).json({ error: "a full date has no seats left" });
      if (state !== "full" && seats === 0) return res.status(400).json({ error: "no seats left means the date is full" });
    }
    if (!process.env.BOOKING_DATABASE_URL) return res.status(503).json({ error: "website_database_not_configured" });
    const change = await changeDepartureState(tripId.trim(), date, hasState ? (state as DateSeatState) : null, seats);
    const row = change.rows[0];
    if (!row) return res.status(404).json({ error: "departure_not_found" });
    return res.status(200).json({ ok: true, tripId, date, state: STATE_OF_STATUS[row.after_status] ?? "open", seats: row.after_seats_left });
  } catch {
    return res.status(500).json({ error: "failed_to_update_departure" });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {});
  }
}
