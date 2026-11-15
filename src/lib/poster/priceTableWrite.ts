/**
 * Keeping a poster's price table saying what the trip's dated price rows say.
 *
 * Why: the poster is a second home of every per-date fare. A Poster-tab save (even one that only
 * swaps a photo) re-reads `price_groups` from the poster table and writes them over the trip
 * (poster/db.ts syncPosterTrip). A fare changed only on the trip — by the assistant or the editor —
 * was therefore undone by the next poster save, and the poster PDF kept quoting the old fare.
 *
 * How: each poster row is read exactly as a poster save reads it (mapPosterTripToFields, then
 * normalizeExtra), its dates are matched to the trip row that sells them (same hotel / package),
 * a row whose dates now sit on two trip rows is split the same way, and only the fare cells whose
 * value differs are rewritten. The result is read back the same way and must agree with the trip
 * rows; otherwise nothing is written and the reason is returned, so the admin is told instead of
 * the poster silently disagreeing. Pure.
 */
import { pricingDays } from "../adminDatePricing";
import { normalizeExtra } from "../tripExtraSchema";
import { isInfantShapedAge } from "../travelFastPathsSearch";
import { shiftAmountsInText } from "../priceShift";
import { splitPackagedHotel } from "./packageRows";
import { mapPosterTripToFields, posterCellIndex, posterFareColumns, type PosterFareColumns } from "./tripMapper";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const norm = (value: unknown): string => text(value).normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ");

export type PosterTableSync = {
  /** The new price_table when a cell or a row changed. */
  table?: Row;
  changed: boolean;
  /** Why the poster table could not be brought in line (nothing is written then). */
  problem?: string;
  /** Every ISO date some poster row sells after the sync. */
  coveredDates: string[];
  /**
   * Poster rows whose dates the trip prices only under another hotel or package (one names a
   * hotel the other does not, or a package against package columns). They are left as they
   * are and their dates are NOT covered: a later poster save would put their old fares back.
   */
  mismatched?: string[];
};

/** A poster price row as a poster save would store it on the trip, or null when it holds nothing. */
export function readPosterPriceRow(columns: string[], row: Row): Row | null {
  const mapped = records(mapPosterTripToFields({ price_table: { columns, rows: [row] } } as Parameters<typeof mapPosterTripToFields>[0]).extra?.price_groups)[0];
  if (!mapped) return null;
  return records(normalizeExtra({ price_groups: [mapped] }).extra.price_groups)[0] ?? null;
}

/** "12 сарын 02, 16" (or "2026 оны 12 сарын 02, 16"): the shape a poster row's date cell is read back from. */
export function posterDateText(isoDates: string[], withYear: boolean): string {
  const parts: string[] = [];
  let month = "";
  let year = "";
  for (const iso of [...isoDates].sort()) {
    const [y, m, d] = iso.split("-");
    if (`${y}-${m}` === month) {
      parts[parts.length - 1] += `, ${d}`;
      continue;
    }
    parts.push(`${withYear && y !== year ? `${y} оны ` : ""}${Number(m)} сарын ${d}`);
    month = `${y}-${m}`;
    year = y;
  }
  return parts.join(", ");
}

function packageOptions(extra: Row): Array<{ id: string; label: string }> {
  return records(extra.package_options)
    .map((option) => ({ id: text(option.id) || text(option.label), label: text(option.label) || text(option.id) }))
    .filter((option) => option.id);
}

/** The hotel and package a poster row's hotel cell names ("Hotel · Package" split against the trip's packages). */
function posterRowHotel(group: Row, tripExtra: Row): { hotel: string; packageId: string } {
  const hotel = text(group.hotel);
  const split = splitPackagedHotel(hotel, packageOptions(tripExtra));
  return split ? { hotel: split.hotel, packageId: split.packageId } : { hotel, packageId: text(group.package_id) };
}

function sameSeller(group: Row, poster: { hotel: string; packageId: string }): boolean {
  return norm(group.hotel) === norm(poster.hotel) && text(group.package_id) === poster.packageId;
}

const formatted = (value: number) => `${value.toLocaleString("en-US")}₮`;
const hasAmount = (cell: string) => /\d{1,3}(?:[,.]\d{3})+|\d{5,}/.test(cell);

type Expectation = { kind: "adult" | "single"; value: number } | { kind: "passenger"; label: string; value: number };

/** The tier of `group` a poster passenger column stands for: same label, or the only tier of its kind. */
function wantedPassengerFare(group: Row, column: { label: string; infant: boolean }, fare: PosterFareColumns): number | null | undefined {
  const tiers = records(group.passenger_prices);
  if (!tiers.length) {
    const sameKind = fare.passengers.filter((entry) => entry.infant === column.infant);
    if (sameKind.length !== 1) return undefined;
    return num(column.infant ? group.infant_price : group.child_price);
  }
  const named = tiers.find((tier) => norm(tier.label) === norm(column.label));
  if (named) return num(named.price);
  const kind = tiers.filter((tier) => isInfantShapedAge(text(tier.label).toLowerCase(), text(tier.age_range)) === column.infant);
  const columns = fare.passengers.filter((entry) => entry.infant === column.infant);
  return kind.length === 1 && columns.length === 1 ? num(kind[0].price) : undefined;
}

/** The row's cells with every fare that differs from `group` rewritten, and what the read-back must show. */
function rewrittenCells(row: Row, columns: string[], fare: PosterFareColumns, current: Row, group: Row): { cells: unknown[]; expect: Expectation[] } | string {
  const cells: unknown[] = Array.isArray(row.cells) ? [...row.cells] : [];
  const expect: Expectation[] = [];
  const cellAt = (columnIndex: number) => posterCellIndex(row as { cells?: string[] }, columns, columnIndex);
  const put = (columnIndex: number, value: string): boolean => {
    const at = cellAt(columnIndex);
    if (at < 0) return false;
    while (cells.length <= at) cells.push("");
    cells[at] = value;
    return true;
  };

  const wantAdult = num(group.adult_price);
  const haveAdult = num(current.adult_price);
  if (wantAdult !== haveAdult) {
    if (wantAdult == null) return "том хүний үнэ хоосон болох гэж байна";
    if (!fare.adult.length) return "том хүний үнийн багана алга";
    const keepRange = Boolean(record(group.adult_price_range).max) && Boolean(record(current.adult_price_range).max) && haveAdult != null;
    if (fare.adult.length === 1 && !keepRange) {
      put(fare.adult[0], formatted(wantAdult));
    } else if (haveAdult != null) {
      // Several per-occupancy columns (or a range): every one moves by the same amount, so the
      // lowest — the fare a poster save reads — lands on the new value.
      for (const index of fare.adult) {
        const cell = String(cells[cellAt(index)] ?? "");
        if (!hasAmount(cell)) continue;
        try {
          put(index, shiftAmountsInText(cell, wantAdult - haveAdult));
        } catch {
          return "том хүний үнэ 0-оос доош болно";
        }
      }
    } else {
      return "том хүний үнийн хэд хэдэн багана байгаа тул алийг нь өөрчлөхөө мэдэхгүй";
    }
    expect.push({ kind: "adult", value: wantAdult });
  }

  for (const column of fare.passengers) {
    const want = wantedPassengerFare(group, column, fare);
    if (want === undefined || want === null) continue;
    const have = num(records(current.passenger_prices).find((tier) => norm(tier.label) === norm(column.label))?.price);
    if (want === have) continue;
    if (!put(column.index, want === 0 ? "Үнэгүй" : formatted(want))) return `«${column.label}» баганын нүд алга`;
    expect.push({ kind: "passenger", label: column.label, value: want });
  }

  const wantSingle = num(group.single_price);
  if (fare.single >= 0 && wantSingle != null && wantSingle !== num(current.single_price)) {
    if (!put(fare.single, formatted(wantSingle))) return "ганцаараа явах үнийн нүд алга";
    expect.push({ kind: "single", value: wantSingle });
  }
  return { cells, expect };
}

function readBackAgrees(read: Row | null, expect: Expectation[]): boolean {
  if (!read) return false;
  return expect.every((item) => {
    if (item.kind === "passenger") return num(records(read.passenger_prices).find((tier) => norm(tier.label) === norm(item.label))?.price) === item.value;
    return num(item.kind === "adult" ? read.adult_price : read.single_price) === item.value;
  });
}

/**
 * The poster price table brought in line with `groups` (the trip's price rows after a change).
 * A poster row selling dates the trip no longer prices is left as it is.
 */
export function syncPosterPriceTable(posterData: unknown, groups: Row[], tripExtra: Row, now: Date): PosterTableSync {
  const table = record(record(posterData).price_table);
  const rows = records(table.rows);
  const columns = (Array.isArray(table.columns) ? table.columns : []).map((column) => String(column ?? ""));
  if (!rows.length) return { changed: false, coveredDates: [] };
  const fare = posterFareColumns(columns);
  const out: Row[] = [];
  const covered = new Set<string>();
  const mismatched: string[] = [];
  let changed = false;
  for (const row of rows) {
    const current = readPosterPriceRow(columns, row);
    const dates = current ? pricingDays(current, now) : [];
    if (!current || !dates.length) {
      out.push(row);
      continue;
    }
    const seller = posterRowHotel(current, tripExtra);
    const owners = dates.map((date) => groups.filter((group) => pricingDays(group, now).includes(date) && sameSeller(group, seller)));
    const label = text(row.dates) || dates.join(", ");
    if (owners.every((list) => list.length === 0)) {
      out.push(row);
      // Dates the trip no longer prices at all: nothing to follow. Dates it prices under another
      // hotel or package: this row cannot follow them, and saying they are covered hid that.
      if (dates.some((date) => groups.some((group) => pricingDays(group, now).includes(date)))) mismatched.push(label);
      else dates.forEach((date) => covered.add(date));
      continue;
    }
    if (owners.some((list) => list.length !== 1)) {
      return { changed: false, coveredDates: [], problem: `постерын «${label}» мөрийн огноонуудад таарах үнийн мөр тодорхойгүй` };
    }
    const parts = new Map<Row, string[]>();
    dates.forEach((date, index) => parts.set(owners[index][0], [...(parts.get(owners[index][0]) || []), date]));
    const withYear = /(?:^|\D)20\d{2}(?:\D|$)/.test(String(row.dates || ""));
    for (const [group, partDates] of parts) {
      const rewritten = rewrittenCells(row, columns, fare, current, group);
      if (typeof rewritten === "string") return { changed: false, coveredDates: [], problem: `постерын «${label}» мөр: ${rewritten}` };
      const next: Row = { ...row, dates: parts.size === 1 ? row.dates : posterDateText(partDates, withYear), cells: rewritten.cells };
      const read = readPosterPriceRow(columns, next);
      const readDates = read ? pricingDays(read, now) : [];
      if (!readBackAgrees(read, rewritten.expect) || readDates.length !== partDates.length || !partDates.every((date) => readDates.includes(date))) {
        return { changed: false, coveredDates: [], problem: `постерын «${label}» мөрийг шинэ үнээр зөв бичиж чадсангүй` };
      }
      if (JSON.stringify(next) !== JSON.stringify(row)) changed = true;
      partDates.forEach((date) => covered.add(date));
      out.push(next);
    }
  }
  const unmatched = mismatched.length ? { mismatched } : {};
  return changed
    ? { table: { ...table, rows: out }, changed: true, coveredDates: [...covered], ...unmatched }
    : { changed: false, coveredDates: [...covered], ...unmatched };
}

/** The card's words for poster rows that cannot follow the trip's rows (PosterTableSync.mismatched). */
export function mismatchedRowsText(labels: string[]): string {
  return `постерын «${labels.join("», «")}» мөрийн буудал/багц үнийн мөртэй таарахгүй`;
}

/**
 * A one-row poster table after a base-fare change (tripToPoster): the adult and child cells
 * rewritten in place, every other column (infant, age-banded child, single, hotel) and the row's
 * own date text kept. Only cells whose fare differs are touched, so a table the same write
 * already brought in line (posterFareFollow) is left exactly as it is. Null when the row cannot
 * be edited in place (no fare columns, an empty adult fare, several adult columns with no fare to
 * shift from); the caller then rebuilds the table as before.
 */
export function posterBaseFareRow(columns: string[], row: Row, fares: { adult: number | null; child: number | null }): Row | null {
  if (!columns.length || !Array.isArray(row.cells)) return null;
  const current = readPosterPriceRow(columns, row);
  if (!current) return null;
  const fare = posterFareColumns(columns);
  if (!fare.adult.length) return null;
  // A range cell ("2,590,000-2,890,000₮") moves as a whole, as a dated fare edit moves it.
  const range = record(current.adult_price_range).max ? { adult_price_range: current.adult_price_range } : {};
  const rewritten = rewrittenCells(row, columns, fare, current, { adult_price: fares.adult, child_price: fares.child, ...range });
  if (typeof rewritten === "string") return null;
  const next: Row = { ...row, cells: rewritten.cells };
  return readBackAgrees(readPosterPriceRow(columns, next), rewritten.expect) ? next : null;
}
