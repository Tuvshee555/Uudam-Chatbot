import type { PoolClient, QueryResultRow } from "pg";
import { queryNeon, withNeonClient } from "./neonDb";
import { tripToPoster } from "./connectedTripMapping";
import type { TravelTrip } from "./travelTypes";
import { getPosterPdfPublicUrl } from "./poster/pdfUrl";

let ready: Promise<void> | undefined;
export type PosterWrite = { id: string; title: string; data: unknown; source_file?: string | null; note?: string | null };
export function ensureConnectedTripSchema(): Promise<void> {
  return ready ??= setup().catch(error => { ready = undefined; throw error; });
}
async function setup() {
  const result = await queryNeon(`
    CREATE TABLE IF NOT EXISTS poster_trips (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', source_file TEXT,
      data JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS poster_trip_versions (
      id BIGSERIAL PRIMARY KEY, trip_id TEXT NOT NULL, data JSONB NOT NULL,
      note TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS travel_trip_poster_unique
      ON travel_trip_entries ((extra->>'poster_trip_id'))
      WHERE COALESCE(extra->>'poster_trip_id', '') <> '';
    CREATE TABLE IF NOT EXISTS trip_website_sync (
      trip_id TEXT PRIMARY KEY, revision BIGINT NOT NULL DEFAULT 1,
      synced_revision BIGINT NOT NULL DEFAULT 0, attempts INT NOT NULL DEFAULT 0,
      last_error TEXT, website_trip_id TEXT, website_slug TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), synced_at TIMESTAMPTZ
    );
    -- Set when the last successful sync held back the trip's content fields
    -- (title/description/hotel/included/excluded/notes/images) because staff
    -- had edited them on the website since the sync last wrote them. Price,
    -- availability and publish status still synced normally — only the sell
    -- copy is on hold, and stays that way until someone edits the trip again
    -- from the chatbot/poster side, which resolves the conflict in favour of
    -- the newer chatbot edit.
    ALTER TABLE trip_website_sync ADD COLUMN IF NOT EXISTS content_conflict BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS connected_trip_assets (
      hash TEXT PRIMARY KEY, url TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS poster_pdf_cache (
      poster_id TEXT PRIMARY KEY, hash TEXT NOT NULL, pdf BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE OR REPLACE FUNCTION queue_trip_website_sync() RETURNS trigger AS $$
    BEGIN
      INSERT INTO trip_website_sync (trip_id) VALUES (COALESCE(NEW.id, OLD.id))
      ON CONFLICT (trip_id) DO UPDATE SET revision = trip_website_sync.revision + 1,
        updated_at = NOW(), last_error = NULL;
      RETURN COALESCE(NEW, OLD);
    END;
    $$ LANGUAGE plpgsql;
    CREATE OR REPLACE TRIGGER trip_website_sync_changed
      AFTER INSERT OR UPDATE OR DELETE ON travel_trip_entries
      FOR EACH ROW EXECUTE FUNCTION queue_trip_website_sync();
  `);
  if (!result) throw new Error("Trip database is not configured");
}

export async function syncTripPoster(client: PoolClient, trip: TravelTrip, before?: TravelTrip | null) {
  const posterId = String(trip.extra.poster_trip_id || `poster-for-${trip.id}`);
  const existing = await client.query(`SELECT data FROM poster_trips WHERE id = $1 FOR UPDATE`, [posterId]);
  const data = tripToPoster(trip, existing.rows[0]?.data, before);
  await client.query(`INSERT INTO poster_trips (id, title, source_file, data)
    VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO UPDATE SET
    title = EXCLUDED.title, data = EXCLUDED.data, updated_at = NOW()`,
  [posterId, trip.route_name, trip.source_description || null, JSON.stringify(data)]);
  if (JSON.stringify(existing.rows[0]?.data) !== JSON.stringify(data)) {
    await client.query(`INSERT INTO poster_trip_versions (trip_id,data,note) VALUES ($1,$2::jsonb,$3)`,
      [posterId, JSON.stringify(data), "Chatbot trip update"]);
  }
  if (trip.extra.poster_trip_id !== posterId) {
    await client.query(`UPDATE travel_trip_entries SET extra = extra || jsonb_build_object('poster_trip_id',$2::text) WHERE id=$1`, [trip.id, posterId]);
    trip.extra.poster_trip_id = posterId;
  }
  return trip;
}

/** The trip, reverse poster update and durable delivery event commit together. */
export async function connectedTripMutation<T extends QueryResultRow>(
  sql: string, params: unknown[], id: string, updatePoster = true, poster?: PosterWrite,
) {
  await ensureConnectedTripSchema();
  return withNeonClient(async client => {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [id]);
      const prior = await client.query("SELECT * FROM travel_trip_entries WHERE id=$1", [id]);
      if (poster) {
        await client.query(`INSERT INTO poster_trips(id,title,data,source_file) VALUES($1,$2,$3::jsonb,$4)
          ON CONFLICT(id) DO UPDATE SET title=EXCLUDED.title,data=EXCLUDED.data,
          source_file=COALESCE(EXCLUDED.source_file,poster_trips.source_file),updated_at=NOW()`,
          [poster.id,poster.title,JSON.stringify(poster.data),poster.source_file || null]);
        await client.query(`INSERT INTO poster_trip_versions(trip_id,data,note) VALUES($1,$2::jsonb,$3)`,
          [poster.id,JSON.stringify(poster.data),poster.note || null]);
      }
      const result = await client.query<T>(sql, params);
      if (updatePoster && result.rows[0]) {
        await syncTripPoster(client, result.rows[0] as unknown as TravelTrip, prior.rows[0]);
      }
      if (result.rows[0]) {
        const trip = result.rows[0] as unknown as TravelTrip;
        const pdfUrl = getPosterPdfPublicUrl(String(trip.extra.poster_trip_id));
        if (pdfUrl) {
          trip.extra = { ...trip.extra, brochure_pdf_url: pdfUrl, brochure_pdf_required: true,
            brochure_pdf_missing: false, source_file_attachment_id: "" };
          await client.query("UPDATE travel_trip_entries SET extra=$2::jsonb WHERE id=$1", [id, JSON.stringify(trip.extra)]);
        }
      }
      await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
  });
}
