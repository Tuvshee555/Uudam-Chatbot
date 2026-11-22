/**
 * Which brand this deployment speaks for.
 *
 * One codebase and ONE database serve two travel brands owned by the same company:
 * - "uudam" (default, the primary): Uudam Travel. It owns the catalogue, the bot settings and every
 *   row written before brands existed.
 * - "magnai": «Магнай Травел», a second Facebook page answered by its own Vercel deployment
 *   (BRAND=magnai). Same trips, same answers, same contacts; its name, its website and its
 *   adult/child fares (BRAND_DISCOUNT_MNT lower, brandFares.ts) differ.
 *
 * A secondary brand never writes the shared catalogue or settings (brandWriteGuard.ts) and only sweeps
 * and lists the customers it owns: travel_senders.brand / travel_leads.brand = `storageKey`.
 * The primary's storageKey is "" so every legacy row (and every row it writes) stays its own.
 */

export type BrandKey = "uudam" | "magnai";

export type Brand = {
  key: BrandKey;
  isPrimary: boolean;
  /** travel_senders.brand / travel_leads.brand of the rows this deployment owns ("" = primary). */
  storageKey: string;
  /** The name customers read, in Mongolian («Магнай Травел»). */
  nameMn: string;
  /** The Latin name («Magnai Travel»). */
  nameLatin: string;
  /** The operator line on posters and trip cards («MAGNAI TRAVEL»). */
  agencyUpper: string;
  /** Poster/catalogue wordmark: big word + small line under it. */
  wordmark: string;
  wordmarkSub: string;
  /** The customer website, no trailing slash. */
  websiteUrl: string;
  websiteHost: string;
  /** Subtracted from every adult and child fare this brand quotes; 0 for the primary. */
  fareDiscountMnt: number;
  /** Poster logo, relative to the project root. */
  posterLogoPath: string;
  posterLogoMime: string;
  /** Extra CSS after poster.css: this brand's colours (empty for the primary). */
  posterCss: string;
  /** travel_sweep_lock row (one sweep slot per brand, so one brand's sweep never blocks the other's). */
  sweepLockId: number;
  /** Optional contact overrides; null = the shared settings' contacts (same company, same staff). */
  contactPhones: string | null;
  officeAddress: string | null;
};

const UUDAM_SITE = "https://uudamtravel.mn";
const MAGNAI_SITE_DEFAULT = "https://magnai-travel.vercel.app";
const MAGNAI_DEFAULT_DISCOUNT = 50_000;

function siteUrl(raw: string | undefined, fallback: string): string {
  const value = (raw || "").trim();
  if (!value) return fallback;
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    return `${url.protocol}//${url.host}`;
  } catch {
    return fallback;
  }
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

function optionalText(raw: string | undefined): string | null {
  const value = (raw || "").trim();
  return value || null;
}

export function resolveBrand(env: NodeJS.ProcessEnv = process.env): Brand {
  const requested = String(env.BRAND || "").trim().toLowerCase();
  if (requested === "magnai") {
    const websiteUrl = siteUrl(env.BRAND_WEBSITE_URL, MAGNAI_SITE_DEFAULT);
    return {
      key: "magnai",
      isPrimary: false,
      storageKey: "magnai",
      nameMn: "Магнай Травел",
      nameLatin: "Magnai Travel",
      agencyUpper: "MAGNAI TRAVEL",
      wordmark: "MAGNAI",
      wordmarkSub: "TRAVEL",
      websiteUrl,
      websiteHost: new URL(websiteUrl).host,
      fareDiscountMnt: nonNegativeInt(env.BRAND_DISCOUNT_MNT, MAGNAI_DEFAULT_DISCOUNT),
      posterLogoPath: "public/poster/magnai-logo.jpg",
      posterLogoMime: "image/jpeg",
      // Its logo's midnight navy and champagne gold.
      posterCss: ":root{--navy:#0f2140;--navy-soft:#1b3560;--navy-deep:#0a1830;--gold:#d4a64a}",
      sweepLockId: 2,
      contactPhones: optionalText(env.BRAND_CONTACT_PHONES),
      officeAddress: optionalText(env.BRAND_OFFICE_ADDRESS),
    };
  }
  return {
    key: "uudam",
    isPrimary: true,
    storageKey: "",
    nameMn: "Уудам Трэвэл",
    nameLatin: "Uudam Travel",
    agencyUpper: "UUDAM TRAVEL AGENCY",
    wordmark: "UUDAM",
    wordmarkSub: "TRAVEL AGENCY",
    websiteUrl: UUDAM_SITE,
    websiteHost: new URL(UUDAM_SITE).host,
    fareDiscountMnt: 0,
    posterLogoPath: "public/poster/uudam-logo.jpg",
    posterLogoMime: "image/jpeg",
    posterCss: "",
    sweepLockId: 1,
    contactPhones: null,
    officeAddress: null,
  };
}

let cache: { signature: string; brand: Brand } | null = null;

/** The brand of this process (env BRAND). Recomputed only when the brand env values change. */
export function getBrand(): Brand {
  const env = process.env;
  const signature = [env.BRAND, env.BRAND_WEBSITE_URL, env.BRAND_DISCOUNT_MNT, env.BRAND_CONTACT_PHONES, env.BRAND_OFFICE_ADDRESS].join("\u0001");
  if (!cache || cache.signature !== signature) cache = { signature, brand: resolveBrand(env) };
  return cache.brand;
}

export function isSecondaryBrand(): boolean {
  return !getBrand().isPrimary;
}

/**
 * SQL condition: the row belongs to a customer of this deployment's brand (travel_senders.brand /
 * travel_leads.brand). `alias` is the table alias with its dot ("s."). The key is a fixed word from
 * resolveBrand, never user input, so it is inlined.
 */
export function ownedBrandSql(alias = ""): string {
  const key = getBrand().storageKey;
  if (!/^[a-z]*$/.test(key)) throw new Error("invalid brand storage key");
  return `${alias}brand = '${key}'`;
}

/** Both brands' customer websites (links on either host are ours). */
export function knownWebsiteHosts(): string[] {
  const hosts = new Set<string>(["uudamtravel.mn", "www.uudamtravel.mn"]);
  const brand = getBrand();
  hosts.add(brand.websiteHost);
  if (!brand.websiteHost.startsWith("www.")) hosts.add(`www.${brand.websiteHost}`);
  return Array.from(hosts);
}

/** `hosts` as one regex alternation, dots escaped. */
export function websiteHostPattern(): string {
  return knownWebsiteHosts().map((host) => host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}

const URL_SPLIT = /(https?:\/\/[^\s<>"'`«»]+)/giu;

/**
 * A customer-facing text in this brand's words: the primary's names become this brand's, and links to
 * the primary's website point at this brand's site (same paths: both sites run the same code).
 * Text inside other URLs is never touched (Cloudinary folders are named after the primary).
 * Identity for the primary brand.
 */
export function brandText(text: string): string {
  const brand = getBrand();
  if (brand.isPrimary || !text) return text;
  return text.split(URL_SPLIT).map((part, index) => {
    if (index % 2 === 1) {
      // A URL: only the primary website's host is swapped.
      return part.replace(/^(https?:\/\/)(?:www\.)?uudamtravel\.mn(?=[/?#]|$)/iu, `$1${brand.websiteHost}`);
    }
    return part
      .replace(/(?:www\.)?uudamtravel\.mn/giu, brand.websiteHost)
      .replace(/UUDAM\s+TRAVEL\s+AGENCY/gu, brand.agencyUpper)
      .replace(/Uudam\s+Travel\s+Agency/giu, brand.nameLatin)
      .replace(/Uudam\s+travel/giu, brand.nameLatin)
      .replace(/UUDAM/gu, brand.wordmark)
      .replace(/Uudam/gu, brand.nameLatin.split(" ")[0])
      .replace(/(?:Уудам|Үүдэм)\s+Тр[эа]в[эе]л/gu, brand.nameMn)
      .replace(/(?:УУДАМ|ҮҮДЭМ)\s+ТР[ЭА]В[ЭЕ]Л/gu, brand.nameMn.toUpperCase())
      .replace(/УУДАМ|ҮҮДЭМ/gu, brand.nameMn.split(" ")[0].toUpperCase())
      .replace(/Уудам|Үүдэм/gu, brand.nameMn.split(" ")[0]);
  }).join("");
}
