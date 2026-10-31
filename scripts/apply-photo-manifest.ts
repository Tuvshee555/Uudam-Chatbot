/**
 * Applies a reviewed photo manifest (see docs/photo-audit in the website repo)
 * to the canonical trips: poster cover and day photos, and the trip's gallery
 * (photo_urls). Every change goes through connectedTripMutation, so the poster
 * gets a poster_trip_versions row (the rollback point) and the website
 * projection is queued as for any other edit.
 *
 *   npx tsx scripts/apply-photo-manifest.ts <manifest.json> [--apply] [--backup <file>]
 *   npx tsx scripts/apply-photo-manifest.ts <manifest.json> --rehost [--apply]
 *
 * New photos are referenced by their source URL. The production projection
 * copies them to Cloudinary (connected_trip_assets); --rehost then swaps those
 * copies into the canonical record, so neither the site nor the bot hotlinks
 * a third-party file. A change is skipped when the slot no longer holds the
 * reviewed "before" photo: someone changed it since the review.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { queryNeon } from "../src/lib/neonDb";
import { connectedTripMutation } from "../src/lib/connectedTripStore";
import { isSitePhotoHost } from "../src/lib/websiteTripSync";

type Row = Record<string, unknown>;
type Change = { slot: string; before: string | null; after: string | null; reason?: string; location?: string };
type ManifestTrip = { n: number; title: string; sourceTripId: string; posterId: string; published: boolean; changes: Change[]; remove: string[] };
type Source = { subject: string; title: string; page: string; url: string; license: string; licenseUrl: string; author: string; provider: string };
type Manifest = { version: string; sources: Record<string, Source>; trips: ManifestTrip[] };

const args = process.argv.slice(2);
const manifestPath = args.find((arg) => !arg.startsWith("--"));
const apply = args.includes("--apply");
const rehost = args.includes("--rehost");
const backupPath = args.includes("--backup") ? args[args.indexOf("--backup") + 1] : `photo-backup-${Date.now()}.json`;
const record = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const records = (value: unknown): Row[] => Array.isArray(value) ? value.map(record) : [];
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

async function hostedCopies(urls: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const url of urls) {
    const hash = createHash("sha256").update(url).digest("hex");
    const row = (await queryNeon<{ url: string }>("SELECT url FROM connected_trip_assets WHERE hash=$1", [hash]))?.rows[0];
    if (row?.url) map.set(url, row.url);
  }
  return map;
}

async function main() {
  if (!manifestPath) throw new Error("usage: apply-photo-manifest.ts <manifest.json> [--apply] [--rehost]");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  const host = new URL(String(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL)).host.split(".")[0];
  console.log(`${apply ? "APPLYING" : "Dry run"}${rehost ? " (rehost)" : ""} on ${host}, manifest ${manifest.version}`);
  const sourceByUrl = new Map(Object.values(manifest.sources).map((source) => [source.url, source]));
  const hosted = rehost ? await hostedCopies([...sourceByUrl.keys()]) : new Map<string, string>();
  if (rehost) console.log(`Cloudinary copies found: ${hosted.size}/${sourceByUrl.size}`);
  const backup: Row[] = [];
  let applied = 0, skipped = 0;

  for (const trip of manifest.trips) {
    const tripRow = (await queryNeon<Row>("SELECT id, route_name, photo_urls, extra, updated_at::text AS version FROM travel_trip_entries WHERE id=$1", [trip.sourceTripId]))?.rows[0];
    const posterRow = (await queryNeon<Row>("SELECT id, title, source_file, data FROM poster_trips WHERE id=$1", [trip.posterId]))?.rows[0];
    if (!tripRow || !posterRow) { console.log(`- T${trip.n} ${trip.title.slice(0, 40)}: trip or poster missing, skipped`); skipped++; continue; }
    const poster = structuredClone(record(posterRow.data));
    const days = records(poster.days);
    const notes: string[] = [];
    let photoUrls = strings(tripRow.photo_urls);
    const extra = record(tripRow.extra);
    const credits: Row = { ...record(extra.photo_credits) };

    if (!rehost) {
      const removed = new Set(trip.remove);
      for (const change of trip.changes) {
        const day = change.slot.startsWith("day:") ? days.find((entry, i) => (Number(entry.day) || i + 1) === Number(change.slot.slice(4))) : null;
        const current = change.slot === "cover" ? (typeof poster.hero_image === "string" ? poster.hero_image : null) : day && typeof day.photo === "string" ? day.photo : null;
        if (current === change.after) continue;
        if (current !== change.before) { notes.push(`${change.slot}: changed since review, left as is`); continue; }
        if (change.slot === "cover") poster.hero_image = change.after;
        else if (day) { if (change.after) day.photo = change.after; else delete day.photo; }
        notes.push(`${change.slot}${change.after ? "" : " (cleared)"}`);
      }
      // A removed photo leaves every slot, not only the reviewed ones.
      for (const day of days) if (typeof day.photo === "string" && removed.has(day.photo)) { delete day.photo; notes.push(`day:${day.day} cleared (removed photo)`); }
      if (typeof poster.hero_image === "string" && removed.has(poster.hero_image)) poster.hero_image = null;
      photoUrls = photoUrls.filter((url) => !removed.has(url));
    } else {
      const swap = (url: unknown) => typeof url === "string" && hosted.has(url) ? hosted.get(url)! : url;
      if (hosted.has(String(poster.hero_image))) { poster.hero_image = swap(poster.hero_image); notes.push("cover rehosted"); }
      for (const day of days) if (hosted.has(String(day.photo))) { day.photo = swap(day.photo); notes.push(`day:${day.day} rehosted`); }
      for (const [url, entry] of Object.entries(credits)) if (hosted.has(url)) { credits[hosted.get(url)!] = { ...record(entry), sourceUrl: url }; delete credits[url]; }
    }
    poster.days = days;
    // The gallery: the cover first, then every day photo, then kept extras —
    // only photos the site can draw (a source URL waits for its Cloudinary copy).
    const ordered = [poster.hero_image, ...days.map((day) => day.photo), ...photoUrls]
      .filter((url): url is string => typeof url === "string" && isSitePhotoHost(url));
    photoUrls = [...new Set(ordered)];
    if (!rehost) {
      for (const url of [poster.hero_image, ...days.map((day) => day.photo)]) {
        const source = typeof url === "string" ? sourceByUrl.get(url) : undefined;
        if (source) credits[url as string] = { subject: source.subject, title: source.title, author: source.author, license: source.license, licenseUrl: source.licenseUrl, page: source.page, provider: source.provider };
      }
    }
    const unchanged = JSON.stringify(poster) === JSON.stringify(posterRow.data) && JSON.stringify(photoUrls) === JSON.stringify(strings(tripRow.photo_urls))
      && JSON.stringify(credits) === JSON.stringify(record(extra.photo_credits));
    console.log(`- T${trip.n} ${trip.published ? "P" : "-"} ${trip.title.slice(0, 40)}: ${unchanged ? "nothing to do" : notes.join(", ") || "gallery"} | gallery ${strings(tripRow.photo_urls).length}→${photoUrls.length}`);
    if (unchanged) continue;
    backup.push({ n: trip.n, sourceTripId: trip.sourceTripId, posterId: trip.posterId, version: tripRow.version, photo_urls: tripRow.photo_urls, photo_credits: extra.photo_credits ?? null, photo_audit: extra.photo_audit ?? null, poster: posterRow.data });
    if (!apply) continue;
    const audit = [...records(extra.photo_audit), { version: manifest.version, at: new Date().toISOString(), step: rehost ? "rehost" : "apply", changes: notes }].slice(-20);
    await connectedTripMutation(
      `UPDATE travel_trip_entries SET photo_urls=$1::jsonb, extra=COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE id=$3 RETURNING *`,
      [JSON.stringify(photoUrls), JSON.stringify({ photo_credits: credits, photo_audit: audit }), trip.sourceTripId],
      trip.sourceTripId, false,
      { id: trip.posterId, title: String(posterRow.title), data: poster, source_file: (posterRow.source_file as string | null) ?? null, note: `Photo audit ${manifest.version}${rehost ? " (Cloudinary copies)" : ""}: ${notes.join("; ").slice(0, 400)}` },
      String(tripRow.version),
    );
    applied++;
  }
  writeFileSync(backupPath, JSON.stringify(backup, null, 1));
  console.log(`${apply ? "Applied" : "Would apply"} ${apply ? applied : backup.length} trips; skipped ${skipped}. Backup of the previous state: ${backupPath}`);
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
