/**
 * Poster generator persistence — its OWN tables, fully separate from the
 * chatbot's travel_trip_entries. Making/saving a poster never touches a live
 * chatbot trip. Uses the chatbot's existing pg pool (queryNeon) so we don't add
 * a second DB client.
 */
import { randomUUID } from "crypto";
import { mapPosterTripToFields } from "@/lib/poster/tripMapper";
import { queryNeon } from "@/lib/neonDb";
import { getTripById, upsertTrip } from "@/lib/travelDb";
import type { TripMutationFields } from "@/lib/travelTypes";

export type PosterTripRow = {
  id: string;
  title: string;
  source_file: string | null;
  data: unknown;
  created_at?: string;
  updated_at: string;
};

export type PosterTripListRow = {
  id: string;
  title: string;
  source_file: string | null;
  updated_at: string;
  linked_trip_id: string | null;
  linked_trip_name: string | null;
  linked_trip_status: string | null;
  linked_trip_has_pdf: boolean;
  linked_trip_needs_review: boolean;
};

let schemaReady = false;
const PDF_REVIEW_REASON = "Poster sync: PDF хөтөлбөр дутуу";
const SCHEDULE_REVIEW_REASON = "Poster sync: гарах өдрийн календарь дутуу";

export async function ensurePosterSchema(): Promise<boolean> {
  if (schemaReady) return true;
  const res = await queryNeon(`
    CREATE TABLE IF NOT EXISTS poster_trips (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      source_file TEXT NULL,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  if (res === null) return false;
  await queryNeon(`
    CREATE TABLE IF NOT EXISTS poster_trip_versions (
      id BIGSERIAL PRIMARY KEY,
      trip_id TEXT NOT NULL,
      data JSONB NOT NULL,
      note TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await queryNeon(`
    CREATE INDEX IF NOT EXISTS idx_poster_trip_versions_trip
      ON poster_trip_versions (trip_id);
  `);
  schemaReady = true;
  return true;
}

export async function listPosterTrips(): Promise<PosterTripListRow[]> {
  if (!(await ensurePosterSchema())) return [];
  const res = await queryNeon<{
    id: string;
    title: string;
    source_file: string | null;
    updated_at: string;
    linked_trip_id: string | null;
    linked_trip_name: string | null;
    linked_trip_status: string | null;
    linked_trip_has_pdf: boolean;
    linked_trip_needs_review: boolean;
  }>(
    `SELECT p.id,
            p.title,
            p.source_file,
            p.updated_at,
            t.id AS linked_trip_id,
            t.route_name AS linked_trip_name,
            t.status AS linked_trip_status,
            (
              COALESCE(t.extra->>'brochure_pdf_url', '') <> ''
              OR COALESCE(t.extra->>'source_file_attachment_id', '') <> ''
            ) AS linked_trip_has_pdf,
            COALESCE((t.extra->>'needs_human_review')::boolean, FALSE) AS linked_trip_needs_review
       FROM poster_trips p
       LEFT JOIN travel_trip_entries t
         ON t.extra->>'poster_trip_id' = p.id
      ORDER BY p.updated_at DESC
      LIMIT 200`,
  );
  return res?.rows ?? [];
}

function linkedTripId(posterId: string): string {
  return `trip-${posterId}`;
}

function posterRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function posterItineraryDays(data: Record<string, unknown>): Record<string, unknown>[] {
  const days = Array.isArray(data.days) ? data.days : [];
  return days
    .map((item, index): Record<string, unknown> | null => {
      if (!item || typeof item !== "object") return null;
      const day = item as Record<string, unknown>;
      const dayNumber = typeof day.day === "number" ? day.day : index + 1;
      const title = typeof day.route === "string" ? day.route.trim() : "";
      const description = typeof day.summary === "string" ? day.summary.trim() : "";
      const hotel = typeof day.hotel === "string" ? day.hotel.trim() : "";
      const meals = day.meals && typeof day.meals === "object" ? day.meals : undefined;
      if (!title && !description && !hotel) return null;
      return {
        day: dayNumber,
        title,
        description,
        ...(hotel ? { hotel } : {}),
        ...(meals ? { meals } : {}),
      };
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function linkedTripFields(row: {
  id: string;
  title: string;
  source_file?: string | null;
  data: unknown;
}): TripMutationFields {
  const data = posterRecord(row.data);
  const mapped = mapPosterTripToFields(data);
  const routeName =
    typeof mapped.route_name === "string" && mapped.route_name.trim()
      ? mapped.route_name.trim()
      : row.title.trim();
  const itineraryDays = posterItineraryDays(data);
  const extra = {
    ...(mapped.extra || {}),
    poster_trip_id: row.id,
    source_file_name: row.source_file || "",
    original_title_text: row.title,
    ...(itineraryDays.length ? { itinerary_days: itineraryDays } : {}),
  };

  return {
    ...mapped,
    route_name: routeName,
    category: "Аялал",
    operator_name: "UUDAM TRAVEL AGENCY",
    status: "active",
    source_description: row.source_file || row.title,
    extra,
  };
}

async function syncPosterTrip(row: {
  id: string;
  title: string;
  source_file?: string | null;
  data: unknown;
}) {
  const fields = linkedTripFields(row);
  if (!fields.route_name) return null;
  const existing = await getTripById(linkedTripId(row.id));
  const existingExtra = (existing?.extra || {}) as Record<string, unknown>;
  const preservedPdfUrl =
    typeof existingExtra.brochure_pdf_url === "string" ? existingExtra.brochure_pdf_url : "";
  const preservedAttachmentId =
    typeof existingExtra.source_file_attachment_id === "string"
      ? existingExtra.source_file_attachment_id
      : "";
  const hasPdf = Boolean(preservedPdfUrl || preservedAttachmentId);
  const hasSchedule = Array.isArray(fields.departure_dates) && fields.departure_dates.length > 0;
  const reviewReasons = new Set(
    (Array.isArray(existingExtra.review_reasons) ? existingExtra.review_reasons : [])
      .filter((reason): reason is string => typeof reason === "string" && reason.trim().length > 0)
      .filter((reason) => reason !== PDF_REVIEW_REASON && reason !== SCHEDULE_REVIEW_REASON),
  );
  if (!hasPdf) reviewReasons.add(PDF_REVIEW_REASON);
  if (!hasSchedule) reviewReasons.add(SCHEDULE_REVIEW_REASON);
  fields.extra = {
    ...(fields.extra || {}),
    ...(preservedPdfUrl ? { brochure_pdf_url: preservedPdfUrl } : {}),
    ...(preservedAttachmentId ? { source_file_attachment_id: preservedAttachmentId } : {}),
    ...(typeof existingExtra.brochure_pdf_generated_at === "string"
      ? { brochure_pdf_generated_at: existingExtra.brochure_pdf_generated_at }
      : {}),
    brochure_pdf_required: true,
    brochure_pdf_missing: !hasPdf,
    needs_human_review: Boolean(existingExtra.needs_human_review) || reviewReasons.size > 0,
    review_reasons: Array.from(reviewReasons),
  };
  return upsertTrip({ id: linkedTripId(row.id), fields });
}

export async function getPosterTrip(id: string): Promise<PosterTripRow | null> {
  if (!(await ensurePosterSchema())) return null;
  const res = await queryNeon<PosterTripRow>(
    `SELECT id, title, source_file, data FROM poster_trips WHERE id = $1`,
    [id],
  );
  return res?.rows?.[0] ?? null;
}

export async function savePosterTrip(input: {
  id?: string | null;
  title: string;
  data: unknown;
  source_file?: string | null;
  note?: string | null;
}): Promise<{ id: string } | null> {
  if (!(await ensurePosterSchema())) return null;
  const dataJson = JSON.stringify(input.data ?? {});
  let tripId = input.id?.trim() || "";

  if (tripId) {
    const updated = await queryNeon(
      `UPDATE poster_trips
          SET title = $1, data = $2::jsonb, updated_at = NOW()
        WHERE id = $3`,
      [input.title, dataJson, tripId],
    );
    if ((updated?.rowCount ?? 0) === 0) {
      await queryNeon(
        `INSERT INTO poster_trips (id, title, source_file, data)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [tripId, input.title, input.source_file ?? null, dataJson],
      );
    }
  } else {
    tripId = `poster-${randomUUID()}`;
    await queryNeon(
      `INSERT INTO poster_trips (id, title, source_file, data)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [tripId, input.title, input.source_file ?? null, dataJson],
    );
  }

  await queryNeon(
    `INSERT INTO poster_trip_versions (trip_id, data, note)
     VALUES ($1, $2::jsonb, $3)`,
    [tripId, dataJson, input.note ?? null],
  );
  const syncedTrip = await syncPosterTrip({
    id: tripId,
    title: input.title,
    source_file: input.source_file ?? null,
    data: input.data ?? {},
  });
  if (!syncedTrip) {
    throw new Error("Постер хадгалагдсан ч холбоотой аяллыг үүсгэж чадсангүй.");
  }
  return { id: tripId };
}

export async function deletePosterTrip(id: string): Promise<boolean> {
  if (!(await ensurePosterSchema())) return false;
  await queryNeon(
    `DELETE FROM travel_trip_entries
      WHERE extra->>'poster_trip_id' = $1`,
    [id],
  );
  await queryNeon(`DELETE FROM poster_trip_versions WHERE trip_id = $1`, [id]);
  const res = await queryNeon<{ id: string }>(
    `DELETE FROM poster_trips WHERE id = $1 RETURNING id`,
    [id],
  );
  return Boolean(res?.rows?.length);
}

export async function exportPosterTrips(): Promise<PosterTripRow[]> {
  if (!(await ensurePosterSchema())) return [];
  const res = await queryNeon<PosterTripRow>(
    `SELECT id, title, source_file, updated_at, data
       FROM poster_trips ORDER BY updated_at DESC`,
  );
  return res?.rows ?? [];
}

export async function syncAllPosterTrips(): Promise<{ posters: number; trips: number }> {
  const posters = await exportPosterTrips();
  let trips = 0;
  for (const poster of posters) {
    const synced = await syncPosterTrip(poster);
    if (synced) trips += 1;
  }
  return { posters: posters.length, trips };
}

