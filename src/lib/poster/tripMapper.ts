/**
 * Maps a poster's extracted trip JSON (the AI-read structured data — title,
 * days, prices, hotel, meals) onto the chatbot's trip fields, so "Аялалд
 * нэмэх" can update/create the ACTUAL bookable trip, not just its photos.
 *
 * Pure mapping only — no DB access, no side effects. The caller (poster-sync)
 * decides which of the returned fields to actually write, based on what the
 * user approved in the per-field review modal.
 */

type PosterDay = {
  day?: number;
  route?: string;
  hotel?: string | null;
  meals?: { breakfast?: boolean; lunch?: boolean; dinner?: boolean };
  summary?: string;
};

type PosterPriceRow = { dates?: string; cells?: string[] };

type PosterTrip = {
  title?: string;
  duration_days?: number;
  duration_nights?: number;
  departures?: Array<{ date?: string }>;
  price_table?: { columns?: string[]; rows?: PosterPriceRow[] } | null;
  days?: PosterDay[];
  includes?: string[];
  excludes?: string[];
};

export type MappedTripFields = {
  route_name?: string;
  duration_text?: string;
  departure_dates?: string[];
  adult_price?: number | null;
  child_price?: number | null;
  hotel?: string;
  has_food?: boolean;
  extra?: {
    included_items?: string[];
    excluded_items?: string[];
  };
};

/** "2,340,000₮" / "4,180 юань / 2,340,000₮" -> 2340000 (first tugrik-looking number). */
function parsePriceToNumber(cellText: string | undefined): number | null {
  if (!cellText) return null;
  // Prefer a ₮-suffixed number; fall back to the first number found.
  const tugrikMatch = cellText.match(/([\d][\d,\s]*\d|\d)\s*₮/);
  const raw = tugrikMatch ? tugrikMatch[1] : cellText.match(/([\d][\d,\s]*\d|\d)/)?.[1];
  if (!raw) return null;
  const digits = raw.replace(/[,\s]/g, "");
  const n = Number(digits);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function findPriceColumnIndex(columns: string[] | undefined, keywords: string[]): number {
  if (!columns) return -1;
  const idx = columns.findIndex((c) =>
    keywords.some((kw) => c.toLowerCase().includes(kw)),
  );
  return idx;
}

function mapPrices(priceTable: PosterTrip["price_table"]): {
  adult_price: number | null;
  child_price: number | null;
} {
  if (!priceTable?.rows?.length) return { adult_price: null, child_price: null };

  const adultIdx = findPriceColumnIndex(priceTable.columns, ["том", "adult"]);
  const childIdx = findPriceColumnIndex(priceTable.columns, ["хүүхэд", "child"]);

  // Take the first row with a usable price in that column (rows are usually
  // ordered earliest-departure-first, which is the most relevant "current" price).
  let adult_price: number | null = null;
  let child_price: number | null = null;
  for (const row of priceTable.rows) {
    const cells = row.cells || [];
    if (adult_price == null) {
      const cell = adultIdx >= 0 ? cells[adultIdx] : cells[0];
      adult_price = parsePriceToNumber(cell);
    }
    if (child_price == null) {
      const cell = childIdx >= 0 ? cells[childIdx] : cells[1];
      child_price = parsePriceToNumber(cell);
    }
    if (adult_price != null && child_price != null) break;
  }
  return { adult_price, child_price };
}

function mapDurationText(durationDays?: number, durationNights?: number): string | undefined {
  if (!durationDays && !durationNights) return undefined;
  const parts: string[] = [];
  if (durationDays) parts.push(`${durationDays} өдөр`);
  if (durationNights) parts.push(`${durationNights} шөнө`);
  return parts.join(" ");
}

function mapHotel(days: PosterDay[] | undefined): string | undefined {
  if (!days?.length) return undefined;
  const hotels = [...new Set(days.map((d) => d.hotel).filter((h): h is string => Boolean(h)))];
  if (hotels.length === 0) return undefined;
  return hotels.join(", ");
}

function mapHasFood(days: PosterDay[] | undefined): boolean | undefined {
  if (!days?.length) return undefined;
  return days.some((d) => d.meals?.breakfast || d.meals?.lunch || d.meals?.dinner);
}

export function mapPosterTripToFields(poster: PosterTrip): MappedTripFields {
  const fields: MappedTripFields = {};

  if (poster.title?.trim()) fields.route_name = poster.title.trim();

  const durationText = mapDurationText(poster.duration_days, poster.duration_nights);
  if (durationText) fields.duration_text = durationText;

  const dates = (poster.departures || [])
    .map((d) => d.date?.trim())
    .filter((d): d is string => Boolean(d));
  if (dates.length) fields.departure_dates = dates;

  const { adult_price, child_price } = mapPrices(poster.price_table);
  if (adult_price != null) fields.adult_price = adult_price;
  if (child_price != null) fields.child_price = child_price;

  const hotel = mapHotel(poster.days);
  if (hotel) fields.hotel = hotel;

  const hasFood = mapHasFood(poster.days);
  if (hasFood !== undefined) fields.has_food = hasFood;

  const includes = (poster.includes || []).filter(Boolean);
  const excludes = (poster.excludes || []).filter(Boolean);
  if (includes.length || excludes.length) {
    fields.extra = {
      ...(includes.length ? { included_items: includes } : {}),
      ...(excludes.length ? { excluded_items: excludes } : {}),
    };
  }

  return fields;
}
