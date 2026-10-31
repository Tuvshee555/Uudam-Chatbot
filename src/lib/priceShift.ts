/**
 * Moving every passenger fare by one fixed amount (scripts/shift-trip-prices.ts): the trip's own
 * fares and its poster, edited in place so the poster keeps its columns, age bands, dates and
 * "Үнэгүй" cells (rebuilding the poster from the trip dropped all three). A fare of 0, "Үнэгүй",
 * "-" or "Үнэ лавлах" stays; single-room supplements, extra fees and exclusions are not passenger
 * fares and never move.
 */
type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const rows = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);

/** Smaller numbers in a fare cell are ages, heights or days, not money. */
const MIN_FARE = 10_000;
const NOT_A_FARE_COLUMN = /ганц|single|хугацаа|өдөр|шөнө/i;
// "1,390,000", "1.390.000", "1390000"; a range is two amounts.
const AMOUNT = /\d{1,3}(?:([,.])\d{3})+(?!\d)|\d{5,}/g;
// A fare amount in free text sits right after its label: "Том хүн: 1,390,000₮", "Хүүхдийн үнэ 580,000₮–3,580,000₮".
const LABELLED_FARES = /((?:том\s+хүн(?:ий\s+үнэ)?|хүүхд?(?:эд|ийн\s+үнэ)\S*|нярай\S*)\s*[:—-]?\s*)(\d[\d,. ]*\d₮?(?:\s*[–-]\s*\d[\d,. ]*\d₮?)?)/giu;

function formatLike(original: string, separator: string | undefined, value: number): string {
  const digits = String(value);
  return separator ? digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator) : digits.padStart(original.length, "0");
}

/** Every amount of a fare in the text moves by `amount`; the text's own number style is kept. */
export function shiftAmountsInText(text: string, amount: number): string {
  return text.replace(AMOUNT, (match, separator: string | undefined) => {
    const value = Number(match.replace(/[,.]/g, ""));
    if (!Number.isSafeInteger(value) || value < MIN_FARE) return match;
    if (value + amount <= 0) throw new Error(`a fare of ${value} would drop to ${value + amount}`);
    return formatLike(match, separator, value + amount);
  });
}

/** Only the amounts written after a fare label move; "ганцаараа ... 490,000₮" in the same note stays. */
export function shiftLabelledFares(text: string, amount: number): string {
  return text.replace(LABELLED_FARES, (_match, label: string, amounts: string) => `${label}${shiftAmountsInText(amounts, amount)}`);
}

/** A positive fare moves; 0, null and text stay. */
export function shiftFare(value: unknown, amount: number): unknown {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return value;
  if (value + amount <= 0) throw new Error(`a fare of ${value} would drop to ${value + amount}`);
  return value + amount;
}

const shiftKeys = (row: Row, keys: string[], amount: number) => {
  const next = { ...row };
  for (const key of keys) if (key in next) next[key] = shiftFare(next[key], amount);
  return next;
};

/** The trip fields patchTrip needs: base fares, per-date rows, age-band fares, child fare rules. */
export function shiftTripFares(trip: Row, amount: number): Row {
  const extra = record(trip.extra);
  const fields: Row = {
    adult_price: shiftFare(trip.adult_price, amount),
    child_price: shiftFare(trip.child_price, amount),
    infant_price: shiftFare(trip.infant_price, amount),
  };
  const extraPatch: Row = {};
  if (Array.isArray(extra.price_groups)) {
    extraPatch.price_groups = rows(extra.price_groups).map((group) => ({
      ...shiftKeys(group, ["adult_price", "child_price", "infant_price"], amount),
      ...(Array.isArray(group.passenger_prices)
        ? { passenger_prices: rows(group.passenger_prices).map((fare) => shiftKeys(fare, ["price"], amount)) } : {}),
    }));
  }
  for (const key of ["child_rules", "infant_prices"]) {
    if (Array.isArray(extra[key])) extraPatch[key] = rows(extra[key]).map((fare) => shiftKeys(fare, ["price"], amount));
  }
  if (Object.keys(extraPatch).length) fields.extra = extraPatch;
  return fields;
}

/** The poster with its fare cells and labelled fares moved, everything else untouched. */
export function shiftPosterFares(data: unknown, amount: number): Row {
  const poster = { ...record(data) };
  const table = record(poster.price_table);
  if (Array.isArray(table.rows)) {
    const columns = Array.isArray(table.columns) ? table.columns.map(String) : [];
    poster.price_table = {
      ...table,
      rows: rows(table.rows).map((row) => ({
        ...row,
        ...(Array.isArray(row.cells) ? {
          cells: row.cells.map((cell, index) => typeof cell === "string" && !NOT_A_FARE_COLUMN.test(columns[index] || "")
            ? shiftAmountsInText(cell, amount) : cell),
        } : {}),
      })),
    };
  }
  for (const key of ["price_note", "price_desc"]) {
    if (typeof poster[key] === "string") poster[key] = shiftLabelledFares(poster[key] as string, amount);
  }
  return poster;
}
