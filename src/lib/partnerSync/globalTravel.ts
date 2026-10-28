// Mirrors a Global Travel Corporation tour page into a poster trip, so the partner's listing stays
// copied exactly: every departure date, package, hotel and price, plus the itinerary and the
// included/excluded lists, as the partner publishes them.
//
// The page ships schema.org JSON-LD with one Offer per date x package x hotel, which is far more
// stable than reading the HTML tables, so prices and dates come from there. The itinerary and the
// included/excluded lists exist only as HTML, so those are read from the markup.
//
// Nothing here writes to the database. `fetchGlobalTravelTour` returns a plain object, and the
// caller (scripts/sync-global-travel.ts) decides what to do with it.

export type PartnerOffer = {
  /** ISO departure date, e.g. "2026-11-11" */
  date: string;
  /** Package name exactly as the partner writes it, e.g. "Чөлөөт аялал" */
  packageLabel: string;
  /** Hotel option exactly as the partner writes it, e.g. "Phoenix+Paxton" */
  hotelLabel: string;
  adultPrice: number;
  currency: string;
  /** true when the partner marks the offer as available */
  inStock: boolean;
};

export type PartnerDay = { day: number; title: string; lines: string[] };

export type PartnerTour = {
  sourceUrl: string;
  title: string;
  description: string;
  heroImage: string | null;
  durationDays: number | null;
  durationNights: number | null;
  destinations: string[];
  hotels: string[];
  offers: PartnerOffer[];
  dates: string[];
  packages: string[];
  hotelOptions: string[];
  days: PartnerDay[];
  includes: string[];
  excludes: string[];
  faq: { question: string; answer: string }[];
  /** The partner's own "last updated" date, when the page states one. */
  dateModified: string | null;
  /** Hash of everything above, so an unchanged page is a no-op. */
  contentHash: string;
};

const MAX_HTML_BYTES = 4_000_000;

/** Decode the HTML entities that appear in this page's markup. */
function decodeEntities(text: string): string {
  return text
    .replace(/&(?:nbsp|#160);/g, " ")
    .replace(/&(?:amp|#38);/g, "&")
    .replace(/&(?:lt|#60);/g, "<")
    .replace(/&(?:gt|#62);/g, ">")
    .replace(/&(?:quot|#34);/g, '"')
    .replace(/&(?:#39|apos|rsquo|#8217);/g, "'")
    .replace(/&(?:mdash|#8212);/g, "—")
    .replace(/&(?:ndash|#8211);/g, "–")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

/** Strip tags from an HTML fragment and collapse whitespace. */
function text(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

/** Every <script type="application/ld+json"> payload on the page, parsed; unparseable blocks are skipped. */
function jsonLdBlocks(html: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed = JSON.parse(match[1].trim());
      for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
        if (item && typeof item === "object") blocks.push(item as Record<string, unknown>);
      }
    } catch {
      // A malformed block is ignored: the others still carry the offers.
    }
  }
  return blocks;
}

const typesOf = (node: Record<string, unknown>): string[] => {
  const raw = node["@type"];
  return (Array.isArray(raw) ? raw : [raw]).filter((x): x is string => typeof x === "string");
};

/**
 * The partner names each offer "<tour> · <date> · <package> · <hotel>".
 * The date also arrives as itemOffered.departureTime, which is the reliable field;
 * the package and hotel are only in the name, so they are read from its tail.
 */
function splitOfferName(name: string): { packageLabel: string; hotelLabel: string } | null {
  const parts = name.split("·").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return { packageLabel: parts[parts.length - 2], hotelLabel: parts[parts.length - 1] };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function readOffers(product: Record<string, unknown>): PartnerOffer[] {
  const raw = Array.isArray(product.offers) ? product.offers : product.offers ? [product.offers] : [];
  const offers: PartnerOffer[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const offer = entry as Record<string, unknown>;
    const item = (offer.itemOffered && typeof offer.itemOffered === "object" ? offer.itemOffered : {}) as Record<string, unknown>;
    const date = String(item.departureTime ?? "").slice(0, 10);
    const price = Number(offer.price);
    const named = splitOfferName(String(offer.name ?? item.name ?? ""));
    if (!ISO_DATE.test(date) || !Number.isFinite(price) || price <= 0 || !named) continue;
    offers.push({
      date,
      packageLabel: named.packageLabel,
      hotelLabel: named.hotelLabel,
      adultPrice: Math.round(price),
      currency: String(offer.priceCurrency ?? "MNT"),
      inStock: !/OutOfStock|SoldOut/i.test(String(offer.availability ?? "")),
    });
  }
  // Stable order: by date, then package, then hotel, so an unchanged page hashes identically.
  return offers.sort((a, b) =>
    a.date.localeCompare(b.date) || a.packageLabel.localeCompare(b.packageLabel) || a.hotelLabel.localeCompare(b.hotelLabel));
}

/** "P9D" -> 9 */
function isoDurationDays(value: unknown): number | null {
  const match = /^P(\d+)D$/.exec(String(value ?? ""));
  return match ? Number(match[1]) : null;
}

/**
 * The itinerary lives in the HTML as a heading per day followed by a list.
 * Headings look like "1-р өдөр: Улаанбаатар - Саняа".
 */
function readDays(html: string): PartnerDay[] {
  const days: PartnerDay[] = [];
  const headingPattern = /<h[23][^>]*>\s*(\d{1,2})\s*-?\s*р\s+өдөр\s*:?\s*([^<]*)<\/h[23]>/gi;
  const matches = [...html.matchAll(headingPattern)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index! + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index! : Math.min(html.length, start + 8000);
    const body = html.slice(start, end);
    const lines = [...body.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => text(li[1])).filter(Boolean);
    if (!lines.length) {
      const paragraphs = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((p) => text(p[1])).filter(Boolean);
      lines.push(...paragraphs);
    }
    days.push({ day: Number(match[1]), title: text(match[2]), lines });
  }
  return days.sort((a, b) => a.day - b.day);
}

/** The bullet list that follows a given heading, e.g. "Үнэд багтсан". */
function readListAfterHeading(html: string, heading: string): string[] {
  const headingAt = html.search(new RegExp(`<h[23][^>]*>\\s*${heading}[^<]*<\\/h[23]>`, "i"));
  if (headingAt < 0) return [];
  const listMatch = /<ul[^>]*>([\s\S]*?)<\/ul>/i.exec(html.slice(headingAt, headingAt + 6000));
  if (!listMatch) return [];
  return [...listMatch[1].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((li) => text(li[1])).filter(Boolean);
}

function readFaq(blocks: Record<string, unknown>[]): { question: string; answer: string }[] {
  const page = blocks.find((block) => typesOf(block).includes("FAQPage"));
  const entities = page && Array.isArray(page.mainEntity) ? page.mainEntity : [];
  const faq: { question: string; answer: string }[] = [];
  for (const entry of entities) {
    if (!entry || typeof entry !== "object") continue;
    const node = entry as Record<string, unknown>;
    const accepted = (node.acceptedAnswer && typeof node.acceptedAnswer === "object" ? node.acceptedAnswer : {}) as Record<string, unknown>;
    const question = text(String(node.name ?? ""));
    const answer = text(String(accepted.text ?? ""));
    if (question && answer) faq.push({ question, answer });
  }
  return faq;
}

async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/** Reads one partner tour page. Throws when the page cannot be read or carries no offers. */
export async function fetchGlobalTravelTour(sourceUrl: string, options: { timeoutMs?: number } = {}): Promise<PartnerTour> {
  const response = await fetch(sourceUrl, {
    headers: { "user-agent": "UudamTravelSync/1.0 (+https://uudamtravel.mn)", accept: "text/html" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) throw new Error(`Partner page returned HTTP ${response.status}`);
  const html = (await response.text()).slice(0, MAX_HTML_BYTES);

  const blocks = jsonLdBlocks(html);
  const product = blocks.find((block) => typesOf(block).some((type) => type === "TouristTrip" || type === "Product"));
  if (!product) throw new Error("Partner page has no TouristTrip/Product structured data");

  const offers = readOffers(product);
  if (!offers.length) throw new Error("Partner page listed no usable offers");

  const days = readDays(html);
  const includes = readListAfterHeading(html, "Үнэд багтсан");
  const excludes = readListAfterHeading(html, "Үнэд багтаагүй");
  const hotels = readListAfterHeading(html, "Зочид буудал");
  const durationDays = isoDurationDays(product.duration);

  const destinationRaw = product.destination;
  const destinations = (Array.isArray(destinationRaw) ? destinationRaw : destinationRaw ? [destinationRaw] : [])
    .map((entry) => (entry && typeof entry === "object" ? String((entry as Record<string, unknown>).name ?? "") : String(entry)))
    .map((name) => text(name))
    .filter(Boolean);

  const tour: Omit<PartnerTour, "contentHash"> = {
    sourceUrl,
    title: text(String(product.name ?? "")),
    description: text(String(product.description ?? "")),
    heroImage: typeof product.image === "string" ? product.image : null,
    durationDays,
    durationNights: durationDays ? durationDays - 1 : null,
    destinations,
    hotels,
    offers,
    dates: [...new Set(offers.map((offer) => offer.date))].sort(),
    packages: [...new Set(offers.map((offer) => offer.packageLabel))],
    hotelOptions: [...new Set(offers.map((offer) => offer.hotelLabel))],
    days,
    includes,
    excludes,
    faq: readFaq(blocks),
    dateModified: typeof product.dateModified === "string" ? product.dateModified.slice(0, 10) : null,
  };
  return { ...tour, contentHash: await sha256Hex(JSON.stringify(tour)) };
}
