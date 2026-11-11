/**
 * A partner page's schedule (scheduleTable.ts) against our trip made from it.
 *
 * What we hold for a departure day: its website state (the Departure row the bot, the website
 * and the fare card read; extra.website_departure_availability), else the state its price row
 * was saved with (status "sold_out" / "almost_full" + seats_left), and its fares on the row
 * that covers it (extra.price_groups) or the trip's own fares.
 *
 * What comes out, per day still ahead:
 *  - seat_state  open / few seats / full changed on the page;
 *  - seat_count  still few seats, another count («4 суудал үлдсэн» → «2 суудал үлдсэн»);
 *  - new_date    a departure the page lists and the trip does not have;
 *  - gone_date   a departure the trip has and the page no longer lists;
 *  - price       one fare of one day (and hotel group) changed.
 * A day staff paused or cancelled is theirs and is not compared; a row or fare that cannot be
 * matched to exactly one of ours is skipped (said in `notes`), never guessed.
 *
 * Only seat_state may be applied without the admin (run.ts, through the assistant's own
 * set_date_state); everything else is recorded for him with a ready instruction.
 *
 * Pure.
 */
import { pricingDays } from "../adminDatePricing";
import { tripDepartures } from "../assistantAgent/readTools";
import { dateStateProblem, tripDepartureDays, ulaanbaatarToday } from "../tripActionPlan";
import { shortDay } from "../tripDatePrice";
import { FEW_SEATS, rowDayState } from "../tripDayStates";
import { isInfantShapedAge } from "../travelFastPathsSearch";
import type { TravelTrip } from "../travelTypes";
import type { SchedulePrice, ScheduleRow, SeatStatus } from "./scheduleTable";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export type SeatView = { state: SeatStatus; seats: number | null };
export type FareKind = "adult" | "child" | "infant" | "single";

export type WatchChange =
  | { kind: "seat_state"; date: string; from: SeatView; to: SeatView }
  | { kind: "seat_count"; date: string; from: SeatView; to: SeatView }
  | { kind: "new_date"; date: string; to: SeatView | null; prices: SchedulePrice[]; hotel?: string }
  | { kind: "gone_date"; date: string }
  /** `hotel` as the page names it; `row_hotel` our row's own hotel (what set_date_price picks the row by). */
  | { kind: "price"; date: string; hotel?: string; row_hotel?: string; column: string; fare: FareKind; band?: string; from: number; to: number };

/** One change with its line for the admin and the instruction the dashboard button puts in the assistant. */
export type WatchItem = WatchChange & { text: string; instruction: string; reason?: string };

export type DatedRow = ScheduleRow & { day: string };

/* ---------------------------------------------------------------- */
/* Page dates → calendar days                                       */
/* ---------------------------------------------------------------- */

const isoOf = (year: number, month: number, day: number) => `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
const dayMs = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

/**
 * The page's "M/D" days as calendar days. A day the trip already has (same month and day,
 * within a year of today) is that day; otherwise the first row is read at its next
 * occurrence (up to two months back still counts as this season) and each later row keeps
 * the table's order, so 12/31 → 1/7 rolls into the next year.
 */
export function resolveRowDays(rows: ScheduleRow[], knownDays: string[], now: Date): DatedRow[] {
  const today = ulaanbaatarToday(now);
  const year = Number(today.slice(0, 4));
  const out: DatedRow[] = [];
  let previous: string | null = null;
  for (const row of rows) {
    let day = "";
    if (ISO.test(row.date)) day = row.date;
    else {
      const [month, date] = row.date.split("/").map(Number);
      const candidates = [year - 1, year, year + 1, year + 2].map((y) => isoOf(y, month, date)).filter((iso) => !Number.isNaN(dayMs(iso)));
      const known = candidates.find((iso) => knownDays.includes(iso) && Math.abs(dayMs(iso) - dayMs(today)) <= 400 * DAY_MS);
      if (known) day = known;
      else if (previous) day = candidates.find((iso) => dayMs(iso) >= dayMs(previous!) - 45 * DAY_MS) || "";
      else day = candidates.find((iso) => dayMs(iso) >= dayMs(today) - 60 * DAY_MS) || "";
    }
    if (!day) continue;
    out.push({ ...row, day });
    previous = day;
  }
  return out;
}

/* ---------------------------------------------------------------- */
/* What we hold                                                     */
/* ---------------------------------------------------------------- */

type OurDay = { state: "open" | "low" | "full" | "paused" | "cancelled"; seats: number | null; onWebsite: boolean };

/** The rows of the trip's price list that cover this day. */
function rowsOn(trip: TravelTrip, day: string, now: Date): Row[] {
  return records(trip.extra?.price_groups).filter((group) => pricingDays(group, now).includes(day));
}

/** The state the day's price row(s) were saved with: "full" when one says sold out. */
export function rowStateOn(trip: TravelTrip, day: string, now: Date): SeatView | null {
  const states = rowsOn(trip, day, now).map((group) => rowDayState(group)).filter((state): state is NonNullable<typeof state> => Boolean(state));
  if (states.some((state) => state.state === "full")) return { state: "full", seats: null };
  const low = states.find((state) => state.state === "low");
  return low ? { state: "low", seats: low.seats } : null;
}

/** Each coming day of the trip with what customers are told about it now. */
export function ourDays(trip: TravelTrip, now: Date): Map<string, OurDay> {
  const today = ulaanbaatarToday(now);
  const days = new Map<string, OurDay>();
  for (const entry of tripDepartures(trip, now)) {
    if (entry.date < today) continue;
    if (entry.state === "not_on_website") {
      const row = rowStateOn(trip, entry.date, now);
      days.set(entry.date, { state: row?.state ?? "open", seats: row?.seats ?? null, onWebsite: false });
    } else {
      days.set(entry.date, { state: entry.state, seats: entry.state === "low" ? entry.seats_left : null, onWebsite: true });
    }
  }
  for (const day of tripDepartureDays(trip, now)) {
    if (day < today || days.has(day)) continue;
    const row = rowStateOn(trip, day, now);
    days.set(day, { state: row?.state ?? "open", seats: row?.seats ?? null, onWebsite: false });
  }
  return days;
}

/* ---------------------------------------------------------------- */
/* Fares                                                            */
/* ---------------------------------------------------------------- */

const NO_BED = /оргүй|ор\s*эз\p{L}*гүй|ор\s*авахгүй|without\s*bed|no\s*bed/iu;
const WITH_BED = /ортой|ор\s*эзэлнэ|with\s*bed/iu;

function fareOfColumn(column: string): { fare: FareKind; bed?: "bed" | "nobed" } | null {
  if (/нярай|infant/iu.test(column)) return { fare: "infant" };
  if (/ганцаар|single/iu.test(column)) return { fare: "single" };
  if (/том\s*хүн|насанд\s*хүрэгч|adult/iu.test(column)) return { fare: "adult" };
  if (/хүүхэд|child/iu.test(column)) return { fare: "child", ...(NO_BED.test(column) ? { bed: "nobed" as const } : WITH_BED.test(column) ? { bed: "bed" as const } : {}) };
  return null;
}

type OurFare = { amount: number; band?: string };

/** Our fare for one page column on one price row (or the trip's own fares); null when it is not exactly one fare. */
function ourFare(source: Row, fare: FareKind, bed: "bed" | "nobed" | undefined, childColumns: number): OurFare | null {
  const tiers = records(source.passenger_prices).filter((tier) => num(tier.price) !== null);
  const infantTier = (tier: Row) => isInfantShapedAge(text(tier.label).toLowerCase(), text(tier.age_range));
  if (fare === "adult") return num(source.adult_price) !== null ? { amount: source.adult_price as number } : null;
  if (fare === "single") return num(source.single_price) !== null ? { amount: source.single_price as number } : null;
  if (fare === "infant") {
    const pool = tiers.filter(infantTier);
    if (pool.length > 1) return null;
    if (pool.length === 1) return { amount: pool[0].price as number };
    return num(source.infant_price) !== null ? { amount: source.infant_price as number } : null;
  }
  const pool = tiers.filter((tier) => !infantTier(tier));
  if (!pool.length) {
    // Only the plain child fare: it is the page's one child column, or its with-bed one.
    if (childColumns > 1 && bed !== "bed") return null;
    return num(source.child_price) !== null ? { amount: source.child_price as number } : null;
  }
  if (pool.length === 1 && childColumns <= 1) return { amount: pool[0].price as number };
  // Several tiers or several child columns: the tier the column's bed words name, exactly one.
  const words = (tier: Row) => `${text(tier.label)} ${text(tier.age_range)}`;
  const named = bed === "nobed" ? pool.filter((tier) => NO_BED.test(words(tier)))
    : bed === "bed" ? (pool.some((tier) => WITH_BED.test(words(tier))) ? pool.filter((tier) => WITH_BED.test(words(tier))) : pool.filter((tier) => !NO_BED.test(words(tier))))
      : [];
  if (named.length !== 1) return null;
  // The planner needs the tier's name when the row has several (set_date_price `band`).
  return { amount: named[0].price as number, ...(pool.length > 1 ? { band: text(named[0].label) || text(named[0].age_range) } : {}) };
}

const HOTEL_NOISE = /[*★☆]+|\d\s*(?:од|star)\p{L}*|hotel|resort|зочид\s*буудал|буудал/giu;
function hotelWords(value: string): string[] {
  return value.toLowerCase().replace(HOTEL_NOISE, " ").split(/[^\p{L}\d]+/u).filter((word) => word.length >= 3);
}

/** The one price row of ours that a page row (one of several on its day) is. */
function rowForHotel(rows: Row[], hotel: string): Row | null {
  const wanted = hotelWords(hotel);
  if (!wanted.length) return null;
  const scored = rows.map((row) => {
    const own = hotelWords(`${text(row.hotel)} ${text(row.label)}`);
    const shared = wanted.filter((word) => own.includes(word)).length;
    return { row, score: own.length ? shared / Math.min(wanted.length, own.length) : 0 };
  }).filter((entry) => entry.score >= 0.6).sort((a, b) => b.score - a.score);
  if (!scored.length || (scored.length > 1 && scored[1].score === scored[0].score)) return null;
  return scored[0].row;
}

/* ---------------------------------------------------------------- */
/* Words                                                            */
/* ---------------------------------------------------------------- */

const amount = (value: number) => value.toLocaleString("en-US");
const mnt = (value: number) => `${amount(value)}₮`;
export const SEAT_WORDS: Record<SeatStatus, string> = { open: "Нээлттэй", low: "Цөөн суудал", full: "Дүүрсэн" };
export function seatWords(view: SeatView): string {
  return view.state === "low" && view.seats !== null ? `${SEAT_WORDS.low} (${view.seats})` : SEAT_WORDS[view.state];
}
const FARE_WORDS: Record<FareKind, string> = { adult: "том хүний", child: "хүүхдийн", infant: "нярайн", single: "ганцаараа өрөөний" };
const STATE_ORDER: Record<SeatStatus, string> = { open: "нээлттэй", low: "цөөн суудалтай", full: "дүүрсэн" };

function describe(change: WatchChange, name: string): { text: string; instruction: string } {
  const day = shortDay(change.date);
  const trip = `«${name}»`;
  switch (change.kind) {
    case "seat_state":
      return { text: `${day}: ${seatWords(change.from)} → ${seatWords(change.to)}`, instruction: `${trip} ${day}-ны гаралтыг ${STATE_ORDER[change.to.state]} болго` };
    // No write sets one day's seat count (set_date_state carries the state only): shown, no button.
    case "seat_count":
      return { text: `${day}: үлдсэн суудал ${change.from.seats ?? "—"} → ${change.to.seats ?? "—"} (цөөн суудал хэвээр)`, instruction: "" };
    case "new_date": {
      const prices = change.prices.map((price) => `${price.column} ${mnt(price.amount)}`).join(", ");
      return {
        text: `${day}: хамтрагчийн хуудсанд шинэ гаралт${change.to ? ` (${seatWords(change.to)})` : ""}${prices ? ` — ${prices}` : ""}`,
        instruction: `${trip} аялалд ${day}-нд гаралт нэм${prices ? `: ${prices}` : ""}`,
      };
    }
    case "gone_date":
      return { text: `${day}: хамтрагчийн хуудсанд алга болсон`, instruction: `${trip} аяллын ${day}-ны гаралтыг хас` };
    case "price": {
      const where = change.hotel ? ` (${change.hotel})` : "";
      return {
        text: `${day}${where}: ${change.column} ${mnt(change.from)} → ${mnt(change.to)}`,
        instruction: `${trip} ${day}-ны${where} ${FARE_WORDS[change.fare]}${change.band ? ` (${change.band})` : ""} үнийг ${amount(change.to)} болго`,
      };
    }
  }
}

/* ---------------------------------------------------------------- */
/* The comparison                                                   */
/* ---------------------------------------------------------------- */

export type WatchCompare = { items: WatchItem[]; notes: string[]; rows: DatedRow[] };

/**
 * The page's state for a day as our trips hold it: «12 суудал үлдсэн» is not few seats (only a
 * handful is, tripDayStates.FEW_SEATS — the same rule a new trip's rows are saved with).
 */
function pageSeat(row: ScheduleRow): SeatView | null {
  if (!row.status) return null;
  if (row.status === "low" && row.seats !== null && row.seats > FEW_SEATS) return { state: "open", seats: row.seats };
  return { state: row.status, seats: row.status === "full" ? null : row.seats };
}

/**
 * The page against the trip: every difference for a day still ahead, in day order. `unread` are
 * the dates of page rows the parser could not place: still listed, so never "gone".
 */
export function compareWithTrip(trip: TravelTrip, pageRows: ScheduleRow[], now: Date, unread: string[] = []): WatchCompare {
  const today = ulaanbaatarToday(now);
  const ours = ourDays(trip, now);
  const rows = resolveRowDays(pageRows, [...ours.keys()], now).filter((row) => row.day >= today);
  const listedUnread = new Set(resolveRowDays(unread.map((date) => ({ date, status: null, seats: null, note: "", prices: [] })), [...ours.keys()], now).map((row) => row.day));
  const notes: string[] = [];
  const changes: WatchChange[] = [];
  const byDay = new Map<string, DatedRow[]>();
  for (const row of rows) byDay.set(row.day, [...(byDay.get(row.day) || []), row]);

  for (const [day, dayRows] of byDay) {
    const statuses = [...new Set(dayRows.map((row) => (row.status ? `${row.status}|${row.seats ?? ""}` : "")).filter(Boolean))];
    const stated = dayRows.find((row) => row.status);
    const page = statuses.length === 1 && stated ? pageSeat(stated) : null;
    if (statuses.length > 1) notes.push(`${shortDay(day)}: хуудсанд буудал бүрт өөр төлөв бичсэн тул суудлыг харьцуулсангүй.`);
    const held = ours.get(day);
    if (!held) {
      changes.push({ kind: "new_date", date: day, to: page, prices: dayRows[0].prices, ...(dayRows.length === 1 && dayRows[0].hotel ? { hotel: dayRows[0].hotel } : {}) });
      continue;
    }
    // A day staff paused or cancelled is their decision, whatever the partner says.
    if (held.state === "paused" || held.state === "cancelled") continue;
    if (page && page.state !== held.state) changes.push({ kind: "seat_state", date: day, from: { state: held.state, seats: held.seats }, to: page });
    // A count on both sides that differs (our "few seats" without a count is not a different count).
    else if (page && page.state === "low" && page.seats !== null && held.seats !== null && page.seats !== held.seats) changes.push({ kind: "seat_count", date: day, from: { state: held.state, seats: held.seats }, to: page });

    // Fares: each page row to exactly one of our rows (by hotel when the day has several).
    const ownRows = rowsOn(trip, day, now);
    for (const pageRow of dayRows) {
      let source: Row | null;
      if (dayRows.length === 1 && ownRows.length <= 1) source = ownRows[0] ?? (trip as unknown as Row);
      else source = pageRow.hotel ? rowForHotel(ownRows, pageRow.hotel) : null;
      if (!source) { notes.push(`${shortDay(day)}${pageRow.hotel ? ` (${pageRow.hotel})` : ""}: манай аль үнийн мөр болохыг тодорхойлж чадсангүй — үнийг харьцуулсангүй.`); continue; }
      const childColumns = pageRow.prices.filter((price) => fareOfColumn(price.column)?.fare === "child").length;
      const seen = new Set<string>();
      for (const price of pageRow.prices) {
        const kind = fareOfColumn(price.column);
        if (!kind) continue;
        const own = ourFare(source, kind.fare, kind.bed, childColumns);
        const key = `${kind.fare}|${own?.band ?? kind.bed ?? ""}`;
        if (!own || seen.has(key)) continue;
        seen.add(key);
        if (own.amount === price.amount) continue;
        const hotel = dayRows.length > 1 && pageRow.hotel ? pageRow.hotel : undefined;
        const rowHotel = ownRows.length > 1 ? text(source.hotel) : "";
        changes.push({
          kind: "price", date: day, ...(hotel ? { hotel } : {}), ...(rowHotel ? { row_hotel: rowHotel } : {}),
          column: price.column, fare: kind.fare, ...(own.band ? { band: own.band } : {}), from: own.amount, to: price.amount,
        });
      }
    }
  }
  // A departure we sell that the page no longer lists (only while the page lists any).
  if (rows.length) {
    for (const [day, held] of ours) {
      if (byDay.has(day) || listedUnread.has(day) || held.state === "cancelled" || held.state === "paused") continue;
      changes.push({ kind: "gone_date", date: day });
    }
  }
  changes.sort((a, b) => a.date.localeCompare(b.date));
  return { items: changes.map((change) => ({ ...change, ...describe(change, trip.route_name) })), notes: [...new Set(notes)], rows };
}

/**
 * Why a seat-state change may not be written without the admin, or null when it may: the same
 * check the assistant's set_date_state passes (a day the website has, ahead, not cancelled), the
 * trip on sale, and no price row of that day still saved as full (reopening the website day
 * alone would leave the fare card reading "conflict").
 */
export function seatChangeProblem(trip: TravelTrip, item: Extract<WatchChange, { kind: "seat_state" }>, now: Date): string | null {
  if (trip.status !== "active") return "аялал идэвхтэй биш (ноорог, түр зогссон эсвэл дүүрсэн) тул автоматаар өөрчлөхгүй";
  const problem = dateStateProblem(trip, item.date, item.to.state, now);
  if (problem) return problem;
  if (item.to.state !== "full" && rowStateOn(trip, item.date, now)?.state === "full") {
    return `${shortDay(item.date)}-ны үнийн мөр «дүүрсэн» гэж хадгалагдсан тул автоматаар нээхгүй — аяллын засварт тэр өдрийг нээнэ үү`;
  }
  return null;
}
