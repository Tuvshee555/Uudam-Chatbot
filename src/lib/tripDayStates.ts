/**
 * Seat state per departure day in a new-trip review: open, few seats (optionally how many), full.
 *
 * Why: a partner's schedule says it per row ("бүртгэж байна", "4 суудал үлдсэн", "дүүрсэн"). The
 * reader writes that on the row (status / seats_left), but the review merges rows with the same
 * price into one card, and a card cannot carry two states. Until 2026-11-11 the states were lost
 * and every date went on sale as open.
 *
 * How: when the proposal is built (tripProposalFinalize) the states move off the rows into the
 * review-only `extra.day_states` (one entry per calendar day), so cards merge by price alone and
 * the calendar shows each day's state. On save (tripReview.reviewedFields) they go back onto the
 * rows: a card whose days have different states is written as one row per state. A row says
 * "sold_out" for a full day and "almost_full" (+ seats_left) for few seats, which the fare card,
 * the website and the bot already read (tripOffers.availability).
 *
 * Pure.
 */
import { pricingDates } from "./adminDatePricing";
import { departureDays, mongoliaToday } from "./tripReview";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export type SeatState = "open" | "low" | "full";
export type DayState = { state: SeatState; seats: number | null };
export const DAY_STATES_KEY = "day_states";
/** At most this many seats left reads as «Цөөн суудал». */
export const FEW_SEATS = 5;

const seatsOf = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null);

/** A row's state as the reader wrote it; null for an ordinary open row with no seat count. */
export function rowDayState(row: Row): DayState | null {
  const status = text(row.status).toLowerCase();
  const seats = seatsOf(row.seats_left);
  if (["sold_out", "full", "closed"].includes(status) || seats === 0) return { state: "full", seats: null };
  // "12 суудал үлдсэн" is not few: only a handful left is flagged (the count is kept either way).
  if (["almost_full", "low", "few"].includes(status)) return { state: seats !== null && seats > FEW_SEATS ? "open" : "low", seats };
  return seats !== null ? { state: "open", seats } : null;
}

function groupsKey(extra: Row): "price_groups" | "departure_date_groups" {
  return records(extra.price_groups).length || !records(extra.departure_date_groups).length ? "price_groups" : "departure_date_groups";
}

const isDefault = (state: DayState) => state.state === "open" && state.seats === null;

/** The states the review holds, by calendar day (YYYY-MM-DD). */
export function dayStates(fields: Row): Record<string, DayState> {
  const raw = record(record(fields.extra)[DAY_STATES_KEY]);
  const out: Record<string, DayState> = {};
  for (const [day, value] of Object.entries(raw)) {
    const entry = record(value);
    const state = entry.state === "low" || entry.state === "full" || entry.state === "open" ? entry.state : null;
    if (!state) continue;
    out[day] = { state, seats: state === "full" ? null : seatsOf(entry.seats) };
  }
  return out;
}

/** One day's state set (null or plain "open" clears it). */
export function setDayState(fields: Row, day: string, state: DayState | null): Row {
  const next = { ...dayStates(fields) };
  if (!state || isDefault(state)) delete next[day];
  else next[day] = { state: state.state, seats: state.state === "full" ? null : state.seats };
  const extra = { ...record(fields.extra) };
  if (Object.keys(next).length) extra[DAY_STATES_KEY] = next;
  else delete extra[DAY_STATES_KEY];
  return { ...fields, extra };
}

/**
 * The rows' states moved into `extra.day_states`; the rows then carry prices only. A trip with a
 * partner's mirrored rows is left as it is (the partner sync owns those states).
 */
export function liftDayStates(fields: Row, now = new Date()): Row {
  const extra = record(fields.extra);
  const key = groupsKey(extra);
  const groups = records(extra[key]);
  if (!groups.length || groups.some((group) => group.partner_source === true)) return fields;
  const states: Record<string, DayState> = { ...dayStates(fields) };
  let moved = false;
  const rows = groups.map((group) => {
    const state = rowDayState(group);
    if (!("status" in group) && !("seats_left" in group)) return group;
    const { days } = departureDays(pricingDates(group, now), now);
    // A row naming no calendar day keeps its own state: there is no day to hold it.
    if (!days.length) return group;
    moved = true;
    if (state && !isDefault(state)) for (const day of days) states[day] = state;
    const { status: _status, seats_left: _seats, ...rest } = group;
    void _status; void _seats;
    return rest;
  });
  if (!moved) return fields;
  const next: Row = { ...extra, [key]: rows };
  if (Object.keys(states).length) next[DAY_STATES_KEY] = states;
  return { ...fields, extra: next };
}

function stateFields(state: DayState | undefined): Row {
  if (!state || isDefault(state)) return {};
  if (state.state === "full") return { status: "sold_out" };
  if (state.state === "low") return { status: "almost_full", ...(state.seats !== null ? { seats_left: state.seats } : {}) };
  return { seats_left: state.seats };
}

const stateId = (state: DayState | undefined) => (state && !isDefault(state) ? `${state.state}|${state.seats ?? ""}` : "");

/**
 * The review's day states written back onto the price rows, ready to save: a row whose days have
 * different states becomes one row per state. A day the trip prices with its own fares (no row)
 * gets a row of those fares carrying its state. `extra.day_states` is removed.
 */
export function lowerDayStates(fields: Row, now = new Date()): Row {
  const extra = { ...record(fields.extra) };
  const states = dayStates(fields);
  delete extra[DAY_STATES_KEY];
  if (!Object.keys(states).length) return { ...fields, extra };
  const key = groupsKey(extra);
  const calendar = new Set(departureDays(fields.departure_dates, now).days);
  const covered = new Set<string>();
  const rows: Row[] = [];
  for (const group of records(extra[key])) {
    const { days, other } = departureDays(pricingDates(group, now), now);
    days.forEach((day) => covered.add(day));
    const parts = new Map<string, string[]>();
    for (const day of days) parts.set(stateId(states[day]), [...(parts.get(stateId(states[day])) || []), day]);
    if (parts.size <= 1 && !stateId(states[days[0]])) {
      rows.push(group);
      continue;
    }
    for (const [id, partDays] of parts) {
      const dates = [...partDays, ...(id === "" ? other : [])];
      rows.push({ ...group, dates, date_keys: dates, display_dates: dates, ...stateFields(states[partDays[0]]) });
    }
    if (!parts.has("") && other.length) rows.push({ ...group, dates: other, date_keys: other, display_dates: other });
  }
  // Days priced by the trip's own fares: a row of those fares carries their state.
  const loose = new Map<string, string[]>();
  for (const [day, state] of Object.entries(states)) {
    if (covered.has(day) || !calendar.has(day) || isDefault(state)) continue;
    loose.set(stateId(state), [...(loose.get(stateId(state)) || []), day]);
  }
  // A row naming no date prices every departure (each hotel/package option): its copy dated to
  // those days carries their state, and the undated row still prices the other days.
  const everyDate = rows.filter((group) => !departureDays(pricingDates(group, now), now).days.length && !departureDays(pricingDates(group, now), now).other.length);
  if (loose.size && everyDate.length) {
    for (const days of loose.values()) {
      const sorted = days.sort();
      for (const group of everyDate) rows.push({ ...group, dates: sorted, date_keys: sorted, display_dates: sorted, ...stateFields(states[sorted[0]]) });
    }
  } else if (loose.size && typeof fields.adult_price === "number") {
    const bands = [
      ...(typeof fields.child_price === "number" ? [{ label: "Хүүхэд", age_range: "", price: fields.child_price, currency: "MNT" }] : []),
      ...(typeof fields.infant_price === "number" ? [{ label: "Нярай", age_range: "", price: fields.infant_price, currency: "MNT", ...(fields.infant_price === 0 ? { note: "Үнэгүй" } : {}) }] : []),
    ];
    for (const days of loose.values()) {
      const sorted = days.sort();
      rows.push({ dates: sorted, date_keys: sorted, display_dates: sorted, adult_price: fields.adult_price,
        child_price: fields.child_price ?? null, infant_price: fields.infant_price ?? null, passenger_prices: bands, ...stateFields(states[sorted[0]]) });
    }
  }
  extra[key] = rows;
  return { ...fields, extra };
}

/**
 * A price row dated in a past year on the same month and day as an upcoming calendar day is that
 * departure: the reader took the year from somewhere else on the page (2026-11-11: a partner page's
 * publish date «2024-10-01» turned every row into 2024/2025 while the calendar had 2026). Only an exact
 * month-day match with a coming calendar day is moved; a row truly in the past stays as it is.
 */
export function withRowYearsOfCalendar(fields: Row, now = new Date()): Row {
  const extra = record(fields.extra);
  const key = groupsKey(extra);
  const groups = records(extra[key]);
  if (!groups.length) return fields;
  const today = mongoliaToday(now);
  const coming = departureDays(fields.departure_dates, now).days.filter((day) => day >= today);
  const isPast = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date < today;
  // The reader used one wrong season for the whole table: the year gap the matching days show (2024 → 2026)
  // moves every past row, also the months the calendar did not list. Several different gaps: nothing moves.
  const gaps = new Set<number>();
  for (const group of groups) for (const date of (Array.isArray(group.dates) ? group.dates.map(String) : []).filter(isPast)) {
    for (const day of coming) if (day.slice(5) === date.slice(5)) gaps.add(Number(day.slice(0, 4)) - Number(date.slice(0, 4)));
  }
  if (gaps.size !== 1) return fields;
  const gap = [...gaps][0];
  let moved = false;
  const rows = groups.map((group) => {
    const dates = Array.isArray(group.dates) ? group.dates.map(String) : [];
    const next = dates.map((date) => {
      if (!isPast(date)) return date;
      const shifted = `${Number(date.slice(0, 4)) + gap}${date.slice(4)}`;
      return shifted >= today ? shifted : date;
    });
    if (next.every((date, index) => date === dates[index])) return group;
    moved = true;
    return { ...group, dates: next, date_keys: next, display_dates: next };
  });
  return moved ? { ...fields, extra: { ...extra, [key]: rows } } : fields;
}

/**
 * Every calendar day a price row names is a departure: a partner's schedule table lists each
 * departure once with its price, and the reader sometimes left some of them off the calendar
 * (2026-11-11: the January rows of a December–January table).
 */
export function withPricedDaysOnCalendar(fields: Row, now = new Date()): Row {
  const extra = record(fields.extra);
  const groups = records(extra[groupsKey(extra)]);
  if (!groups.length) return fields;
  const { days: calendar, other } = departureDays(fields.departure_dates, now);
  const known = new Set(calendar);
  const today = mongoliaToday(now);
  const added = groups.flatMap((group) => departureDays(pricingDates(group, now), now).days).filter((day) => day >= today && !known.has(day));
  if (!added.length) return fields;
  const days = [...new Set([...calendar, ...added])].sort();
  return { ...fields, departure_dates: [...days, ...other] };
}
