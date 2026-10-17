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
export function normalizePriceTable<T extends PriceTable | null | undefined>(input: T): T {
  if (!input || !Array.isArray(input.columns) || !Array.isArray(input.rows)) return input;
  const table = input as PriceTable & { columns: string[]; rows: PriceTableRow[] };
  const dateColumns = table.columns.map((_, index) => index).filter((index) => isDateColumn(table, index));
  // Date columns first: the currency check below reads price cells only.
  if (!dateColumns.length || dateColumns.length >= table.columns.length) return dropYuan(mergeStackedCurrencyRows(table)) as T;
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
  return dropYuan(mergeStackedCurrencyRows({ ...table, columns: table.columns.filter((_, index) => keep(index)), rows })) as T;
}

const YUAN = /юань|yuan|cny|rmb|元|人民币|¥/iu;
const TUGRIK_AMOUNT = /\d[\d.,\s]*\d\s*(?:₮|төг\p{L}*)|\d\s*(?:₮|төг\p{L}*)/giu;

/** A cell without its юань amounts: "3780юань / 2337000₮" → "2337000₮", "3780юань" → "" (no price). */
function withoutYuan(cell: string): string {
  if (!YUAN.test(cell)) return cell;
  return (cell.match(TUGRIK_AMOUNT) || []).map((amount) => amount.trim()).join(" / ");
}

/**
 * Owner's rule: юань is the partner's land price, never the customer's. A yuan amount is not a
 * fare — it is removed, and a cell that held only yuan is left empty (the trip shows "price on
 * request" until staff enter the ₮ price). A column that held only yuan is removed when another
 * column still has fares. Runs after the юань-over-₮ merge so a merged ₮ price reaches both dates.
 */
function dropYuan(table: PriceTable): PriceTable {
  const rows = table.rows || [];
  if (!rows.some((row) => (row.cells || []).some((cell) => YUAN.test(String(cell))))) return table;
  const cleaned = rows.map((row) => ({ ...row, cells: (row.cells || []).map((cell) => withoutYuan(String(cell ?? ""))) }));
  const columns = table.columns || [];
  const emptied = columns.map((_, index) => cleaned.every((row) => !String(row.cells[index] || "").trim())
    && rows.some((row) => YUAN.test(String(row.cells?.[index] ?? ""))));
  const dropAny = emptied.some(Boolean) && emptied.some((gone) => !gone);
  const keep = (index: number) => !dropAny || !emptied[index];
  return {
    ...table,
    columns: dropAny ? columns.filter((_, index) => keep(index)) : columns,
    rows: cleaned.map((row) => ({ ...row, cells: dropAny ? row.cells.filter((_, index) => keep(index)) : row.cells })),
  };
}

/** Amount and currency of a cell that holds exactly one price ("3780юань", "2,337,000₮"). */
function singleAmount(cell: string): { amount: number; currency: "CNY" | "MNT" } | null {
  const text = cell.trim();
  if (!text || text.includes("/")) return null;
  const currency = /юань|yuan|cny|¥/iu.test(text) ? "CNY" : /₮|төг/iu.test(text) ? "MNT" : null;
  const digits = text.replace(/[^\d]/g, "");
  return currency && digits ? { amount: Number(digits), currency } : null;
}

/**
 * A price cell merged DOWN across two date rows, showing the partner's land price in юань above
 * the selling price in ₮ ("Лант үнэ (юань) / Монголд зарах үнэ (₮)"), came out of extraction as
 * row 1 = юань, row 2 = ₮ — so the first departure was priced in yuan and the second in tugrik.
 * Two neighbouring rows where every cell of the first is юань, every cell of the second is ₮, and
 * each ₮/юань pair sits at a yuan exchange rate are one price in two currencies: both rows get
 * "X юань / Y₮". The model was told this and still split it, so the rule lives in code.
 */
function mergeStackedCurrencyRows(table: PriceTable): PriceTable {
  const rows = table.rows || [];
  let changed = false;
  const out = rows.map((row) => ({ ...row, cells: [...(row.cells || [])] }));
  for (let i = 0; i + 1 < out.length; i++) {
    const top = out[i].cells.map((cell) => singleAmount(String(cell)));
    const bottom = out[i + 1].cells.map((cell) => singleAmount(String(cell)));
    if (!top.length || top.length !== bottom.length) continue;
    const paired = top.every((a, index) => {
      const b = bottom[index];
      if (!a || !b || a.currency !== "CNY" || b.currency !== "MNT" || !a.amount) return false;
      const rate = b.amount / a.amount;
      return rate >= 300 && rate <= 900;
    });
    if (!paired) continue;
    const merged = out[i].cells.map((cell, index) => `${String(cell).trim()} / ${String(out[i + 1].cells[index]).trim()}`);
    out[i].cells = merged;
    out[i + 1].cells = [...merged];
    changed = true;
    i++;
  }
  return changed ? { ...table, rows: out } : table;
}

/** The same fix applied to a whole poster's data object (`price_table` lives on it). */
export function normalizePosterPriceTable<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  const table = record.price_table as PriceTable | null | undefined;
  const fixed = normalizePriceTable(table);
  return fixed === table ? data : ({ ...record, price_table: fixed } as T);
}
