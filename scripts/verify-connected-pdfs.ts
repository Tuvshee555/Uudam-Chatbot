import { loadEnvConfig } from "@next/env";
import { mkdirSync, writeFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
loadEnvConfig(process.cwd());

async function main() {
  const { exportPosterTrips } = await import("../src/lib/poster/db");
  const { renderPosterPdf } = await import("../src/lib/poster/renderPdf");
  const { closeNeonPool } = await import("../src/lib/neonDb");
  const posters = await exportPosterTrips();
  try {
    mkdirSync("tmp/pdfs", { recursive: true });
    for (const poster of posters) {
      if (poster.id.includes("sync-test-")) continue;
      const pdf = await renderPosterPdf(poster);
      const doc = await PDFDocument.load(pdf);
      if (!doc.getPageCount()) throw new Error(`Empty PDF: ${poster.id}`);
      writeFileSync(`tmp/pdfs/${poster.id}.pdf`, pdf);
      console.log(JSON.stringify({ id: poster.id, title: poster.title, pages: doc.getPageCount(), bytes: pdf.length }));
      if (process.argv.includes("--sample")) break;
    }
  } finally { await closeNeonPool(); }
}
main().then(()=>process.exit(0)).catch(error=>{ console.error(error.message); process.exit(1); });
