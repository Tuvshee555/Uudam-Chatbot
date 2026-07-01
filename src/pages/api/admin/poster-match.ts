import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { findTripMatches, listTrips } from "@/lib/travelDb";
import { mapPosterTripToFields } from "@/lib/poster/tripMapper";

/**
 * Read-only: given a poster title (+ optionally its full extracted data),
 * return the ranked candidate trips the poster could attach to — each with
 * its current field values so the client can build a per-field diff — plus
 * the full trip list for manual pick, and the poster's data mapped onto trip
 * fields. Writes NOTHING.
 *
 * The poster app uses this to show a confirmation modal BEFORE any image
 * upload or DB change happens.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster-match");
  if (!allowed) return;

  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as { tripTitle?: unknown; posterTrip?: unknown };
  const tripTitle = typeof body.tripTitle === "string" ? body.tripTitle.trim() : "";
  if (!tripTitle) return res.status(400).json({ error: "tripTitle хоосон байна" });

  const posterTrip =
    body.posterTrip && typeof body.posterTrip === "object"
      ? (body.posterTrip as Record<string, unknown>)
      : null;
  const mappedFields = posterTrip ? mapPosterTripToFields(posterTrip) : null;

  const trips = await listTrips();
  const ranked = findTripMatches(trips, undefined, tripTitle);

  const toCandidate = (t: (typeof trips)[number]) => ({
    id: t.id,
    route_name: t.route_name,
    operator_name: t.operator_name,
    category: t.category,
    photoCount: Array.isArray(t.photo_urls) ? t.photo_urls.length : 0,
    // Current values, so the client can diff against mappedFields per-field.
    currentFields: {
      route_name: t.route_name,
      duration_text: t.duration_text,
      departure_dates: t.departure_dates,
      adult_price: t.adult_price,
      child_price: t.child_price,
      hotel: t.hotel,
      has_food: t.has_food,
      included_items: (t.extra?.included_items as string[]) ?? [],
      excluded_items: (t.extra?.excluded_items as string[]) ?? [],
    },
  });

  const candidates = ranked.slice(0, 5).map(toCandidate);

  // Full lightweight list for the manual-pick dropdown (photo count only —
  // currentFields fetched again once picked would be wasteful, so include
  // them here too since the trip list is already small/local).
  const allTrips = trips
    .map(toCandidate)
    .sort((a, b) => a.route_name.localeCompare(b.route_name, "mn"));

  return res.status(200).json({
    tripTitle,
    candidates, // ranked best-first; [] means no confident match
    allTrips, // for manual selection / "wrong match" override
    mappedFields, // poster data mapped onto trip fields, for diffing client-side
  });
}
