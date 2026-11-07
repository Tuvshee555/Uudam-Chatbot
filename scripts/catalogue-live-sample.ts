/**
 * Renders a catalogue from the LIVE trip catalogue and writes the PDF + one JPEG per page to a folder.
 * READ-ONLY: it reads trips and posters straight from the database, keeps trip codes in memory
 * (A01, A02, ...), stores nothing, publishes nothing and sends nothing. It is the quickest way to
 * look at what real data and real photos make of the design.
 *
 *   node --env-file=.env.local --import tsx scripts/catalogue-live-sample.ts <outDir> [quick|complete|preview] [count]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { queryNeon } from "../src/lib/neonDb";
import { mapTripRow } from "../src/lib/travelDb";
import { contactSettingsOf } from "../src/lib/contactReplies";
import { buildCatalogueSnapshot, loadPosterRows, planEdition } from "../src/lib/catalogue/tripData";
import { parsePhones } from "../src/lib/catalogue/contact";
import { renderCatalogue } from "../src/lib/catalogue/render";
import type { CatalogueEdition, CatalogueEditionConfig } from "../src/lib/catalogue/types";

const outDir = path.resolve(process.argv[2] || "outputs/catalogue-live");
const edition = (process.argv[3] || "quick") as CatalogueEdition;
const count = Number(process.argv[4] || 10);

async function main() {
  const nowIso = new Date().toISOString();
  const tripRows = await queryNeon<Record<string, unknown>>("SELECT * FROM travel_trip_entries WHERE status = 'active'");
  const trips = (tripRows?.rows || []).map(mapTripRow);
  const settingsRow = await queryNeon<{ extra: unknown }>("SELECT extra FROM travel_bot_settings LIMIT 1");
  const phones = parsePhones(contactSettingsOf(settingsRow?.rows[0]?.extra).phones);

  // Without a curated list, take the first eligible trips, newest first.
  const probe = planEdition({ edition: "complete", trips, config: emptyConfig() }, nowIso.slice(0, 10)).trips;
  const picked = [...probe].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, count);
  const config: CatalogueEditionConfig = { ...emptyConfig(), tripIds: picked.map((t) => t.id) };
  const planned = planEdition({ edition, trips, config }, nowIso.slice(0, 10)).trips;
  const codeMap: Record<string, string> = {};
  planned.forEach((trip, i) => { codeMap[trip.id] = `A${String(i + 1).padStart(2, "0")}`; });
  const posterByTripId = await loadPosterRows(planned);

  const snapshot = buildCatalogueSnapshot({
    edition, nowIso, trips, posterByTripId, config, codeMap, contactPhones: phones, siteBaseUrl: "https://uudamtravel.mn",
  });
  const started = Date.now();
  const rendered = await renderCatalogue(snapshot, { pageImages: true, versionLabel: "live-sample" });

  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, `${edition}.pdf`), rendered.pdf);
  for (let i = 0; i < rendered.pageImages.length; i++) {
    await writeFile(path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.jpg`), rendered.pageImages[i]!);
  }
  console.log(JSON.stringify({
    outDir, edition, trips: snapshot.trips.length, pages: rendered.pageCount,
    pdfMB: Math.round((rendered.pdf.length / 1024 / 1024) * 100) / 100, ms: Date.now() - started,
    groups: snapshot.groups.map((g) => `${g.label}: ${g.codes.join(",")}`),
    cards: snapshot.trips.map((t) => `${t.code} ${t.price.display} | ${t.dates.label} | ${t.highlights.length}hl | photo:${t.photo ? "y" : "n"}`),
    warnings: [...snapshot.warnings, ...rendered.warnings].map((w) => `${w.severity} ${w.code}${w.tripId ? ` ${w.tripId.slice(0, 8)}` : ""}`),
  }, null, 2));
}

function emptyConfig(): CatalogueEditionConfig {
  return { tripIds: [], groupOverrides: {}, featuredTripIds: [], excludedTripIds: [] };
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
