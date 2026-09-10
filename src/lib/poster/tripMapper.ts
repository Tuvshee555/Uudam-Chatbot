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
type PassengerPrice = {
  label: string;
  age_range: string;
  price: number | null;
  currency: "MNT";
  /** "Үнэгүй" when the cell documented this fare as free — see isDocumentedFreeFare,
   * which only trusts a 0 price when this note says so, never a bare 0. */
  note?: string;
};
type MappedPriceGroup = {
  label: string;
  dates: string[];
  display_dates: string[];
  adult_price: number | null;
  child_price: number | null;
  infant_price: number | null;
  child_age: string;
  infant_age: string;
  passenger_prices: PassengerPrice[];
  note: string;
};

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
  infant_price?: number | null;
  hotel?: string;
  has_food?: boolean;
  extra?: {
    included_items?: string[];
    excluded_items?: string[];
    price_groups?: MappedPriceGroup[];
    child_rules?: PassengerPrice[];
    /** Age bands read off the column headers ("Хүүхэд 2-11 нас") when the poster states them. */
    age_rules?: MappedAgeRules;
  };
};

/** A price cell the operator explicitly wrote as free, not merely blank. */
export function isFreePriceCell(cellText: string | undefined): boolean {
  return /үнэгүй|free/i.test(cellText || "");
}

/** "2,340,000₮" / "990.000₮" / "4,180 юань / 2,340,000₮" -> first tugrik-looking number.
 * A cell written as "Үнэгүй" (free) maps to 0 when allowFree is set — only the
 * child/infant columns pass that; the adult column never does, so a stray
 * "Үнэгүй" typed in the wrong cell can never zero out a real adult fare. See
 * isDocumentedFreeFare, which only trusts a 0 accompanied by that note. */
function parsePriceToNumber(cellText: string | undefined, allowFree = false): number | null {
  if (!cellText) return null;
  if (allowFree && isFreePriceCell(cellText)) return 0;
  // Prefer a ₮-suffixed number; fall back to the first number found.
  const tugrikMatch = cellText.match(/([\d][\d,.\s]*\d|\d)\s*₮/);
  const raw = tugrikMatch ? tugrikMatch[1] : cellText.match(/([\d][\d,.\s]*\d|\d)/)?.[1];
  if (!raw) return null;
  const digits = raw.replace(/[,.\s]/g, "");
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

function dateColumnIndex(columns: string[] | undefined): number {
  return (columns || []).findIndex((column) => /огноо|date/i.test(column));
}

function priceCell(row: PosterPriceRow, columns: string[] | undefined, columnIndex: number): string | undefined {
  const cells = row.cells || [];
  if (columnIndex < 0) return undefined;
  if (!columns?.length || cells.length === columns.length) return cells[columnIndex];
  const dateIdx = dateColumnIndex(columns);
  if (dateIdx >= 0 && cells.length === columns.length - 1) {
    return cells[columnIndex > dateIdx ? columnIndex - 1 : columnIndex];
  }
  return cells[columnIndex];
}

function cleanColumnLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * "0-23 сар" (23 MONTHS old) used to come out as "0-23 нас" (23 YEARS old) —
 * the unit was matched optionally then discarded, always appending "нас"
 * regardless of what the source actually said. isInfantShapedAge and every
 * other reader downstream tells infant from child ONLY by checking for the
 * literal substring "сар", so silently dropping it mislabels a real infant
 * band as an adult-aged child band. Preserve whichever unit was present;
 * only default to "нас" when the label had no unit word at all.
 */
function extractAgeRange(label: string): string {
  const unit = /сар/i.test(label) ? "сар" : "нас";
  const range = label.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(?:сар|нас|age)?/i);
  if (range) return `${Number(range[1])}-${Number(range[2])} ${unit}`;
  const single = label.match(/(\d{1,2})\s*(?:сар|нас|age)/i);
  return single ? `${Number(single[1])} ${unit}` : "";
}

function isAdultColumn(label: string): boolean {
  return /том|adult/i.test(label);
}

/** "Нярай", "Infant", or an age band given in months / starting at 0 ("0-2 нас"). */
export function isInfantColumn(label: string): boolean {
  if (isAdultColumn(label)) return false;
  if (/нярай|infant/i.test(label)) return true;
  if (/сар/i.test(label) && /\d/.test(label)) return true;
  return /(^|[^\d])0\s*[-–—]\s*[12](?!\d)/.test(label);
}

function isChildColumn(label: string): boolean {
  return /хүүх|child|нас|age/i.test(label) && !isAdultColumn(label) && !isInfantColumn(label);
}

function expandPosterDateList(value: string | undefined): string[] {
  const text = normalizeDepartureText(value || "")
    .replace(/\b(?:нд|ны|ний)\b/gi, "")
    .replace(/(\d)(?:нд|ны|ний)\b/gi, "$1")
    .trim();
  if (!text || /^үнэ$/i.test(text)) return [];

  const markers = [...text.matchAll(/(\d{1,2})\s*(?:-?\s*р)?\s*сарын/gi)];
  if (markers.length === 0) return [text];

  const dates: string[] = [];
  for (let i = 0; i < markers.length; i++) {
    const marker = markers[i];
    const month = Number(marker[1]);
    const start = (marker.index || 0) + marker[0].length;
    const end = markers[i + 1]?.index ?? text.length;
    const segment = text.slice(start, end);
    const days = [...segment.matchAll(/\d{1,2}/g)].map((match) => match[0]);
    for (const rawDay of days) {
      const day = Number(rawDay);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        dates.push(`${month} сарын ${String(day).padStart(2, "0")}`);
      }
    }
  }

  return [...new Set(dates.length > 0 ? dates : [text])];
}

function mapPriceGroups(priceTable: PosterTrip["price_table"]): MappedPriceGroup[] {
  if (!priceTable?.rows?.length) return [];
  const columns = priceTable.columns || [];
  const adultIdx = findPriceColumnIndex(columns, ["том", "adult"]);
  // Every non-adult passenger column, infants included — the infant one is
  // recognised by its own header ("Нярай") or an infant-shaped age band, not
  // guessed from being the last column.
  const childColumns = columns
    .map((column, index) => ({ column: cleanColumnLabel(column), index }))
    .filter(({ column }) => isChildColumn(column) || isInfantColumn(column));

  return priceTable.rows
    .map((row) => {
      const dates = expandPosterDateList(row.dates);
      const passenger_prices = childColumns.map(({ column, index }) => {
        const cell = priceCell(row, columns, index);
        return {
          label: column,
          age_range: extractAgeRange(column),
          price: parsePriceToNumber(cell, true),
          currency: "MNT" as const,
          ...(isFreePriceCell(cell) ? { note: "Үнэгүй" } : {}),
        };
      });
      const pricedPassengers = passenger_prices.filter((price) => price.price != null);
      const infant = pricedPassengers.find((price) => isInfantColumn(price.label));
      const child = pricedPassengers.find((price) => price !== infant) || pricedPassengers[0];
      return {
        label: dates.join(", ") || normalizeDepartureText(row.dates || ""),
        dates,
        display_dates: dates,
        adult_price: parsePriceToNumber(priceCell(row, columns, adultIdx >= 0 ? adultIdx : 0)),
        child_price: child?.price ?? null,
        infant_price: infant?.price ?? null,
        child_age: child?.age_range || "",
        infant_age: infant?.age_range || "",
        passenger_prices,
        note: "",
      };
    })
    .filter((group) =>
      group.dates.length > 0 ||
      group.adult_price != null ||
      group.child_price != null ||
      group.infant_price != null ||
      group.passenger_prices.some((price) => price.price != null),
    );
}

function mapPrices(priceTable: PosterTrip["price_table"]): {
  adult_price: number | null;
  child_price: number | null;
  infant_price: number | null;
} {
  if (!priceTable?.rows?.length) return { adult_price: null, child_price: null, infant_price: null };

  const groups = mapPriceGroups(priceTable);
  const priced = groups
    .filter((group) => group.adult_price != null)
    .sort((a, b) => (a.adult_price || 0) - (b.adult_price || 0));
  const firstInfant = groups.find((group) => group.infant_price != null)?.infant_price ?? null;
  if (priced.length > 0) {
    return {
      adult_price: priced[0].adult_price,
      child_price: priced[0].child_price,
      infant_price: priced[0].infant_price ?? firstInfant,
    };
  }

  return {
    adult_price: groups.find((group) => group.adult_price != null)?.adult_price ?? null,
    child_price: groups.find((group) => group.child_price != null)?.child_price ?? null,
    infant_price: firstInfant,
  };
}

/**
 * "Нярай 0-23 сар" → "0-23 сар", "Хүүхэд 2-11 нас" → "2-11 нас", "Том хүн 12+ нас"
 * → "12+ нас". Keeps the unit the poster used (months vs years) — unlike
 * extractAgeRange, which normalises every band to "нас" for child rules.
 */
function extractAgeBand(label: string): string {
  const range = label.match(/(\d{1,2})\s*[-–—]\s*(\d{1,2})\s*(нас|сар|age)?/i);
  if (range) {
    const unit = /сар/i.test(range[3] || "") ? "сар" : "нас";
    return `${Number(range[1])}-${Number(range[2])} ${unit}`;
  }
  const openAbove = label.match(/(\d{1,2})\s*\+\s*(?:нас|age)?/i);
  if (openAbove) return `${Number(openAbove[1])}+ нас`;
  const openBelow = label.match(/(\d{1,2})\s*(нас|сар)?\s*(доош|хүртэл)/i);
  if (openBelow) return `${Number(openBelow[1])} ${openBelow[2] || "нас"} ${openBelow[3]}`;
  return "";
}

type MappedAgeRules = { infant?: string; child?: string; adult?: string };

/** Age bands the poster's own column headers state, e.g. "Хүүхэд 2-11 нас". */
function mapAgeRules(priceTable: PosterTrip["price_table"]): MappedAgeRules | undefined {
  const columns = (priceTable?.columns || []).map(cleanColumnLabel);
  const bandOf = (predicate: (label: string) => boolean) => {
    const column = columns.find(predicate);
    return column ? extractAgeBand(column) : "";
  };
  const infant = bandOf(isInfantColumn);
  const child = bandOf(isChildColumn);
  const adult = bandOf(isAdultColumn);
  if (!infant && !child && !adult) return undefined;
  return {
    ...(infant ? { infant } : {}),
    ...(child ? { child } : {}),
    ...(adult ? { adult } : {}),
  };
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

function normalizeDepartureText(value: string): string {
  return value
    .replace(/\r?\n+/g, ", ")
    .replace(/(\d{1,2})\s*(?:-?р\s*)?сарын\s*(\d)/gi, "$1 сарын $2")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushDepartureText(target: string[], value: string | undefined): void {
  const dates = expandPosterDateList(value);
  for (const text of dates) {
    if (!text || /^үнэ$/i.test(text)) continue;
    if (!target.includes(text)) target.push(text);
  }
}

function extractTitleDate(title: string | undefined): string | null {
  const match = String(title || "").match(/(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?!\d)/);
  if (!match) return null;
  return `${Number(match[1])} сарын ${Number(match[2])}`;
}

function mapDepartureDates(poster: PosterTrip): string[] {
  const dates: string[] = [];
  for (const departure of poster.departures || []) {
    pushDepartureText(dates, departure.date);
  }
  if (dates.length === 0) {
    for (const row of poster.price_table?.rows || []) {
      pushDepartureText(dates, row.dates);
    }
  }
  if (dates.length === 0) {
    pushDepartureText(dates, extractTitleDate(poster.title) || undefined);
  }
  return dates;
}

export function mapPosterTripToFields(poster: PosterTrip): MappedTripFields {
  const fields: MappedTripFields = {};

  if (poster.title?.trim()) fields.route_name = poster.title.trim();

  const durationText = mapDurationText(poster.duration_days, poster.duration_nights);
  if (durationText) fields.duration_text = durationText;

  const dates = mapDepartureDates(poster);
  if (dates.length) fields.departure_dates = dates;

  const { adult_price, child_price, infant_price } = mapPrices(poster.price_table);
  if (adult_price != null) fields.adult_price = adult_price;
  if (child_price != null) fields.child_price = child_price;
  if (infant_price != null) fields.infant_price = infant_price;
  const ageRules = mapAgeRules(poster.price_table);

  const hotel = mapHotel(poster.days);
  if (hotel) fields.hotel = hotel;

  const hasFood = mapHasFood(poster.days);
  if (hasFood !== undefined) fields.has_food = hasFood;

  const includes = (poster.includes || []).filter(Boolean);
  const excludes = (poster.excludes || []).filter(Boolean);
  const priceGroups = mapPriceGroups(poster.price_table);
  const childRules = priceGroups.flatMap((group) => group.passenger_prices)
    .filter((price, index, all) =>
      price.price != null &&
      index === all.findIndex((other) =>
        other.label === price.label &&
        other.age_range === price.age_range &&
        other.price === price.price,
      ),
    );
  if (includes.length || excludes.length || priceGroups.length || childRules.length || ageRules) {
    fields.extra = {
      ...(includes.length ? { included_items: includes } : {}),
      ...(excludes.length ? { excluded_items: excludes } : {}),
      ...(priceGroups.length ? { price_groups: priceGroups } : {}),
      ...(childRules.length ? { child_rules: childRules } : {}),
      ...(ageRules ? { age_rules: ageRules } : {}),
    };
  }

  return fields;
}
