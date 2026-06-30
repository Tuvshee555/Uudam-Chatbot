import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "@/lib/adminAccess";
import { findTripMatches, listTrips } from "@/lib/travelDb";

/**
 * Read-only: given a poster title, return the ranked candidate trips the
 * poster could attach to, each with its current photo count, plus the full
 * trip list so the poster app can offer a manual pick. Writes NOTHING.
 *
 * The poster app uses this to show a confirmation modal BEFORE any image
 * upload or DB change happens.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const allowed = await requireAdminAccess(req, res, "api.admin.poster-match");
  if (!allowed) return;

  if (req.method !== "POST") return res.status(405).end();

  const body = req.body as { tripTitle?: unknown };
  const tripTitle = typeof body.tripTitle === "string" ? body.tripTitle.trim() : "";
  if (!tripTitle) return res.status(400).json({ error: "tripTitle хоосон байна" });

  const trips = await listTrips();
  const ranked = findTripMatches(trips, undefined, tripTitle);

  const candidates = ranked.slice(0, 5).map((t) => ({
    id: t.id,
    route_name: t.route_name,
    operator_name: t.operator_name,
    category: t.category,
    photoCount: Array.isArray(t.photo_urls) ? t.photo_urls.length : 0,
  }));

  // Full lightweight list for the manual-pick dropdown (no photos payload).
  const allTrips = trips
    .map((t) => ({
      id: t.id,
      route_name: t.route_name,
      category: t.category,
      photoCount: Array.isArray(t.photo_urls) ? t.photo_urls.length : 0,
    }))
    .sort((a, b) => a.route_name.localeCompare(b.route_name, "mn"));

  return res.status(200).json({
    tripTitle,
    candidates, // ranked best-first; [] means no confident match
    allTrips, // for manual selection / "wrong match" override
  });
}
