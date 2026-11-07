/**
 * What a trip costs and when it leaves, for the catalogue.
 *
 * Reads the ONE canonical fare resolver the bot already uses (tripOffers.ts: dated price rows,
 * hotel and package choices, per-date seat status), never a second price table and never prose.
 * "From" price = the MINIMUM ADULT fare among future departures that are still on sale. A zero
 * or placeholder fare is missing data, a contradictory date is left out, nothing is summed or
 * inferred. When nothing usable is left the card says "Үнэ лавлах" and a warning explains why.
 *
 * "Today" is always an Asia/Ulaanbaatar calendar day passed in by the caller; the clock is
 * never read here. A departure counts only when it is after today.
 */
import type { TravelTrip } from "../travelTypes";
import { pricingDays } from "../adminDatePricing";
import { isPlaceholderDepartureText, parseDepartureDateText } from "../travelDates";
import { dateIsOnSale, upcomingDepartures } from "../tripFareBlock";
import {
  normalizeTripOffers,
  resolveTripOffer,
  resolveTripOfferFareCard,
  resolveUndatedFareCard,
  type ResolvedTripOffer,
  type TripOfferSelection,
} from "../tripOffers";
import type { CatalogueDateInfo, CataloguePrice, CatalogueWarning, IsoDay } from "./types";
import { customerText, extractMntAmounts, finiteNumber, formatMnt, row, rows, text, warn } from "./diagnostics";

/** Same floor as the resolver and the bot: under 1,000₮ is a placeholder, never a fare. */
export const MIN_REAL_FARE_MNT = 1000;
export const MAX_DEPARTURES_SHOWN = 12;

const UB_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" });

/** The Asia/Ulaanbaatar calendar day of an instant. */
export function ubDay(at: Date | string): IsoDay {
  const date = typeof at === "string" ? new Date(at) : at;
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${String(at)}`);
  return UB_DAY.format(date);
}

/** An instant inside the given Ulaanbaatar day (noon), for the resolvers that take a Date. */
export function dayAsNow(day: IsoDay): Date {
  return new Date(`${day}T12:00:00+08:00`);
}

/** "2027-01-09" -> "2027.01.09" */
export const dotDay = (day: IsoDay): string => day.replace(/-/g, ".");

/* ------------------------------------------------------------------ fare scan */

type Probe = { amounts: number[]; conflict: boolean; missing: boolean; foreign: boolean };

export type DatedFare = { date: IsoDay | null; mnt: number };

export type FareScan = {
  /** The trip has at least one dated (calendar) offer. */
  hasCalendar: boolean;
  /** Future departures still on sale, ascending. */
  dates: IsoDay[];
  /** A RECOGNISED weekly schedule the calendar cannot date ("<гараг> бүр", "Пүрэв, Ням гариг"), customer-safe, or null. */
  recurringLabel: string | null;
  /** Departure text that is neither a date nor a recognised weekly pattern ("2026 оны 9 сар", "Лавлана"). Staff-facing; never printed. */
  unrecognisedSchedule: string[];
  /** Every usable adult fare per date (all hotels / packages), ascending by amount then date. */
  fares: DatedFare[];
  conflictDates: IsoDay[];
  missingDates: IsoDay[];
  foreign: boolean;
  /** Raw price rows that carry a 0 / placeholder adult fare for a future date. */
  zeroRows: number;
};

function adultFare(offer: ResolvedTripOffer): { mnt: number | null; foreign: boolean } {
  if (offer.currency !== "MNT") return { mnt: null, foreign: true };
  const fare = offer.prices.adult;
  if (!fare) return { mnt: null, foreign: false };
  if (fare.kind === "exact") return { mnt: fare.amount >= MIN_REAL_FARE_MNT ? fare.amount : null, foreign: false };
  if (fare.kind === "range") return { mnt: fare.min >= MIN_REAL_FARE_MNT ? fare.min : null, foreign: false };
  return { mnt: null, foreign: false };
}

/** Every adult fare one departure (or the undated schedule) sells, hotel by hotel and package by package. */
function probe(trip: TravelTrip, date: IsoDay | null, now: Date): Probe {
  const out: Probe = { amounts: [], conflict: false, missing: false, foreign: false };
  const visit = (selection: TripOfferSelection, depth: number) => {
    const card = date === null
      ? resolveUndatedFareCard(trip, selection, now)
      : resolveTripOfferFareCard(trip, { ...selection, date, passengers: [] }, now);
    if (card.status === "ready") {
      if (date !== null) {
        const sale = resolveTripOffer(trip, { ...selection, date, passengers: [] }, now);
        if (sale.status === "unavailable") return; // this hotel / package is full or paused on that date
      }
      const { mnt, foreign } = adultFare(card.offer);
      if (foreign) out.foreign = true;
      if (mnt !== null) out.amounts.push(mnt);
      else if (!foreign) out.missing = true;
      return;
    }
    if (card.status === "needs_selection" && depth < 2 && (card.fields.includes("hotel") || card.fields.includes("package"))) {
      const byHotel = card.fields.includes("hotel");
      for (const option of card.options) {
        const next: TripOfferSelection = byHotel ? { ...selection, hotel: option } : { ...selection, packageId: option };
        const named = date === null ? resolveUndatedFareCard(trip, next, now) : resolveTripOfferFareCard(trip, { ...next, date, passengers: [] }, now);
        if (byHotel && (named.status === "missing" || named.status === "unavailable")) {
          visit({ ...selection, hotelId: option }, depth + 1);
        } else visit(next, depth + 1);
      }
      return;
    }
    if (card.status === "conflict") out.conflict = true;
    else if (card.status === "missing" || card.status === "needs_selection") out.missing = true;
    // "unavailable": a closed departure is simply not offered.
  };
  visit({}, 0);
  return out;
}

const WEEKDAY_WORD = /(?<![\p{L}])(?:даваа|мягмар|лхагва|пүрэв|баасан|бямба|ням)\p{L}{0,3}(?![\p{L}])/giu;
const SCHEDULE_FILLER = /(?<![\p{L}])(?:гараг|гариг|гарагт|гаригт|гарагийн|гаригийн|бүр|бүрийн|бүрд|болгон|тутам|тутамд|долоо|хоног|хоногт|өдөр|цаг|цагт|цагийн|ба|болон|эсвэл)(?![\p{L}])/giu;

/**
 * Is this departure text a RECOGNISED weekly (or daily) pattern: weekday names with the usual
 * filler ("Пүрэв гараг бүр", "Пүрэв, Ням гариг", "Мягмар гаригт 10:00 цагт") or "өдөр бүр" /
 * "долоо хоног бүр"? Anything else that is not a calendar date ("2026 оны 9 сар", "Лавлана",
 * "Өвөл", a past month) says nothing about when the trip leaves, so it is NOT a schedule.
 */
export function isWeeklyScheduleText(value: string): boolean {
  let rest = ` ${value.toLowerCase()} `
    .replace(/\d{1,2}\s*[:.]\s*\d{2}/g, " ") // 10:00
    .replace(/\d{1,2}\s*цаг\p{L}*/giu, " ") // 10 цагт
    .replace(/(?<![\d])7\s*хоног/giu, " хоног "); // 7 хоног бүр
  const hasWeekday = new RegExp(WEEKDAY_WORD.source, "iu").test(rest);
  const hasRecurrence = /(?<![\p{L}])(?:бүр|бүрийн|бүрд|болгон|тутам|тутамд)(?![\p{L}])/iu.test(rest);
  const hasPeriod = /(?<![\p{L}])(?:өдөр|хоног)(?![\p{L}])/iu.test(rest);
  rest = rest.replace(WEEKDAY_WORD, " ").replace(SCHEDULE_FILLER, " ").replace(/[\s,;/&+\-–—.()]+/g, "");
  if (rest) return false;
  return hasWeekday || (hasRecurrence && hasPeriod);
}

/** Departure text the calendar cannot date: the recognised weekly schedule (customer-safe) and everything else (staff-facing). */
function undatedSchedule(trip: TravelTrip, now: Date): { weekly: string | null; other: string[] } {
  const undated = (trip.departure_dates || [])
    .map((entry) => text(entry))
    .filter((entry) => entry && !isPlaceholderDepartureText(entry) && parseDepartureDateText(entry, now).length === 0);
  const weekly = [...new Set(undated.filter(isWeeklyScheduleText).map((entry) => customerText(entry)).filter(Boolean))];
  const other = [...new Set(undated.filter((entry) => !isWeeklyScheduleText(entry)))];
  return { weekly: weekly.length ? weekly.slice(0, 2).join(", ") : null, other: other.slice(0, 3) };
}

const ADULT_LABEL = /том хүн|насанд хүр|adult/i;

/** Rows of the trip's own price data that put a 0 (or a sub-1,000 placeholder) on an adult fare for a future date. */
function countZeroRows(trip: TravelTrip, today: IsoDay, now: Date, undated: boolean): number {
  const extra = row(trip.extra);
  const isZero = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value < MIN_REAL_FARE_MNT;
  const documentedFree = (raw: Record<string, unknown>) => raw.free === true || raw.adult_price_free === true || /үнэгүй|\bfree\b/i.test(text(raw.note));
  let count = 0;
  if (isZero(trip.adult_price) && !(trip.adult_price === 0 && documentedFree(extra))) count += 1;
  for (const group of rows(extra.price_groups)) {
    const days = pricingDays(group, now);
    const relevant = days.length ? days.some((day) => day > today) : undated;
    if (!relevant) continue;
    const adultTier = rows(group.passenger_prices).some((tier) => ADULT_LABEL.test(text(tier.label)) && isZero(tier.price) && !documentedFree(tier));
    if ((isZero(group.adult_price) && !documentedFree(group)) || adultTier) count += 1;
  }
  return count;
}

const scanCache = new WeakMap<TravelTrip, Map<IsoDay, FareScan>>();

/** Everything the catalogue knows about a trip's future departures and adult fares. Memoised per trip object and day. */
export function scanTripFares(trip: TravelTrip, today: IsoDay): FareScan {
  const cached = scanCache.get(trip)?.get(today);
  if (cached) return cached;
  const now = dayAsNow(today);
  const offers = normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount");
  const hasCalendar = offers.some((offer) => offer.dates.length > 0);
  const undated = hasCalendar ? { weekly: null, other: [] as string[] } : undatedSchedule(trip, now);
  const recurringLabel = undated.weekly;
  const scan: FareScan = { hasCalendar, dates: [], recurringLabel, unrecognisedSchedule: undated.other, fares: [], conflictDates: [], missingDates: [], foreign: false, zeroRows: 0 };

  const take = (date: IsoDay | null, result: Probe) => {
    if (result.foreign) scan.foreign = true;
    for (const mnt of result.amounts) scan.fares.push({ date, mnt });
    if (date !== null) {
      if (result.conflict && !result.amounts.length) scan.conflictDates.push(date);
      else if (result.missing && !result.amounts.length && !result.foreign) scan.missingDates.push(date);
    }
  };
  if (hasCalendar) {
    scan.dates = upcomingDepartures(trip, now).filter((date) => date > today && dateIsOnSale(trip, date, now));
    for (const date of scan.dates) take(date, probe(trip, date, now));
  } else if (recurringLabel) {
    take(null, probe(trip, null, now));
  }
  scan.fares.sort((a, b) => a.mnt - b.mnt || (a.date ?? "").localeCompare(b.date ?? ""));
  scan.zeroRows = countZeroRows(trip, today, now, !hasCalendar);
  const byDay = scanCache.get(trip) ?? new Map<IsoDay, FareScan>();
  byDay.set(today, scan);
  scanCache.set(trip, byDay);
  return scan;
}

/* ------------------------------------------------------------------ eligibility */

const STATUS_REASON: Record<string, string> = {
  archived: "Архивлагдсан аялал",
  draft: "Ноорог аялал",
  paused: "Түр зогсоосон аялал",
  sold_out: "Суудал дүүрсэн аялал",
  cancelled: "Цуцлагдсан аялал",
};

function unrecognisedReason(scan: FareScan): string {
  return `Явах огноо тодорхой биш: «${scan.unrecognisedSchedule.join("», «")}». Тодорхой огноо эсвэл «Пүрэв гараг бүр» хэлбэрээр бичнэ үү`;
}

/** May this trip appear in a catalogue printed on `today`, and if not, why (Mongolian, for staff). */
export function isTripEligible(trip: TravelTrip, today: IsoDay): { eligible: boolean; reason: string | null } {
  const no = (reason: string) => ({ eligible: false, reason });
  if (!text(trip.route_name)) return no("Аяллын нэр хоосон");
  if (trip.status !== "active") return no(STATUS_REASON[trip.status] ?? `Идэвхгүй аялал (${String(trip.status)})`);
  const extra = row(trip.extra);
  if (extra.customer_visible === false || (trip as unknown as Record<string, unknown>).customer_visible === false) {
    return no("Хэрэглэгчид харагдахгүй гэж тохируулсан");
  }
  if (extra.website_published === false) return no("Вэбсайтад нийтлээгүй");
  const scan = scanTripFares(trip, today);
  if (scan.hasCalendar) {
    return scan.dates.length ? { eligible: true, reason: null } : no("Захиалах боломжтой ирээдүйн огноо алга (өнгөрсөн, дүүрсэн эсвэл зогссон)");
  }
  if (scan.recurringLabel) return { eligible: true, reason: null };
  if (scan.unrecognisedSchedule.length) return no(unrecognisedReason(scan));
  return no("Явах огноо бүртгэгдээгүй");
}

/* ------------------------------------------------------------------ starting price */

function whyNoPrice(scan: FareScan): string {
  if (scan.conflictDates.length) return `огнооны үнэ өөр хоорондоо зөрж байна (${scan.conflictDates.slice(0, 3).join(", ")})`;
  if (scan.foreign && !scan.fares.length) return "үнэ төгрөгөөр биш байна";
  if (scan.zeroRows) return "үнэ 0₮ эсвэл бөглөөгүй байна";
  return "насанд хүрэгчийн огноот үнэ бүртгэгдээгүй байна";
}

/**
 * The card's price: the minimum adult fare among future, on-sale departures, with the date that
 * fare belongs to. Missing or contradictory data gives "Үнэ лавлах" and a warning, never a guess.
 */
export function deriveStartingPrice(trip: TravelTrip, today: IsoDay): { price: CataloguePrice; warnings: CatalogueWarning[] } {
  const scan = scanTripFares(trip, today);
  const warnings: CatalogueWarning[] = [];
  const inquire: CataloguePrice = { kind: "inquire", display: "Үнэ лавлах" };
  if (scan.zeroRows) {
    warnings.push(warn("price_zero", "warning",
      `${scan.zeroRows} үнийн мөрөнд 0₮ эсвэл 1,000₮-өөс бага үнэ байна — үнэгүй гэж үзэлгүй, дутуу мэдээлэл гэж тооцсон.`, trip.id, { rows: scan.zeroRows }));
  }
  if (!scan.hasCalendar && !scan.recurringLabel) {
    warnings.push(warn("dates_missing", "warning", scan.unrecognisedSchedule.length
      ? `${unrecognisedReason(scan)}. Иймд «Үнэ лавлах», «Явах огноог лавлана» гэж харуулна.`
      : "Явах огноо бүртгэгдээгүй тул «Үнэ лавлах» гэж харуулна.", trip.id, scan.unrecognisedSchedule.length ? { texts: scan.unrecognisedSchedule.length } : undefined));
    return { price: inquire, warnings };
  }
  if (scan.hasCalendar && !scan.dates.length) {
    warnings.push(warn("no_future_departure", "warning", "Захиалах боломжтой ирээдүйн огноо алга тул «Үнэ лавлах» гэж харуулна.", trip.id));
    return { price: inquire, warnings };
  }
  const first = scan.fares[0];
  if (!first) {
    warnings.push(warn("price_missing", "warning", `Огноот үнэ тодорхойгүй: ${whyNoPrice(scan)}. «Үнэ лавлах» гэж харуулна.`, trip.id,
      { conflictDates: scan.conflictDates.length, missingDates: scan.missingDates.length }));
    return { price: inquire, warnings };
  }
  const skipped = scan.conflictDates.length + scan.missingDates.length;
  if (skipped) {
    warnings.push(warn("price_missing", "warning",
      `${skipped} огнооны насанд хүрэгчийн үнэ тодорхойгүй (${[...scan.conflictDates, ...scan.missingDates].slice(0, 3).join(", ")}) — «${formatMnt(first.mnt)}-с» нь зөвхөн үнэ нь тодорхой огноонуудаас гарсан.`,
      trip.id, { conflictDates: scan.conflictDates.length, missingDates: scan.missingDates.length }));
  }
  return { price: { kind: "from", amountMnt: first.mnt, date: first.date, display: `${formatMnt(first.mnt)}-с` }, warnings };
}

/* ------------------------------------------------------------------ dates */

/** Future on-sale departures and the one line the card prints. Never an invented schedule. */
export function deriveDateInfo(trip: TravelTrip, today: IsoDay): CatalogueDateInfo {
  const scan = scanTripFares(trip, today);
  const all = scan.dates;
  const departures = all.slice(0, MAX_DEPARTURES_SHOWN);
  let label = "Явах огноог лавлана";
  if (departures.length === 1) label = `Хөдлөх огноо: ${dotDay(departures[0])}`;
  else if (departures.length > 1 && departures.length <= 3) label = `Хөдлөх огноо: ${departures.map(dotDay).join(", ")}`;
  else if (departures.length > 3) {
    const rest = all.length - 3;
    label = `Ойрын огноо: ${departures.slice(0, 3).map(dotDay).join(", ")}${rest > 0 ? ` болон өөр ${rest} огноо` : ""}`;
  } else if (scan.recurringLabel) label = scan.recurringLabel;
  return { nextDeparture: departures[0] ?? null, departures, label };
}

/* ------------------------------------------------------------------ overview vs dated fare */

const PROSE_FIELDS: Array<{ field: string; label: string; read: (trip: TravelTrip) => unknown }> = [
  { field: "notes", label: "Тайлбар (notes)", read: (t) => t.notes },
  { field: "source_description", label: "Эх тайлбар (source_description)", read: (t) => t.source_description },
  { field: "website_summary", label: "Вэбсайтын товч тайлбар", read: (t) => row(t.extra).website_summary },
  { field: "marketing_badge", label: "Маркетингийн тэмдэг", read: (t) => row(t.extra).marketing_badge },
  { field: "website_description", label: "Вэбсайтын тайлбар", read: (t) => row(row(t.extra).website_details).description },
  { field: "website_overview", label: "Вэбсайтын тойм", read: (t) => row(row(t.extra).website_details).summary },
];

/**
 * Prose (overview, summary, notes, marketing text) that quotes an adult price different from the
 * authoritative dated fare. The catalogue always prints the dated fare; each conflict is a
 * 'price_conflict' warning naming the field and both amounts, so staff can fix the stale copy.
 * A poster's subtitle / price description can be passed as `poster`. Child, deposit, discount
 * and supplement clauses are not adult-fare claims and are left alone.
 */
export function findOverviewPriceConflicts(trip: TravelTrip, today: IsoDay, poster?: unknown): CatalogueWarning[] {
  const scan = scanTripFares(trip, today);
  if (!scan.fares.length) return [];
  const dated = new Set(scan.fares.map((fare) => fare.mnt));
  const from = scan.fares[0].mnt;
  const sources = PROSE_FIELDS.map(({ field, label, read }) => ({ field, label, value: text(read(trip)) }));
  const posterRow = row(poster);
  sources.push({ field: "poster_subtitle", label: "Постерын дэд гарчиг", value: text(posterRow.subtitle) },
    { field: "poster_price_desc", label: "Постерын үнийн тайлбар", value: text(posterRow.price_desc) });
  const out: CatalogueWarning[] = [];
  const seen = new Set<string>();
  for (const { field, label, value } of sources) {
    if (!value) continue;
    for (const amount of extractMntAmounts(value)) {
      if (amount.nonAdult || dated.has(amount.amountMnt)) continue;
      const key = `${field}:${amount.amountMnt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const stale = amount.amountMnt < from;
      out.push(warn("price_conflict", "warning",
        `${label}-д ${formatMnt(amount.amountMnt)} гэж бичсэн боловч огноот үнэ ${formatMnt(from)} байна${stale ? " (тайлбар дахь үнэ хуучирсан, хямд байна)" : ""}. Каталогт зөвхөн огноот үнийг (${formatMnt(from)}-с) гаргана — тайлбарыг засна уу.`,
        trip.id, { field, overviewMnt: amount.amountMnt, datedMnt: from, staleCheaper: stale }));
      if (out.length >= 4) return out;
    }
  }
  // The website's own "price" column, when it disagrees with every dated adult fare.
  const rawWebsitePrice = row(row(trip.extra).website_details).price;
  const websitePrice = finiteNumber(typeof rawWebsitePrice === "string" && rawWebsitePrice.trim() ? Number(rawWebsitePrice) : rawWebsitePrice);
  if (websitePrice !== null && websitePrice >= MIN_REAL_FARE_MNT && !dated.has(Math.round(websitePrice))) {
    out.push(warn("price_conflict", "info",
      `Вэбсайтын «үнэ» талбарт ${formatMnt(websitePrice)} байна, огноот үнэ ${formatMnt(from)}. Каталогт огноот үнийг гаргана.`,
      trip.id, { field: "website_price", overviewMnt: Math.round(websitePrice), datedMnt: from, staleCheaper: websitePrice < from }));
  }
  return out;
}
