/**
 * A new trip read from a partner page, checked against the page's own schedule table (no AI).
 *
 * Why (2026-11-11): on a page whose price columns are grouped by hotel («Том хүн <Hotel A> |
 * Хүүхэд <Hotel A> | Том хүн <Hotel B> | …») the reader kept the first hotel's prices for every
 * date and dropped the second hotel. The deterministic table reader (scheduleTable.ts) reads both.
 *
 * Rules: a (date, hotel) the table lists but the reader left out is added, built on the reader's
 * own row for that date (its bands, single supplement, note) with the table's prices; a price the
 * two read differently is flagged for the admin, never silently replaced. Only when the reader's
 * rows already name hotels and the table's price columns line up with the row's bands one to one;
 * anything less is left as the reader wrote it. Pure.
 */
import { pricingDates } from "../adminDatePricing";
import { departureDays } from "../tripReview";
import { isInfantShapedAge } from "../travelFastPathsSearch";
import type { AIChangeProposal, ConflictItem } from "../travelTypes";
import { parseScheduleTables, type ScheduleRow } from "./scheduleTable";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const money = (value: number) => `${value.toLocaleString("en-US")}₮`;

/** "Citadines Bayfront Nha Trang *****" → "citadines bayfront nha trang". */
const hotelKey = (value: unknown) => text(value).toLowerCase().replace(/[*★]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** The hotels a cell names: "1 A ****, 2. B" / "A / B" / "A эсвэл B" → ["a", "b"] (list numbers and stars dropped). */
export function hotelParts(value: unknown): string[] {
  return text(value).split(/\s*(?:,|\/|;|\n|\s+эсвэл\s+|\s+or\s+)\s*/i)
    .map((part) => hotelKey(part.replace(/^\s*\d{1,2}\s*[.)]?\s+/, ""))).filter(Boolean);
}
/** Two cells name the same hotel(s): every hotel of each is in the other ("A, B" = "B / A"; "A" ≈ "A Hotel"). */
export function sameHotel(a: unknown, b: unknown): boolean {
  const x = hotelParts(a);
  const y = hotelParts(b);
  if (!x.length || !y.length) return false;
  const found = (part: string, list: string[]) => list.some((other) => part.includes(other) || other.includes(part));
  return x.every((part) => found(part, y)) && y.every((part) => found(part, x));
}

function isoOf(row: ScheduleRow, now: Date): string | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return row.date;
  const [month, day] = row.date.split("/").map(Number);
  if (!month || !day) return null;
  const spelled = row.year ? `${row.year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}` : `${month} сарын ${day}`;
  return departureDays([spelled], now).days[0] ?? null;
}

const ADULT = /том\s*хүн|adult|насанд хүрэгч/i;

/** The row for a missing hotel, or why it cannot be built. */
function rowFor(template: Row, parsed: ScheduleRow, day: string): Row | string {
  const adult = parsed.prices.filter((price) => ADULT.test(price.column));
  const others = parsed.prices.filter((price) => !ADULT.test(price.column));
  const bands = records(template.passenger_prices);
  const childBands = bands.filter((band) => !isInfantShapedAge(text(band.label).toLowerCase(), text(band.age_range)));
  if (adult.length !== 1 || others.length !== childBands.length) return "үнийн баганууд мөртэй таарахгүй";
  let next = 0;
  const passengers = bands.map((band) => (childBands.includes(band) ? { ...band, price: others[next++].amount } : band));
  const firstChild = others[0]?.amount ?? template.child_price ?? null;
  return {
    ...template,
    dates: [day], date_keys: [day], display_dates: [day],
    hotel: parsed.hotel, adult_price: adult[0].amount, child_price: firstChild, passenger_prices: passengers,
    ...(parsed.status === "full" ? { status: "sold_out" } : parsed.status === "low" ? { status: "almost_full", ...(parsed.seats !== null ? { seats_left: parsed.seats } : {}) } : {}),
  };
}

/** The reader's rows for one new trip completed from the page's table; notes for the admin. */
export function completeFromSchedule(fields: Row, pageText: string, now = new Date()): { fields: Row; notes: ConflictItem[] } {
  const parsed = parseScheduleTables(pageText);
  if (!parsed.ok || !parsed.rows.length) return { fields, notes: [] };
  const extra = record(fields.extra);
  const key = records(extra.price_groups).length ? "price_groups" : "departure_date_groups";
  const rows = records(extra[key]);
  if (!rows.length || !rows.some((row) => text(row.hotel))) return { fields, notes: [] };
  const dayOf = (row: Row) => departureDays(pricingDates(row, now), now).days;
  const added: Row[] = [];
  const addedText: string[] = [];
  const skipped: string[] = [];
  const differ: string[] = [];
  for (const entry of parsed.rows) {
    const day = isoOf(entry, now);
    if (!day || !entry.hotel) continue;
    const sameDay = rows.filter((row) => dayOf(row).includes(day));
    if (!sameDay.length) continue;
    const match = sameDay.find((row) => sameHotel(row.hotel, entry.hotel));
    const adult = entry.prices.find((price) => ADULT.test(price.column))?.amount;
    if (match) {
      if (typeof adult === "number" && typeof match.adult_price === "number" && adult !== match.adult_price) {
        differ.push(`${entry.date} ${entry.hotel}: хүснэгтэд ${money(adult)}, уншсан ${money(match.adult_price)}`);
      }
      continue;
    }
    // The same prices as a row of that day: the same option named differently, not a missing hotel.
    const amounts = entry.prices.map((price) => price.amount).sort((a, b) => a - b).join(",");
    const rowAmounts = (row: Row) => [row.adult_price, ...records(row.passenger_prices).map((band) => band.price)]
      .filter((value): value is number => typeof value === "number" && value > 0).sort((a, b) => a - b).join(",");
    if (sameDay.some((row) => rowAmounts(row) === amounts)) continue;
    const built = rowFor(sameDay[0], entry, day);
    if (typeof built === "string") { skipped.push(`${entry.date} ${entry.hotel}: ${built}`); continue; }
    added.push(built);
    addedText.push(`${entry.date} ${entry.hotel}`);
  }
  const notes: ConflictItem[] = [];
  if (addedText.length) notes.push({ text: `Хуудасны хүснэгтээс нэмсэн буудлын үнэ (AI уншаагүй): ${addedText.join("; ")}.`, severity: "info", type: "schedule_rows_added" });
  if (skipped.length) notes.push({ text: `Хүснэгтэд байгаа ч нэмж чадаагүй: ${skipped.join("; ")} — гараар шалгана уу.`, severity: "warning", type: "schedule_rows_skipped" });
  if (differ.length) notes.push({ text: `Хүснэгтийн үнэ AI уншсанаас өөр: ${differ.join("; ")} — хуудастай тулгаж шалгана уу.`, severity: "warning", type: "schedule_price_differs" });
  if (!added.length) return { fields, notes };
  return { fields: { ...fields, extra: { ...extra, [key]: [...rows, ...added] } }, notes };
}

/** completeFromSchedule over every new-trip action of a proposal (in place); the notes go on the card. */
export function crossCheckProposal(proposal: AIChangeProposal, pageText: string, now = new Date()): AIChangeProposal {
  if (!pageText.trim()) return proposal;
  for (const action of proposal.actions) {
    if (action.action !== "upsert" || text(action.trip_id) || !action.fields) continue;
    const checked = completeFromSchedule(action.fields as Row, pageText, now);
    action.fields = checked.fields as typeof action.fields;
    for (const note of checked.notes) {
      proposal.conflict_items = [...(proposal.conflict_items || []), note];
      proposal.conflicts = [...(proposal.conflicts || []), note.text];
    }
  }
  return proposal;
}
