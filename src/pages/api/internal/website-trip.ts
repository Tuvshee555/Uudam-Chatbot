import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "@/lib/env";
import { safeSecretCompare } from "@/lib/adminAuth";
import { deleteTrip, getTripById, patchTrip, upsertTrip } from "@/lib/travelDb";
import { websiteTripPatch, websiteTripToCanonicalFields } from "@/lib/websiteTripBridge";

/**
 * Private website -> canonical-trip bridge. The website calls this after its
 * own admin save, so the chatbot, poster and website always share one set of
 * customer-facing trip facts.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") return res.status(405).end();

  const expected = process.env.WEBSITE_TRIP_SYNC_SECRET || getEnv().adminSecret;
  const provided = typeof req.headers["x-trip-sync-secret"] === "string"
    ? req.headers["x-trip-sync-secret"]
    : "";
  if (!safeSecretCompare(expected, provided)) return res.status(401).json({ error: "unauthorized" });

  try {
    if (req.body?.action === "delete") {
      const sourceTripId = typeof req.body?.sourceTripId === "string" ? req.body.sourceTripId.trim() : "";
      if (!sourceTripId) return res.status(400).json({ error: "source_trip_id_required" });
      const deleted = await deleteTrip(sourceTripId);
      return res.status(deleted ? 200 : 404).json({ ok: deleted });
    }
    const { sourceTripId, fields } = websiteTripToCanonicalFields(req.body?.trip);
    const existing = await getTripById(sourceTripId);
    const patch = existing ? websiteTripPatch(req.body?.trip, req.body?.previousTrip, existing) : fields;
    const trip = existing
      ? Object.keys(patch).length ? await patchTrip(sourceTripId, patch, true, undefined, existing.updated_at) : existing
      : await upsertTrip({ id: sourceTripId, fields });
    if (!trip) return res.status(503).json({ error: "trip_sync_failed" });
    return res.status(200).json({ ok: true, tripId: trip.id });
  } catch (error) {
    if (error instanceof Error && error.message === "trip_edit_conflict") return res.status(409).json({ error: "trip_edit_conflict" });
    console.error("Website trip sync failed", error);
    return res.status(400).json({ error: "invalid_trip_sync_payload" });
  }
}
