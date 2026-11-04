/**
 * Every trip shows at least six photos (owner, 2026-11-04). For trips with fewer, finds free
 * photos of the places the trip visits on Wikimedia Commons (tripPhotoFinder.ts: CC0 / public
 * domain / CC BY / CC BY-SA, 1600px+, ranked by a vision model; never border towns, stations
 * or airports) and adds them to the trip's gallery with their credit.
 *
 * Two steps, so nothing is written before a person has looked at the picks:
 *
 *   EVAL_RUN_APPROVED=1 node --env-file=.env.local --import tsx scripts/backfill-trip-photos.ts --select <manifest.json> [--sheet <dir>] [--only=<trip id,…>]
 *     Model calls (about two per trip, through evalGuard), no writes. Writes the manifest and,
 *     with --sheet, one contact-sheet JPEG per trip to look at.
 *
 *   node --env-file=.env.local --import tsx scripts/backfill-trip-photos.ts --apply <manifest.json> --backup <file> [--drop=<trip id>:<n>,…]
 *     No model calls. Saves every touched trip's photo_urls and photo_credits to the backup
 *     first, then per trip: download, shrink to 1920px, upload to Cloudinary, append to
 *     photo_urls and extra.photo_credits (connectedTripMutation, no poster rebuild), and push
 *     the website. A trip edited since the manifest was made is skipped. --drop leaves out a
 *     reviewed pick (1-based). Undo: restore photo_urls / photo_credits from the backup.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { queryNeon, closeNeonPool } from "../src/lib/neonDb";
import { connectedTripMutation } from "../src/lib/connectedTripStore";
import { flushWebsiteSync } from "../src/lib/websiteTripSync";
import { uploadImageToCloudinary } from "../src/lib/tripPhotoImport/upload";
import {
  PHOTOS_PER_TRIP, collectPhotoCandidates, commonsRendition, downloadPhoto, photoQueriesForTrip, rankPhotos, type FoundPhoto,
} from "../src/lib/tripPhotoFinder";
import { isTransitDay, type ItineraryDay } from "../src/lib/tripTransitDays";

type Row = Record<string, unknown>;
type ManifestTrip = { id: string; route: string; version: string; have: number; need: number; queries: string[]; picks: FoundPhoto[] };
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const listFlag = (name: string) => (args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) || "").split(",").map((v) => v.trim()).filter(Boolean);

/** Non-archived trips and their distinct photos: poster cover, poster day photos and gallery (counted in SQL). */
async function thinTrips(): Promise<Array<Row & { distinct: number }>> {
  const { rows } = (await queryNeon<Row & { distinct: number }>(`
    WITH p AS (
      SELECT id, NULLIF(data->>'hero_image','') AS hero,
        (SELECT COALESCE(array_agg(d->>'photo'), '{}') FROM jsonb_array_elements(COALESCE(data->'days','[]'::jsonb)) d WHERE COALESCE(d->>'photo','') <> '') AS day_photos
      FROM poster_trips)
    SELECT t.id, t.route_name, t.status, t.extra, t.updated_at::text AS version,
      (SELECT count(DISTINCT u)::int FROM unnest(ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(t.photo_urls)='array' THEN t.photo_urls ELSE '[]'::jsonb END))
        || COALESCE(p.day_photos,'{}') || ARRAY[p.hero]) u WHERE u IS NOT NULL AND u <> '') AS distinct
    FROM travel_trip_entries t LEFT JOIN p ON p.id = t.extra->>'poster_trip_id'
    WHERE t.status IN ('active','sold_out','draft')
    ORDER BY t.route_name`))!;
  return rows.filter((row) => Number(row.distinct) < PHOTOS_PER_TRIP);
}

async function contactSheet(trip: ManifestTrip, dir: string) {
  const tiles = await Promise.all(trip.picks.map(async (photo) => {
    const response = await fetch(commonsRendition(photo.url, 500), { headers: { "user-agent": "UudamTravelChatbot/1.0 (https://uudamtravel.mn; trip photos)" } });
    return sharp(Buffer.from(await response.arrayBuffer())).resize(480, 320, { fit: "cover" }).jpeg().toBuffer();
  }));
  if (!tiles.length) return;
  const columns = 3;
  const sheet = sharp({ create: { width: columns * 480, height: Math.ceil(tiles.length / columns) * 320, channels: 3, background: "#ffffff" } })
    .composite(tiles.map((input, i) => ({ input, left: (i % columns) * 480, top: Math.floor(i / columns) * 320 })));
  await sheet.jpeg({ quality: 70 }).toFile(path.join(dir, `${trip.id}.jpg`));
}

async function select(manifestPath: string) {
  const { requireApprovedEvaluation } = await import("./lib/evalGuard.mjs");
  const only = new Set(listFlag("--only"));
  const trips = (await thinTrips()).filter((trip) => !only.size || only.has(String(trip.id)));
  requireApprovedEvaluation({ name: "trip photo backfill (select)", estimatedModelCalls: trips.length * 2 + 2 });
  const sheetDir = flag("--sheet");
  if (sheetDir) mkdirSync(sheetDir, { recursive: true });
  const used = new Set<string>();
  const manifest: ManifestTrip[] = [];
  for (const trip of trips) {
    const extra = record(trip.extra);
    const days = (Array.isArray(extra.itinerary_days) ? extra.itinerary_days : []).map((day) => record(day) as ItineraryDay).filter((day) => !isTransitDay(day));
    const need = PHOTOS_PER_TRIP - Number(trip.distinct);
    const queries = await photoQueriesForTrip({ title: String(trip.route_name), days, destinations: strings(extra.destinations) });
    const candidates = (await collectPhotoCandidates(queries.map((q) => q.query), { perQuery: 6 })).filter((photo) => !used.has(photo.url));
    const picks = await rankPhotos(candidates, { subject: `${trip.route_name}: ${queries.map((q) => q.query).join(", ")}`, count: need });
    for (const photo of picks) used.add(photo.url);
    const entry: ManifestTrip = { id: String(trip.id), route: String(trip.route_name), version: String(trip.version), have: Number(trip.distinct), need, queries: queries.map((q) => q.query), picks };
    manifest.push(entry);
    console.log(`\n${entry.route} [${trip.status}] has ${entry.have}, needs ${need}, picked ${picks.length}`);
    console.log(`  queries: ${entry.queries.join(" | ")}`);
    picks.forEach((photo, i) => console.log(`  ${i + 1}. ${photo.title} (${photo.license}, ${photo.author})`));
    if (sheetDir) await contactSheet(entry, sheetDir).catch((error) => console.log(`  (no contact sheet: ${error instanceof Error ? error.message : error})`));
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
  }
  const { processAiTotals } = await import("../src/lib/aiUsage");
  console.log(`\nManifest: ${manifestPath} — ${manifest.length} trips, ${manifest.reduce((n, t) => n + t.picks.length, 0)} photos. Model use: ${JSON.stringify(processAiTotals())}`);
}

async function apply(manifestPath: string, backupPath: string) {
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ManifestTrip[];
  const drops = new Map<string, Set<number>>();
  for (const item of listFlag("--drop")) {
    const [id, n] = item.split(":");
    if (!drops.has(id)) drops.set(id, new Set());
    drops.get(id)!.add(Number(n));
  }
  const ids = manifest.map((trip) => trip.id);
  const { rows: current } = (await queryNeon<Row>("SELECT id, route_name, photo_urls, extra, updated_at::text AS version FROM travel_trip_entries WHERE id = ANY($1::text[])", [ids]))!;
  writeFileSync(backupPath, JSON.stringify(current.map((row) => ({ id: row.id, route_name: row.route_name, version: row.version,
    photo_urls: row.photo_urls, photo_credits: record(row.extra).photo_credits ?? null })), null, 1));
  console.log(`Backup of ${current.length} trips: ${backupPath}`);
  for (const trip of manifest) {
    const row = current.find((candidate) => candidate.id === trip.id);
    if (!row) { console.log(`- ${trip.route}: trip gone, skipped`); continue; }
    if (row.version !== trip.version) { console.log(`- ${trip.route}: edited since the manifest, skipped`); continue; }
    const picks = trip.picks.filter((_, i) => !drops.get(trip.id)?.has(i + 1));
    const urls: string[] = [];
    const credits: Row = { ...record(record(row.extra).photo_credits) };
    for (const photo of picks) {
      const file = await downloadPhoto(photo);
      if (!file) { console.log(`  ! download failed: ${photo.title}`); continue; }
      const url = await uploadImageToCloudinary(file.buffer, `${photo.title.replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) || "photo"}.jpg`, file.mimeType);
      urls.push(url);
      credits[url] = { title: photo.title, author: photo.author, license: photo.license, page: photo.pageUrl, provider: "Wikimedia Commons" };
    }
    if (!urls.length) { console.log(`- ${trip.route}: nothing uploaded`); continue; }
    const photoUrls = [...new Set([...strings(row.photo_urls), ...urls])];
    await connectedTripMutation(
      `UPDATE travel_trip_entries SET photo_urls=$1::jsonb, extra=COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [JSON.stringify(photoUrls), JSON.stringify({ photo_credits: credits }), trip.id],
      trip.id, false, undefined, trip.version,
    );
    const pushed = await flushWebsiteSync(trip.id).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    console.log(`- ${trip.route}: +${urls.length} photos (gallery ${strings(row.photo_urls).length} → ${photoUrls.length}); website ${JSON.stringify(pushed)}`);
  }
}

async function main() {
  const selectPath = flag("--select");
  const applyPath = flag("--apply");
  if (selectPath) await select(selectPath);
  else if (applyPath) {
    const backup = flag("--backup");
    if (!backup) throw new Error("--apply needs --backup <file>");
    await apply(applyPath, backup);
  } else throw new Error("usage: --select <manifest.json> [--sheet <dir>] | --apply <manifest.json> --backup <file>");
}

main().then(() => closeNeonPool(), async (error) => { console.error(error); await closeNeonPool().catch(() => {}); process.exitCode = 1; });
