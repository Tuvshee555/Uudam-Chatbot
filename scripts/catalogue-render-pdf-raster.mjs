/**
 * Visual QA only. Rasterises pages of a catalogue PDF (not the HTML) by running pdf.js inside a local
 * headless Chrome, so what you look at is what a PDF viewer draws from the embedded fonts and images.
 * Local file access is enabled for this QA page only; the catalogue renderer itself never does that.
 *
 *   node scripts/catalogue-render-pdf-raster.mjs <file.pdf> <outDir> [pages, e.g. 1,4,11]
 */
import { chromium } from "playwright-core";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
const [pdfPath, outDir, pagesArg] = process.argv.slice(2);
const pages = (pagesArg || "1,3").split(",").map(Number);
mkdirSync(outDir, { recursive: true });
const fwd = p => p.split(path.sep).join("/");
const root = fwd(path.resolve("node_modules/pdfjs-dist/build"));
const b64 = readFileSync(pdfPath).toString("base64");
const html = `<!doctype html><body style="margin:0"><canvas id="c"></canvas><script type="module">
import * as pdfjs from "file:///${root}/pdf.mjs";
pdfjs.GlobalWorkerOptions.workerSrc = "file:///${root}/pdf.worker.mjs";
const data = Uint8Array.from(atob("${b64}"), c => c.charCodeAt(0));
const doc = await pdfjs.getDocument({ data, useSystemFonts: false }).promise;
window.renderPage = async (n) => {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale: 1.5 });
  const c = document.getElementById("c"); c.width = vp.width; c.height = vp.height;
  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
  return c.toDataURL("image/png");
};
window.ready = true;
</script></body>`;
const htmlPath = path.join(outDir, "viewer.html");
writeFileSync(htmlPath, html);
const browser = await chromium.launch({ executablePath: process.env.CHROME_EXECUTABLE_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--allow-file-access-from-files", "--disable-web-security"] });
const page = await browser.newPage();
page.on("console", m => console.log("console:", m.text()));
page.on("pageerror", e => console.log("pageerror:", e.message));
await page.goto("file:///" + fwd(htmlPath));
await page.waitForFunction("window.ready === true", null, { timeout: 60000 });
for (const n of pages) {
  const url = await page.evaluate(n => window.renderPage(n), n);
  writeFileSync(path.join(outDir, `pdf-p${n}.png`), Buffer.from(url.split(",")[1], "base64"));
  console.log("wrote page", n);
}
process.exit(0);
