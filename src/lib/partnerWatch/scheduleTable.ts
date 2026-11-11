/**
 * A partner page's departure schedule, read from the page text in code (no model).
 *
 * Partner pages put the schedule in an HTML table; readWebPage renders each row as
 * `cell | cell | cell |`, a cell's line breaks as new lines, and a blank line between rows.
 * htmlToText also folds an EMPTY cell into its neighbour's separator, so a row can have fewer
 * cells than its header: the cells are then placed by what they hold (a date, an amount, a
 * status) and a row that could sit two ways is skipped, never guessed.
 *
 * A schedule table is a header row with a departure-date column and at least one price
 * column. Shapes handled (all seen on partner pages):
 *  - a status column («бүртгэж байна», «4 суудал үлдсэн», «дүүрсэн.») or none;
 *  - a code / label column before the status («Т-1», «1. Нэг талдаа дамжих нислэг»);
 *  - a note paragraph between rows (the table goes on after it);
 *  - wrapped cells (a hotel cell on two lines, a row whose first cell ends its line);
 *  - amounts written 4,490,000 / 4.490.000 / 4 490 000, with or without «төг» / «₮»;
 *  - hotels as column groups («Том хүн <Буудал A> | Хүүхэд <Буудал A> | Том хүн <Буудал B> | …»):
 *    one row per hotel group.
 * Anything else comes back as { ok: false, reason } in plain Mongolian.
 *
 * Pure.
 */

export type SeatStatus = "open" | "low" | "full";
export type SchedulePrice = { column: string; amount: number };
export type ScheduleRow = {
  /** "M/D" as the page writes it, or YYYY-MM-DD when the page states the year. */
  date: string;
  year?: number;
  status: SeatStatus | null;
  seats: number | null;
  /** The row's label («Шинэ жил») and a status cell that is not a status («Цагаан сар»). */
  note: string;
  prices: SchedulePrice[];
  /** The row's hotel cell, or the hotel of its column group. */
  hotel?: string;
};
export type ScheduleParse =
  /** `unread`: the first date of each row that could not be placed — still on the page, its facts unknown. */
  | { ok: true; rows: ScheduleRow[]; tables: number; skipped: number; unread: string[] }
  | { ok: false; reason: string };

type ColumnKind = "label" | "status" | "date" | "return" | "price" | "hotel" | "other";
type Column = { kind: ColumnKind; header: string; lines: string[] };

const PASSENGER = /том\s*хүн|насанд\s*хүрэгч|хүүхэд|нярай|ганцаар|adult|child|infant|single/iu;
const PRICE_HEADER = new RegExp(`${PASSENGER.source}|үнэ|price`, "iu");
const RETURN_HEADER = /ирэх|буцах|дуусах|return|arriv/iu;
const DATE_HEADER = /гарах|явах|эхлэх|аяллын\s+өдр|аялах\s+өдр|аяллын\s+огноо|огноо|хуваарь|departure|date/iu;
const STATUS_HEADER = /бүртгэл|төлөв|суудал|байдал|status|seats?/iu;
const LABEL_HEADER = /^(?:№|#|no\.?|д\/д|код)$|дугаар/iu;
const HOTEL_HEADER = /буудал|буудл|зочид|hotel|resort/iu;
const ADULT = /том\s*хүн|насанд\s*хүрэгч|adult/iu;

const MAX_NOTE_BLOCKS = 3;
const MAX_MISSING_CELLS = 3;

const squash = (value: string) => value.replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").trim();
const oneLine = (value: string) => squash(value).replace(/\n+/g, " ");
const hasLetters = (value: string) => /\p{L}/u.test(value);

/* ---------------------------------------------------------------- */
/* Cell readers                                                     */
/* ---------------------------------------------------------------- */

const AMOUNT = /(?<![\d.,])(\d{1,3}(?:[.,\s]\d{3})+|\d{4,9})(?![\d])/u;
const CURRENCY_WORDS = /төгрөгөөр|төгрөг|төг\.?|₮|mnt|tugrik|tug/giu;

/** "4,490,000 төг", "4.490.000", "4 490 000", "700,000₮" → 4490000; "Үнэгүй" → 0; anything else → null. */
export function amountOf(cell: string): number | null {
  const text = oneLine(cell);
  if (/^үнэгүй\.?$/iu.test(text)) return 0;
  const match = AMOUNT.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(/[^\d]/g, ""));
  if (!Number.isSafeInteger(value) || value < 1_000) return null;
  // The cell is the amount (and its currency): «4,490,000 төг», not «2 хүн 4,490,000» or a date.
  const rest = text.replace(match[0], " ").replace(CURRENCY_WORDS, " ").trim();
  return /^[\s.,\-–—/()]*$/u.test(rest) ? value : null;
}

/** A status cell: «бүртгэж байна», «Бүртгэж байна.», «4 суудал үлдсэн», «цөөн суудал», «дүүрсэн», «дууссан», «суудал дууссан». */
export function statusOf(cell: string): { status: SeatStatus; seats: number | null } | null {
  const text = oneLine(cell).toLowerCase().replace(/[.!]+$/u, "").trim();
  if (!text) return null;
  const counted = /(\d+)\s*(?:хүний\s+)?(?:суудал|сул\s+суудал|хүн)\s*(?:үлдсэн|үлдлээ|үлдэв|байна)/u.exec(text);
  if (counted) {
    const seats = Number(counted[1]);
    return seats === 0 ? { status: "full", seats: null } : { status: "low", seats };
  }
  if (/дүүрсэн|дүүрэн|дууссан|хаагдсан|sold\s*out|(?<!\p{L})full(?!\p{L})/u.test(text)) return { status: "full", seats: null };
  if (/цөөн\s+суудал|few\s+seats/u.test(text)) return { status: "low", seats: null };
  if (/бүртгэж\s+байна|бүртгэл\s+нээлттэй|нээлттэй|бүртгэлтэй|(?<!\p{L})open(?!\p{L})/u.test(text)) return { status: "open", seats: null };
  return null;
}

type PageDate = { date: string; year?: number };

const validDay = (month: number, day: number) => month >= 1 && month <= 12 && day >= 1 && day <= 31;
const pad = (value: number) => String(value).padStart(2, "0");

/** Every departure date in a cell: «12 сарын 05», «01 сарын 01», «12 сарын 2 5», «12-р сарын 5», «12/05», «2026-12-05», «2026 оны 12 сарын 5». */
export function datesOf(cell: string): PageDate[] {
  const text = oneLine(cell);
  const found: Array<{ index: number; value: PageDate }> = [];
  const taken: Array<[number, number]> = [];
  const free = (start: number, end: number) => !taken.some(([a, b]) => start < b && end > a);
  const add = (match: RegExpExecArray, value: PageDate | null) => {
    if (!value || !free(match.index, match.index + match[0].length)) return;
    taken.push([match.index, match.index + match[0].length]);
    found.push({ index: match.index, value });
  };
  for (const match of text.matchAll(/(\d{4})\s*оны\s*(\d{1,2})\s*(?:-?\s*р\s*)?сар\p{L}*\s*(\d{1,2})(?!\d)/gu)) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    add(match, validDay(month, day) ? { date: `${year}-${pad(month)}-${pad(day)}`, year } : null);
  }
  for (const match of text.matchAll(/(?<!\d)(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?!\d)/gu)) {
    const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
    add(match, validDay(month, day) ? { date: `${year}-${pad(month)}-${pad(day)}`, year } : null);
  }
  // «12 сарын 2 5»: a day typed with a space between its digits.
  for (const match of text.matchAll(/(?<!\d)(\d{1,2})\s*(?:-?\s*р\s*)?сар\p{L}*\s*(\d\s\d(?!\d)|\d{1,2}(?!\d))/gu)) {
    const [month, day] = [Number(match[1]), Number(match[2].replace(/\s/g, ""))];
    add(match, validDay(month, day) ? { date: `${month}/${day}` } : null);
  }
  for (const match of text.matchAll(/(?<![\d./])(\d{1,2})[/.](\d{1,2})(?![\d./])/gu)) {
    const [month, day] = [Number(match[1]), Number(match[2])];
    add(match, validDay(month, day) ? { date: `${month}/${day}` } : null);
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.value);
}

/** True when the cell is a date and nothing much else (a weekday or «-нд» may follow). */
function isDateCell(cell: string): boolean {
  const dates = datesOf(cell);
  if (!dates.length) return false;
  const rest = oneLine(cell)
    .replace(/(\d{4}\s*оны\s*)?\d{1,2}\s*(?:-?\s*р\s*)?сар\p{L}*\s*(?:\d\s\d|\d{1,2})|\d{4}[-./]\d{1,2}[-./]\d{1,2}|\d{1,2}[/.]\d{1,2}/gu, " ")
    .replace(/[\s,.;\-–—()/]+/gu, " ").trim();
  return rest.length <= 20;
}

/* ---------------------------------------------------------------- */
/* Rows and headers                                                 */
/* ---------------------------------------------------------------- */

/** The page text as blocks (rows and paragraphs), a row's wrapped lines kept together. */
function blocksOf(text: string): string[] {
  const raw = String(text || "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map((block) => block.trim()).filter(Boolean);
  const blocks: string[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    let block = raw[index];
    // A cell with paragraphs inside splits one row over two blocks: join them while the row is open.
    let joins = 0;
    while (block.includes("|") && !block.endsWith("|") && joins < 2 && index + 1 < raw.length && raw[index + 1].includes("|")) {
      block = `${block}\n${raw[index + 1]}`;
      index += 1;
      joins += 1;
    }
    blocks.push(block);
  }
  return blocks;
}

function cellsOf(block: string): string[] {
  const cells = block.split("|").map(squash);
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function columnKind(header: string): ColumnKind {
  const text = oneLine(header);
  if (!text) return "other";
  if (RETURN_HEADER.test(text) && !PASSENGER.test(text)) return "return";
  if (PRICE_HEADER.test(text)) return "price";
  if (LABEL_HEADER.test(text)) return "label";
  if (DATE_HEADER.test(text)) return "date";
  if (STATUS_HEADER.test(text)) return "status";
  if (HOTEL_HEADER.test(text)) return "hotel";
  return "other";
}

function headerOf(block: string): Column[] | null {
  if (!block.includes("|")) return null;
  const cells = cellsOf(block);
  if (cells.length < 2) return null;
  // A header names its columns; a data row holds dates and amounts.
  if (cells.some((cell) => amountOf(cell) !== null || isDateCell(cell))) return null;
  const columns = cells.map((cell) => ({ kind: columnKind(cell), header: oneLine(cell), lines: squash(cell).split("\n").map((line) => line.trim()).filter(Boolean) }));
  const dates = columns.filter((column) => column.kind === "date");
  if (!dates.length || !columns.some((column) => column.kind === "price")) return null;
  // Only the first departure column is the departure; another is read as the return.
  for (const extra of dates.slice(1)) extra.kind = "return";
  return columns;
}

/** Whether a row cell can sit in a column of this kind. */
function fits(kind: ColumnKind, cell: string): boolean {
  // An empty cell (the page's own blank, kept when it opens the row) sits anywhere but the departure.
  if (!oneLine(cell)) return kind !== "date";
  const date = isDateCell(cell);
  const amount = amountOf(cell) !== null;
  switch (kind) {
    case "date": return date;
    case "return": return date;
    case "price": return amount || /^[-–—]$/u.test(oneLine(cell));
    case "status": return !date && !amount && hasLetters(cell);
    case "label": return !date && !amount;
    case "hotel": return !date && !amount && hasLetters(cell);
    default: return !date;
  }
}

/**
 * The row's cells placed on the header's columns: column index per cell. With the same count
 * each cell is its column (it must fit); with fewer cells (an empty cell folded away) every
 * in-order placement where each cell fits is tried, and only a single one is accepted.
 */
function placeCells(columns: Column[], cells: string[]): number[] | null {
  if (cells.length > columns.length) return null;
  if (cells.length === columns.length) return cells.every((cell, index) => fits(columns[index].kind, cell)) ? cells.map((_, index) => index) : null;
  if (columns.length - cells.length > MAX_MISSING_CELLS) return null;
  const departure = columns.findIndex((column) => column.kind === "date");
  const found: number[][] = [];
  const walk = (cell: number, from: number, placed: number[]) => {
    if (found.length > 1) return;
    if (cell === cells.length) {
      // The departure date must be one of the placed cells (a missing return date is fine).
      if (placed.includes(departure)) found.push([...placed]);
      return;
    }
    for (let column = from; column <= columns.length - (cells.length - cell); column += 1) {
      if (fits(columns[column].kind, cells[cell])) walk(cell + 1, column + 1, [...placed, column]);
    }
  };
  walk(0, 0, []);
  return found.length === 1 ? found[0] : null;
}

/* ---------------------------------------------------------------- */
/* Hotel column groups                                              */
/* ---------------------------------------------------------------- */

type PriceGroup = { hotel?: string; columns: Array<{ index: number; name: string }> };

/** What a price header says besides the passenger: its wrapped second line, or the words after the passenger phrase. */
function qualifier(column: Column): string {
  if (column.lines.length >= 2) return column.lines.slice(1).join(" ").trim();
  return column.header
    .replace(PASSENGER, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\d+\s*(?:-|–)?\s*\d*\s*нас\p{L}*/giu, " ")
    .replace(/\d\s*одтой|\*+/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function priceGroups(columns: Column[]): PriceGroup[] | { reason: string } {
  const prices = columns.map((column, index) => ({ column, index })).filter(({ column }) => column.kind === "price");
  const adults = prices.filter(({ column }) => ADULT.test(column.header));
  if (adults.length < 2) {
    return [{ columns: prices.map(({ column, index }) => ({ index, name: column.header })) }];
  }
  // Several adult columns: each one opens a hotel group that runs to the next.
  const groups: PriceGroup[] = [];
  for (const { column, index } of prices) {
    if (ADULT.test(column.header) || !groups.length) groups.push({ hotel: qualifier(column), columns: [] });
    const group = groups[groups.length - 1];
    group.columns.push({ index, name: column.lines.length >= 2 ? column.lines[0] : column.header });
    const own = qualifier(column);
    if (own && group.hotel && own.toLowerCase() !== group.hotel.toLowerCase()) return { reason: "Үнийн баганууд буудлаар бүлэглэгдсэн боловч бүлгийн буудлын нэр зөрж байна." };
    if (!group.hotel && own) group.hotel = own;
  }
  const names = groups.map((group) => (group.hotel || "").toLowerCase());
  if (names.some((name) => !name) || new Set(names).size !== names.length) {
    return { reason: "Үнийн баганууд буудлаар бүлэглэгдсэн боловч буудлын нэр тодорхойгүй байна." };
  }
  return groups;
}

/* ---------------------------------------------------------------- */
/* The table                                                        */
/* ---------------------------------------------------------------- */

const LEADING_CODE = /^(?:\p{L}{1,2}\s*-\s*)?\d{1,3}\s*[.)]?\s*/u;

function labelNote(cell: string): string {
  return oneLine(cell).replace(LEADING_CODE, "").replace(/^[.\-–—\s]+/u, "").trim();
}

function hotelText(cell: string): string {
  return squash(cell).split("\n").map((line) => line.replace(/^\d{1,2}\s*[.)]?\s+/u, "").trim()).filter(Boolean).join(" / ");
}

type TableRead = { rows: ScheduleRow[]; skipped: number; unread: string[]; used: number };

function readRow(columns: Column[], groups: PriceGroup[], cells: string[]): ScheduleRow[] | null {
  const placed = placeCells(columns, cells);
  if (!placed) return null;
  const at = new Map(placed.map((column, cell) => [column, cells[cell]]));
  const dateColumn = columns.findIndex((column) => column.kind === "date");
  const dates = datesOf(at.get(dateColumn) || "");
  if (!dates.length) return null;
  let status: ScheduleRow["status"] = null;
  let seats: number | null = null;
  const notes: string[] = [];
  let hotel = "";
  columns.forEach((column, index) => {
    const cell = at.get(index);
    if (!cell) return;
    if (column.kind === "status") {
      const read = statusOf(cell);
      if (read) ({ status, seats } = read);
      else notes.push(oneLine(cell));
    } else if (column.kind === "label") {
      const note = labelNote(cell);
      if (note) notes.push(note);
      // A label column can hold the status too («1. Дүүрсэн»).
      const read = !status ? statusOf(note) : null;
      if (read) ({ status, seats } = read);
    } else if (column.kind === "hotel") {
      hotel = hotelText(cell);
    }
  });
  const note = [...new Set(notes)].filter((text) => !statusOf(text)).join(" · ");
  const out: ScheduleRow[] = [];
  for (const group of groups) {
    const prices = group.columns.flatMap(({ index, name }) => {
      const amount = amountOf(at.get(index) || "");
      return amount === null ? [] : [{ column: name, amount }];
    });
    const rowHotel = group.hotel || hotel;
    for (const date of dates) {
      out.push({ ...date, status, seats, note, prices, ...(rowHotel ? { hotel: rowHotel } : {}) });
    }
  }
  return out;
}

function readTable(blocks: string[], start: number, columns: Column[], groups: PriceGroup[]): TableRead {
  const rows: ScheduleRow[] = [];
  const unread: string[] = [];
  let skipped = 0;
  let quiet = 0;
  let index = start + 1;
  for (; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (!block.includes("|")) {
      // A note between rows: the table goes on after it; a few paragraphs in a row end it.
      quiet += 1;
      if (quiet > MAX_NOTE_BLOCKS) break;
      continue;
    }
    if (headerOf(block)) break;
    const cells = cellsOf(block);
    const read = readRow(columns, groups, cells);
    if (!read) {
      // A row that names a date but cannot be placed is counted; a stray one-cell line is not a row.
      const named = cells.length > 1 ? datesOf(block)[0] : undefined;
      if (named) { skipped += 1; unread.push(named.date); }
      else { quiet += 1; if (quiet > MAX_NOTE_BLOCKS) break; }
      continue;
    }
    quiet = 0;
    rows.push(...read);
  }
  return { rows, skipped, unread, used: index };
}

/** Every schedule table on the page, read row by row. */
export function parseScheduleTables(text: string): ScheduleParse {
  const blocks = blocksOf(text);
  const rows: ScheduleRow[] = [];
  const unread: string[] = [];
  let tables = 0;
  let skipped = 0;
  let groupProblem = "";
  for (let index = 0; index < blocks.length; index += 1) {
    const columns = headerOf(blocks[index]);
    if (!columns) continue;
    const groups = priceGroups(columns);
    if ("reason" in groups) { groupProblem = groups.reason; continue; }
    const table = readTable(blocks, index, columns, groups);
    if (table.rows.length) {
      tables += 1;
      rows.push(...table.rows);
    }
    skipped += table.skipped;
    unread.push(...table.unread);
    index = table.used - 1;
  }
  if (!rows.length) {
    if (groupProblem) return { ok: false, reason: groupProblem };
    return { ok: false, reason: skipped
      ? `Хуваарийн хүснэгтийн ${skipped} мөрийг баганатай нь тааруулж уншиж чадсангүй.`
      : "Хуудсанд гарах өдөр, үнэтэй хуваарийн хүснэгт олдсонгүй." };
  }
  // Too many rows that could not be placed: the columns are not what the header says.
  if (skipped > rows.length) return { ok: false, reason: `Хуваарийн хүснэгтийн ${skipped} мөрийг баганатай нь тааруулж уншиж чадсангүй.` };
  // The same departure (and hotel) twice with different facts: the page contradicts itself.
  const seen = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.date}|${(row.hotel || "").toLowerCase()}`;
    const facts = JSON.stringify([row.status, row.seats, row.prices]);
    if (seen.has(key) && seen.get(key) !== facts) return { ok: false, reason: `Хуудсанд ${row.date}-ны гаралт хоёр өөр мэдээлэлтэй байна.` };
    seen.set(key, facts);
  }
  const unique = rows.filter((row, index) => rows.findIndex((other) => other.date === row.date && (other.hotel || "").toLowerCase() === (row.hotel || "").toLowerCase()) === index);
  return { ok: true, rows: unique, tables, skipped, unread: [...new Set(unread)] };
}
