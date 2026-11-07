/**
 * Visual QA for the catalogue renderer. Builds a snapshot from INVENTED trips with synthetic photos
 * (no network, no database, no model), renders it and writes the PDF plus one JPEG per page.
 *
 *   node --import tsx scripts/catalogue-render-sample.ts <outDir> [tripCount]
 *
 * For design review with real photos, render a snapshot saved as JSON (for example from
 * scripts/catalogue-live-sample.ts) and keep the downloaded photos in a local cache folder so
 * every iteration renders offline:
 *
 *   node --import tsx scripts/catalogue-render-sample.ts <outDir> --snapshot snap.json \
 *        [--pick A01,A04,...] [--edition quick|complete] [--cache <folder>] [--cover A04]
 *
 * --pick keeps those codes (in that order, regrouped by the snapshot's groups); --cover sets the
 * cover trip. Nothing is stored, published or sent.
 *
 * Fixture mode also takes --cover-photo tall|ok (a dedicated portrait / landscape cover photograph) and
 * --notes (two invented company-group lines on the closing page).
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCatalogue } from "../src/lib/catalogue/render";
import { defaultImageFetcher } from "../src/lib/catalogue/render/images";
import { sampleImageFetcher, sampleSnapshot } from "../src/lib/catalogue/render/fixture";
import type { CatalogueSnapshot } from "../src/lib/catalogue/types";

const args = process.argv.slice(2);
const flag = (name: string): string | null => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1]!.startsWith("--") ? args[i + 1]! : null;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const outDir = path.resolve(positional[0] || "catalogue-sample-out");
const snapshotFile = flag("--snapshot");
const tripCount = Number(positional[1] || 8);
const coverPhotoShape = flag("--cover-photo") as "tall" | "ok" | null;
const sampleNotes = args.includes("--notes");

async function cachedFetcher(cacheDir: string) {
  await mkdir(cacheDir, { recursive: true });
  return async (url: string): Promise<Buffer | null> => {
    const file = path.join(cacheDir, `${createHash("sha1").update(url).digest("hex")}.bin`);
    try {
      return await readFile(file);
    } catch {
      /* not cached yet */
    }
    const bytes = await defaultImageFetcher(url);
    if (bytes) await writeFile(file, bytes);
    return bytes ? Buffer.from(bytes) : null;
  };
}

async function loadSnapshot(): Promise<CatalogueSnapshot> {
  if (!snapshotFile) {
    return sampleSnapshot({
      trips: tripCount,
      edition: tripCount > 12 ? "complete" : "quick",
      coverPhoto: coverPhotoShape ?? undefined,
      corporateNotes: sampleNotes ? ["Жишиг мөр нэг: байгууллагад зориулсан тусгай хөтөлбөрийг ажилтан бэлтгэнэ.", "Жишиг мөр хоёр: хамт олны хэмжээнээс хамаарч санал өөр байна."] : undefined,
    });
  }
  const snap = JSON.parse(await readFile(path.resolve(snapshotFile), "utf8")) as CatalogueSnapshot;
  const pick = (flag("--pick") || "").split(",").map(s => s.trim()).filter(Boolean);
  const edition = (flag("--edition") as CatalogueSnapshot["edition"] | null) ?? (pick.length ? "quick" : snap.edition);
  let trips = snap.trips;
  if (pick.length) trips = pick.map(code => snap.trips.find(t => t.code === code)).filter((t): t is NonNullable<typeof t> => !!t);
  const codes = new Set(trips.map(t => t.code));
  const groups = snap.groups
    .map(g => ({ ...g, codes: (pick.length ? pick : g.codes).filter(c => g.codes.includes(c) && codes.has(c)) }))
    .filter(g => g.codes.length > 0);
  const cover = flag("--cover");
  const coverUrl = flag("--cover-url");
  return {
    ...snap,
    ...(coverUrl ? { coverPhoto: { url: coverUrl, width: null, height: null, credit: null, source: "trip_photo" as const } } : {}),
    edition,
    trips,
    groups,
    coverTripId: cover ? (trips.find(t => t.code === cover)?.tripId ?? null) : (snap.coverTripId ?? null),
  };
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const snapshot = await loadSnapshot();
  const fetcher = snapshotFile ? await cachedFetcher(path.resolve(flag("--cache") || path.join(outDir, "..", "photo-cache"))) : sampleImageFetcher();
  const started = Date.now();
  const rendered = await renderCatalogue(snapshot, { pageImages: true, imageFetcher: fetcher, versionLabel: "v-sample" });
  const pdfName = snapshotFile ? `${snapshot.edition}.pdf` : "sample.pdf";
  await writeFile(path.join(outDir, pdfName), rendered.pdf);
  for (let i = 0; i < rendered.pageImages.length; i++) {
    await writeFile(path.join(outDir, `page-${String(i + 1).padStart(2, "0")}.jpg`), rendered.pageImages[i]!);
  }
  console.log(JSON.stringify({
    outDir,
    pages: rendered.pageCount,
    pageSize: rendered.pageSize,
    pdfKB: Math.round(rendered.pdf.length / 1024),
    fonts: rendered.fonts,
    renderMs: rendered.renderMs,
    totalMs: Date.now() - started,
    warnings: rendered.warnings.map(w => `${w.code}${w.tripId ? ` ${w.tripId}` : ""}: ${w.message}`),
  }, null, 2));
}

// Chromium can take a long time to exit on a busy Windows box; the files are already written.
main().then(() => process.exit(0), error => {
  console.error(error);
  process.exit(1);
});
