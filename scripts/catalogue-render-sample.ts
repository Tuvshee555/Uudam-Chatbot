/**
 * Visual QA for the catalogue renderer. Builds a snapshot from INVENTED trips with synthetic photos
 * (no network, no database, no model), renders it and writes the PDF plus one JPEG per page.
 *
 *   node --import tsx scripts/catalogue-render-sample.ts <outDir> [tripCount]
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { renderCatalogue } from "../src/lib/catalogue/render";
import { sampleImageFetcher, sampleSnapshot } from "../src/lib/catalogue/render/fixture";

const outDir = path.resolve(process.argv[2] || "catalogue-sample-out");
const tripCount = Number(process.argv[3] || 6);

async function main() {
  await mkdir(outDir, { recursive: true });
  const snapshot = sampleSnapshot({ trips: tripCount, edition: tripCount > 12 ? "complete" : "quick" });
  const started = Date.now();
  const rendered = await renderCatalogue(snapshot, { pageImages: true, imageFetcher: sampleImageFetcher(), versionLabel: "v-sample" });
  await writeFile(path.join(outDir, "sample.pdf"), rendered.pdf);
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
