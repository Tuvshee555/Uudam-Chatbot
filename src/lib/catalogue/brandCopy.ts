/**
 * A secondary brand's corporate catalogue (brand.ts). Server-only.
 *
 * The primary builds and publishes the catalogue (versions.ts, autoRefresh.ts). A secondary brand sends the
 * SAME published version — same trips, order and codes — printed in its own name, logo, phone, website and
 * adult fares (brandFares.ts rule: −BRAND_DISCOUNT_MNT on every adult/child fare). Its copy of a published
 * version is rendered once, by its own refresh endpoint (cron/catalogue-refresh.ts), and kept in
 * brand_catalogue_files. Until the copy exists a customer's request is held and answered with the website
 * link, exactly like a stale file (send.ts, held.ts); the copy's refresh then sends it.
 */
import { createHash } from "node:crypto";
import { brandText, getBrand } from "../brand";
import { discountedFare, makeFareTextReplacer, MIN_DISCOUNTABLE_FARE, type FareMap } from "../brandFares";
import { queryNeon } from "../neonDb";
import { logInfo, logWarn } from "../observability";
import type { CatalogueEdition, CatalogueSnapshot } from "./types";

type Rec = Record<string, unknown>;
const FARE_NUMBER_KEY = /Mnt$/;
const INFANT_KEY = /infant|нярай/i;

function isRecord(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function collectFares(value: unknown, key: string, out: Set<number>): void {
  if (typeof value === "number") {
    if (FARE_NUMBER_KEY.test(key) && !INFANT_KEY.test(key) && value >= MIN_DISCOUNTABLE_FARE) out.add(Math.trunc(value));
    return;
  }
  if (Array.isArray(value)) value.forEach((item) => collectFares(item, key, out));
  else if (isRecord(value)) for (const [childKey, child] of Object.entries(value)) collectFares(child, childKey, out);
}

function applyFares(value: unknown, key: string, fares: FareMap, text: (s: string) => string): unknown {
  if (typeof value === "string") return text(value);
  if (typeof value === "number") return FARE_NUMBER_KEY.test(key) && !INFANT_KEY.test(key) ? fares.get(value) ?? value : value;
  if (Array.isArray(value)) return value.map((item) => applyFares(item, key, fares, text));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, applyFares(child, childKey, fares, text)]));
  return value;
}

/**
 * The published snapshot as this brand prints it: adult fares (the "from" price, every dated fare and the
 * same amounts written in texts) lower by the brand's discount, its own phone and website on the contact
 * page, its name instead of the primary's. Identity for the primary. Pure.
 */
export function brandCatalogueSnapshot(snapshot: CatalogueSnapshot): CatalogueSnapshot {
  const brand = getBrand();
  if (brand.isPrimary) return snapshot;
  const amounts = new Set<number>();
  collectFares(snapshot.trips, "", amounts);
  const fares: FareMap = new Map();
  if (brand.fareDiscountMnt > 0) for (const amount of amounts) fares.set(amount, discountedFare(amount, brand.fareDiscountMnt));
  const fareText = makeFareTextReplacer(fares);
  const text = (value: string) => brandText(fareText(value));
  const branded = applyFares(snapshot, "", fares, text) as CatalogueSnapshot;
  const contact = branded.contact ?? { phones: [], siteLabel: "", siteUrl: "" };
  return {
    ...branded,
    contact: {
      ...contact,
      phones: brand.contactPhones ? [brand.contactPhones] : contact.phones,
      siteLabel: brand.websiteHost,
      siteUrl: brand.websiteUrl,
    },
  };
}

let tableReady: Promise<boolean> | null = null;
function ensureTable(): Promise<boolean> {
  tableReady ??= queryNeon(`CREATE TABLE IF NOT EXISTS brand_catalogue_files (
      brand TEXT NOT NULL, version_id UUID NOT NULL, file_name TEXT NOT NULL, bytes BYTEA NOT NULL,
      size_bytes INT NOT NULL, page_count INT NOT NULL, sha256 TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (brand, version_id))`)
    .then((result) => Boolean(result)).catch(() => { tableReady = null; return false; });
  return tableReady;
}

export type BrandCatalogueFile = { bytes: Buffer; fileName: string; sizeBytes: number; pageCount: number; sha256: string };

/** This brand's copy of a published version, or null while it is not rendered yet. */
export async function getBrandCatalogueFile(versionId: string): Promise<BrandCatalogueFile | null> {
  if (!(await ensureTable())) return null;
  const result = await queryNeon<{ bytes: Buffer; file_name: string; size_bytes: number; page_count: number; sha256: string }>(
    `SELECT bytes, file_name, size_bytes, page_count, sha256 FROM brand_catalogue_files WHERE brand = $1 AND version_id = $2`,
    [getBrand().key, versionId],
  ).catch(() => null);
  const row = result?.rows?.[0];
  return row ? { bytes: row.bytes, fileName: row.file_name, sizeBytes: row.size_bytes, pageCount: row.page_count, sha256: row.sha256 } : null;
}

export async function hasBrandCatalogueFile(versionId: string): Promise<boolean> {
  if (!(await ensureTable())) return false;
  const result = await queryNeon<{ one: number }>(
    `SELECT 1 AS one FROM brand_catalogue_files WHERE brand = $1 AND version_id = $2`, [getBrand().key, versionId],
  ).catch(() => null);
  return Boolean(result?.rows?.length);
}

/** One render at a time per brand: a 4-minute slot in travel_sweep_lock (id 100 + the brand's sweep slot). */
async function claimRenderSlot(): Promise<boolean> {
  const result = await queryNeon<{ id: number }>(
    `INSERT INTO travel_sweep_lock (id, last_run_at) VALUES ($1, NOW())
       ON CONFLICT (id) DO UPDATE SET last_run_at = NOW()
       WHERE travel_sweep_lock.last_run_at < NOW() - INTERVAL '4 minutes'
     RETURNING id`,
    [100 + getBrand().sweepLockId],
  ).catch(() => null);
  return Boolean(result?.rows?.length);
}

export type BrandCopyResult = { edition: CatalogueEdition; status: "ready" | "rendered" | "none_published" | "busy" | "failed"; versionNo?: number; heldSent?: number };

/**
 * Makes sure this brand has its copy of every published customer edition, then sends the held requests of
 * its own page. Called by its refresh endpoint (the primary pings it after publishing; a request that meets
 * no copy pings it too). No-op for the primary.
 */
export async function refreshBrandCatalogueCopies(): Promise<BrandCopyResult[]> {
  const brand = getBrand();
  if (brand.isPrimary || !(await ensureTable())) return [];
  const [{ getPublished, getVersionSnapshot }, { renderCatalogue }, { deliverHeldCatalogues }, { sendHeldCatalogue }] = await Promise.all([
    import("./versions"), import("./render"), import("./held"), import("./send"),
  ]);
  const results: BrandCopyResult[] = [];
  let slot: boolean | null = null;
  for (const edition of ["quick", "complete"] as const) {
    const published = await getPublished(edition).catch(() => null);
    if (!published) { results.push({ edition, status: "none_published" }); continue; }
    let status: BrandCopyResult["status"] = "ready";
    if (!(await hasBrandCatalogueFile(published.id))) {
      slot ??= await claimRenderSlot();
      if (!slot) status = "busy";
      else {
        try {
          const snapshot = await getVersionSnapshot(published.id);
          if (!snapshot) throw new Error("snapshot_missing");
          const rendered = await renderCatalogue(brandCatalogueSnapshot(snapshot), { pageImages: false, versionLabel: `v${published.versionNo}` });
          const sha256 = createHash("sha256").update(rendered.pdf).digest("hex");
          await queryNeon(
            `INSERT INTO brand_catalogue_files (brand, version_id, file_name, bytes, size_bytes, page_count, sha256)
               VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (brand, version_id) DO UPDATE SET file_name = EXCLUDED.file_name, bytes = EXCLUDED.bytes,
               size_bytes = EXCLUDED.size_bytes, page_count = EXCLUDED.page_count, sha256 = EXCLUDED.sha256, created_at = NOW()`,
            [brand.key, published.id, brandText(published.fileName), rendered.pdf, rendered.pdf.length, rendered.pageCount, sha256],
          );
          status = "rendered";
          logInfo("catalogue.brand_copy_rendered", { brand: brand.key, edition, versionNo: published.versionNo, sizeBytes: rendered.pdf.length, renderMs: rendered.renderMs });
        } catch (error) {
          status = "failed";
          logWarn("catalogue.brand_copy_failed", { brand: brand.key, edition, message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
        }
      }
    }
    const result: BrandCopyResult = { edition, status, versionNo: published.versionNo };
    // Customers of this brand who asked before the copy existed get it now (held.ts: own page only).
    if (status === "ready" || status === "rendered") {
      const counts = await deliverHeldCatalogues(edition, sendHeldCatalogue).catch(() => null);
      if (counts?.sent) result.heldSent = counts.sent;
    }
    results.push(result);
  }
  // Copies of versions the primary has pruned are not needed any more.
  await queryNeon(`DELETE FROM brand_catalogue_files WHERE brand = $1 AND version_id NOT IN (SELECT id FROM catalogue_versions)`, [brand.key]).catch(() => null);
  return results;
}

/**
 * The primary just published: ask each sister brand's bot to render its copy now
 * (CATALOGUE_SISTER_REFRESH_URLS, comma-separated refresh endpoints; they share CRON_SECRET).
 */
export async function pingSisterCatalogueRefresh(): Promise<void> {
  const secret = process.env.CRON_SECRET || "";
  const urls = (process.env.CATALOGUE_SISTER_REFRESH_URLS || "").split(",").map((url) => url.trim()).filter((url) => /^https:\/\//.test(url));
  if (!secret || !urls.length || !getBrand().isPrimary) return;
  await Promise.all(urls.map(async (url) => {
    try {
      await fetch(`${url}${url.includes("?") ? "&" : "?"}async=1`, { method: "POST", headers: { Authorization: `Bearer ${secret}` }, signal: AbortSignal.timeout(5_000) });
    } catch (error) {
      logWarn("catalogue.sister_refresh_failed", { message: error instanceof Error ? error.message.slice(0, 200) : String(error) });
    }
  }));
}
