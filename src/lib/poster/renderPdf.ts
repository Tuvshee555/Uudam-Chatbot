import { createElement } from "react";
import { launchWithRetry, sharedExecutablePath } from "../chromiumLaunch";
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
import { isAllowedPosterPdfImageUrl } from "./pdfImagePolicy";
import { posterPdfHeight } from "./pdfLayout";
import { brandText, getBrand } from "../brand";
import { applyBrandFaresToPoster, posterFareMap, tripFareMap, type FareMap } from "../brandFares";

/**
 * The fares of the trip this poster is attached to, read RAW (a secondary deployment's trip reads are
 * already in its fares, and the map must go from the catalogue's figure to the brand's).
 */
async function linkedTripFares(posterId: string, discount: number): Promise<FareMap | null> {
  const result = await queryNeon<{ adult_price: number | null; child_price: number | null; extra: Record<string, unknown> | null }>(
    `SELECT adult_price, child_price, extra FROM travel_trip_entries WHERE extra->>'poster_trip_id' = $1 ORDER BY updated_at DESC LIMIT 1`,
    [posterId],
  );
  const row = result?.rows?.[0];
  if (!row) return null;
  return tripFareMap({ adult_price: row.adult_price ?? null, child_price: row.child_price ?? null, extra: row.extra ?? {} }, discount);
}

/** The poster as this deployment's brand prints it: its fares and name (brandFares.ts); the primary's unchanged. */
async function brandPosterData(poster: PosterPdfRow): Promise<PosterTrip> {
  const brand = getBrand();
  const data = poster.data as PosterTrip;
  if (brand.isPrimary) return data;
  const fares = posterFareMap(data, await linkedTripFares(poster.id, brand.fareDiscountMnt), brand.fareDiscountMnt);
  return applyBrandFaresToPoster(data, fares, brandText) as PosterTrip;
}

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
  const brand = getBrand();
  const trip = optimizePosterImagesForPdf(await brandPosterData(poster));
  // The brand is part of the key: one brand's PDF is never served for the other (a secondary
  // deployment cannot write this cache at all — brandWriteGuard.ts — so it renders every time).
  const hash = createHash("sha256").update(`poster-render-v3:${brand.isPrimary ? "" : `${brand.key}:${brand.fareDiscountMnt}:`}${JSON.stringify(trip)}`).digest("hex");
  const cached = await queryNeon<{ pdf: Buffer }>("SELECT pdf FROM poster_pdf_cache WHERE poster_id=$1 AND hash=$2", [poster.id, hash]);
  if (cached?.rows[0]) return cached.rows[0].pdf;
  const root = process.cwd();
  const [css, logo, regular, bold] = await Promise.all([
    readFile(path.join(root,"src/styles/poster.css"),"utf8"),
    readFile(path.join(root, brand.posterLogoPath)),
    readFile(path.join(root,"public/fonts/NotoSans-Regular.ttf")),
    readFile(path.join(root,"public/fonts/NotoSans-Bold.ttf")),
  ]);
  const markup = renderToStaticMarkup(createElement(Poster, {
    trip, upd: noop, addItem: noop, removeItem: noop, insertDay: noop, reorderDay: noop,
    addPriceRow: noop, addPriceCol: noop, removePriceCol: noop, onDayPhotoFile: noop,
    dayPhotoInputRefs: { current: {} }, page1Ref: { current: null },
    logoSrc: `data:${brand.posterLogoMime};base64,${logo.toString("base64")}`,
    wordmark: { name: brand.wordmark, sub: brand.wordmarkSub },
    posterStyle: { headlineScale: 1, infoScale: 1, dayTitleScale: 1, dayTextScale: 1,
      photoScale: 0.75, ...trip.style },
  }));
  const localExecutable = process.env.CHROME_EXECUTABLE_PATH || [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  ].find(existsSync);
  const browser = await launchWithRetry(async () => playwright.launch({
    executablePath: localExecutable || await sharedExecutablePath(() => chromium.executablePath()),
    args: localExecutable ? [] : chromium.args, headless: true,
  }));
  try {
    const page = await browser.newPage({ viewport: { width: 1080, height: 1528 } });
    // This renderer may load images, never arbitrary document scripts or local URLs.
    await page.route("**/*", route => {
      const url = new URL(route.request().url());
      const allowed = isAllowedPosterPdfImageUrl(url.toString());
      return allowed ? route.continue() : route.abort();
    });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      @font-face{font-family:PosterNoto;src:url(data:font/ttf;base64,${regular.toString("base64")})}
      @font-face{font-family:PosterNoto;src:url(data:font/ttf;base64,${bold.toString("base64")});font-weight:700}
      ${css}
      ${brand.posterCss}
      html,body{margin:0;background:white} .poster-root{font-family:PosterNoto,sans-serif}
      .poster-root .page{margin:0;box-shadow:none;break-after:auto}
      .dayrow,.photo-tile,.head,.hero,.sec,.foot{break-inside:avoid}
      .photo-tile.empty,.hidden-input,.editor-only{display:none!important}
      *{-webkit-print-color-adjust:exact;print-color-adjust:exact}
    </style></head><body class="exporting"><main class="poster-root">${markup}</main></body></html>`, { waitUntil: "domcontentloaded", timeout: 15000 });
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(async () => {
      const imgLoads = Array.from(document.images).map(img => img.complete ? true : new Promise(resolve => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      }));

      // The day-photo tiles are painted via CSS background-image, not <img>,
      // so document.images never sees them and this wait used to resolve
      // instantly — page.pdf() then fired before the browser had even
      // requested those photos, leaving them blank in the exported PDF.
      //
      // Deduped deliberately: the same photo appears in more than one rule,
      // and probing each occurrence separately decodes the image again per
      // probe. On an 8-photo poster that was enough extra bitmap memory to
      // crash Chromium outright inside Vercel's sandbox.
      const bgUrlPattern = /url\(["']?(.*?)["']?\)/;
      const bgUrls = new Set<string>();
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        const match = getComputedStyle(el).backgroundImage.match(bgUrlPattern);
        const url = match?.[1];
        if (url && !url.startsWith("data:")) bgUrls.add(url);
      }
      const bgLoads = Array.from(bgUrls).map(url => new Promise(resolve => {
        const probe = new Image();
        probe.addEventListener("load", resolve, { once: true });
        probe.addEventListener("error", resolve, { once: true });
        probe.src = url;
      }));

      await Promise.race([
        Promise.all([...imgLoads, ...bgLoads]),
        new Promise(resolve => setTimeout(resolve, 8000)),
      ]);
    });
    const height = posterPdfHeight(await page.evaluate(() => {
      const poster = document.querySelector<HTMLElement>(".poster-root .page");
      return poster?.scrollHeight || document.documentElement.scrollHeight;
    }));
    let pdf: Buffer;
    try {
      pdf = await page.pdf({ width: "1080px", height: `${height}px`, printBackground: true });
    } catch {
      await page.waitForTimeout(500);
      pdf = await page.pdf({ width: "1080px", height: `${height}px`, printBackground: true });
    }
    // Free the renderer (and every decoded photo in it) before the database
    // round-trip: Vercel reuses a warm container between requests, so holding
    // the page open across the write leaves that memory in place for the next
    // poster to trip over.
    await page.close();
    await queryNeon(`INSERT INTO poster_pdf_cache(poster_id,hash,pdf) VALUES ($1,$2,$3)
      ON CONFLICT(poster_id) DO UPDATE SET hash=EXCLUDED.hash,pdf=EXCLUDED.pdf,updated_at=NOW()`, [poster.id,hash,pdf]);
    return pdf;
  } finally { await browser.close(); }
}
