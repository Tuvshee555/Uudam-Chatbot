/**
 * Renders a catalogue from the LIVE trip catalogue and writes the PDF + one JPEG per page to a folder.
 * READ-ONLY: it reads trips and posters straight from the database, keeps trip codes in memory
 * (A01, A02, ...), stores nothing, publishes nothing and sends nothing. It is the quickest way to
 * look at what real data and real photos make of the design.
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-live-sample.ts <outDir> [quick|complete|preview] [count]
 *        [--picks <picks.json>]   apply the photo editor's hero choices (see scripts/catalogue-photo-audit.ts)
 *        [--measure]              read the real pixel size of the candidate photos (downloads images)
 *        [--no-render]            only print the recommended shortlist and the groups, render nothing
 *
 * The quick / preview edition is the RECOMMENDED shortlist (curation.ts: a balanced, one-place-one-slot,
 * premium-photo mix), not "the newest trips".
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryNeon } from "../src/lib/neonDb";
import { mapTripRow } from "../src/lib/travelDb";
import { contactSettingsOf } from "../src/lib/contactReplies";
import { buildCatalogueSnapshot, loadPosterRows, planEdition, recommendedShortlistFor } from "../src/lib/catalogue/tripData";
import { parsePhones } from "../src/lib/catalogue/contact";
import { sanitizeHeroByTripId } from "../src/lib/catalogue/config";
import { measurePhotoSizes, rankPhotoCandidates, type PhotoSizes } from "../src/lib/catalogue/photos";
import { ubDay } from "../src/lib/catalogue/pricing";
import type { CatalogueEdition, CatalogueEditionConfig } from "../src/lib/catalogue/types";

const args = process.argv.slice(2);
const option = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1]! : null;
};
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--picks");
const outDir = path.resolve(positional[0] || "outputs/catalogue-live");
const edition = (positional[1] || "quick") as CatalogueEdition;
const count = Number(positional[2] || 10);
const picksFile = option("--picks");

async function main() {
  const nowIso = new Date().toISOString();
  const today = ubDay(nowIso);
  const tripRows = await queryNeon<Record<string, unknown>>("SELECT * FROM travel_trip_entries WHERE status = 'active'");
  const trips = (tripRows?.rows || []).map(mapTripRow);
  const settingsRow = await queryNeon<{ extra: unknown }>("SELECT extra FROM travel_bot_settings LIMIT 1");
  const phones = parsePhones(contactSettingsOf(settingsRow?.rows[0]?.extra).phones);

  const heroByTripId = picksFile ? sanitizeHeroByTripId(JSON.parse(await readFile(path.resolve(picksFile), "utf8"))) : {};
  const eligible = planEdition({ edition: "complete", trips, config: emptyConfig() }, today).trips;
  const posterByTripId = await loadPosterRows(eligible);

  // Real sizes: the chosen heroes plus the best few candidates of every eligible trip (--measure).
  let photoSizes: PhotoSizes = {};
  if (flags.has("--measure")) {
    const urls = new Set<string>(Object.values(heroByTripId).map((choice) => choice.url));
    for (const trip of eligible) for (const candidate of rankPhotoCandidates(trip, posterByTripId[trip.id]).slice(0, 6)) urls.add(candidate.url);
    photoSizes = await measurePhotoSizes([...urls]);
    console.log(`measured ${Object.keys(photoSizes).length}/${urls.size} photos`);
  }

  const context = { posterByTripId, heroByTripId, photoSizes };
  // The edition's trips: the recommended shortlist (quick / preview), or every eligible trip (complete).
  const shortlist = recommendedShortlistFor(trips, today, context);
  const config: CatalogueEditionConfig = { ...emptyConfig(), tripIds: edition === "complete" ? [] : shortlist.tripIds.slice(0, count) };
  const planned = planEdition({ edition, trips, config }, today).trips;
  const codeMap: Record<string, string> = {};
  planned.forEach((trip, i) => { codeMap[trip.id] = `A${String(i + 1).padStart(2, "0")}`; });

  const snapshot = buildCatalogueSnapshot({
    edition, nowIso, trips, posterByTripId, config, heroByTripId, photoSizes, codeMap, contactPhones: phones, siteBaseUrl: "https://uudamtravel.mn",
  });
  const summary = {
    outDir, edition, trips: snapshot.trips.length, cover: snapshot.trips.find((t) => t.tripId === snapshot.coverTripId)?.editorialTitle ?? null,
    groups: snapshot.groups.map((g) => `${g.label}: ${g.codes.join(",")}`),
    shortlist: snapshot.trips.map((t) => `${t.code} [${t.groupKey}] ${t.editorialTitle} | ${t.price.display} | ${t.durationText} | ${t.transportLabel} | hero:${t.heroQuality}${t.photo?.focal ? " staff-focal" : ""} | dest:${t.destinationKey} | ${shortlist.reasons[t.tripId] ?? ""}`),
    highlights: snapshot.trips.map((t) => `${t.code}: ${t.highlights.join(" / ") || "—"}`),
    warnings: snapshot.warnings.map((w) => `${w.severity} ${w.code}${w.tripId ? ` ${w.tripId.slice(0, 8)}` : ""}`),
  };
  if (flags.has("--no-render")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  const { renderCatalogue } = await import("../src/lib/catalogue/render");
  const started = Date.now();
  const rendered = await renderCatalogue(snapshot, { pageImages: true, versionLabel: "live-sample" });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${edition}.pdf`), rendered.pdf);
  for (let i = 0; i < rendered.pageImages.length; i++) {
    await writeFile(path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.jpg`), rendered.pageImages[i]!);
  }
  console.log(JSON.stringify({
    ...summary, pages: rendered.pageCount, pdfMB: Math.round((rendered.pdf.length / 1024 / 1024) * 100) / 100, ms: Date.now() - started,
    warnings: [...snapshot.warnings, ...rendered.warnings].map((w) => `${w.severity} ${w.code}${w.tripId ? ` ${w.tripId.slice(0, 8)}` : ""}`),
  }, null, 2));
}

function emptyConfig(): CatalogueEditionConfig {
  return { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] };
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
