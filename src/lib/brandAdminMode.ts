/**
 * Admin mode for a secondary brand's deployment (brand.ts). Server-only (node:async_hooks): never
 * import it from a module a browser component loads.
 *
 * The secondary brand shares the primary's catalogue and settings. Its customers see them in the
 * brand's words and fares; its ADMIN must see and save them exactly as the primary's admin does, so a
 * save from either admin changes the same data the same way and never stores the brand's discounted
 * fares or its own links. A signed-in admin request (adminAccess.hasAdminAccess) enters admin mode for
 * the rest of that request and the work it schedules: raw trips and settings (travelDb), its own
 * unguarded database connections (neonDb, websiteTripSync), the website sync, and the primary's bot in
 * every program-PDF link it stores. Customers' requests (the webhook, the demo, crons) never enter it.
 * No effect on the primary brand.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getBrand } from "./brand";

const adminMode = new AsyncLocalStorage<true>();

/** Marks the rest of this request (and the work it schedules) as the brand's admin. Primary: no-op. */
export function enterBrandAdminMode(): void {
  if (!getBrand().isPrimary) adminMode.enterWith(true);
}

/** True inside a secondary brand's admin request. */
export function inBrandAdminMode(): boolean {
  return adminMode.getStore() === true;
}

/** Runs fn as the brand's admin (tests, scripts). */
export function runInBrandAdminMode<T>(fn: () => T): T {
  return adminMode.run(true, fn);
}

/**
 * A program-PDF link about to be STORED in the shared catalogue or website: always the primary's bot,
 * whose customers and website read it. A secondary brand points shown links back at its own bot
 * (brand.ts brandText). Identity for the primary and for every other URL.
 */
export function storedPosterPdfUrl(url: string): string {
  const brand = getBrand();
  if (brand.isPrimary || !url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname !== "/api/poster-pdf") return url;
    const primary = new URL(brand.primaryBotUrl);
    parsed.protocol = primary.protocol;
    parsed.host = primary.host;
    return parsed.toString();
  } catch {
    return url;
  }
}
