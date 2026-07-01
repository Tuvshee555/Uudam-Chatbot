/**
 * Poster generator persistence — its OWN tables, fully separate from the
 * chatbot's travel_trip_entries. Making/saving a poster never touches a live
 * chatbot trip. Uses the chatbot's existing pg pool (queryNeon) so we don't add
 * a second DB client.
 */
import { randomUUID } from "crypto";
import { queryNeon } from "@/lib/neonDb";

export type PosterTripRow = {
  id: string;
  title: string;
  source_file: string | null;
  data: unknown;
  updated_at: string;
};

let schemaReady = false;

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

export async function listPosterTrips(): Promise<
  Array<{ id: string; title: string; source_file: string | null; updated_at: string }>
> {
  if (!(await ensurePosterSchema())) return [];
  const res = await queryNeon<{
    id: string;
    title: string;
    source_file: string | null;
    updated_at: string;
  }>(
    `SELECT id, title, source_file, updated_at
       FROM poster_trips
      ORDER BY updated_at DESC
      LIMIT 200`,
  );
  return res?.rows ?? [];
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
    await queryNeon(
      `UPDATE poster_trips
          SET title = $1, data = $2::jsonb, updated_at = NOW()
        WHERE id = $3`,
      [input.title, dataJson, tripId],
    );
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
  return { id: tripId };
}

export async function deletePosterTrip(id: string): Promise<boolean> {
  if (!(await ensurePosterSchema())) return false;
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
