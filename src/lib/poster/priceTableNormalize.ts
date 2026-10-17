/**
 * A poster's price table: the row's date goes in `dates`, every column is a fare (or a hotel /
 * room label). Source documents often print the date as its own columns ("Гарах сар | Өдөр |
 * Том хүн | Хүүхэд"); the extractor copied them as price columns, so the poster showed
 * "2026 он 10 сар" and "26" as if they were fares, each with a "make free" button. This folds
 * any date-shaped column back into the row's date and drops it. Pure: used on extraction, on
 * save, and when a stored poster is opened.
 */

export type PriceTableRow = { dates?: string; cells?: string[]; [key: string]: unknown };
export type PriceTable = { columns?: string[]; rows?: PriceTableRow[]; note?: string; [key: string]: unknown };

/** A header that names the departure (date, month, day, year) and nothing a fare is for. */
const DATE_HEADER = /огноо|гарах|сар|өдөр|(?:^|[^\p{L}])он(?:$|[^\p{L}])|date|month|day|year/iu;
const FARE_HEADER = /том|хүүх|нярай|насанд|нас|adult|child|infant|kid|үнэ|price|fare|буудал|hotel|өрөө|room|ганц|single|багц|package/iu;
/** A cell that holds money: a currency mark, or an amount too big to be a day, month or year. */
const MONEY = /₮|төг|юань|yuan|cny|¥|\$|usd|eur|€|₩|won|бат|baht|үнэгүй|free/iu;

function isMoneyCell(cell: string): boolean {
  if (MONEY.test(cell)) return true;
  return (cell.match(/\d[\d.,\s]*/g) || []).some((part) => Number(part.replace(/[^\d]/g, "")) >= 10_000);
}

function isDateColumn(table: PriceTable, index: number): boolean {
  const header = String(table.columns?.[index] || "");
  if (!DATE_HEADER.test(header) || FARE_HEADER.test(header)) return false;
  return (table.rows || []).every((row) => !isMoneyCell(String(row.cells?.[index] || "")));
}

/** Folds date-shaped columns into each row's `dates` and removes them. Returns the same object when nothing changes. */
export function normalizePriceTable<T extends PriceTable | null | undefined>(table: T): T {
  if (!table || !Array.isArray(table.columns) || !Array.isArray(table.rows)) return table;
  const dateColumns = table.columns.map((_, index) => index).filter((index) => isDateColumn(table, index));
  if (!dateColumns.length || dateColumns.length >= table.columns.length) return table;
  const keep = (index: number) => !dateColumns.includes(index);
  const rows = table.rows.map((row) => {
    const cells = Array.isArray(row.cells) ? row.cells : [];
    const pieces = dateColumns.map((index) => String(cells[index] || "").trim()).filter(Boolean);
    const dates = String(row.dates || "").trim();
    // The row date already says it ("2026 он 10 сар 26") — keep it; otherwise build it from the pieces.
    const missing = pieces.filter((piece) => !dates.includes(piece));
    return {
      ...row,
      dates: !dates ? pieces.join(" ") : missing.length ? [dates, ...missing].join(" ") : dates,
      cells: cells.filter((_, index) => keep(index)),
    };
  });
  return { ...table, columns: table.columns.filter((_, index) => keep(index)), rows } as T;
}

/** The same fix applied to a whole poster's data object (`price_table` lives on it). */
export function normalizePosterPriceTable<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  const table = record.price_table as PriceTable | null | undefined;
  const fixed = normalizePriceTable(table);
  return fixed === table ? data : ({ ...record, price_table: fixed } as T);
}
