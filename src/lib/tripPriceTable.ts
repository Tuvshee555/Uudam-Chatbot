/**
 * The departure and price table of a trip, read from its picture row by row.
 *
 * The big file-reading prompt groups a table's rows under the picture's own month
 * headings and gives them the first row's prices: on a real table (2026-11-05) a
 * departure 100,000₮ cheaper than its neighbours was saved at their price, twice
 * in a row, and one of two child columns was lost. A rule in that prompt did not
 * change it. So the table is read on its own, with one small question — "what
 * does each row say?" — and the trip's dates and per-date fares are built from
 * the rows in code.
 */
import { askOpenAIChatParts } from "./openaiFallback";
import { logWarn } from "./observability";
import { MIN_TRIP_PRICE_MNT, PARTNER_PRICE } from "./tripPriceRules";

type Row = Record<string, unknown>;
type Ask = typeof askOpenAIChatParts;
export type PriceTableRow = { departure: string; prices: Array<{ column: string; currency: string; amount: number }> };
export type PriceTable = { year: number | null; rows: PriceTableRow[] };

const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

const PROMPT = [
  "This image is a tour operator's departure schedule and price table. Read it row by row, cell by cell.",
  "Return JSON only: {\"year\": 2027 or null, \"rows\": [{\"departure\": \"MM/DD\", \"prices\": [{\"column\": \"<heading>\", \"currency\": \"MNT\" or \"CNY\" or another code, \"amount\": 3590000}]}, {\"departure\": \"MM/DD\", \"amounts\": [3490000, 5680]}]}",
  "- The FIRST row lists every price cell of that row, left to right, as prices. column is the heading cell above it in full, every line of it joined with spaces — who the price is for and every qualifier (height, age, with or without a bed or ticket). Two cells never get the same heading. төг / ₮ / төгрөг is MNT, юань / ¥ is CNY.",
  "- Every LATER row has amounts only: the numbers of its price cells left to right, exactly as many as the first row has prices, in the same order.",
  "- One entry per table row, in the table's order, across every section of the table; a row that spans a range (01/14-01/19) departs on its first date.",
  "- Copy each number from its own row and its own cell. Never repeat the row above. Check every row again before answering.",
  "- year is the year written in the picture's title or dates; null when none is written.",
  "- If the picture has no such table, return {\"year\": null, \"rows\": []}.",
].join("\n");

/** Reads one picture. Null when it holds no table or the reading failed. */
export async function readPriceTable(inline: { mimeType: string; data: string }, options: { ask?: Ask; trace?: { requestId?: string; correlationId?: string } } = {}): Promise<PriceTable | null> {
  const ask = options.ask || askOpenAIChatParts;
  try {
    const result = await ask([{ text: PROMPT }, { inlineData: inline }], { model: "gpt-4o", jsonMode: true, temperature: 0, maxOutputTokens: 3000, timeoutMs: 45_000,
      imageDetail: "high", source: "trip_price_table.read", requestId: options.trace?.requestId, correlationId: options.trace?.correlationId });
    return parsePriceTable(JSON.parse(result?.text || "{}"));
  } catch (error) {
    logWarn("trip_price_table.read_failed", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** The model's answer as rows that are safe to use: real dates, positive amounts. */
export function parsePriceTable(raw: unknown): PriceTable | null {
  const body = record(raw);
  const year = Number.isInteger(body.year) && Number(body.year) >= 2000 && Number(body.year) <= 2199 ? Number(body.year) : null;
  const rows: PriceTableRow[] = [];
  // The headings are read once, on the first row; a later row is its numbers in the same order.
  let columns: Row[] = (Array.isArray(body.columns) ? body.columns : []).map(record);
  for (const entry of Array.isArray(body.rows) ? body.rows : []) {
    const row = record(entry);
    const date = /^(\d{1,2})\s*[/.\-]\s*(\d{1,2})/.exec(text(row.departure).replace(/^20\d{2}\s*[/.\-]\s*/, ""));
    if (!date) continue;
    const month = Number(date[1]), day = Number(date[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (Array.isArray(row.prices) && !columns.length) columns = row.prices.map(record).map((price) => ({ heading: price.column, currency: price.currency }));
    // A row of bare numbers that does not line up with the headings cannot be trusted: the whole reading is dropped.
    if (!Array.isArray(row.prices) && Array.isArray(row.amounts) && row.amounts.length !== columns.length) return null;
    const cells = Array.isArray(row.prices) ? row.prices.map(record)
      : (Array.isArray(row.amounts) ? row.amounts : []).map((amount, index) => ({ column: text(columns[index]?.heading), currency: columns[index]?.currency, amount }));
    const prices = cells
      .map((price) => ({ column: text(price.column), currency: text(price.currency).toUpperCase() || "MNT", amount: Number(price.amount) }))
      .filter((price) => Number.isFinite(price.amount) && price.amount > 0);
    if (prices.length) rows.push({ departure: `${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`, prices });
  }
  return rows.length ? { year, rows } : null;
}

const SELLING_WORDS = /зарлах|зарах|борлуулах|үнэ|price/gi;
const isAdult = (column: string) => /том\s*хүн|adult|насанд/i.test(column);
const isChild = (column: string) => /хүүхэд|child|бага\s*нас/i.test(column);
const isInfant = (column: string) => /нярай|infant/i.test(column);
/**
 * A child column named by what can be measured: "Зарлах үнэ хүүхэд буудалд оргүй 1,2 м-1,4м өндөр" →
 * "Хүүхэд 1,2 м-1,4м өндөр". The long wording of a heading is easy to misread from a picture;
 * the height or age is what tells two child fares apart.
 */
function bandLabel(column: string): string {
  const unit = "(?:м|см|нас|сар)";
  const measure = new RegExp(`\\d[\\d.,]*\\s*${unit}?\\s*[-–]\\s*\\d[\\d.,]*\\s*${unit}.*$|\\d[\\d.,]*\\s*${unit}.*$`, "i").exec(column)?.[0].replace(/\s+/g, " ").trim();
  if (measure) return `Хүүхэд ${measure}`;
  const rest = column.replace(SELLING_WORDS, " ").replace(/хүүхэд/i, " ").replace(/\s+/g, " ").trim();
  return rest ? `Хүүхэд, ${rest}` : "Хүүхэд";
}

/** A label that names its column even when the reading gave two columns the same heading. */
function distinctLabel(labels: string[], index: number): string {
  return labels.filter((label) => label === labels[index]).length > 1 ? `${labels[index]} (${index + 1}-р багана)` : labels[index];
}

/**
 * The table as the trip's departures and per-date fares: tugrug selling prices only
 * (a yuan or land-price column is the partner's cost), one fare row per departure.
 * Null when no row has a tugrug adult price.
 */
export function priceTableFares(table: PriceTable): { departure_dates: string[]; price_groups: Row[]; adult_price: number; child_price: number | null } | null {
  const groups: Row[] = [];
  for (const row of table.rows) {
    const selling = row.prices.filter((price) => price.currency === "MNT" && price.amount >= MIN_TRIP_PRICE_MNT && !PARTNER_PRICE.test(price.column));
    const adult = selling.find((price) => isAdult(price.column)) ?? selling.find((price) => !isChild(price.column) && !isInfant(price.column));
    if (!adult) continue;
    const children = selling.filter((price) => isChild(price.column));
    const infant = selling.find((price) => isInfant(price.column));
    const date = table.year ? `${table.year}-${row.departure.replace("/", "-")}` : `${Number(row.departure.slice(0, 2))} сарын ${Number(row.departure.slice(3))}`;
    groups.push({
      label: "",
      dates: [date],
      adult_price: adult.amount,
      child_price: children[0]?.amount ?? null,
      infant_price: infant?.amount ?? null,
      // Two child columns (by height, with or without a bed) are two fares: both are kept, named as the table names them.
      ...(children.length > 1 ? { passenger_prices: children.map((price, index) => ({ label: distinctLabel(children.map((child) => bandLabel(child.column)), index), price: price.amount, currency: "MNT" })) } : {}),
    });
  }
  if (!groups.length) return null;
  const cheapest = [...groups].sort((a, b) => (a.adult_price as number) - (b.adult_price as number))[0];
  return {
    departure_dates: Array.from(new Set(groups.map((group) => (group.dates as string[])[0]))),
    price_groups: groups,
    adult_price: cheapest.adult_price as number,
    child_price: (cheapest.child_price as number | null) ?? null,
  };
}

/**
 * Puts the table's departures and fares onto the trip's fields, replacing what the
 * general reading guessed for them. True when the trip was changed.
 */
export function applyPriceTable(fields: Row, table: PriceTable): boolean {
  const fares = priceTableFares(table);
  if (!fares) return false;
  const extra = { ...record(fields.extra) };
  extra.price_groups = fares.price_groups;
  extra.departure_date_groups = [];
  fields.extra = extra;
  fields.departure_dates = fares.departure_dates;
  fields.adult_price = fares.adult_price;
  fields.child_price = fares.child_price;
  fields.currency = "MNT";
  return true;
}
