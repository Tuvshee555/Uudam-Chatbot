import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";
import { changeDepartureDeal, notifyWebsiteTripsChanged, readDepartureDeal, readTripDepartureDeals } from "../../../lib/websiteTripSync";

const MAX_FARE = 1_000_000_000;

/** A fare from the request: undefined = leave as is, null = clear, else a whole positive amount. */
function fareField(value: unknown): number | null | undefined | "invalid" {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).replace(/[\s,₮]/g, ""));
  return Number.isFinite(n) && n > 0 && n < MAX_FARE ? Math.round(n) : "invalid";
}

/**
 * ONE date's sale fares and «Онцлох» (departureDeals.ts), written to the website's departure row,
 * which the website and the bot read, so the change shows up on all of them at once.
 * Body: { tripId, date: YYYY-MM-DD, salePrice?, saleChildPrice?, featured? } — null clears a sale.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({ route: "api.admin.departure_deal", method: req.method, url: req.url });
  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.departure_deal");
    if (!allowed) return;
    if (req.method === "GET") {
      // The editor's date rows: each upcoming date's regular fares and its sale/«Онцлох».
      const tripId = typeof req.query.tripId === "string" ? req.query.tripId.trim() : "";
      if (!tripId) return res.status(400).json({ error: "tripId is required" });
      if (!process.env.BOOKING_DATABASE_URL) return res.status(200).json({ dates: [] });
      const rows = await readTripDepartureDeals(tripId);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ dates: rows.map((row) => ({
        date: row.date, regularAdult: row.regularAdult, regularChild: row.regularChild,
        salePrice: row.before.salePrice, saleChildPrice: row.before.saleChildPrice, featured: row.before.isFeatured,
      })) });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    const body = (req.body || {}) as Record<string, unknown>;
    const tripId = typeof body.tripId === "string" ? body.tripId.trim() : "";
    const date = typeof body.date === "string" ? body.date.trim() : "";
    if (!tripId) return res.status(400).json({ error: "tripId is required" });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
    const salePrice = fareField(body.salePrice);
    const saleChildPrice = fareField(body.saleChildPrice);
    if (salePrice === "invalid" || saleChildPrice === "invalid") return res.status(400).json({ error: "invalid_price", message: "Үнэ буруу байна." });
    if (body.featured !== undefined && typeof body.featured !== "boolean") return res.status(400).json({ error: "featured must be true or false" });
    const featured = body.featured as boolean | undefined;
    if (salePrice === undefined && saleChildPrice === undefined && featured === undefined) return res.status(400).json({ error: "nothing_to_change" });
    if (!process.env.BOOKING_DATABASE_URL) return res.status(503).json({ error: "website_database_not_configured" });

    const current = await readDepartureDeal(tripId, date);
    if (!current) return res.status(404).json({ error: "departure_not_found", message: "Энэ өдөр вэбсайтад олдсонгүй." });
    // A sale that is not below the regular fare would sell the date dearer.
    const notBelow = (sale: number | null | undefined, regular: number | null) => typeof sale === "number" && regular !== null && sale >= regular;
    if (notBelow(salePrice, current.regularAdult) || notBelow(saleChildPrice, current.regularChild)) {
      return res.status(400).json({ error: "sale_not_below_regular", message: "Хямдралтай үнэ энгийн үнээс бага байх ёстой.", regularAdult: current.regularAdult, regularChild: current.regularChild });
    }
    const change = await changeDepartureDeal(tripId, date, { salePrice, saleChildPrice, isFeatured: featured });
    const row = change.rows[0];
    if (!row) return res.status(404).json({ error: "departure_not_found", message: "Энэ өдөр вэбсайтад олдсонгүй." });
    // The trip page is cached for a day; its dates and prices would show the old fare until then.
    if (change.slug) await notifyWebsiteTripsChanged([change.slug]).catch(() => undefined);
    return res.status(200).json({
      ok: true, tripId, date,
      regularAdult: row.regularAdult, regularChild: row.regularChild,
      salePrice: row.after.salePrice, saleChildPrice: row.after.saleChildPrice, featured: row.after.isFeatured,
    });
  } catch {
    return res.status(500).json({ error: "failed_to_update_departure" });
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {});
  }
}
