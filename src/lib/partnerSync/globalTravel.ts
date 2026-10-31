// Reads one Global Travel Corporation (GTC) tour from their public API.
//
// GTC's tour page is a JavaScript app: the HTML only carries adult fares, while the booking panel
// (child, infant, single-room, programme variants, per-hotel, per-date, seats) loads from
// api.global-travel.mn after the page renders. That API is what the page itself uses, so it is the
// source copied here. Nothing in this file writes anywhere; it returns a plain object.

export type PartnerPrices = {
  adult: number | null;
  child2to5: number | null;
  child6to11: number | null;
  infant: number | null;
  single: number | null;
  programAdult: number | null;
  programChild2to5: number | null;
  programChild6to11: number | null;
};

export type PartnerRow = {
  /** ISO departure date */
  date: string;
  /** Hotel option exactly as the source names it. */
  hotel: string;
  /** false when GTC shows the date as sold out */
  open: boolean;
  seats: number | null;
  prices: PartnerPrices;
};

export type PartnerDay = {
  day: number;
  title: string;
  route: string;
  lines: string[];
  meals: { breakfast: boolean; lunch: boolean; dinner: boolean };
  accommodation: string | null;
  distance?: string;
  transportation?: string | null;
};

export type PartnerTour = {
  slug: string;
  sourceUrl: string;
  title: string;
  description: string;
  destinations: string[];
  airlines: string[];
  durationDays: number | null;
  durationNights: number | null;
  hotels: { name: string; stars: number | null; description: string }[];
  includes: string[];
  excludes: string[];
  days: PartnerDay[];
  rows: PartnerRow[];
  dates: string[];
  hotelOptions: string[];
  /** GTC's own "last updated" stamp for the tour record. */
  updatedAt: string | null;
  /** Hash of everything above, so an unchanged tour is a no-op. */
  contentHash: string;
};

const API = "https://api.global-travel.mn/api";
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function validDate(value: string): boolean {
  return ISO_DATE.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}

async function getJson(path: string, timeoutMs: number): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}${path}`, {
    headers: { accept: "application/json", "user-agent": "UudamTravelSync/1.0 (+https://uudamtravel.mn)" },
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`GTC ${path} returned HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown>;
  if (body.success === false) throw new Error(`GTC ${path} reported failure`);
  return body;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item ?? "").trim()).filter(Boolean) : [];

/** "3490000" -> 3490000; anything empty, zero or non-numeric -> null (never an invented 0). */
function money(value: unknown): number | null {
  if (value == null || value === "" || value === 0 || value === "0") return null;
  const number = Number(value);
  if ((typeof value !== "number" && typeof value !== "string") || !Number.isSafeInteger(number) || number <= 0) throw new Error("GTC returned an invalid fare");
  return number;
}

/**
 * Uudam sells the partner's tour above the partner's own fares (owner, 2026-10-31: every trip's
 * passenger fares +100,000₮). Adult, child, infant and programme fares move; the single-room
 * supplement is not a passenger fare and a missing fare stays missing. Applied when the tour is
 * read, so the poster, trip, website and the parity check (scripts/verify-partner-sync.ts) all see it.
 */
export const PARTNER_FARE_MARKUP_MNT = 100_000;

export function withPartnerMarkup(prices: PartnerPrices, markup = PARTNER_FARE_MARKUP_MNT): PartnerPrices {
  const up = (fare: number | null) => (fare == null ? null : fare + markup);
  return {
    ...prices,
    adult: up(prices.adult), child2to5: up(prices.child2to5), child6to11: up(prices.child6to11), infant: up(prices.infant),
    programAdult: up(prices.programAdult), programChild2to5: up(prices.programChild2to5), programChild6to11: up(prices.programChild6to11),
  };
}

function readPrices(raw: unknown): PartnerPrices {
  const p = record(raw);
  return {
    adult: money(p.adult_price),
    child2to5: money(p.child_2_5_price),
    child6to11: money(p.child_6_11_price),
    infant: money(p.infant_price),
    single: money(p.single_supply_price),
    programAdult: money(p.program_adult_price),
    programChild2to5: money(p.program_child_2_5_price),
    programChild6to11: money(p.program_child_6_11_price),
  };
}

/** One row per date x hotel. GTC pads the table with empty rows (no hotel, no prices): those are skipped. */
export function readRows(raw: unknown): PartnerRow[] {
  const byKey = new Map<string, { row: PartnerRow; updated: string }>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = record(entry);
    if (item.deleted_at) continue;
    const date = String(item.departure_date ?? "").slice(0, 10);
    const meta = record(item.meta);
    const hotel = String(item.hotel_name ?? meta.hotel_name ?? "").trim();
    const prices = readPrices(item.prices);
    if (!hotel && Object.keys(record(item.prices)).length === 0) continue;
    if (!validDate(date) || !hotel) throw new Error("GTC returned an invalid departure date or hotel");
    if (prices.adult == null && prices.programAdult == null) {
      if (Object.values(record(item.prices)).some((value) => value != null && value !== "")) throw new Error("GTC returned a priced row without a valid adult fare");
      continue;
    }
    const availability = String(item.availability ?? "");
    const seats = item.seats == null || item.seats === "" ? NaN : Number(item.seats);
    const row: PartnerRow = {
      date,
      hotel,
      open: seats !== 0 && !/дүүрсэн|sold\s*out|full|closed|cancelled|inactive/i.test(`${availability} ${item.status ?? ""}`),
      seats: Number.isInteger(seats) && seats >= 0 ? seats : null,
      prices,
    };
    const key = `${date}|${hotel}`;
    const updated = String(item.updated_at ?? "");
    const kept = byKey.get(key);
    if (!kept || updated > kept.updated) byKey.set(key, { row, updated });
  }
  return [...byKey.values()].map((entry) => entry.row).sort((a, b) => a.date.localeCompare(b.date) || a.hotel.localeCompare(b.hotel));
}

function readDays(raw: unknown): PartnerDay[] {
  const days: PartnerDay[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    const item = record(entry);
    const day = Number(item.day);
    if (!Number.isInteger(day) || day < 1) continue;
    const route = Array.isArray(item.route) && item.route.length ? record(item.route[0]) : {};
    const meals = record(item.meals);
    days.push({
      day,
      title: String(item.title ?? "").trim(),
      route: [route.from, route.to].filter(Boolean).join(" - "),
      lines: strings(item.description),
      meals: { breakfast: Boolean(meals.breakfast), lunch: Boolean(meals.lunch), dinner: Boolean(meals.dinner) },
      accommodation: typeof item.accommodation === "string" && item.accommodation.trim() ? item.accommodation.trim() : null,
      distance: String(route.distance ?? ""),
      transportation: typeof item.transportation === "string" ? item.transportation : null,
    });
  }
  return days.sort((a, b) => a.day - b.day);
}

async function sha256Hex(value: string): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(value).digest("hex");
}

/** The partner writes its own brand into the blurb ("GTC-тэй хамт …"); our customers must not read that. */
export function ownVoice(text: string): string {
  return text.replace(/GTC\S*\s+хамт\s+/gi, "").replace(/\s+/g, " ").trim();
}

/** Reads a tour by its GTC slug (the last part of https://global-travel.mn/tours/<slug>). Throws when it cannot be read. */
export async function fetchGlobalTravelTour(slug: string, options: { timeoutMs?: number } = {}): Promise<PartnerTour> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const tourBody = await getJson(`/tours/${encodeURIComponent(slug)}`, timeoutMs);
  const tour = record(tourBody.tour);
  const tourId = String(tour.id ?? "");
  if (!tourId) throw new Error("GTC returned no tour");

  const [itineraryBody, tableBody] = await Promise.all([
    getJson(`/itinerary/tour/${encodeURIComponent(tourId)}`, timeoutMs),
    getJson(`/tours/${encodeURIComponent(slug)}/price-table?audience=public&includeSoldOut=true`, timeoutMs),
  ]);

  const rows = readRows(tableBody.data).map((row) => ({ ...row, prices: withPartnerMarkup(row.prices) }));
  if (!rows.length) throw new Error("GTC listed no priced departures");
  const days = readDays(itineraryBody.itineraryDays);
  if (!Array.isArray(tour.included_items) || !Array.isArray(tour.excluded_items) || !Array.isArray(tour.hotels)
    || !days.length || new Set(days.map((day) => day.day)).size !== days.length) {
    throw new Error("GTC returned incomplete tour content");
  }

  const durationDays = Number(tour.duration_day);
  const durationNights = Number(tour.duration_night);
  const hotels = (Array.isArray(tour.hotels) ? tour.hotels : [])
    .map((entry) => record(entry))
    .map((hotel) => ({ name: String(hotel.name ?? "").trim(), description: String(hotel.description ?? "").trim(), stars: Number.isFinite(Number(hotel.stars)) && Number(hotel.stars) > 0 ? Number(hotel.stars) : null }))
    .filter((hotel) => hotel.name);

  const data: Omit<PartnerTour, "contentHash"> = {
    slug,
    sourceUrl: `https://global-travel.mn/tours/${slug}`,
    title: String(tour.title ?? "").trim(),
    description: ownVoice(String(tour.description ?? "")),
    destinations: strings(tour.cities),
    airlines: strings(tour.airlines),
    durationDays: Number.isInteger(durationDays) && durationDays > 0 ? durationDays : null,
    durationNights: Number.isInteger(durationNights) && durationNights >= 0 ? durationNights : null,
    hotels,
    includes: strings(tour.included_items),
    excludes: strings(tour.excluded_items),
    days,
    rows,
    dates: [...new Set(rows.map((row) => row.date))].sort(),
    hotelOptions: [...new Set(rows.map((row) => row.hotel))],
    updatedAt: typeof tour.updated_at === "string" ? tour.updated_at : null,
  };
  return { ...data, contentHash: await sha256Hex(JSON.stringify(data)) };
}
