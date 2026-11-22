/**
 * Which brand this deployment speaks for.
 *
 * One codebase and ONE database serve two travel brands owned by the same company:
 * - "uudam" (default, the primary): Uudam Travel. It owns the catalogue, the bot settings and every
 *   row written before brands existed.
 * - "magnai": «Магнай Травел», a second Facebook page answered by its own Vercel deployment
 *   (BRAND=magnai). Same trips, same answers; its name, its website, its phone number
 *   (BRAND_CONTACT_PHONES) and its adult/child fares (BRAND_DISCOUNT_MNT lower, brandFares.ts) differ.
 *
 * A secondary brand's customers see the shared data in its words (brandText, brandFares). Its admin
 * sees and saves the shared data exactly as the primary's admin does (brandAdminMode.ts); outside
 * admin requests it never writes the shared catalogue or settings (brandWriteGuard.ts), and it only
 * sweeps and lists the customers it owns: travel_senders.brand / travel_leads.brand = `storageKey`.
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
  /** This brand's bot deployment (its program-PDF links), no trailing slash. */
  botUrl: string;
  /** The primary brand's bot: links stored in the shared catalogue always point there. */
  primaryBotUrl: string;
};

const UUDAM_SITE = "https://uudamtravel.mn";
const UUDAM_BOT = "https://uudam-chatbot.vercel.app";
const MAGNAI_SITE_DEFAULT = "https://magnai-travel.vercel.app";
const MAGNAI_BOT_DEFAULT = "https://magnai-chatbot.vercel.app";
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
      botUrl: siteUrl(env.SITE_URL, MAGNAI_BOT_DEFAULT),
      primaryBotUrl: siteUrl(env.BRAND_PRIMARY_BOT_URL, UUDAM_BOT),
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
    botUrl: UUDAM_BOT,
    primaryBotUrl: UUDAM_BOT,
  };
}

let cache: { signature: string; brand: Brand } | null = null;

/** The brand of this process (env BRAND). Recomputed only when the brand env values change. */
export function getBrand(): Brand {
  const env = process.env;
  const signature = [
    env.BRAND, env.BRAND_WEBSITE_URL, env.BRAND_DISCOUNT_MNT, env.BRAND_CONTACT_PHONES,
    env.BRAND_OFFICE_ADDRESS, env.SITE_URL, env.BRAND_PRIMARY_BOT_URL,
  ].join("\u0001");
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `hosts` as one regex alternation, dots escaped. */
export function websiteHostPattern(): string {
  return knownWebsiteHosts().map(escapeRegExp).join("|");
}

const URL_SPLIT = /(https?:\/\/[^\s<>"'`«»]+)/giu;

/**
 * A customer-facing text in this brand's words: the primary's names become this brand's, links to
 * the primary's website point at this brand's site (same paths: both sites run the same code), the
 * primary bot's program PDFs at this brand's bot, and the primary's phone numbers become this brand's
 * own when it has one. Text inside other URLs is never touched (Cloudinary folders are named after
 * the primary). Identity for the primary brand.
 */
export function brandText(text: string): string {
  const brand = getBrand();
  if (brand.isPrimary || !text) return text;
  const primaryBotPdf = new RegExp(`^${escapeRegExp(brand.primaryBotUrl)}(?=/api/poster-pdf)`, "iu");
  const branded = text.split(URL_SPLIT).map((part, index) => {
    if (index % 2 === 1) {
      return part
        .replace(/^(https?:\/\/)(?:www\.)?uudamtravel\.mn(?=[/?#]|$)/iu, `$1${brand.websiteHost}`)
        .replace(primaryBotPdf, brand.botUrl);
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
  return brand.contactPhones ? brandPhones(branded, brand.contactPhones) : branded;
}

/**
 * The primary brand's phone numbers as customers see them: these (its welcome text and posters print
 * them) plus every number in the shared settings' list, added at runtime (brandSettings.ts).
 */
const primaryPhones = new Set<string>(["77136633", "89136633", "91172769", "99248000"]);

/** Adds the numbers found in a shared text (any "#### ####" / "####-####" / "########" style). */
export function registerPrimaryPhones(text: string): void {
  for (const match of text.matchAll(/(?<!\d)\d{4}[\s-]?\d{4}(?!\d)/g)) primaryPhones.add(match[0].replace(/\D/g, ""));
}

/**
 * Every primary number in a text becomes `ownPhones` (an 8-digit number), in the same style
 * ("7713 6633" → "9026 6633", "7713-6633" → "9026-6633"); a list of them collapses to one number and a
 * line that only repeats it is dropped.
 */
export function brandPhones(text: string, ownPhones: string): string {
  const own = ownPhones.replace(/\D/g, "");
  if (own.length !== 8 || !text) return text;
  let out = text;
  for (const phone of primaryPhones) {
    if (phone === own) continue;
    const pattern = new RegExp(`(?<!\\d)${phone.slice(0, 4)}([\\s-]?)${phone.slice(4)}(?!\\d)`, "g");
    out = out.replace(pattern, (_match, separator: string) => `${own.slice(0, 4)}${separator}${own.slice(4)}`);
  }
  const ownPattern = `${own.slice(0, 4)}[\\s-]?${own.slice(4)}`;
  out = out.replace(new RegExp(`(${ownPattern})(?:\\s*[/,|]\\s*${ownPattern})+`, "g"), "$1");
  let shown = false;
  return out.split("\n").filter((line) => {
    if (line.replace(/[^\p{L}\p{N}]+/gu, "") !== own) return true;
    if (shown) return false;
    shown = true;
    return true;
  }).join("\n");
}
