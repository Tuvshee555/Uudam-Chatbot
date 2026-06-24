import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { listTrips, upsertTrip, patchTrip } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace, logError } from "../../../lib/observability";
import type { TripMutationFields } from "../../../lib/travelTypes";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.admin.trips-bulk",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    const allowed = await requireAdminAccess(req, res, "api.admin.trips-bulk");
    if (!allowed) return;

    // GET — export all trips as JSON
    if (req.method === "GET") {
      const trips = await listTrips({ limit: 5000 });
      // Return a clean shape: all base fields + structured extra fields inlined
      const exported = trips.map((t) => {
        const extra = (t.extra || {}) as Record<string, unknown>;
        return {
          id: t.id,
          route_name: t.route_name,
          operator_name: t.operator_name,
          category: t.category,
          duration_text: t.duration_text,
          adult_price: t.adult_price,
          child_price: t.child_price,
          currency: t.currency,
          departure_dates: t.departure_dates,
          seats_total: t.seats_total,
          seats_left: t.seats_left,
          has_food: t.has_food,
          status: t.status,
          hotel: t.hotel,
          notes: t.notes,
          source_description: t.source_description,
          // Structured extra fields
          aliases: Array.isArray(extra.aliases) ? extra.aliases : [],
          price_groups: Array.isArray(extra.price_groups) ? extra.price_groups : [],
          discounts: Array.isArray(extra.discounts) ? extra.discounts : [],
          child_rules: Array.isArray(extra.child_rules) ? extra.child_rules : [],
          extra_fees: Array.isArray(extra.extra_fees) ? extra.extra_fees : [],
          departure_rule: typeof extra.departure_rule === "string" ? extra.departure_rule : "",
          included_items: Array.isArray(extra.included_items) ? extra.included_items : [],
          excluded_items: Array.isArray(extra.excluded_items) ? extra.excluded_items : [],
          room_prices: Array.isArray(extra.room_prices) ? extra.room_prices : [],
          important_notes: Array.isArray(extra.important_notes) ? extra.important_notes : [],
          brochure_pdf_url: typeof extra.brochure_pdf_url === "string" ? extra.brochure_pdf_url : "",
        };
      });
      return res.status(200).json({ trips: exported });
    }

    // POST — bulk upsert: accepts array of trip objects, upserts each by id or route_name
    if (req.method === "POST") {
      const body = req.body as unknown;
      if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).trips)) {
        return res.status(400).json({ error: "Expected { trips: [...] }" });
      }
      const incoming = (body as { trips: unknown[] }).trips;
      const results: { id: string; route_name: string; ok: boolean; error?: string }[] = [];

      for (const raw of incoming) {
        if (!raw || typeof raw !== "object") continue;
        const trip = raw as Record<string, unknown>;
        const routeName = typeof trip.route_name === "string" ? trip.route_name.trim() : "";
        if (!routeName) continue;

        // Build extra from inlined structured fields
        const extra: Record<string, unknown> = {
          aliases: Array.isArray(trip.aliases) ? trip.aliases : [],
          price_groups: Array.isArray(trip.price_groups) ? trip.price_groups : [],
          discounts: Array.isArray(trip.discounts) ? trip.discounts : [],
          child_rules: Array.isArray(trip.child_rules) ? trip.child_rules : [],
          extra_fees: Array.isArray(trip.extra_fees) ? trip.extra_fees : [],
          departure_rule: typeof trip.departure_rule === "string" ? trip.departure_rule : "",
          included_items: Array.isArray(trip.included_items) ? trip.included_items : [],
          excluded_items: Array.isArray(trip.excluded_items) ? trip.excluded_items : [],
          room_prices: Array.isArray(trip.room_prices) ? trip.room_prices : [],
          important_notes: Array.isArray(trip.important_notes) ? trip.important_notes : [],
          brochure_pdf_url: typeof trip.brochure_pdf_url === "string" ? trip.brochure_pdf_url : null,
        };

        const fields: TripMutationFields = {
          route_name: routeName,
          operator_name: typeof trip.operator_name === "string" ? trip.operator_name : undefined,
          category: typeof trip.category === "string" ? trip.category : undefined,
          duration_text: typeof trip.duration_text === "string" ? trip.duration_text : undefined,
          adult_price: typeof trip.adult_price === "number" ? trip.adult_price : null,
          child_price: typeof trip.child_price === "number" ? trip.child_price : null,
          currency: typeof trip.currency === "string" ? trip.currency : "MNT",
          departure_dates: Array.isArray(trip.departure_dates)
            ? (trip.departure_dates as unknown[]).filter((d) => typeof d === "string") as string[]
            : [],
          seats_total: typeof trip.seats_total === "number" ? trip.seats_total : null,
          seats_left: typeof trip.seats_left === "number" ? trip.seats_left : null,
          has_food: typeof trip.has_food === "boolean" ? trip.has_food : null,
          status: (["active", "cancelled", "sold_out", "draft"].includes(String(trip.status))
            ? trip.status
            : "active") as "active" | "cancelled" | "sold_out" | "draft",
          hotel: typeof trip.hotel === "string" ? trip.hotel : "",
          notes: typeof trip.notes === "string" ? trip.notes : "",
          source_description: typeof trip.source_description === "string" ? trip.source_description : "",
          extra,
        };

        try {
          const existingId = typeof trip.id === "string" && trip.id.trim() ? trip.id.trim() : undefined;
          if (existingId) {
            // Patch existing trip by ID (merges extra via JSONB ||)
            await patchTrip(existingId, fields);
            results.push({ id: existingId, route_name: routeName, ok: true });
          } else {
            // Insert new
            const saved = await upsertTrip({ fields });
            results.push({ id: saved?.id ?? "", route_name: routeName, ok: true });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logError("trips-bulk.upsert_failed", { routeName, error: msg });
          results.push({ id: "", route_name: routeName, ok: false, error: msg });
        }
      }

      const failed = results.filter((r) => !r.ok);
      return res.status(200).json({
        saved: results.filter((r) => r.ok).length,
        failed: failed.length,
        errors: failed.map((r) => `${r.route_name}: ${r.error}`),
      });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
