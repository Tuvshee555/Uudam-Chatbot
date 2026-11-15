/**
 * Infant fares of a new trip read from a partner's schedule, put right in code.
 *
 * Why (2026-11-11, a real partner page): the table had «Хүүхэд ортой» and «Хүүхэд оргүй (12 – 2
 * нас)» columns and the line «Нярай үнэгүй». The reader kept both child columns as bands but also
 * copied the "without a bed" child amount into every row's infant_price, and never wrote the free
 * infant. The bot would have quoted a 4,290,000₮ infant.
 *
 * Rules: a row's infant_price that is only another band's amount (no infant band exists) is
 * dropped; when the source says infants travel free, every row and the trip get a free infant;
 * an age band written backwards ("12 – 2 нас") reads forwards. Pure.
 */
import { isInfantShapedAge } from "./travelFastPathsSearch";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((entry) => text(entry)).filter(Boolean) : [text(value)].filter(Boolean));

const INFANT_FREE = /нярай[^.\n]{0,30}?үнэгүй|үнэгүй[^.\n]{0,15}?нярай|infants?\s+(?:travel\s+|go\s+)?free/i;

/** "12 – 2 нас" → "2-12 нас"; anything else as it is. */
export function forwardAgeRange(value: string): string {
  const match = /^(\d{1,2})\s*[-–—]\s*(\d{1,2})(\s*(?:нас|сар))$/i.exec(value.trim());
  if (!match || Number(match[1]) <= Number(match[2])) return value;
  return `${Number(match[2])}-${Number(match[1])}${match[3].replace(/^\s*/, " ")}`;
}

/**
 * A numbered hotel list ("1 LARACINE ****, 2. Vinholidays Fiesta ****") is the source offering one or the
 * other: written the house way, "LARACINE **** эсвэл Vinholidays Fiesta ****" (the hotel split rule both
 * repos share). A single numbered hotel loses its number. Anything else is left as written.
 */
export function cleanHotelList(value: string): string {
  const numbered = /(^|,|\n)\s*\d{1,2}\s*[.)]?\s+\S/;
  if (!numbered.test(value)) return value;
  const parts = value.split(/\s*(?:,|\n)\s*/).map((part) => part.replace(/^\s*\d{1,2}\s*[.)]?\s+/, "").trim()).filter(Boolean);
  return parts.join(" эсвэл ");
}

/**
 * A new trip's title without its length in brackets ("… аялал (8 өдөр) МИАТ чартер нислэг" → "… аялал МИАТ
 * чартер нислэг"): the length is the trip's own field and is shown beside the title on the site and in
 * the bot; written twice it went stale when the program changed. The admin removed it by hand until 2026-11-12.
 */
export function cleanTripTitle(fields: Row): Row {
  const title = text(fields.route_name);
  const clean = title.replace(/\s*\(\s*\d+\s*(?:өдөр|хоног)(?:\s*[/,]?\s*\d+\s*шөнө)?\s*\)\s*/giu, " ").replace(/\s{2,}/g, " ").trim();
  return clean && clean !== title ? { ...fields, route_name: clean } : fields;
}

const FREE_NOTE = "Үнэгүй";
const unsetZero = (value: unknown) => (value === 0 ? null : value);

/**
 * A 0₮ the reader wrote for a fare the source does not give is "not set", not free (2026-11-14: a
 * Chongqing file had prices for one date only; the other rows came back adult 0₮, the assistant read
 * them as free and would not price them). An adult fare is never free; a child band is free only when
 * marked «Үнэгүй». Infant fares are left alone (0 there is usually free). Pure.
 */
export function unsetZeroFares(fields: Row): Row {
  const extra = record(fields.extra);
  let changed = false;
  const rows = (key: string) => records(extra[key]).map((row) => {
    const bands = records(row.passenger_prices).map((band) => {
      if (band.price !== 0 || text(band.note) === FREE_NOTE || /нярай|infant/i.test(text(band.label))) return band;
      changed = true;
      return { ...band, price: null };
    });
    if (row.adult_price === 0) changed = true;
    return { ...row, adult_price: unsetZero(row.adult_price), ...(Array.isArray(row.passenger_prices) ? { passenger_prices: bands } : {}) };
  });
  const priceGroups = rows("price_groups");
  const dateGroups = rows("departure_date_groups");
  if (!changed && fields.adult_price !== 0) return fields;
  return {
    ...fields,
    adult_price: unsetZero(fields.adult_price),
    extra: {
      ...extra,
      ...(Array.isArray(extra.price_groups) ? { price_groups: priceGroups } : {}),
      ...(Array.isArray(extra.departure_date_groups) ? { departure_date_groups: dateGroups } : {}),
    },
  };
}

/** Every row's hotel and the trip's hotel line cleaned (cleanHotelList). */
export function cleanRowHotels(fields: Row): Row {
  const extra = record(fields.extra);
  const key = records(extra.price_groups).length ? "price_groups" : "departure_date_groups";
  let changed = false;
  const rows = records(extra[key]).map((row) => {
    const hotel = text(row.hotel);
    const clean = hotel ? cleanHotelList(hotel) : hotel;
    if (clean === hotel) return row;
    changed = true;
    return { ...row, hotel: clean };
  });
  const tripHotel = typeof fields.hotel === "string" ? cleanHotelList(fields.hotel) : fields.hotel;
  if (!changed && tripHotel === fields.hotel) return fields;
  return { ...fields, hotel: tripHotel, extra: { ...extra, ...(changed ? { [key]: rows } : {}) } };
}

/** The source says infants travel free (notes, important notes, included items). */
export function saysInfantsFree(fields: Row): boolean {
  const extra = record(fields.extra);
  return [...strings(fields.notes), ...strings(extra.important_notes), ...strings(extra.included_items)].some((line) => INFANT_FREE.test(line));
}

export function settleRowInfantFares(fields: Row): Row {
  const extra = record(fields.extra);
  const key = records(extra.price_groups).length ? "price_groups" : "departure_date_groups";
  const groups = records(extra[key]);
  const free = saysInfantsFree(fields);
  const infantAge = text(record(extra.age_rules).infant);
  let changed = false;
  const rows = groups.map((group) => {
    let bands = records(group.passenger_prices).map((band) => {
      const age = forwardAgeRange(text(band.age_range));
      if (age !== text(band.age_range)) changed = true;
      return age !== text(band.age_range) ? { ...band, age_range: age } : band;
    });
    const next: Row = { ...group };
    const infantBand = bands.find((band) => isInfantShapedAge(text(band.label).toLowerCase(), text(band.age_range)));
    if (!infantBand && typeof next.infant_price === "number" && next.infant_price > 0
      && bands.some((band) => band.price === next.infant_price)) {
      next.infant_price = null;
      changed = true;
    }
    if (free && !infantBand) {
      bands = [...bands, { label: "Нярай", age_range: infantAge, price: 0, currency: "MNT", note: "Үнэгүй" }];
      next.infant_price = 0;
      changed = true;
    } else if (!infantBand && bands.length && typeof next.infant_price === "number" && next.infant_price >= 0) {
      // An infant fare kept only on the row («Нярай: 700.000») becomes a band like the others: the review's
      // table, the poster and the fare card all read the bands (it was invisible in the review, 2026-11-12).
      const price = next.infant_price;
      bands = [...bands, { label: "Нярай", age_range: infantAge, price, currency: "MNT", ...(price === 0 ? { note: "Үнэгүй" } : {}) }];
      changed = true;
    }
    if (bands.length) next.passenger_prices = bands;
    return next;
  });
  const tripInfant = free && (fields.infant_price === null || fields.infant_price === undefined) ? { infant_price: 0 } : {};
  // The trip's own age bands, the same way round ("12 – 2 нас" → "2-12 нас").
  const ages = record(extra.age_rules);
  const forwardAges = Object.fromEntries(Object.entries(ages).map(([key, value]) => [key, typeof value === "string" ? forwardAgeRange(value) : value]));
  const agesChanged = JSON.stringify(forwardAges) !== JSON.stringify(ages);
  if (!changed && !agesChanged && !Object.keys(tripInfant).length) return fields;
  return { ...fields, ...tripInfant, extra: { ...extra, ...(groups.length ? { [key]: rows } : {}), ...(agesChanged ? { age_rules: forwardAges } : {}) } };
}
