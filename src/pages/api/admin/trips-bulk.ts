import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { listTrips, upsertTrip, patchTrip } from "../../../lib/travelOps";
import { beginRequestTrace, finishRequestTrace, logError } from "../../../lib/observability";
import type { TripMutationFields, TripStatus } from "../../../lib/travelTypes";
import { TripDataValidationError } from "../../../lib/tripDataValidation";
import {
  JSON_EDITOR_EXTRA_FIELDS as EXTRA_FIELDS,
  JSON_EDITOR_NUMBER_FIELDS as MONEY_FIELDS,
  JSON_EDITOR_TEXT_FIELDS as TEXT_FIELDS,
} from "../../../lib/jsonEditorPlan";

const TRIP_STATUSES: readonly TripStatus[] = ["active", "paused", "cancelled", "sold_out", "draft", "archived"];

export type BulkTripResult = { id: string; route_name: string; ok: boolean; created?: boolean; conflict?: boolean; error?: string };

/** A whole number, a numeric string ("1 250 000", "1,250,000") or null; anything else is a typing mistake. */
function wholeNumberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string") {
    const digits = value.replace(/[\s,₮]/g, "");
    if (digits === "") return null;
    if (/^\d+$/.test(digits)) return Number(digits);
  }
  throw new Error(`${field}: тоо эсвэл null байх ёстой`);
}

/**
 * Turns one pasted trip into a patch. Only keys present in the object are written:
 * a field ChatGPT dropped stays as it is in the catalogue instead of being cleared
 * (an absent departure_dates used to empty the schedule and auto-archive the trip).
 * An explicit null still clears a value.
 */
export function bulkTripFields(trip: Record<string, unknown>, isNew: boolean): TripMutationFields {
  const has = (key: string) => Object.prototype.hasOwnProperty.call(trip, key);
  const fields: TripMutationFields = {};
  if (has("route_name")) {
    if (typeof trip.route_name !== "string" || !trip.route_name.trim()) throw new Error("route_name хоосон байна");
    fields.route_name = trip.route_name.trim();
  }
  for (const key of TEXT_FIELDS) {
    if (!has(key)) continue;
    if (typeof trip[key] !== "string") throw new Error(`${key}: текст байх ёстой`);
    fields[key] = trip[key] as string;
  }
  for (const key of MONEY_FIELDS) {
    if (has(key)) fields[key] = wholeNumberOrNull(trip[key], key);
  }
  if (has("departure_dates")) {
    const dates = trip.departure_dates;
    if (!Array.isArray(dates) || dates.some((date) => typeof date !== "string")) {
      throw new Error("departure_dates: текстэн огнооны жагсаалт байх ёстой");
    }
    fields.departure_dates = dates as string[];
  }
  if (has("has_food")) {
    if (trip.has_food !== null && typeof trip.has_food !== "boolean") throw new Error("has_food: true, false эсвэл null");
    fields.has_food = trip.has_food as boolean | null;
  }
  if (has("status")) {
    if (!TRIP_STATUSES.includes(trip.status as TripStatus)) throw new Error(`status: «${String(trip.status)}» гэсэн төлөв байхгүй`);
    fields.status = trip.status as TripStatus;
  }
  const extra: Record<string, unknown> = {};
  for (const key of EXTRA_FIELDS) if (has(key)) extra[key] = trip[key];
  if (has("customer_visible") && typeof trip.customer_visible !== "boolean") throw new Error("customer_visible: true эсвэл false");
  if (Object.keys(extra).length) fields.extra = extra;
  if (isNew) {
    if (!fields.route_name) throw new Error("Шинэ аялалд route_name заавал хэрэгтэй");
    fields.status ??= "draft";
    fields.currency ??= "MNT";
  }
  return fields;
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message === "trip_edit_conflict") {
    return "Таныг ачаалснаас хойш энэ аяллыг өөр газраас өөрчилсөн тул хадгалсангүй. «Дахин татах» дараад засна уу.";
  }
  if (error instanceof TripDataValidationError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

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

    // GET — export all non-archived trips as JSON, plus each one's saved version
    // (kept outside the trip objects so ChatGPT never sees or rewrites it).
    if (req.method === "GET") {
      const trips = await listTrips({ limit: 5000 });
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
          infant_price: t.infant_price,
          currency: t.currency,
          departure_dates: t.departure_dates,
          seats_total: t.seats_total,
          seats_left: t.seats_left,
          has_food: t.has_food,
          status: t.status,
          customer_visible: typeof extra.customer_visible === "boolean" ? extra.customer_visible : true,
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
          source_provenance: Array.isArray(extra.source_provenance) ? extra.source_provenance : [],
          answer_hints: Array.isArray(extra.answer_hints) ? extra.answer_hints : [],
          needs_human_review: typeof extra.needs_human_review === "boolean" ? extra.needs_human_review : false,
          review_reasons: Array.isArray(extra.review_reasons) ? extra.review_reasons : [],
        };
      });
      const versions = Object.fromEntries(trips.map((t) => [t.id, t.updated_at]));
      return res.status(200).json({ trips: exported, versions });
    }

    // POST — { trips: [...], versions?: { [id]: updated_at } }. A trip with an id is
    // patched (only the keys it carries); one without an id is created as a draft.
    if (req.method === "POST") {
      const body = req.body as unknown;
      if (!body || typeof body !== "object" || !Array.isArray((body as Record<string, unknown>).trips)) {
        return res.status(400).json({ error: "Expected { trips: [...] }" });
      }
      const incoming = (body as { trips: unknown[] }).trips;
      const rawVersions = (body as { versions?: unknown }).versions;
      const versions = rawVersions && typeof rawVersions === "object" ? rawVersions as Record<string, unknown> : {};
      const results: BulkTripResult[] = [];

      for (const raw of incoming) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
          results.push({ id: "", route_name: "", ok: false, error: "Аялал бүр { } объект байх ёстой" });
          continue;
        }
        const trip = raw as Record<string, unknown>;
        const routeName = typeof trip.route_name === "string" ? trip.route_name.trim() : "";
        const existingId = typeof trip.id === "string" && trip.id.trim() ? trip.id.trim() : undefined;
        try {
          const fields = bulkTripFields(trip, !existingId);
          if (existingId) {
            const expected = typeof versions[existingId] === "string" ? versions[existingId] as string : undefined;
            const saved = await patchTrip(existingId, fields, true, undefined, expected);
            if (!saved) throw new Error("Ийм id-тай аялал олдсонгүй");
            results.push({ id: existingId, route_name: saved.route_name || routeName, ok: true });
          } else {
            const saved = await upsertTrip({ fields });
            if (!saved) throw new Error("Хадгалж чадсангүй");
            results.push({ id: saved.id, route_name: saved.route_name || routeName, ok: true, created: true });
          }
        } catch (err) {
          const conflict = err instanceof Error && err.message === "trip_edit_conflict";
          const msg = errorText(err);
          if (!conflict) logError("trips-bulk.upsert_failed", { routeName, error: msg });
          results.push({ id: existingId || "", route_name: routeName, ok: false, conflict, error: msg });
        }
      }

      const failed = results.filter((r) => !r.ok);
      return res.status(200).json({
        saved: results.length - failed.length,
        created: results.filter((r) => r.created).length,
        failed: failed.length,
        results,
        errors: failed.map((r) => `${r.route_name || r.id || "—"}: ${r.error}`),
      });
    }

    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
