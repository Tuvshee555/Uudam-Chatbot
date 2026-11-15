/**
 * Applies a reviewed photo plan (docs/photo-audit/<date>/photo-plan.json) to the canonical
 * trips. Unlike apply-photo-manifest.ts, the plan states the wanted result per trip — the
 * cover, the photo of a program day, photos to take out everywhere, photos to add to the
 * gallery — and new photos are copied to our Cloudinary before anything is written, so one
 * run leaves the trip, its poster and the website in the final state.
 *
 *   node --env-file=.env.local --import tsx scripts/apply-photo-plan.ts <plan.json> [--only=<n,…>]
 *     Dry run: prints what would change per trip. No uploads, no writes.
 *   node --env-file=.env.local --env-file=<cloudinary env> --import tsx scripts/apply-photo-plan.ts <plan.json> --apply --backup <file> [--only=<n,…>]
 *     Uploads the new photos (1920px JPEG; the hosted URL of each source is kept in
 *     <plan>.hosted.json so a second run uploads nothing twice), saves every touched trip's
 *     previous photos, credits, day photos and poster to the backup, writes through
 *     connectedTripMutation (poster version = rollback point) and pushes the website.
 *
 * Every place a photo lives is kept in step (tripPhotoEdit.ts): the gallery photo_urls, the
 * program days' extra.itinerary_days[].photo, and the poster's hero_image and days[].photo —
 * a gallery photo the poster does not show becomes a photo-only slot after the program. A
 * trip whose photos are no longer the reviewed ones is skipped: someone changed it since.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import sharp from "sharp";
import { queryNeon, closeNeonPool } from "../src/lib/neonDb";
import { connectedTripMutation } from "../src/lib/connectedTripStore";
import { flushWebsiteSync, isSitePhotoHost } from "../src/lib/websiteTripSync";
import { uploadImageToCloudinary } from "../src/lib/tripPhotoImport/upload";
import { isProgramPosterDay, posterProgramDayIndex, MAX_TRIP_PHOTOS } from "../src/lib/tripPhotoEdit";

type Row = Record<string, unknown>;
type Source = { subject: string; title: string; page: string; url: string; license: string; licenseUrl?: string; author: string; provider: string };
type PlanTrip = {
  n: number; title: string; sourceTripId: string; posterId: string;
  /** The trip's photos in site order when it was reviewed; a different set means it was edited since. */
  reviewed: string[];
  /** A hosted photo URL, or "src:<key>" for a new photo listed under sources. */
  cover?: string;
  /** Program day number (the poster day's own number) → its photo, or null to leave the day without one. */
  days?: Record<string, string | null>;
  remove?: string[];
  add?: string[];
  note?: string;
};
type Plan = { version: string; sources: Record<string, Source>; trips: PlanTrip[] };

const USER_AGENT = "UudamTravelChatbot/1.0 (https://uudamtravel.mn; trip photos)";
const args = process.argv.slice(2);
const planPath = args.find((arg, index) => !arg.startsWith("--") && args[index - 1] !== "--backup");
const apply = args.includes("--apply");
const backupPath = args.includes("--backup") ? args[args.indexOf("--backup") + 1] : "";
const only = new Set((args.find((arg) => arg.startsWith("--only="))?.slice(7) || "").split(",").map((v) => Number(v.trim())).filter(Boolean));
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
const photoOf = (value: unknown): string => (typeof value === "string" && /^https:\/\//.test(value) ? value : "");

/** The trip's photos as the site lists them: cover, day photos in order, then the rest of the gallery. */
function siteOrder(poster: Row, photoUrls: string[]): string[] {
  return [...new Set([photoOf(poster.hero_image), ...records(poster.days).map((day) => photoOf(day.photo)), ...photoUrls].filter(Boolean))];
}

async function hostSource(source: Source): Promise<string> {
  const response = await fetch(source.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`download ${response.status} ${source.url}`);
  const buffer = await sharp(Buffer.from(await response.arrayBuffer())).rotate().resize({ width: 1920, withoutEnlargement: true }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  return uploadImageToCloudinary(buffer, `${source.title.replace(/\.[a-z0-9]+$/i, "").replace(/[^\p{L}\p{N}]+/gu, "-").slice(0, 60) || "photo"}.jpg`, "image/jpeg");
}

async function main() {
  if (!planPath) throw new Error("usage: apply-photo-plan.ts <plan.json> [--apply --backup <file>] [--only=<n,…>]");
  if (apply && !backupPath) throw new Error("--apply needs --backup <file>");
  const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
  const trips = plan.trips.filter((trip) => !only.size || only.has(trip.n));
  const host = new URL(String(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL)).host.split(".")[0];
  console.log(`${apply ? "APPLYING" : "Dry run"} on ${host}, plan ${plan.version}, ${trips.length} trips`);

  // New photos → our Cloudinary first, so nothing below ever writes a third-party URL.
  const hostedPath = planPath.replace(/\.json$/, "") + ".hosted.json";
  const hosted: Record<string, string> = existsSync(hostedPath) ? JSON.parse(readFileSync(hostedPath, "utf8")) : {};
  const refs = (trip: PlanTrip) => [trip.cover, ...Object.values(trip.days || {}), ...(trip.add || [])].filter((ref): ref is string => typeof ref === "string");
  const wanted = [...new Set(trips.flatMap(refs).filter((ref) => ref.startsWith("src:")).map((ref) => ref.slice(4)))];
  for (const key of wanted) if (!plan.sources[key]) throw new Error(`plan names an unknown source: ${key}`);
  if (apply) {
    for (const key of wanted) {
      if (hosted[key]) continue;
      hosted[key] = await hostSource(plan.sources[key]);
      writeFileSync(hostedPath, JSON.stringify(hosted, null, 1));
      console.log(`  hosted ${key}`);
    }
  }
  const sourceOfUrl = new Map<string, Source>();
  const resolve = (ref: string): string => {
    if (!ref.startsWith("src:")) return ref;
    const key = ref.slice(4);
    // A dry run has not uploaded yet: a stand-in address keeps the counts honest; --apply never writes one.
    const url = hosted[key] || `https://dry-run.invalid/${key}`;
    sourceOfUrl.set(url, plan.sources[key]);
    return url;
  };

  const backup: Row[] = [];
  let applied = 0, skipped = 0;
  for (const trip of trips) {
    const label = `T${trip.n} ${trip.title.slice(0, 44)}`;
    const tripRow = (await queryNeon<Row>("SELECT id, route_name, photo_urls, extra, updated_at::text AS version FROM travel_trip_entries WHERE id=$1", [trip.sourceTripId]))?.rows[0];
    const posterRow = (await queryNeon<Row>("SELECT id, title, source_file, data FROM poster_trips WHERE id=$1", [trip.posterId]))?.rows[0];
    if (!tripRow || !posterRow) { console.log(`- ${label}: trip or poster missing, skipped`); skipped++; continue; }
    const before = record(posterRow.data);
    const galleryBefore = strings(tripRow.photo_urls);
    const current = siteOrder(before, galleryBefore);
    if (JSON.stringify([...current].sort()) !== JSON.stringify([...trip.reviewed].sort())) { console.log(`- ${label}: photos changed since the review, skipped`); skipped++; continue; }

    const removed = new Set(trip.remove || []);
    const poster = structuredClone(before);
    // A photo-only slot whose photo is taken out goes with it; a program day only loses the photo.
    let days = records(poster.days).filter((day) => isProgramPosterDay(day) || !removed.has(photoOf(day.photo)));
    for (const day of days) if (removed.has(photoOf(day.photo))) day.photo = null;
    const notes: string[] = [];
    for (const [number, ref] of Object.entries(trip.days || {})) {
      const day = days.find((entry, index) => isProgramPosterDay(entry) && (Number(entry.day) || index + 1) === Number(number));
      if (!day) { notes.push(`day ${number}: no such program day`); continue; }
      const next = ref ? resolve(ref) : null;
      if ((photoOf(day.photo) || null) !== next) { day.photo = next; notes.push(`day ${number}${next ? "" : " cleared"}`); }
    }
    let hero = photoOf(poster.hero_image);
    if (trip.cover) hero = resolve(trip.cover);
    else if (removed.has(hero)) hero = "";
    const additions = (trip.add || []).map(resolve);
    const dayPhotos = () => days.map((day) => photoOf(day.photo)).filter(Boolean);
    if (!hero) hero = dayPhotos()[0] || additions[0] || galleryBefore.find((url) => !removed.has(url)) || "";
    if (hero !== photoOf(before.hero_image)) notes.push("cover");
    // The gallery: cover, day photos, the kept extras, then the new ones — one photo once.
    const gallery = [...new Set([hero, ...dayPhotos(), ...galleryBefore.filter((url) => !removed.has(url)), ...additions].filter(Boolean))].slice(0, MAX_TRIP_PHOTOS);
    const shown = new Set([hero, ...dayPhotos()]);
    const lastDay = days.reduce((max, day, index) => Math.max(max, Number(day.day) || index + 1), 0);
    gallery.filter((url) => !shown.has(url)).forEach((url, index) => days.push({ day: lastDay + index + 1, route: "", summary: "", photo: url }));
    days = days.filter((day) => isProgramPosterDay(day) || photoOf(day.photo));
    poster.days = days;
    poster.hero_image = hero || null;

    // The chatbot's own program days follow the poster day they were copied from.
    const extra = record(tripRow.extra);
    const chatDays = records(extra.itinerary_days).map((day) => ({ ...day }));
    const beforeDays = records(before.days);
    let chatChanged = false;
    chatDays.forEach((day, index) => {
      const at = posterProgramDayIndex(days, index + 1);
      const was = posterProgramDayIndex(beforeDays, index + 1);
      const now = at >= 0 ? photoOf(days[at].photo) : "";
      const then = was >= 0 ? photoOf(beforeDays[was].photo) : "";
      const own = photoOf(day.photo);
      if (now === then && !removed.has(own)) return;
      if (now) day.photo = now; else delete day.photo;
      if (own !== now) chatChanged = true;
    });

    const credits: Row = { ...record(extra.photo_credits) };
    for (const url of Object.keys(credits)) if (!gallery.includes(url)) delete credits[url];
    for (const url of gallery) {
      const source = sourceOfUrl.get(url);
      if (source) credits[url] = { subject: source.subject, title: source.title, author: source.author, license: source.license, ...(source.licenseUrl ? { licenseUrl: source.licenseUrl } : {}), page: source.page, provider: source.provider, sourceUrl: source.url };
    }
    const unhosted = gallery.filter((url) => !isSitePhotoHost(url));
    const unchanged = JSON.stringify(poster) === JSON.stringify(before) && JSON.stringify(gallery) === JSON.stringify(galleryBefore) && !chatChanged;
    console.log(`- ${label}: ${unchanged ? "nothing to do" : `${notes.join(", ") || "gallery"} | photos ${current.length}→${gallery.length}, -${[...removed].filter((url) => current.includes(url)).length} +${gallery.filter((url) => !current.includes(url)).length}`}`);
    if (unchanged) continue;
    backup.push({ n: trip.n, sourceTripId: trip.sourceTripId, posterId: trip.posterId, version: tripRow.version, photo_urls: tripRow.photo_urls,
      photo_credits: extra.photo_credits ?? null, photo_audit: extra.photo_audit ?? null, itinerary_day_photos: records(extra.itinerary_days).map((day) => day.photo ?? null), poster: posterRow.data });
    if (!apply) continue;
    if (unhosted.length) { console.log(`  ! not on our Cloudinary, skipped: ${unhosted.join(", ")}`); skipped++; continue; }
    const audit = [...records(extra.photo_audit), { version: plan.version, at: new Date().toISOString(), step: "plan", changes: notes }].slice(-20);
    try {
      await connectedTripMutation(
        `UPDATE travel_trip_entries SET photo_urls=$1::jsonb, extra=COALESCE(extra,'{}'::jsonb) || $2::jsonb, updated_at=NOW() WHERE id=$3 RETURNING *`,
        [JSON.stringify(gallery), JSON.stringify({ photo_credits: credits, photo_audit: audit, ...(chatChanged ? { itinerary_days: chatDays } : {}) }), trip.sourceTripId],
        trip.sourceTripId, false,
        { id: trip.posterId, title: String(posterRow.title), data: poster, source_file: (posterRow.source_file as string | null) ?? null, note: `Photo audit ${plan.version}: ${notes.join("; ").slice(0, 400)}` },
        String(tripRow.version),
      );
    } catch (error) {
      console.log(`  ! not saved (${error instanceof Error ? error.message : error}); run again for this trip`);
      skipped++;
      continue;
    }
    writeFileSync(backupPath, JSON.stringify(backup, null, 1));
    const pushed = await flushWebsiteSync(trip.sourceTripId).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
    console.log(`  saved; website ${JSON.stringify(pushed)}`);
    applied++;
  }
  if (backupPath) writeFileSync(backupPath, JSON.stringify(backup, null, 1));
  console.log(`${apply ? "Applied" : "Would change"} ${apply ? applied : backup.length} trips; skipped ${skipped}.${backupPath ? ` Backup of the previous state: ${backupPath}` : ""}`);
}

main().then(() => closeNeonPool(), async (error) => { console.error(error); await closeNeonPool().catch(() => {}); process.exitCode = 1; });
