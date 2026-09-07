import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import {
  deleteAllTrips,
  deleteTrip,
  getBotControl,
  listTrips,
  patchTrip,
  upsertTrip,
} from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";
import { websiteSyncStatus } from "../../../lib/websiteTripSync";
import { ensureConnectedTripSchema } from "../../../lib/connectedTripStore";
import { blockingGaps, findTripGaps, formatGapLabels, tripCompletenessInput } from "../../../lib/tripCompleteness";
import { POSTER_PHOTO_COUNT_SQL } from "../../../lib/poster/photoCount";
import { queryNeon } from "../../../lib/neonDb";
import { getTripById } from "../../../lib/travelDb";
import type { TravelTrip } from "../../../lib/travelTypes";

function asText(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * How many photos each trip's poster holds. The gallery lives on the poster, so
 * a trip with an empty photo_urls can still be fully illustrated everywhere it
 * is published, and must not be reported as missing photos.
 */
async function posterPhotoCountsByTrip(): Promise<Map<string, number>> {
  const rows = await queryNeon<{ id: string; photo_count: string }>(
    `SELECT t.id, ${POSTER_PHOTO_COUNT_SQL} AS photo_count
       FROM travel_trip_entries t
       JOIN poster_trips p ON p.id = t.extra->>'poster_trip_id'`,
  );
  return new Map((rows?.rows || []).map(row => [row.id, Number(row.photo_count) || 0]));
}

/**
 * Refuses a save that would leave a customer-facing field empty. The admin asks
 * for confirmation and resends with confirmIncomplete, so this blocks silent
 * writes (scripts, stale tabs) without trapping a deliberate draft.
 */
async function incompleteResponse(
  fields: Record<string, unknown>,
  existing: TravelTrip | null,
  confirmed: boolean,
) {
  if (confirmed) return null;
  const merged = {
    ...(existing || {}),
    ...fields,
    extra: { ...((existing?.extra as Record<string, unknown>) || {}), ...(fields.extra as Record<string, unknown> || {}) },
  } as TravelTrip;
  const posterId = typeof merged.extra?.poster_trip_id === "string" ? merged.extra.poster_trip_id : "";
  const posterPhotoCount = posterId ? (await posterPhotoCountsByTrip()).get(merged.id) || 0 : 0;
  const gaps = blockingGaps(findTripGaps(tripCompletenessInput(merged, { posterPhotoCount })));
  if (gaps.length === 0) return null;
  return {
    error: "trip_incomplete",
    message: `Дутуу мэдээлэл: ${formatGapLabels(gaps)}`,
    gaps,
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  const trace = beginRequestTrace({
    route: "api.admin.trips",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.trips");
    if (!allowed) return;

    if (req.method === "GET") {
      const search = asText(req.query.search);
      const status = asText(req.query.status);
      const limit = Number(req.query.limit || 200);

      const [trips, control] = await Promise.all([
        listTrips({
          search: search || undefined,
          status: status || undefined,
          limit: Number.isFinite(limit) ? limit : 200,
        }),
        getBotControl(),
      ]);

      await ensureConnectedTripSchema();
      const connections = new Map((await websiteSyncStatus()).map(row => [row.trip_id, row]));
      const posterPhotoCounts = await posterPhotoCountsByTrip();
      return res.status(200).json({ ok: true, trips: trips.map(trip => ({ ...trip,
        extra: {
          ...trip.extra,
          website_sync: connections.get(trip.id) || null,
          poster_photo_count: posterPhotoCounts.get(trip.id) || 0,
        } })), control });
    }

    if (req.method === "POST") {
      const { id, fields, confirmIncomplete } = req.body || {};
      if (!fields || typeof fields !== "object") {
        return res.status(400).json({ error: "fields object is required" });
      }
      const existing = typeof id === "string" && id.trim() ? await getTripById(id.trim()) : null;
      const incomplete = await incompleteResponse(fields, existing, confirmIncomplete === true);
      if (incomplete) return res.status(409).json(incomplete);
      const saved = await upsertTrip({
        id: typeof id === "string" ? id : undefined,
        fields,
      });
      if (!saved) return res.status(500).json({ error: "failed_to_save_trip" });
      return res.status(200).json({ ok: true, trip: saved });
    }

    if (req.method === "PATCH") {
      const { id, fields, confirmIncomplete } = req.body || {};
      if (typeof id !== "string" || !id.trim()) {
        return res.status(400).json({ error: "id is required" });
      }
      if (!fields || typeof fields !== "object") {
        return res.status(400).json({ error: "fields object is required" });
      }
      // Only a full form save carries route_name. Partial patches — the hide
      // toggle, an AI field change — must stay possible on an incomplete trip.
      if (typeof fields.route_name === "string") {
        const existing = await getTripById(id.trim());
        const incomplete = await incompleteResponse(fields, existing, confirmIncomplete === true);
        if (incomplete) return res.status(409).json(incomplete);
      }
      const saved = await patchTrip(id.trim(), fields);
      if (!saved) return res.status(404).json({ error: "trip_not_found_or_no_changes" });
      return res.status(200).json({ ok: true, trip: saved });
    }

    if (req.method === "DELETE") {
      if (req.query.all === "true") {
        const count = await deleteAllTrips();
        return res.status(200).json({ ok: true, deleted: count });
      }
      const id = asText(req.query.id) || asText((req.body || {}).id);
      if (!id) return res.status(400).json({ error: "id is required" });
      const deleted = await deleteTrip(id);
      if (!deleted) return res.status(404).json({ error: "trip_not_found" });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
