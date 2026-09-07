import { loadEnvConfig } from "@next/env";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { Pool } from "pg";

loadEnvConfig(process.cwd());
if (!process.env.BOOKING_DATABASE_URL) {
  const env = parseEnv(readFileSync("../uudam-booking-web/.env", "utf8"));
  process.env.BOOKING_DATABASE_URL = env.DATABASE_URL;
}
process.env.SITE_URL ||= "https://uudam-chatbot.vercel.app";

async function main() {
  const { queryNeon, closeNeonPool } = await import("../src/lib/neonDb");
  const { ensureConnectedTripSchema, connectedTripMutation } = await import("../src/lib/connectedTripStore");
  const { flushWebsiteSync, closeBookingPool, websiteSyncStatus, materializePoster } = await import("../src/lib/websiteTripSync");
  const { exportPosterTrips, savePosterTrip } = await import("../src/lib/poster/db");
  const { posterPhotos } = await import("../src/lib/connectedTripMapping");
  const { patchTrip } = await import("../src/lib/travelDb");
  const url = new URL(process.env.BOOKING_DATABASE_URL!);
  url.searchParams.set("sslmode", "verify-full");
  const web = new Pool({ connectionString: url.toString() });
  try {
    if (process.argv.includes("--backfill")) {
      const backup = {
        source: (await queryNeon("SELECT * FROM travel_trip_entries"))?.rows,
        posters: await exportPosterTrips(),
        website: (await web.query('SELECT * FROM "Trip"')).rows,
        itinerary: (await web.query('SELECT * FROM "ItineraryDay"')).rows,
        departures: (await web.query('SELECT * FROM "Departure"')).rows,
      };
      mkdirSync("tmp", { recursive: true });
      writeFileSync(`tmp/connected-trip-backup-${Date.now()}.json`, JSON.stringify(backup));
      await ensureConnectedTripSchema();
      for (const poster of await exportPosterTrips()) {
        const linked = await queryNeon<{ id: string }>("SELECT id FROM travel_trip_entries WHERE extra->>'poster_trip_id'=$1", [poster.id]);
        if (!linked?.rows[0]) { await savePosterTrip(poster); continue; }
        const data = await materializePoster(poster.data);
        await connectedTripMutation("UPDATE travel_trip_entries SET photo_urls=$2::jsonb WHERE id=$1 RETURNING *",
          [linked.rows[0].id,JSON.stringify(posterPhotos(data))],linked.rows[0].id,false,{...poster,data,note:"Enable connected website delivery"});
        await flushWebsiteSync(linked.rows[0].id,1);
        console.log(`Connected ${poster.title}`);
      }
      const orphans = await queryNeon<{ id: string; route_name: string }>(`SELECT id,route_name FROM travel_trip_entries
        WHERE COALESCE(extra->>'poster_trip_id','')=''`);
      for (const row of orphans?.rows || []) await patchTrip(row.id,{ route_name:row.route_name });
      await flushWebsiteSync(undefined,100);
      console.log(JSON.stringify(await websiteSyncStatus(),null,2));
    }
    const source = await queryNeon(`SELECT t.id,t.route_name,t.extra->>'poster_trip_id' AS poster_id,
      p.id IS NOT NULL AS has_poster FROM travel_trip_entries t LEFT JOIN poster_trips p ON p.id=t.extra->>'poster_trip_id' ORDER BY t.id`);
    const website = await web.query(`SELECT id,"sourceTripId","brochurePdfUrl",image FROM "Trip" ORDER BY "sourceTripId"`);
    const ids = new Set(website.rows.map(row => row.sourceTripId));
    console.log(JSON.stringify({ source:source?.rows.length, posters:source?.rows.filter(r=>r.has_poster).length,
      website:website.rows.length, missingWebsite:source?.rows.filter(row=>!ids.has(row.id)).map(row=>row.id),
      websiteWithoutPdf:website.rows.filter(row=>!row.brochurePdfUrl).length },null,2));
  } finally { await closeNeonPool(); await closeBookingPool(); await web.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
