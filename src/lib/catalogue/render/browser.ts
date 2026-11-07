/**
 * Headless Chromium driver. Same launch pattern as src/lib/poster/renderPdf.ts: a local Chrome or
 * Edge on a developer machine (CHROME_EXECUTABLE_PATH or the usual install paths), @sparticuz/chromium
 * on Vercel. The page can load data: URLs only, runs no document script of its own, and every
 * measurement happens through page.evaluate.
 */
import { existsSync } from "node:fs";
import { chromium as playwright, type Browser, type Page } from "playwright-core";
import chromium from "@sparticuz/chromium";
import type { CatalogueWarning } from "../types";
import { CatalogueRenderError } from "./renderTypes";

const LOCAL_BROWSER_CANDIDATES = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function localBrowserPath(): string | undefined {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  return LOCAL_BROWSER_CANDIDATES.find(existsSync);
}

async function launch(): Promise<Browser> {
  const local = localBrowserPath();
  try {
    return await playwright.launch({
      executablePath: local || (await chromium.executablePath()),
      args: local ? [] : chromium.args,
      headless: true,
    });
  } catch (error) {
    throw new CatalogueRenderError("browser_unavailable", `Chromium-ийг ажиллуулж чадсангүй: ${(error as Error).message}`, { cause: error });
  }
}

const CLOSE_GRACE_MS = 8_000;

/**
 * Close without letting a slow process exit hold the request hostage. On a busy Windows dev box
 * Chrome can take 30s+ to exit after all work is done; the result is already in hand by then.
 */
async function closeQuietly(browser: Browser | null): Promise<void> {
  if (!browser) return;
  const closing = browser.close().catch(() => {});
  await Promise.race([closing, new Promise<void>(resolve => setTimeout(resolve, CLOSE_GRACE_MS).unref?.())]);
}

let probe: { at: number; result: Promise<boolean> } | null = null;
const FAILED_PROBE_TTL_MS = 60_000;

/**
 * True when a headless browser can really be launched here. A success is remembered for the life of
 * the process; a failure is re-checked after a minute (a cold container or a transient start failure
 * must not disable the feature until the next deploy).
 */
export async function isRenderBrowserAvailable(): Promise<boolean> {
  if (probe) {
    const known = await probe.result;
    if (known || Date.now() - probe.at < FAILED_PROBE_TTL_MS) return known;
  }
  const result = serialised(async () => {
    let browser: Browser | null = null;
    try {
      browser = await launch();
      return true;
    } catch {
      return false;
    } finally {
      await closeQuietly(browser);
    }
  });
  probe = { at: Date.now(), result };
  return result;
}

// One Chromium at a time per process: a second concurrent generate would double the memory peak.
let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => {});
  return run;
}

export type PageAudit = {
  /** Pages (1-based) whose content did not fit. */
  overflowPages: { page: number; what: string }[];
  /** Image elements that failed to decode. */
  brokenImages: number;
  /** Elements the fit pass had to shrink (ids/codes) - informational. */
  shrunk: string[];
};

/** Runs inside the page: shrink headlines/lists that do not fit, then look for anything that spills. */
const FIT_AND_AUDIT = `(() => {
  const shrunk = [];
  for (const el of document.querySelectorAll('[data-fit-maxh]')) {
    const min = parseFloat(el.getAttribute('data-fit-min') || '0');
    const maxh = parseFloat(el.getAttribute('data-fit-maxh') || '0');
    let fs = parseFloat(getComputedStyle(el).fontSize);
    const start = fs;
    while (el.getBoundingClientRect().height > maxh + 0.5 && fs - 0.5 >= min) {
      fs -= 0.5;
      el.style.fontSize = fs + 'px';
    }
    if (fs < start) shrunk.push((el.closest('.page')?.getAttribute('data-page') || '?') + ':' + el.tagName.toLowerCase() + ':' + Math.round(start) + '>' + Math.round(fs));
  }
  // Optional blocks (e.g. the closing page's quick-pick list) give way before anything is cut.
  for (const page of document.querySelectorAll('.page')) {
    for (const opt of page.querySelectorAll('[data-optional]')) {
      if (page.scrollHeight <= page.clientHeight + 1) break;
      opt.style.display = 'none';
      shrunk.push((page.getAttribute('data-page') || '?') + ':optional-hidden');
    }
  }
  const overflowPages = [];
  const pages = Array.from(document.querySelectorAll('.page'));
  pages.forEach((page, i) => {
    const r = page.getBoundingClientRect();
    const tol = 1.5;
    let what = '';
    if (page.scrollHeight > page.clientHeight + tol) what = 'height ' + page.scrollHeight + '>' + page.clientHeight;
    if (!what && page.scrollWidth > page.clientWidth + tol) what = 'width';
    if (!what) {
      const walker = document.createTreeWalker(page, NodeFilter.SHOW_TEXT);
      const boxes = [];
      let node;
      while ((node = walker.nextNode())) {
        if (!node.textContent || !node.textContent.trim()) continue;
        const el = node.parentElement;
        if (!el || el.closest('.ph')) continue;
        const inFoot = !!el.closest('.foot,.caption');
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const b of range.getClientRects()) {
          if (b.width === 0 || b.height === 0) continue;
          // body text keeps clear of the footer line (52px = 39pt from the bottom edge)
          if (b.left < r.left + 20 || b.right > r.right - 20 || b.bottom > r.bottom - 8 || b.top < r.top || (!inFoot && b.bottom > r.bottom - 52)) {
            what = 'text outside margins: ' + node.textContent.trim().slice(0, 40);
            break;
          }
          boxes.push({ b, el, t: node.textContent.trim().slice(0, 28) });
        }
        if (what) break;
      }
      for (let x = 0; !what && x < boxes.length; x++) {
        for (let y = x + 1; y < boxes.length; y++) {
          const p = boxes[x], q = boxes[y];
          if (p.el === q.el) continue;
          const ix = Math.min(p.b.right, q.b.right) - Math.max(p.b.left, q.b.left);
          const iy = Math.min(p.b.bottom, q.b.bottom) - Math.max(p.b.top, q.b.top);
          if (ix > 3 && iy > 4) { what = 'text overlaps: ' + p.t + ' / ' + q.t; break; }
        }
      }
    }
    if (what) overflowPages.push({ page: i + 1, what });
  });
  const brokenImages = Array.from(document.images).filter(img => !img.complete || img.naturalWidth === 0).length;
  return { overflowPages, brokenImages, shrunk };
})()`;

export type BrowserRenderResult = {
  pdf: Buffer;
  pageImages: Buffer[];
  audit: PageAudit;
};

async function preparePage(page: Page, html: string): Promise<void> {
  // Only data: URLs may load. A request for anything else is dropped before it leaves the machine.
  await page.route("**/*", route => (route.request().url().startsWith("data:") ? route.continue() : route.abort()));
  await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all(Array.from(document.images).map(img => img.decode().catch(() => undefined)));
  });
}

export function renderHtml(html: string, opts: { pageImages: boolean }): Promise<BrowserRenderResult> {
  return serialised(async () => {
    const browser = await launch();
    try {
      const context = await browser.newContext({ viewport: { width: 720, height: 1280 }, deviceScaleFactor: 1.125 });
      const page = await context.newPage();
      await preparePage(page, html);
      const audit = (await page.evaluate(FIT_AND_AUDIT)) as PageAudit;

      await page.emulateMedia({ media: "print" });
      let pdf: Buffer;
      try {
        pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      } catch {
        await page.waitForTimeout(500);
        pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, tagged: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
      }

      const pageImages: Buffer[] = [];
      if (opts.pageImages) {
        await page.emulateMedia({ media: "screen" });
        const count = await page.locator(".page").count();
        for (let i = 0; i < count; i++) {
          pageImages.push(await page.locator(".page").nth(i).screenshot({ type: "jpeg", quality: 80, animations: "disabled" }));
        }
      }
      await page.close();
      return { pdf, pageImages, audit };
    } finally {
      await closeQuietly(browser);
    }
  });
}

export function auditWarnings(audit: PageAudit): CatalogueWarning[] {
  const out: CatalogueWarning[] = [];
  for (const o of audit.overflowPages) {
    out.push({
      code: "other",
      severity: "warning",
      message: `${o.page}-р хуудасны агуулга багтсангүй (${o.what}). Гарчиг эсвэл онцлогийг богиносгоно уу.`,
      detail: { page: o.page, what: o.what },
    });
  }
  if (audit.brokenImages > 0) {
    out.push({
      code: "photo_fetch_failed",
      severity: "warning",
      message: `${audit.brokenImages} зураг хуудсанд зөв ачаалагдсангүй.`,
      detail: { brokenImages: audit.brokenImages },
    });
  }
  return out;
}
