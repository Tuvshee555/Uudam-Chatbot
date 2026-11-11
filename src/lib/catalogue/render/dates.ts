/**
 * Departure dates as the book prints them. Pure and browser-free: the page plan (and so every page
 * number printed in the guide) and the HTML builder share these decisions.
 *
 * One date format everywhere: month lines such as "11-р сар: 10 · 17 · 24" and, when the year differs
 * from the year the book was issued, "2027 оны 1-р сар: 05 · 12". A single full date (the "next
 * departure" fallback) reads "2027 оны 1-р сарын 09". Dates are never altered or invented.
 */
import type { CatalogueDeparture, CatalogueTripCard, IsoDay } from "../types";

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Rolling window the trip pages print, in days (the data layer reports its own in dates.windowDays). */
export const DEFAULT_WINDOW_DAYS = 90;
/** A trip page prints month lines up to this many dates / month lines, a compact day grid beyond it. */
export const TRIP_LINES_MAX_DATES = 12;
export const TRIP_LINES_MAX_MONTHS = 3;
/** The day grid never prints more month rows than this when the window is very dense (e.g. daily departures). */
export const TRIP_GRID_MAX_ROWS = 4;
export const TRIP_GRID_DENSE_DATES = 31;

export const NO_DATES_PLAIN = "Явах огноог лавлана";
export const PRICE_VARIES_NOTE = "Үнэ огнооноос хамаарна";
export const NEXT_DEPARTURE_LABEL = "Хамгийн ойрын хөдөлгөөн";

export const pad = (n: number) => String(n).padStart(2, "0");

export function isIsoDay(value: unknown): value is IsoDay {
  return typeof value === "string" && ISO_DAY.test(value);
}

/** "2027-01-09" + days -> ISO day (calendar arithmetic in UTC, no clock involved). */
export function addDays(iso: IsoDay, days: number): IsoDay {
  const m = ISO_DAY.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** "11-р сар" (month word in the numeric style the owner approved). */
export const monthWord = (month: number) => `${month}-р сар`;

/** "2027 оны 1-р сарын 09": the one full-date form (used where a single departure stands alone). */
export function fullDate(iso: IsoDay): string {
  const m = ISO_DAY.exec(iso);
  return m ? `${m[1]} оны ${Number(m[2])}-р сарын ${m[3]}` : iso;
}

export const moneyMnt = (amount: number) => `${Math.round(amount).toLocaleString("en-US")}₮`;

export type MonthLine = {
  /** "2026-11" */
  key: string;
  year: number;
  month: number;
  /** "11-р сар", or "2027 оны 1-р сар" when the year differs from the issue year. */
  label: string;
  /** Two-digit days, ascending. */
  days: string[];
  /** The adult fare of this run (fare mode only); null = none recorded. */
  fare: number | null;
  /** "11-р сар: 10 · 17 · 24" (fare mode appends " — 3,990,000₮"). */
  text: string;
};

type Dep = { date: IsoDay; adultMnt: number | null };

function normalise(list: ReadonlyArray<IsoDay | CatalogueDeparture> | null | undefined): Dep[] {
  const seen = new Set<string>();
  const out: Dep[] = [];
  for (const item of list ?? []) {
    const date = typeof item === "string" ? item : item?.date;
    if (!isIsoDay(date) || seen.has(date)) continue;
    seen.add(date);
    const fare = typeof item === "string" ? null : item.adultMnt;
    out.push({ date, adultMnt: typeof fare === "number" && Number.isFinite(fare) && fare > 0 ? fare : null });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Departures grouped by calendar month, ascending. The year is printed only when it differs from
 * `refYear` (the year the book was issued). With `fares: true` a month is split into runs of equal
 * adult fare, one line per run: "11-р сар: 10 · 17 — 3,990,000₮".
 */
export function groupDatesByMonth(
  list: ReadonlyArray<IsoDay | CatalogueDeparture> | null | undefined,
  refYear: string | number,
  opts: { fares?: boolean } = {},
): MonthLine[] {
  const ref = Number(refYear);
  const lines: MonthLine[] = [];
  const anyFare = opts.fares === true;
  for (const dep of normalise(list)) {
    const m = ISO_DAY.exec(dep.date)!;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const key = `${m[1]}-${m[2]}`;
    const last = lines[lines.length - 1];
    if (last && last.key === key && (!anyFare || last.fare === dep.adultMnt)) {
      last.days.push(m[3]!);
      continue;
    }
    lines.push({ key, year, month, label: year === ref ? monthWord(month) : `${year} оны ${monthWord(month)}`, days: [m[3]!], fare: anyFare ? dep.adultMnt : null, text: "" });
  }
  for (const line of lines) {
    const fare = anyFare ? ` — ${line.fare != null ? moneyMnt(line.fare) : "үнэ лавлах"}` : "";
    line.text = `${line.label}: ${line.days.join(" · ")}${fare}`;
  }
  return lines;
}

/** Number of distinct non-null adult fares in a departure list. */
export function distinctFares(list: ReadonlyArray<CatalogueDeparture> | null | undefined): number {
  return new Set((list ?? []).map(d => d.adultMnt).filter((n): n is number => typeof n === "number" && n > 0)).size;
}

export function scheduleOf(card: CatalogueTripCard, asOfDay: IsoDay): Dep[] {
  const raw = card.dates.schedule ?? card.dates.departures ?? [];
  return normalise(raw).filter(d => d.date >= asOfDay);
}

export function windowOf(card: CatalogueTripCard, asOfDay: IsoDay): Dep[] {
  if (card.dates.window) return normalise(card.dates.window).filter(d => d.date >= asOfDay);
  const end = addDays(asOfDay, card.dates.windowDays ?? DEFAULT_WINDOW_DAYS);
  return scheduleOf(card, asOfDay).filter(d => d.date <= end);
}

/** True when the departures do not share one adult fare (the data layer's flag, or derived from the dated fares). */
export function priceVariesOf(card: CatalogueTripCard, asOfDay: IsoDay): boolean {
  if (typeof card.dates.priceVaries === "boolean") return card.dates.priceVaries;
  return distinctFares(scheduleOf(card, asOfDay)) > 1;
}

/**
 * The data layer's own wording for recurring / weekly trips ("every Friday"). A generated date list
 * ("Ойрын огноо: 2026.11.14, ...") or an inquiry phrase is not a rule and is never repeated.
 */
export function recurringNote(card: CatalogueTripCard): string | null {
  const label = (card.dates.label ?? "").replace(/\s+/g, " ").trim();
  if (!label || /лавлана/iu.test(label) || /\d{4}[.\-]\d{2}[.\-]\d{2}/.test(label) || /^Ойрын огноо/iu.test(label)) return null;
  return label.length > 90 ? null : label;
}

export type TripDates = {
  /** lines = month lines, grid = compact day grid, next = only the nearest departure is known, plain = no dates. */
  kind: "lines" | "grid" | "next" | "plain";
  /** The window, grouped by month. */
  lines: MonthLine[];
  windowCount: number;
  scheduleCount: number;
  /** "2027 оны 1-р сарын 09" when the window is empty but a later departure exists. */
  nextFull: string | null;
  plain: string;
  priceVaries: boolean;
  recurring: string | null;
  /** The book carries a schedule-appendix block for this trip. */
  hasSchedule: boolean;
};

export function tripDates(card: CatalogueTripCard, asOfDay: IsoDay): TripDates {
  const refYear = asOfDay.slice(0, 4);
  const schedule = scheduleOf(card, asOfDay);
  const win = windowOf(card, asOfDay);
  const lines = groupDatesByMonth(win, refYear);
  const nextDay = card.dates.nextDeparture && isIsoDay(card.dates.nextDeparture) && card.dates.nextDeparture >= asOfDay ? card.dates.nextDeparture : (schedule[0]?.date ?? null);
  const plain = (card.dates.label ?? "").trim() || NO_DATES_PLAIN;
  const kind: TripDates["kind"] = win.length > 0 ? (win.length > TRIP_LINES_MAX_DATES || lines.length > TRIP_LINES_MAX_MONTHS ? "grid" : "lines") : nextDay ? "next" : "plain";
  return {
    kind,
    lines,
    windowCount: win.length,
    scheduleCount: schedule.length,
    nextFull: win.length === 0 && nextDay ? fullDate(nextDay) : null,
    plain,
    priceVaries: priceVariesOf(card, asOfDay),
    recurring: kind === "plain" ? null : recurringNote(card),
    hasSchedule: schedule.length > 0,
  };
}

/** A trip's block in the schedule appendix: every future departure, with fares when they differ. */
export function scheduleLines(card: CatalogueTripCard, asOfDay: IsoDay): { lines: MonthLine[]; priceVaries: boolean } {
  const priceVaries = priceVariesOf(card, asOfDay);
  return { lines: groupDatesByMonth(scheduleOf(card, asOfDay), asOfDay.slice(0, 4), { fares: priceVaries }), priceVaries };
}
