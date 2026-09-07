import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { chromium as playwright } from "playwright-core";
import chromium from "@sparticuz/chromium";
import Poster from "@/components/admin/poster/Poster";
import type { PosterTrip } from "@/components/admin/poster/PosterTab";
import { queryNeon } from "../neonDb";
import { ensureConnectedTripSchema } from "../connectedTripStore";
import type { PosterPdfRow } from "./pdf";

const noop = () => {};

function renderFriendlyImageUrl(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    const url = new URL(value);
    if (url.hostname === "res.cloudinary.com" && url.pathname.includes("/image/upload/")) {
      url.pathname = url.pathname.replace("/image/upload/", "/image/upload/f_auto,q_auto:eco,w_1400,c_limit/");
      return url.toString();
    }
  } catch {
    return value;
  }
  return value;
}

function optimizePosterImagesForPdf(trip: PosterTrip): PosterTrip {
  return {
    ...trip,
    hero_image: renderFriendlyImageUrl(trip.hero_image) as string | null | undefined,
    days: (trip.days || []).map(day => ({
      ...day,
      photo: renderFriendlyImageUrl(day.photo) as string | null | undefined,
    })),
  };
}

export async function renderPosterPdf(poster: PosterPdfRow) {
  await ensureConnectedTripSchema();
  const trip = optimizePosterImagesForPdf(poster.data as PosterTrip);
  const hash = createHash("sha256").update(`poster-render-v1:${JSON.stringify(trip)}`).digest("hex");
  const cached = await queryNeon<{ pdf: Buffer }>("SELECT pdf FROM poster_pdf_cache WHERE poster_id=$1 AND hash=$2", [poster.id, hash]);
  if (cached?.rows[0]) return cached.rows[0].pdf;
  const root = process.cwd();
  const [css, logo, regular, bold] = await Promise.all([
    readFile(path.join(root,"src/styles/poster.css"),"utf8"),
    readFile(path.join(root,"public/poster/uudam-logo.jpg")),
    readFile(path.join(root,"public/fonts/NotoSans-Regular.ttf")),
    readFile(path.join(root,"public/fonts/NotoSans-Bold.ttf")),
  ]);
  const markup = renderToStaticMarkup(createElement(Poster, {
    trip, upd: noop, addItem: noop, removeItem: noop, insertDay: noop, reorderDay: noop,
    addPriceRow: noop, addPriceCol: noop, removePriceCol: noop, onDayPhotoFile: noop,
    dayPhotoInputRefs: { current: {} }, page1Ref: { current: null },
    logoSrc: `data:image/jpeg;base64,${logo.toString("base64")}`,
    posterStyle: { headlineScale: 1, infoScale: 1, dayTitleScale: 1, dayTextScale: 1,
      photoScale: 0.75, ...trip.style },
  }));
  const localExecutable = process.env.CHROME_EXECUTABLE_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  const browser = await playwright.launch({
    executablePath: localExecutable || await chromium.executablePath(),
    args: localExecutable ? [] : chromium.args, headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1528 } });
    // This renderer may load images, never arbitrary document scripts or local URLs.
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      const allowed = url.protocol === "https:" && ["res.cloudinary.com", "images.unsplash.com"].includes(url.hostname);
      return allowed ? route.continue() : route.abort();
    });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face{font-family:PosterNoto;src:url(data:font/ttf;base64,${regular.toString("base64")})}
      @font-face{font-family:PosterNoto;src:url(data:font/ttf;base64,${bold.toString("base64")});font-weight:700}
      ${css}
      html,body{margin:0;background:white} .poster-root{font-family:PosterNoto,sans-serif}
      @page{size:1080px 1528px;margin:0}
      .poster-root .page{margin:0;box-shadow:none;break-after:auto}
      .dayrow,.photo-tile,.head,.hero,.sec,.foot{break-inside:avoid}
      .photo-tile.empty,.hidden-input,.editor-only{display:none!important}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    </style></head><body class="exporting"><main class="poster-root">${markup}</main></body></html>`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      const images = Array.from(document.images);
      await Promise.race([
        Promise.all(images.map(img => img.complete ? true : new Promise(resolve => {
          img.addEventListener("load", resolve, { once: true });
          img.addEventListener("error", resolve, { once: true });
        }))),
        new Promise(resolve => setTimeout(resolve, 8000)),
      ]);
    });
    let pdf: Buffer;
    try {
      pdf = await page.pdf({ width: "1080px", height: "1528px", printBackground: true, preferCSSPageSize: true });
    } catch {
      await page.waitForTimeout(500);
      pdf = await page.pdf({ width: "1080px", height: "1528px", printBackground: true, preferCSSPageSize: true });
    }
    await queryNeon(`INSERT INTO poster_pdf_cache(poster_id,hash,pdf) VALUES ($1,$2,$3)
      ON CONFLICT(poster_id) DO UPDATE SET hash=EXCLUDED.hash,pdf=EXCLUDED.pdf,updated_at=NOW()`, [poster.id,hash,pdf]);
    return pdf;
  } finally { await browser.close(); }
}
