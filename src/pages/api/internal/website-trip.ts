import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "@/lib/env";
import { safeSecretCompare } from "@/lib/adminAuth";
import { logError, logWarn } from "@/lib/observability";
import { deleteTrip, getTripById, patchTrip, upsertTrip } from "@/lib/travelDb";
import type { TripMutationFields } from "@/lib/travelTypes";
import { sameParityValue } from "@/lib/tripWebsiteParityValue";
import {
  WebsiteTripPayloadError, sameConflict, validateWebsiteTripPayload, websiteTripPatchReport, websiteTripSourceId,
  websiteTripToCanonicalFields, withBaseFreeFareRule, type SharedConflict,
} from "@/lib/websiteTripBridge";
import { flushWebsiteSync, withWebsiteDepartureAvailability } from "@/lib/websiteTripSync";
import { waitUntil } from "@vercel/functions";
import { TripDataValidationError } from "@/lib/tripDataValidation";

/**
 * A website delivery carries the trip, its baseline and their departures.
 * Next's default 1 MB body limit refused the 2026-10-26 Санья edit (HTTP 413)
 * on every attempt; the website now sends only what this route reads, and
 * this limit (under Vercel's 4.5 MB request cap) keeps a large trip in reach.
 */
export const config = { api: { bodyParser: { sizeLimit: "4mb" } } };

type Row = Record<string, unknown>;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const CANONICAL_COLUMNS = new Set(["route_name", "duration_text", "adult_price", "child_price", "infant_price", "currency", "departure_dates", "has_food", "status", "notes", "hotel", "photo_urls"]);

/**
 * Private website -> canonical-trip bridge. The website calls this after its
 * own admin save, so the chatbot, poster and website always share one set of
 * customer-facing trip facts. The reply says what the save changed, which
 * disagreements it recorded and which website fields it could not take, so
 * the website never treats a dropped field as a successful sync.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).end();
  }

  const expected = process.env.WEBSITE_TRIP_SYNC_SECRET || getEnv().adminSecret;
  const provided = typeof req.headers["x-trip-sync-secret"] === "string"
    ? req.headers["x-trip-sync-secret"]
    : "";
  if (!safeSecretCompare(expected, provided)) return res.status(401).json({ error: "unauthorized" });

  let sourceTripId = "";
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body) || (req.body.action !== undefined && !["delete", "resolve_conflict", "flush"].includes(req.body.action))) {
      return res.status(400).json({ error: "invalid_trip_sync_payload" });
    }
    if (req.body?.action === "delete") {
      sourceTripId = typeof req.body?.sourceTripId === "string" ? req.body.sourceTripId.trim() : "";
      if (!sourceTripId) return res.status(400).json({ error: "source_trip_id_required" });
      const deleted = await deleteTrip(sourceTripId);
      return res.status(deleted ? 200 : 404).json({ ok: deleted });
    }
    if (req.body.action === "resolve_conflict") return await resolveConflict(req, res);
    // The website's retry sweep nudges this side's durable outbox too, so a
    // chatbot edit whose projection failed is retried behind ordinary traffic
    // instead of waiting for the daily cron (Vercel Hobby).
    if (req.body.action === "flush") {
      const work = flushWebsiteSync(undefined, 10).then(() => undefined, (error) => {
        logError("website_trip_sync.flush_failed", { message: error instanceof Error ? error.message.slice(0, 300) : String(error) });
      });
      try { waitUntil(work); } catch { void work; }
      return res.status(202).json({ ok: true });
    }

    validateWebsiteTripPayload(req.body.trip);
    sourceTripId = websiteTripSourceId(req.body.trip);
    const changedFields = Array.isArray(req.body.changedFields)
      ? (req.body.changedFields as unknown[]).filter((field): field is string => typeof field === "string")
      : undefined;
    const existing = await getTripById(sourceTripId);
    if (!existing) {
      const { fields } = websiteTripToCanonicalFields(req.body.trip);
      if (!fields.route_name) throw new WebsiteTripPayloadError("A new trip requires a title");
      for (const kind of ["child", "infant"] as const) {
        const value = kind === "child" ? fields.child_price : fields.infant_price;
        if (value === 0) fields.extra = { ...fields.extra, child_rules: withBaseFreeFareRule(fields.extra?.child_rules, kind, true) };
      }
      const created = await upsertTrip({ id: sourceTripId, fields });
      if (!created) return res.status(503).json({ error: "trip_sync_failed" });
      return res.status(200).json({ ok: true, tripId: created.id, applied: Object.keys(fields), conflicts: [], ignored: [] });
    }
    const report = websiteTripPatchReport(req.body.trip, req.body.previousTrip, existing, changedFields);
    const patch = report.fields;
    // The website is the authority for seats and sold-out dates. Take them from
    // its live rows rather than from the payload, which a delayed retry can
    // deliver days after newer bookings changed them.
    if (patch.extra && "website_departure_availability" in patch.extra) {
      const live = (await withWebsiteDepartureAvailability([existing]))[0]?.extra?.website_departure_availability;
      if (Array.isArray(live)) patch.extra.website_departure_availability = live;
      if (sameParityValue(patch.extra.website_departure_availability, existing.extra?.website_departure_availability)) {
        delete patch.extra.website_departure_availability;
        report.applied = report.applied.filter((path) => path !== "extra.website_departure_availability");
      }
      if (!Object.keys(patch.extra).length) delete patch.extra;
    }
    const trip = Object.keys(patch).length
      ? await patchTrip(sourceTripId, patch, true, undefined, existing.updated_at, { flush: "background" })
      : existing;
    if (!trip) return res.status(503).json({ error: "trip_sync_failed" });
    if (report.ignored.length) logWarn("website_trip_sync.fields_not_applied", { sourceTripId, ignored: report.ignored });
    return res.status(200).json({ ok: true, tripId: trip.id, applied: report.applied, conflicts: report.conflicts, ignored: report.ignored });
  } catch (error) {
    if (error instanceof Error && error.message === "trip_edit_conflict") {
      logWarn("website_trip_sync.edit_conflict", { sourceTripId });
      return res.status(409).json({ error: "trip_edit_conflict" });
    }
    if (error instanceof WebsiteTripPayloadError || error instanceof TripDataValidationError) {
      logWarn("website_trip_sync.invalid_payload", { sourceTripId, message: error.message.slice(0, 500) });
      return res.status(400).json({ error: "invalid_trip_sync_payload", message: error.message.slice(0, 300) });
    }
    logError("website_trip_sync.failed", { sourceTripId, message: error instanceof Error ? error.message.slice(0, 500) : String(error) });
    return res.status(503).json({ error: "trip_sync_failed" });
  }
}

/**
 * Settles one recorded disagreement from the website admin. "website" writes
 * the website's value into the canonical record; "chatbot" keeps the canonical
 * value. Either way the entry moves to resolved_conflicts with who decided and
 * when, so no decision is ever lost.
 */
async function resolveConflict(req: NextApiRequest, res: NextApiResponse) {
  const sourceTripId = typeof req.body.sourceTripId === "string" ? req.body.sourceTripId.trim() : "";
  const resolution = req.body.resolution;
  const conflict = record(req.body.conflict);
  if (!sourceTripId || !["website", "chatbot"].includes(resolution) || typeof conflict.field !== "string") {
    return res.status(400).json({ error: "invalid_conflict_resolution" });
  }
  const existing = await getTripById(sourceTripId);
  if (!existing) return res.status(404).json({ error: "trip_not_found" });
  const open = (Array.isArray(existing.extra?.shared_conflicts) ? existing.extra.shared_conflicts : []) as SharedConflict[];
  const match = open.find((entry) => sameConflict(entry, conflict));
  if (!match) return res.status(404).json({ error: "conflict_not_found" });

  const fields: TripMutationFields = {};
  const extra: Row = {
    shared_conflicts: open.filter((entry) => entry !== match),
    resolved_conflicts: [
      ...(Array.isArray(existing.extra?.resolved_conflicts) ? existing.extra.resolved_conflicts : []),
      { ...match, resolution, resolvedAt: new Date().toISOString(), resolvedBy: typeof req.body.resolvedBy === "string" ? req.body.resolvedBy.slice(0, 120) : "website-admin" },
    ].slice(-200),
  };
  if (resolution === "website") {
    if (match.field.startsWith("extra.") && !match.field.slice(6).includes(".")) extra[match.field.slice(6)] = match.website;
    else if (CANONICAL_COLUMNS.has(match.field)) Object.assign(fields, { [match.field]: match.website });
    else return res.status(400).json({ error: "conflict_needs_manual_edit" });
  }
  fields.extra = extra;
  const trip = await patchTrip(sourceTripId, fields, true, undefined, existing.updated_at, { flush: "background" });
  if (!trip) return res.status(503).json({ error: "trip_sync_failed" });
  return res.status(200).json({ ok: true, open: (extra.shared_conflicts as unknown[]).length });
}
