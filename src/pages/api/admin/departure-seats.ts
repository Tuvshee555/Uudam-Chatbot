import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";
import { setDepartureSeatState, type DateSeatState } from "../../../lib/websiteTripSync";

const STATES: DateSeatState[] = ["open", "low", "full"];

/**
 * One date's seat state: "open", "low" (few seats left, that date only) or
 * "full". Written to the website's departure row, which the website and the
 * bot read, so the change shows up on all three at once.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({ route: "api.admin.departure_seats", method: req.method, url: req.url });
  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.departure_seats");
    if (!allowed) return;
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    const { tripId, date, state } = (req.body || {}) as Record<string, unknown>;
    if (typeof tripId !== "string" || !tripId.trim()) return res.status(400).json({ error: "tripId is required" });
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    if (typeof state !== "string" || !STATES.includes(state as DateSeatState)) return res.status(400).json({ error: "state must be open, low or full" });
    if (!process.env.BOOKING_DATABASE_URL) return res.status(503).json({ error: "website_database_not_configured" });
    const updated = await setDepartureSeatState(tripId.trim(), date, state as DateSeatState);
    if (!updated) return res.status(404).json({ error: "departure_not_found" });
    return res.status(200).json({ ok: true, tripId, date, state });
  } catch {
    return res.status(500).json({ error: "failed_to_update_departure" });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {});
  }
}
