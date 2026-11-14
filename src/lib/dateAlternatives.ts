/**
 * The asked departure does not exist: the real departures CLOSEST to it, nearest first.
 *
 * Owner's client, 2026-11-13: "when a specific date like 11/11 is asked and there is none, the bot
 * should not just say no — it should offer close dates like 11/13 or 11/10 (basic business)". The
 * not-scheduled reply used to list each trip's SOONEST departures without ever looking at the date
 * the customer asked for, so a departure one day off could be left out while ones weeks away were
 * shown (2/8, 2/11, 2/22, 2/25 listed for an ask of 2/20 while 2/19 existed).
 *
 * Search ladder (the order a consultant uses): the trips passed in are already the customer's
 * destination and travel type where they stated one (routing scope); within them every bookable
 * departure is ranked by its distance to the asked date or window, so ±1–3 days come before ±7 and
 * before anything further. Only real, upcoming, on-sale departures are used: nothing is invented and a
 * closed date is never offered. The radius only decides the wording ("closest" vs "next"): the nearest
 * real departures are always shown when they exist.
 */
import type { TravelTrip } from "./travelTypes";
import { requestedDepartureScope, type RequestedDepartureScope } from "./travelDates";
import { dateIsOnSale, upcomingDepartures } from "./tripFareBlock";
import { customerDate } from "./customerDate";

/** Heading line of the nearest-dates reply; later turns recognise the reply by it. */
export const NEAREST_DATES_MARKER = "Хамгийн ойр гарах өдрүүд:";

const DAY_MS = 86_400_000;
const MAX_ROWS = 5;
const MAX_ROWS_PER_TRIP = 2;

/** Days either side of the asked date that count as "close" (env DATE_ALTERNATIVE_RADIUS_DAYS, default 7). */
export function dateAlternativeRadiusDays(): number {
  const raw = Number(process.env.DATE_ALTERNATIVE_RADIUS_DAYS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 60 ? raw : 7;
}

export type AskedWindow = { start: string; end: string; label: string };

const shiftYmd = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The asked time as a window with the words the reply uses for it; null for a time the parser could not place. */
export function askedWindowOf(scope: RequestedDepartureScope | null, now = new Date()): AskedWindow | null {
  if (!scope || scope.kind === "unsupported") return null;
  if (scope.kind === "dates") {
    const dates = [...scope.dates].sort();
    if (!dates.length) return null;
    return { start: dates[0], end: dates.at(-1)!, label: `${dates.map((date) => customerDate(date, now)).join(", ")}-нд` };
  }
  if (scope.kind === "range") {
    return { start: scope.startYmd, end: scope.endYmd, label: `${customerDate(scope.startYmd, now)} – ${customerDate(scope.endYmd, now)}-ны хооронд` };
  }
  const first = `${scope.year}-${String(scope.month).padStart(2, "0")}-01`;
  const last = shiftYmd(`${scope.month === 12 ? scope.year + 1 : scope.year}-${String(scope.month === 12 ? 1 : scope.month + 1).padStart(2, "0")}-01`, -1);
  return { start: first, end: last, label: `${scope.month} сард` };
}

export type DateAlternative = { trip: TravelTrip; date: string; /** Signed days from the asked window: <0 before it, >0 after it. */ offsetDays: number };

/** Every bookable upcoming departure of the pool, nearest to the asked window first. */
export function nearestDepartureAlternatives(pool: TravelTrip[], window: AskedWindow, now = new Date(),
  options: { max?: number; perTrip?: number } = {}): DateAlternative[] {
  const rows: DateAlternative[] = [];
  for (const trip of pool) {
    if (trip.status !== "active") continue;
    for (const date of upcomingDepartures(trip, now)) {
      // upcomingDepartures keeps cancelled and full dates (a cancelled departure was offered as an alternative
      // in the audit): only a date the customer can still book is an alternative.
      if (!dateIsOnSale(trip, date, now)) continue;
      const offsetDays = date < window.start ? daysBetween(window.start, date) : date > window.end ? daysBetween(window.end, date) : 0;
      rows.push({ trip, date, offsetDays });
    }
  }
  rows.sort((a, b) => Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.date.localeCompare(b.date));
  const perTrip = new Map<string, number>();
  const picked: DateAlternative[] = [];
  for (const row of rows) {
    if (picked.length >= (options.max ?? MAX_ROWS)) break;
    const count = perTrip.get(row.trip.id) ?? 0;
    if (count >= (options.perTrip ?? MAX_ROWS_PER_TRIP)) continue;
    if (picked.some((other) => other.trip.id === row.trip.id && other.date === row.date)) continue;
    perTrip.set(row.trip.id, count + 1);
    picked.push(row);
  }
  return picked;
}

/**
 * Every bookable departure of the pool that is not one of the `anchors`, ranked by the distance to the CLOSEST
 * anchor, nearest first; `offsetDays` is signed from that closest anchor. Used when the customer turned down
 * one or several dates: with several, a span from the first to the last would make every date inside it look
 * "zero days away" (found in a before/after replay: a date between two rejected ones was offered as "0 days").
 */
export function departuresNearestTo(pool: TravelTrip[], anchors: string[], now = new Date(),
  options: { max?: number; perTrip?: number; /** Dates never offered (already offered before). */ exclude?: Set<string> } = {}): DateAlternative[] {
  if (!anchors.length) return [];
  const anchorSet = new Set(anchors);
  const rows: DateAlternative[] = [];
  for (const trip of pool) {
    if (trip.status !== "active") continue;
    for (const date of upcomingDepartures(trip, now)) {
      if (anchorSet.has(date) || options.exclude?.has(date) || !dateIsOnSale(trip, date, now)) continue;
      const offsetDays = anchors.map((anchor) => daysBetween(anchor, date)).sort((a, b) => Math.abs(a) - Math.abs(b) || a - b)[0];
      rows.push({ trip, date, offsetDays });
    }
  }
  rows.sort((a, b) => Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.date.localeCompare(b.date));
  const perTrip = new Map<string, number>();
  const picked: DateAlternative[] = [];
  for (const row of rows) {
    if (picked.length >= (options.max ?? MAX_ROWS)) break;
    const count = perTrip.get(row.trip.id) ?? 0;
    if (count >= (options.perTrip ?? MAX_ROWS_PER_TRIP)) continue;
    perTrip.set(row.trip.id, count + 1);
    picked.push(row);
  }
  return picked;
}

function offsetWords(offsetDays: number): string {
  if (offsetDays === 0) return "таны асуусан хугацаанд";
  return `${Math.abs(offsetDays)} хоногийн ${offsetDays < 0 ? "өмнө" : "дараа"}`;
}

/**
 * "<asked>-нд гарах аялал алга. Хамгийн ойр гарах өдрүүд: • <trip>: <date> (<n> хоногийн өмнө/дараа)" — the trip
 * first, the way the reply checker (verifyTripReply) reads which trip a date belongs to.
 * Null when the asked time cannot be placed or the pool has no bookable departure (the caller keeps its
 * own answer or hands over).
 */
/** The heading of the second list: other trips that leave around the asked date. */
export const SIMILAR_TRIPS_MARKER = "Тэр үеэр гарах өөр аяллууд:";
/** How far from the asked date another trip's departure still counts as "around then". */
const SIMILAR_RADIUS_DAYS = 3;
const MAX_SIMILAR_ROWS = 3;
/** The far side of the asked date is offered only within this many days (a date months away is not "near"). */
const OTHER_SIDE_MAX_DAYS = 31;

const transportOf = (trip: TravelTrip) => String(trip.extra?.transport_type ?? "");

/**
 * Other trips (outside the asked direction) that leave within a few days of the asked date, one row each: the
 * same travel kind as the asked trips first, then the nearest. A human consultant does this (owner, 2026-11-14:
 * "12.27 шанхай" got one Shanghai date while seven other trips left on 12/27: "give him similar trips").
 */
export function similarTripsAround(pool: TravelTrip[], others: TravelTrip[], window: AskedWindow, now = new Date()): DateAlternative[] {
  const poolIds = new Set(pool.map((trip) => trip.id));
  const kinds = new Set(pool.map(transportOf).filter(Boolean));
  const rows = nearestDepartureAlternatives(others.filter((trip) => !poolIds.has(trip.id)), window, now, { max: 200, perTrip: 1 })
    .filter((row) => Math.abs(row.offsetDays) <= SIMILAR_RADIUS_DAYS);
  const sameKind = (row: DateAlternative) => (kinds.has(transportOf(row.trip)) ? 0 : 1);
  return rows.sort((a, b) => sameKind(a) - sameKind(b) || Math.abs(a.offsetDays) - Math.abs(b.offsetDays) || a.date.localeCompare(b.date))
    .slice(0, MAX_SIMILAR_ROWS);
}

export function buildNearestDatesReply(pool: TravelTrip[], askText: string, now = new Date(), closingLines: string[] = [],
  options: { /** The rest of the customer-visible catalogue: other trips around the asked date are offered too. */ others?: TravelTrip[] } = {}): string | null {
  // "20-оос 25", "20 эсвэл 21": the parser keeps only the first day, so the label would drop the second one.
  if (/\d\s*(?:-?\s*(?:оос|өөс|аас|ээс)|эсвэл|esvel|esvl)\s*\d/iu.test(askText)) return null;
  const window = askedWindowOf(requestedDepartureScope(askText, now), now);
  if (!window) return null;
  const ranked = nearestDepartureAlternatives(pool, window, now);
  // A trip of the pool DOES leave in the asked time: "no trip then" would be false (the caller keeps its answer).
  if (!ranked.length || ranked.some((row) => row.offsetDays === 0)) return null;
  const radius = dateAlternativeRadiusDays();
  const close = Math.abs(ranked[0].offsetDays) <= radius;
  // Close dates exist: only those (a departure two weeks off is noise beside one a day away). None close:
  // the nearest few in calendar order (a list that runs backwards reads as broken), said to be the next ones.
  const alternatives = close ? ranked.filter((row) => Math.abs(row.offsetDays) <= radius) : [...ranked.slice(0, 3)].sort((a, b) => a.date.localeCompare(b.date));
  // Close dates only on one side of the asked date: the nearest one on the other side too, within a month
  // (a customer who cannot leave earlier is not served by earlier dates alone; owner, 2026-11-14: "more options").
  if (close) {
    const hasBefore = alternatives.some((row) => row.offsetDays < 0);
    const hasAfter = alternatives.some((row) => row.offsetDays > 0);
    if (hasBefore !== hasAfter) {
      const wide = nearestDepartureAlternatives(pool, window, now, { max: 200, perTrip: 200 });
      const otherSide = wide.find((row) => (hasBefore ? row.offsetDays > 0 : row.offsetDays < 0) && Math.abs(row.offsetDays) <= OTHER_SIDE_MAX_DAYS);
      if (otherSide) alternatives.push(otherSide);
    }
  }
  const similar = options.others?.length ? similarTripsAround(pool, options.others, window, now) : [];
  const rows = alternatives.length + similar.length;
  return [
    // Other trips DO leave then: the heading says the asked direction has none, not that nothing leaves.
    `${similar.length ? "Энэ чиглэлд " : ""}${window.label} гарах аялал алга.`,
    NEAREST_DATES_MARKER,
    // "1 хоногийн өмнө" helps beside a near miss; beside a date weeks away it is noise.
    ...alternatives.map((row) => `• ${row.trip.route_name}: ${customerDate(row.date, now)}${close ? ` (${offsetWords(row.offsetDays)})` : ""}`),
    ...(similar.length ? ["", SIMILAR_TRIPS_MARKER, ...similar.map((row) => `• ${row.trip.route_name}: ${customerDate(row.date, now)}`)] : []),
    ...(closingLines.length ? ["", ...closingLines] : []),
    rows === 1 ? "Энэ өдөр танд тохирох уу? 😊" : similar.length ? "Эдгээрээс аль нь танд тохирох вэ? 😊"
      : close ? "Эдгээр өдрөөс аль нь танд тохирох вэ? 😊" : "Өөр хугацаа танд тохирох уу? 😊",
  ].join("\n");
}
