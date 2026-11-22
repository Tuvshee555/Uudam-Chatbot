/**
 * A secondary brand's fares (brand.ts): every ADULT and CHILD fare is `discount` lower.
 * Infant fares, single-room supplements, fees and deposits stay exactly as the catalogue has them.
 *
 * The same rule runs on the website (uudam-booking-web), so the bot and the site always quote the same
 * figure. Applied only to what a customer is told (trip reads in a secondary deployment, its poster
 * PDFs) — never written back: a secondary deployment cannot write the catalogue (brandWriteGuard.ts).
 *
 * How:
 * 1. Collect the trip's adult/child fare amounts (columns, price rows, discount rows, child bands that
 *    are not infant-shaped, per-person room prices) into a map original → discounted.
 * 2. Change every numeric fare field whose value is in that map (infant-shaped bands and infant keys
 *    are never touched), and every formatted occurrence of exactly those amounts inside texts
 *    («4,690,000₮», «4 690 000», «4.69 сая»), in ONE pass, so a value is never discounted twice.
 */
import type { TravelTrip } from "./travelTypes";

/** Fares below this are not package fares (fees, deposits); never discounted. */
export const MIN_DISCOUNTABLE_FARE = 200_000;
/** Set on a trip whose fares this module already changed (in memory only; never stored). */
export const BRAND_FARES_MARK = "brand_fares_applied";

type Rec = Record<string, unknown>;
export type FareMap = Map<number, number>;

function isRecord(value: unknown): value is Rec {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function records(value: unknown): Rec[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}
function fareNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_DISCOUNTABLE_FARE ? Math.trunc(value) : null;
}

/**
 * An infant band (age 0–3, months, «нярай»/infant, or a passenger kind of "infant"). Same reading as
 * travelFastPathsSearch.isInfantShapedAge plus the record's own kind; kept here to stay import-free.
 */
export function isInfantBand(record: Rec): boolean {
  const kind = String(record.kind ?? record.passenger ?? record.type ?? "").toLowerCase();
  if (kind === "infant") return true;
  const label = String(record.label ?? record.name ?? "").toLowerCase();
  const age = String(record.age_range ?? record.ageRange ?? record.age ?? "").toLowerCase();
  if (/нярай|infant|baby/.test(label) || /нярай|infant/.test(age)) return true;
  if (/сар/.test(age)) return true;
  const span = /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*нас/.exec(age) || /(\d{1,2})\s*[-–]\s*(\d{1,2})\s*нас/.exec(label);
  if (span && Number(span[1]) === 0 && Number(span[2]) <= 3) return true;
  const birthYears = /(\d{4})\s*[-–]\s*(\d{4})/.exec(age);
  if (birthYears) {
    const maxAge = new Date().getFullYear() - Number(birthYears[1]);
    if (maxAge >= 0 && maxAge <= 3) return true;
  }
  return false;
}

/** discounted(amount) for one adult/child fare; anything else unchanged. */
export function discountedFare(amount: number, discount: number): number {
  if (!(discount > 0) || !(amount >= MIN_DISCOUNTABLE_FARE)) return amount;
  return Math.max(0, amount - discount);
}

/** The trip's adult and child fare amounts, mapped to this brand's figure. */
export function tripFareMap(trip: Pick<TravelTrip, "adult_price" | "child_price" | "extra">, discount: number): FareMap {
  const fares = new Set<number>();
  const add = (value: unknown) => {
    const n = fareNumber(value);
    if (n != null) fares.add(n);
  };
  const adultFares: number[] = [];
  const addAdult = (value: unknown) => {
    const n = fareNumber(value);
    if (n != null) { fares.add(n); adultFares.push(n); }
  };
  addAdult(trip.adult_price);
  add(trip.child_price);
  const extra = isRecord(trip.extra) ? trip.extra : {};
  for (const key of ["price_groups", "departure_date_groups", "discounts"]) {
    for (const row of records(extra[key])) {
      addAdult(row.adult_price);
      add(row.child_price);
      if (isRecord(row.adult_price_range)) { addAdult(row.adult_price_range.min); addAdult(row.adult_price_range.max); }
      for (const band of records(row.passenger_prices)) if (!isInfantBand(band)) add(band.price);
      // A single-occupancy FULL fare (not a supplement) is at least the row's adult fare.
      const single = fareNumber(row.single_price);
      const adult = fareNumber(row.adult_price);
      if (single != null && adult != null && single >= adult) add(single);
    }
  }
  for (const key of ["child_rules", "passenger_prices", "child_price_rules"]) {
    for (const band of records(extra[key])) if (!isInfantBand(band)) add(band.price);
  }
  // A room row priced like a per-person fare (≥ half the cheapest adult fare) is a fare; a smaller one
  // is a supplement and stays.
  const cheapestAdult = adultFares.length ? Math.min(...adultFares) : 0;
  if (cheapestAdult) {
    for (const room of records(extra.room_prices)) {
      const n = fareNumber(room.price);
      if (n != null && n >= cheapestAdult / 2) fares.add(n);
    }
  }
  const map: FareMap = new Map();
  if (discount > 0) for (const amount of fares) map.set(amount, discountedFare(amount, discount));
  return map;
}

function groupThousands(digits: string): string[] {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) groups.unshift(digits.slice(Math.max(0, end - 3), end));
  return groups;
}

const SEPARATORS = ",.'   ";
const SEP_CLASS = "[,.'\\u00a0\\u202f ]";

function millionsText(amount: number): string | null {
  if (amount < 1_000_000 || amount % 10_000 !== 0) return null;
  return (amount / 1_000_000).toFixed(2).replace(/\.?0+$/, "");
}

/**
 * Replaces, in one pass, every formatted occurrence of a mapped amount with its new figure in the same
 * style: «4,690,000» → «4,640,000», «4 690 000» → «4 640 000», «4690000» → «4640000», «4.69 сая» →
 * «4.64 сая». Digits that are part of a longer number never match.
 */
export function makeFareTextReplacer(fares: FareMap): (text: string) => string {
  if (!fares.size) return (text) => text;
  const alternatives: string[] = [];
  const amounts = Array.from(fares.keys()).sort((a, b) => b - a);
  for (const amount of amounts) {
    const groups = groupThousands(String(amount));
    if (groups.length > 1) alternatives.push(groups.join(SEP_CLASS));
  }
  for (const amount of amounts) alternatives.push(String(amount));
  for (const amount of amounts) {
    const millions = millionsText(amount);
    if (millions && millions.includes(".")) alternatives.push(`${millions.replace(".", "[.,]")}(?=\\s*сая)`);
  }
  const pattern = new RegExp(`(?<![\\d.,'])(?:${alternatives.join("|")})(?!\\d)(?![,.']\\d)`, "gu");
  const byMillions = new Map<string, number>();
  for (const amount of amounts) {
    const millions = millionsText(amount);
    if (millions) byMillions.set(millions, amount);
  }
  return (text: string) => {
    if (!text) return text;
    return text.replace(pattern, (match, offset: number, whole: string) => {
      const after = whole.slice(offset + match.length);
      if (/^\s*сая/u.test(after) && /^\d+[.,]\d+$/.test(match)) {
        const original = byMillions.get(match.replace(",", "."));
        const next = original != null ? fares.get(original) : undefined;
        if (original == null || next == null) return match;
        const decimal = match.includes(",") ? "," : ".";
        return (millionsText(next) ?? String(next / 1_000_000)).replace(".", decimal);
      }
      const digits = match.replace(/[^\d]/g, "");
      const next = fares.get(Number(digits));
      if (next == null) return match;
      const separator = Array.from(match).find((char) => SEPARATORS.includes(char));
      return separator ? groupThousands(String(next)).join(separator) : String(next);
    });
  };
}

const FARE_KEY = /price|fare|amount|^min$|^max$/i;
/** Subtrees whose numbers are never fares: infant tiers, fees, taxes, deposits, supplements. */
const NEVER_KEY = /infant|нярай|fee|tax|deposit|supplement|visa/i;

/**
 * One-pass transform of a JSON value: mapped fare numbers, mapped amounts in texts. Numbers inside an
 * infant band, or under an infant key, are never changed (however deep).
 */
export function transformFareValue(
  value: unknown,
  fares: FareMap,
  text: (s: string) => string,
  key = "",
  inInfant = false,
): unknown {
  if (typeof value === "string") return text(value);
  if (typeof value === "number") {
    if (inInfant || !FARE_KEY.test(key) || NEVER_KEY.test(key)) return value;
    const next = fares.get(value);
    return next == null ? value : next;
  }
  if (Array.isArray(value)) return value.map((item) => transformFareValue(item, fares, text, key, inInfant));
  if (isRecord(value)) {
    const infant = inInfant || isInfantBand(value);
    const out: Rec = {};
    for (const [childKey, child] of Object.entries(value)) {
      out[childKey] = transformFareValue(child, fares, text, childKey, infant || NEVER_KEY.test(childKey));
    }
    return out;
  }
  return value;
}

/**
 * The trip as this brand quotes it. `brandTextFn` swaps the primary's names in texts (brand.ts
 * brandText). Identity when there is no discount and no text change, or when already applied.
 */
export function applyBrandFares(
  trip: TravelTrip,
  discount: number,
  brandTextFn: (text: string) => string = (text) => text,
): TravelTrip {
  if (isRecord(trip.extra) && trip.extra[BRAND_FARES_MARK] === true) return trip;
  const fares = tripFareMap(trip, discount);
  const fareText = makeFareTextReplacer(fares);
  const text = (value: string) => brandTextFn(fareText(value));
  const fare = (value: number | null) => (value == null ? value : fares.get(value) ?? value);
  const extra = transformFareValue(isRecord(trip.extra) ? trip.extra : {}, fares, text) as Rec;
  return {
    ...trip,
    operator_name: brandTextFn(trip.operator_name),
    adult_price: fare(trip.adult_price),
    child_price: fare(trip.child_price),
    notes: text(trip.notes),
    source_description: text(trip.source_description),
    extra: { ...extra, [BRAND_FARES_MARK]: true },
  };
}

const ADULT_OR_CHILD_HEADER = /том|насанд|adult|хүүх|child|kid|үнэ|price|fare|багц|package|хүн/iu;
const NOT_A_FARE_HEADER = /нярай|infant|ганц|single|нэмэлт|supplement|өрөө\s*нэм|виз|visa|такс|tax|хураамж|fee/iu;

/**
 * The fares a poster prints: the linked trip's fares plus every money cell of a price-table column
 * whose header reads as an adult/child fare (not infant, single supplement, fee).
 */
export function posterFareMap(data: unknown, tripFares: FareMap | null, discount: number): FareMap {
  const map: FareMap = new Map(tripFares ?? []);
  if (!(discount > 0) || !isRecord(data)) return map;
  const table = isRecord(data.price_table) ? data.price_table : null;
  const columns = Array.isArray(table?.columns) ? table.columns.map((column) => String(column ?? "")) : [];
  for (const row of records(table?.rows)) {
    const cells = Array.isArray(row.cells) ? row.cells : [];
    cells.forEach((cell, index) => {
      const header = columns[index] || "";
      if (!ADULT_OR_CHILD_HEADER.test(header) || NOT_A_FARE_HEADER.test(header)) return;
      const digits = String(cell ?? "").replace(/[^\d]/g, "");
      const amount = fareNumber(digits ? Number(digits) : null);
      if (amount != null && !map.has(amount)) map.set(amount, discountedFare(amount, discount));
    });
  }
  return map;
}

/** Poster data as this brand prints it: mapped fares in every text, the operator line in its name. */
export function applyBrandFaresToPoster(
  data: unknown,
  fares: FareMap,
  brandTextFn: (text: string) => string = (text) => text,
): unknown {
  const fareText = makeFareTextReplacer(fares);
  return transformFareValue(data, fares, (value) => brandTextFn(fareText(value)));
}
