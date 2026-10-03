import { parseTripDepartureDateText } from "./travelDates";
import type { TravelTrip } from "./travelTypes";

export type PassengerKind = "adult" | "child" | "infant";
export type PassengerSelection = {
  kind?: PassengerKind;
  age?: number;
  ageUnit?: "year" | "month";
  birthYear?: number;
  count: number;
};
export type TripOfferSelection = {
  tripId?: string | null;
  date?: string | null;
  hotel?: string | null;
  hotelId?: string | null;
  packageId?: string | null;
  package?: string | null;
  passengers?: PassengerSelection[];
  discountId?: string | null;
  confirmedDiscountConditions?: string[];
};
export type OfferFare =
  | { kind: "exact"; amount: number }
  | { kind: "free"; amount: 0 }
  | { kind: "range"; min: number; max: number }
  | { kind: "unknown"; reason: string };
export type OfferAgeBand =
  | { unit: "month"; min: number; maxExclusive: number | null }
  | { unit: "birth_year"; min: number; max: number };
export type NormalizedPassengerFare = {
  kind: PassengerKind;
  ageRange: string | null;
  ageBand: OfferAgeBand | null;
  fare: OfferFare;
  currency: string;
  sourceOfferId: string;
  /** Passenger rows > child rules > derived scalar summaries. */
  priority: number;
  issues: string[];
};
export type OfferAvailability = {
  status: "open" | "unknown" | "sold_out" | "paused" | "cancelled" | "departed" | "unavailable" | "conflict";
  seatsLeft: number | null;
};
export type CanonicalTripOffer = {
  id: string;
  source: "base" | "price_group" | "legacy" | "discount";
  dates: string[];
  dateScoped: boolean;
  hotel: string | null;
  hotelId: string | null;
  packageId: string | null;
  currency: string;
  fares: NormalizedPassengerFare[];
  supplementalFares: Array<{ label: string; fare: OfferFare; currency: string }>;
  availability: Array<OfferAvailability & { date: string }>;
  discount: { condition: string | null; validFrom: string | null; validUntil: string | null; active: boolean } | null;
  issues: string[];
};
export type ResolvedPassengerPrice = {
  kind: PassengerKind;
  age: number | null;
  ageUnit: "year" | "month";
  count: number;
  fare: OfferFare;
  lineTotal: OfferFare;
  sourceOfferId: string;
  ageRange: string | null;
};
export type ResolvedTripOffer = {
  id: string;
  tripId: string;
  date: string;
  hotel: string | null;
  hotelId: string | null;
  packageId: string | null;
  currency: string;
  prices: Partial<Record<PassengerKind, OfferFare>>;
  fares: NormalizedPassengerFare[];
  passengerPrices: ResolvedPassengerPrice[];
  total: OfferFare | null;
  availability: OfferAvailability;
  sourceOfferIds: string[];
  conditions: string[];
};
export type OfferSelectionField = "date" | "hotel" | "package" | "passengers" | "discount_condition";
export type TripOfferResult =
  | { status: "ready"; offer: ResolvedTripOffer }
  | { status: "needs_selection"; reason: string; fields: OfferSelectionField[]; options: string[] }
  | { status: "unavailable"; reason: string; date: string | null; availability?: OfferAvailability }
  | { status: "missing"; reason: string }
  | { status: "conflict"; reason: string; issues: string[] };
export type TripOfferPriceSummary =
  | { status: "ready"; summary: Pick<ResolvedTripOffer, "hotel" | "hotelId" | "packageId" | "currency" | "prices" | "fares" | "sourceOfferIds" | "conditions"> & { dates: string[] } }
  | Exclude<TripOfferResult, { status: "ready" }>;
export type TripOfferSummarySelection = Omit<TripOfferSelection, "date" | "passengers">;

type Row = Record<string, unknown>;
const KINDS: PassengerKind[] = ["adult", "child", "infant"];
const SOURCE_PRIORITY = { base: 0, legacy: 1, price_group: 2, discount: 3 };
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.filter((v) => Object.keys(row(v)).length > 0).map(row) : [];
const str = (value: unknown): string => typeof value === "string" ? value.trim() : "";
const strings = (value: unknown): string[] => Array.isArray(value) ? value.map(str).filter(Boolean) : [];
const key = (value: string | null | undefined) => (value || "").trim().toLowerCase().replace(/\s+/g, " ");
const unique = <T>(values: T[]): T[] => [...new Set(values)];
const unknownFare = (reason: string): OfferFare => ({ kind: "unknown", reason });

function today(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function validIso(value: string): boolean {
  return /^20\d{2}-\d{2}-\d{2}$/.test(value) && parseTripDepartureDateText(value).includes(value);
}

function hasYear(value: string): boolean { return /\b20\d{2}\b/.test(value); }

function catalogDates(trip: TravelTrip, now: Date): string[] {
  const frozen = rows(trip.extra?.departure_dates_resolved);
  const dates = (trip.departure_dates || []).flatMap((text) => {
    if (hasYear(text)) return parseTripDepartureDateText(text, now);
    const saved = frozen.filter((r) => r.text === text && validIso(str(r.ymd))).map((r) => str(r.ymd));
    return saved.length ? saved : parseTripDepartureDateText(text, now);
  });
  return unique([...dates, ...rows(trip.extra?.website_departure_availability).map((r) => str(r.date)).filter(validIso)]).sort();
}

function offerDates(raw: Row, trip: TravelTrip, now: Date): { dates: string[]; dateScoped: boolean; issues: string[] } {
  const texts = unique([...strings(raw.dates), ...strings(raw.display_dates), ...strings(raw.date_keys), ...(str(raw.date) ? [str(raw.date)] : [])]);
  const dated = texts.length > 0;
  const issues: string[] = [];
  const explicit = texts.filter(hasYear).flatMap((text) => parseTripDepartureDateText(text, now));
  const catalog = catalogDates(trip, now);
  const frozen = rows(trip.extra?.departure_dates_resolved);
  const dates = texts.flatMap((text) => {
    if (hasYear(text)) {
      const parsed = parseTripDepartureDateText(text, now);
      if (!parsed.length) issues.push("invalid_departure_date");
      return parsed;
    }
    const saved = frozen.filter((r) => r.text === text && validIso(str(r.ymd))).map((r) => str(r.ymd));
    if (saved.length) return saved;
    return parseTripDepartureDateText(text, now).flatMap((date) => {
      if (typeof raw.year === "number" && Number.isInteger(raw.year)) {
        const ymd = `${raw.year}${date.slice(4)}`;
        if (validIso(ymd)) return [ymd];
        issues.push("invalid_departure_year");
        return [];
      }
      const own = explicit.filter((d) => d.slice(5) === date.slice(5));
      if (own.length) return own;
      const known = catalog.filter((d) => d.slice(5) === date.slice(5));
      if (known.length > 1) issues.push("departure_year_ambiguous");
      return known.length ? known : [date];
    });
  });
  return { dates: unique(dates).sort(), dateScoped: dated, issues: unique(issues) };
}

/** Inclusive completed ages: 2-11 years covers months 24 through 143. */
function ageBand(text: string): OfferAgeBand | null {
  const value = text.toLowerCase();
  const births = /\b(20\d{2}|19\d{2})\s*[-\u2013\u2014]\s*(20\d{2}|19\d{2})\b/.exec(value);
  if (births) return Number(births[1]) <= Number(births[2]) ? { unit: "birth_year", min: Number(births[1]), max: Number(births[2]) } : null;
  const factor = /сар|month/.test(value) ? 1 : 12;
  const range = /(?:^|\D)(\d{1,3})\s*[-\u2013\u2014]\s*(\d{1,3})(?!\d)/.exec(value);
  if (range) return Number(range[1]) <= Number(range[2]) ? { unit: "month", min: Number(range[1]) * factor, maxExclusive: (Number(range[2]) + 1) * factor } : null;
  const plus = /(\d{1,3})\s*\+|(?:over|above)\s*(\d{1,3})|(\d{1,3})\s*(?:нас|сар)?\s*(?:дээш|болон дээш)/.exec(value);
  if (plus) return { unit: "month", min: Number(plus[1] || plus[2] || plus[3]) * factor, maxExclusive: null };
  const under = /(?:under|below)\s*(\d{1,3})|(\d{1,3})\s*(?:нас|сар)?\s*(?:доош|хүртэл)/.exec(value);
  if (under) return { unit: "month", min: 0, maxExclusive: (Number(under[1] || under[2]) + (value.includes("хүртэл") ? 1 : 0)) * factor };
  const single = /^(\d{1,3})\s*(?:нас|сар|years?|months?)$/.exec(value);
  return single ? { unit: "month", min: Number(single[1]) * factor, maxExclusive: (Number(single[1]) + 1) * factor } : null;
}

function passengerKind(raw: Row, band: OfferAgeBand | null, now: Date): PassengerKind | null {
  const label = key(str(raw.kind) || str(raw.category) || str(raw.label));
  if (/adult|том хүн|насанд хүр/.test(label)) return "adult";
  if (/infant|нярай/.test(label)) return "infant";
  // A few imports label an infant birth-year band as a child band.
  if (band && (band.unit === "month" ? band.min === 0 && band.maxExclusive !== null && band.maxExclusive <= 36 : Number(today(now).slice(0, 4)) - band.min <= 2)) return "infant";
  if (/child|хүүхэд/.test(label)) return "child";
  return null;
}

function money(raw: Row, currency: string, kind: PassengerKind, scalar = false): OfferFare {
  const amount = raw[scalar ? `${kind}_price` : "price"] ?? (!scalar ? raw.amount : undefined);
  const range = row(raw[scalar ? `${kind}_price_range` : "price_range"]);
  const usable = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0 && (currency !== "MNT" || n >= 1000);
  if (Object.keys(range).length) {
    if (!usable(range.min) || !usable(range.max) || range.min > range.max) return unknownFare("invalid_price_range");
    if (usable(amount) && (amount < range.min || amount > range.max)) return unknownFare("price_outside_range");
    return range.min === range.max ? { kind: "exact", amount: range.min } : { kind: "range", min: range.min, max: range.max };
  }
  if (usable(amount)) return { kind: "exact", amount };
  const free = raw.free === true || raw[`${kind}_price_free`] === true || /үнэгүй|\bfree\b/i.test(str(raw.note));
  if (amount === 0 && free) return { kind: "free", amount: 0 };
  return unknownFare("fare_not_confirmed");
}

function fares(raw: Row, trip: TravelTrip, id: string, now: Date, base: boolean): NormalizedPassengerFare[] {
  const currency = (str(raw.currency) || trip.currency || "MNT").toUpperCase();
  const savedBands = row(trip.extra?.age_rules);
  const result: NormalizedPassengerFare[] = [];
  const add = (data: Row, kind: PassengerKind | null, age: string, priority: number, scalar: boolean) => {
    const band = age ? ageBand(age) : null;
    const issues: string[] = [];
    if (!kind) issues.push("passenger_category_unknown");
    if (age && !band) issues.push("invalid_age_band");
    if (kind === "adult" && band?.unit === "month" && band.maxExclusive !== null && band.maxExclusive <= 36) issues.push("passenger_category_age_conflict");
    const fare = money(data, (str(data.currency) || currency).toUpperCase(), kind || "child", scalar);
    if (fare.kind === "unknown" && fare.reason !== "fare_not_confirmed") issues.push(fare.reason);
    result.push({ kind: kind || "child", ageRange: age || null, ageBand: band, fare, currency: (str(data.currency) || currency).toUpperCase(), sourceOfferId: id, priority, issues });
  };
  for (const kind of KINDS) {
    const age = str(raw[`${kind}_age`]) || str(savedBands[kind]);
    if (raw[`${kind}_price`] !== undefined || raw[`${kind}_price_range`] != null || age) add(raw, kind, age, 0, true);
  }
  for (const entry of rows(raw.passenger_prices)) {
    const age = str(entry.age_range);
    add(entry, passengerKind(entry, ageBand(age), now), age, 2, false);
  }
  for (const entry of [...rows(raw.child_rules), ...rows(raw.child_price_rules)]) {
    const age = str(entry.age_range) || (ageBand(str(entry.label)) ? str(entry.label) : "");
    add(entry, passengerKind(entry, ageBand(age), now) || (ageBand(age) ? "child" : null), age, 1, false);
  }
  if (base) for (const entry of rows(trip.extra?.passenger_prices)) {
    const age = str(entry.age_range);
    add(entry, passengerKind(entry, ageBand(age), now), age, 2, false);
  }
  return result;
}

function availability(raw: Row, fallbackSeats: number | null): OfferAvailability {
  const seats = raw.seatsLeft ?? raw.seats_left;
  const seatsLeft = typeof seats === "number" && Number.isFinite(seats) && seats >= 0 ? seats
    : typeof fallbackSeats === "number" && Number.isFinite(fallbackSeats) && fallbackSeats >= 0 ? fallbackSeats : null;
  const status = str(raw.status).toLowerCase();
  if (["sold_out", "paused", "cancelled", "departed"].includes(status)) return { status: status as OfferAvailability["status"], seatsLeft };
  if (["draft", "archived", "closed"].includes(status)) return { status: "unavailable", seatsLeft };
  if (seatsLeft === 0) return { status: "sold_out", seatsLeft };
  return { status: ["open", "active", "available"].includes(status) || seatsLeft !== null ? "open" : "unknown", seatsLeft };
}

function departureAvailability(trip: TravelTrip, date: string, raw: Row, now: Date): OfferAvailability {
  if (date < today(now)) return { status: "departed", seatsLeft: null };
  if (trip.status !== "active") return availability({ status: trip.status }, trip.seats_left);
  const website = rows(trip.extra?.website_departure_availability).filter((r) => r.date === date);
  const values = website.map((r) => availability(r, null));
  if (unique(values.map((v) => JSON.stringify(v))).length > 1) return { status: "conflict", seatsLeft: null };
  const group = availability(raw, null);
  if (["sold_out", "paused", "cancelled", "departed", "unavailable"].includes(group.status)) {
    if (values[0]?.status === "open") return { status: "conflict", seatsLeft: null };
    return group;
  }
  return values[0] || availability(raw, trip.seats_left);
}

function discountInfo(raw: Row, now: Date): CanonicalTripOffer["discount"] {
  const condition = str(raw.condition) || null;
  const validFrom = str(raw.valid_from) || str(raw.starts_at) || null;
  let validUntil = str(raw.valid_until) || str(raw.expires_at) || str(raw.expiry_date) || str(raw.booking_deadline) || null;
  if (!validUntil && condition && /хүртэл|\buntil\b|\bby\b|\bexpires?\b/i.test(condition)) {
    validUntil = parseTripDepartureDateText(condition, now)[0] || null;
  }
  const boundaryMet = (value: string, end: boolean): boolean => {
    if (validIso(value)) return end ? today(now) <= value : today(now) >= value;
    const time = Date.parse(value);
    return Number.isFinite(time) && (end ? now.getTime() <= time : now.getTime() >= time);
  };
  return { condition, validFrom, validUntil, active: (!validFrom || boundaryMet(validFrom, false)) && (!validUntil || boundaryMet(validUntil, true)) };
}

/** Pure catalog view; raw catalog objects are never rewritten or repaired. */
export function normalizeTripOffers(trip: TravelTrip, now = new Date()): CanonicalTripOffer[] {
  const extra = trip.extra || {};
  const records: Array<{ source: CanonicalTripOffer["source"]; raw: Row }> = [
    { source: "base", raw: { ...extra, adult_price: trip.adult_price, child_price: trip.child_price, infant_price: trip.infant_price, currency: trip.currency } },
    ...rows(extra.departure_date_groups).map((raw) => ({ source: "legacy" as const, raw })),
    ...rows(extra.price_groups).map((raw) => ({ source: "price_group" as const, raw })),
    ...[...rows(extra.discounts), ...rows(extra.discount_groups)].map((raw) => ({ source: "discount" as const, raw })),
  ];
  const baseDates = catalogDates(trip, now);
  return records.map(({ source, raw }, index) => {
    const id = str(raw.id) || `${trip.id}:${source}:${index}`;
    const scoped = source === "base" ? { dates: baseDates, dateScoped: false, issues: [] } : offerDates(raw, trip, now);
    return {
      id, source, ...scoped,
      // Only explicit offer rows create hotel choices. A trip-level hotel is
      // included accommodation text, not a selectable package; inheriting it
      // made ordinary date-specific prices look like "hotel picker" options.
      hotel: str(raw.hotel) || null,
      hotelId: str(raw.hotel_id) || null,
      packageId: str(raw.package_id) || str(raw.package) || null,
      currency: (str(raw.currency) || trip.currency || "MNT").toUpperCase(),
      fares: fares(raw, trip, id, now, source === "base"),
      supplementalFares: [
        ...(typeof raw.single_price === "number" ? [{ label: "single", price: raw.single_price }] : []),
        ...rows(raw.room_prices),
      ].map((r) => {
        const currency = (str(r.currency) || str(raw.currency) || trip.currency || "MNT").toUpperCase();
        return { label: str(r.label) || str(r.room_type) || "room", currency, fare: money(r, currency, "adult") };
      }),
      availability: (scoped.dates.length ? scoped.dates : baseDates).map((date) => ({ date, ...departureAvailability(trip, date, source === "base" ? {} : raw, now) })),
      discount: source === "discount" ? discountInfo(raw, now) : null,
    };
  });
}

function needs(field: OfferSelectionField, reason: string, options: string[] = []): TripOfferResult {
  return { status: "needs_selection", reason, fields: [field], options: unique(options) };
}
function conflict(issues: string[]): TripOfferResult { return { status: "conflict", reason: "catalog_contradiction", issues: unique(issues) }; }
function sameFare(a: OfferFare, b: OfferFare): boolean { return JSON.stringify(a) === JSON.stringify(b); }
function multiply(fare: OfferFare, count: number): OfferFare {
  if (fare.kind === "exact") return { kind: "exact", amount: fare.amount * count };
  if (fare.kind === "range") return { kind: "range", min: fare.min * count, max: fare.max * count };
  return fare;
}
function sum(fares: OfferFare[]): OfferFare {
  let min = 0, max = 0;
  for (const fare of fares) {
    if (fare.kind === "unknown") return fare;
    min += fare.kind === "range" ? fare.min : fare.amount;
    max += fare.kind === "range" ? fare.max : fare.amount;
  }
  return min !== max ? { kind: "range", min, max } : min === 0 ? { kind: "free", amount: 0 } : { kind: "exact", amount: min };
}

function covers(band: OfferAgeBand, passenger: PassengerSelection): boolean | null {
  if (band.unit === "birth_year") return passenger.birthYear === undefined ? null : passenger.birthYear >= band.min && passenger.birthYear <= band.max;
  if (passenger.age === undefined) return null;
  const months = passenger.age * (passenger.ageUnit === "month" ? 1 : 12);
  return months >= band.min && (band.maxExclusive === null || months < band.maxExclusive);
}

/**
 * Precedence is per passenger: modern groups > legacy groups > base; within a
 * source, scoped date/package/hotel rows win, then passenger bands > summaries.
 * Active unconditional or explicitly confirmed discounts override regular fares.
 * Null/placeholder fields may inherit; an explicit unknown passenger band may not.
 */
function resolve(trip: TravelTrip, selection: TripOfferSelection, now: Date, displayOnly: boolean): TripOfferResult {
  if (selection.tripId && selection.tripId !== trip.id) return { status: "missing", reason: "trip_selection_mismatch" };
  const packageId = selection.packageId || selection.package;
  const offers = normalizeTripOffers(trip, now);
  const regular = offers.filter((o) => o.source !== "discount");
  const dates = unique(regular.flatMap((o) => o.dates)).sort();
  let date = str(selection.date);
  if (date && !validIso(date)) {
    const parsed = parseTripDepartureDateText(date, now);
    const matches = hasYear(date) ? parsed : unique(parsed.flatMap((d) => dates.filter((known) => known.slice(5) === d.slice(5))));
    if (!matches.length) return { status: "missing", reason: "invalid_departure_date" };
    if (matches.length > 1) return needs("date", "departure_year_required", matches);
    date = matches[0];
  }
  if (!date) {
    const future = displayOnly ? dates : dates.filter((d) => d >= today(now));
    if (!dates.length) return { status: "missing", reason: "departure_date_missing" };
    if (!future.length) return { status: "unavailable", reason: "departed", date: null };
    if (future.length > 1) return needs("date", "departure_required", future);
    date = future[0];
  }
  if (!displayOnly && date < today(now)) return { status: "unavailable", reason: "departed", date };
  if (!dates.includes(date)) return { status: "unavailable", reason: "departure_not_offered", date };
  const baseAvailability = offers[0].availability.find((a) => a.date === date) || departureAvailability(trip, date, {}, now);
  if (baseAvailability.status === "conflict") return conflict(["departure_availability_conflict"]);
  if (!displayOnly && !["open", "unknown"].includes(baseAvailability.status)) return { status: "unavailable", reason: baseAvailability.status, date, availability: baseAvailability };
  let candidates = regular.filter((o) => !o.dateScoped || o.dates.includes(date));
  if (selection.hotel || selection.hotelId) {
    const hotel = key(selection.hotel);
    const matches = (o: CanonicalTripOffer) => (!hotel || key(o.hotel) === hotel || key(o.hotelId) === hotel) && (!selection.hotelId || o.hotelId === selection.hotelId);
    if (!candidates.some(matches)) return { status: "unavailable", reason: "hotel_not_offered", date };
    candidates = candidates.filter((o) => (!o.hotel && !o.hotelId) || matches(o));
  } else {
    const hotels = unique(candidates.filter((o) => o.source !== "base").map((o) => o.hotelId || o.hotel).filter((h): h is string => Boolean(h)));
    if (hotels.length > 1) return needs("hotel", "hotel_required", hotels.map((identity) => {
      const offer = candidates.find((o) => (o.hotelId || o.hotel) === identity)!;
      const sameNameIds = unique(candidates.filter((o) => key(o.hotel) === key(offer.hotel)).map((o) => o.hotelId));
      return offer.hotel && sameNameIds.length <= 1 ? offer.hotel : identity;
    }));
    if (hotels.length === 1) candidates = candidates.filter((o) => !o.hotel && !o.hotelId || (o.hotelId || o.hotel) === hotels[0]);
  }
  const packages = unique(candidates.map((o) => o.packageId).filter((p): p is string => Boolean(p)));
  if (packageId) {
    if (!packages.includes(packageId)) return { status: "unavailable", reason: "package_not_offered", date };
    candidates = candidates.filter((o) => !o.packageId || o.packageId === packageId);
  } else if (packages.length > 1) return needs("package", "package_required", packages);
  const discounts = offers.filter((o) => o.source === "discount" && (!o.dateScoped || o.dates.includes(date)) && (!o.hotel || candidates.some((c) => key(c.hotel) === key(o.hotel))) && (!o.packageId || candidates.some((c) => c.packageId === o.packageId)));
  if (selection.discountId) {
    const discount = discounts.find((o) => o.id === selection.discountId);
    if (!discount) return { status: "missing", reason: "discount_not_offered" };
    if (!discount.discount?.active) return { status: "unavailable", reason: "discount_expired_or_not_started", date };
    if (discount.discount.condition && !selection.confirmedDiscountConditions?.includes(discount.discount.condition)) return needs("discount_condition", "discount_condition_required", [discount.discount.condition]);
    candidates.push(discount);
  } else candidates.push(...discounts.filter((o) => o.discount?.active && !o.discount.condition));
  const issues = candidates.flatMap((o) => o.issues);
  if (issues.length) return conflict(issues);
  const scopedAvailability = candidates.filter((o) => o.source !== "base").flatMap((o) => o.availability.filter((a) => a.date === date));
  if (scopedAvailability.some((a) => a.status === "conflict")) return conflict(["departure_availability_conflict"]);
  const closed = scopedAvailability.find((a) => !["open", "unknown"].includes(a.status));
  if (closed && !displayOnly) return { status: "unavailable", reason: closed.status, date, availability: closed };
  const selectedAvailability = closed || scopedAvailability.find((a) => a.seatsLeft !== null) || baseAvailability;
  if (unique(scopedAvailability.map((a) => a.seatsLeft).filter((n) => n !== null)).length > 1) return conflict(["departure_seat_count_conflict"]);
  const rank = (fare: NormalizedPassengerFare): number => {
    const offer = candidates.find((o) => o.id === fare.sourceOfferId)!;
    return SOURCE_PRIORITY[offer.source] * 100 + Number(offer.dateScoped) * 20 + Number(Boolean(offer.hotel || offer.hotelId || offer.packageId)) * 10 + fare.priority;
  };
  const allFares = candidates.flatMap((o) => o.fares);
  const effective: NormalizedPassengerFare[] = [];
  for (const kind of KINDS) {
    const entries = allFares.filter((f) => f.kind === kind);
    const usable = entries.filter((f) => f.fare.kind !== "unknown" || f.priority > 0 || f.issues.length > 0);
    if (!usable.length) continue;
    const max = Math.max(...usable.map(rank));
    effective.push(...usable.filter((f) => rank(f) === max));
  }
  if (effective.some((f) => f.issues.length)) return conflict(effective.flatMap((f) => f.issues));
  const prices: ResolvedTripOffer["prices"] = {};
  for (const kind of KINDS) {
    const entries = effective.filter((f) => f.kind === kind);
    if (entries.length) prices[kind] = entries.every((f) => sameFare(f.fare, entries[0].fare)) ? entries[0].fare : unknownFare("passenger_age_required");
    // Identical age/category scopes with different prices are contradictory,
    // even when the caller only requested a fare card.
    for (const entry of entries) if (entries.some((other) => JSON.stringify(entry.ageBand) === JSON.stringify(other.ageBand) && !sameFare(entry.fare, other.fare))) return conflict([`${kind}_fare_conflict`]);
  }
  const passengerPrices: ResolvedPassengerPrice[] = [];
  for (const passenger of selection.passengers || []) {
    if (!Number.isInteger(passenger.count) || passenger.count <= 0 || passenger.age !== undefined && (!Number.isFinite(passenger.age) || passenger.age < 0) || passenger.birthYear !== undefined && (!Number.isInteger(passenger.birthYear) || passenger.birthYear > Number(date.slice(0, 4)))) return { status: "missing", reason: "invalid_passenger_selection" };
    let entries: NormalizedPassengerFare[];
    if (passenger.age !== undefined || passenger.birthYear !== undefined) {
      const matched = effective.filter((f) => f.ageBand && covers(f.ageBand, passenger) === true);
      const classified = KINDS.filter((kind) => {
        const band = ageBand(str(row(trip.extra?.age_rules)[kind]));
        return band && covers(band, passenger) === true;
      });
      const matchedKinds = unique([...matched.map((f) => f.kind), ...classified]);
      if (matchedKinds.length > 1) return conflict(["overlapping_passenger_age_categories"]);
      if (matched.length) entries = matched;
      else if (classified.length === 1) entries = effective.filter((f) => f.kind === classified[0] && !f.ageBand);
      else if (passenger.kind && !effective.some((f) => f.kind === passenger.kind && f.ageBand) && !str(row(trip.extra?.age_rules)[passenger.kind])) entries = effective.filter((f) => f.kind === passenger.kind && !f.ageBand);
      else return needs("passengers", "passenger_age_band_missing", effective.map((f) => f.ageRange || f.kind));
    } else {
      if (!passenger.kind) return needs("passengers", "passenger_kind_required", KINDS);
      entries = effective.filter((f) => f.kind === passenger.kind);
      if (entries.some((f) => f.ageBand?.unit === "birth_year")) return needs("passengers", "passenger_birth_year_required", entries.map((f) => f.ageRange || f.kind));
      if (unique(entries.map((f) => f.ageRange)).length > 1) return needs("passengers", "passenger_age_required", entries.map((f) => f.ageRange || f.kind));
    }
    if (!entries.length) return { status: "missing", reason: "passenger_fare_missing" };
    const max = Math.max(...entries.map(rank));
    entries = entries.filter((f) => rank(f) === max);
    if (!entries.every((f) => f.kind === entries[0].kind && f.currency === entries[0].currency && sameFare(f.fare, entries[0].fare))) return conflict(["passenger_fare_conflict"]);
    const chosen = entries[0];
    if (chosen.fare.kind === "unknown") return { status: "missing", reason: chosen.fare.reason };
    passengerPrices.push({ kind: chosen.kind, age: passenger.age ?? null, ageUnit: passenger.ageUnit || "year", count: passenger.count, fare: chosen.fare, lineTotal: multiply(chosen.fare, passenger.count), sourceOfferId: chosen.sourceOfferId, ageRange: chosen.ageRange });
  }
  if (!effective.some((f) => f.fare.kind !== "unknown")) return { status: "missing", reason: "fare_missing" };
  if (unique(effective.map((f) => f.currency)).length > 1) return conflict(["fare_currency_conflict"]);
  const count = passengerPrices.reduce((n, p) => n + p.count, 0);
  if (!displayOnly && selectedAvailability.seatsLeft !== null && count > selectedAvailability.seatsLeft) return { status: "unavailable", reason: "insufficient_seats", date, availability: selectedAvailability };
  const primary = [...candidates].sort((a, b) => SOURCE_PRIORITY[b.source] - SOURCE_PRIORITY[a.source])[0];
  const hotelOffer = candidates.find((o) => o.hotel || o.hotelId);
  return { status: "ready", offer: {
    id: primary.id, tripId: trip.id, date, hotel: hotelOffer?.hotel || null, hotelId: hotelOffer?.hotelId || null,
    packageId: candidates.find((o) => o.packageId)?.packageId || null,
    currency: effective[0].currency, prices, fares: effective, passengerPrices,
    total: passengerPrices.length ? sum(passengerPrices.map((p) => p.lineTotal)) : null,
    availability: { status: selectedAvailability.status, seatsLeft: selectedAvailability.seatsLeft }, sourceOfferIds: unique(effective.map((f) => f.sourceOfferId)),
    conditions: unique(candidates.flatMap((o) => o.discount?.condition ? [o.discount.condition] : [])),
  } };
}

export function resolveTripOffer(trip: TravelTrip, selection: TripOfferSelection = {}, now = new Date()): TripOfferResult {
  return resolve(trip, selection, now, false);
}

/** Catalog projection only: ready means fares resolved, and availability may
 * still be closed. Booking callers must use resolveTripOffer instead. */
export function resolveTripOfferFareCard(trip: TravelTrip, selection: TripOfferSelection = {}, now = new Date()): TripOfferResult {
  return resolve(trip, selection, now, true);
}

/** An undated price overview, never a booking/availability/total assertion. */
export function summarizeTripOfferPrices(trip: TravelTrip, selection: TripOfferSummarySelection = {}, now = new Date()): TripOfferPriceSummary {
  const dates = unique(normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount").flatMap((offer) => offer.dates)).filter((date) => date >= today(now)).sort();
  if (!dates.length) return { status: "missing", reason: "future_departure_date_missing" };
  const cards: ResolvedTripOffer[] = [];
  for (const date of dates) {
    const result = resolveTripOfferFareCard(trip, { ...selection, date, passengers: [] }, now);
    if (result.status !== "ready") return result;
    cards.push(result.offer);
  }
  const signature = (card: ResolvedTripOffer) => JSON.stringify({
    hotel: key(card.hotel), hotelId: card.hotelId, packageId: card.packageId, currency: card.currency,
    conditions: [...card.conditions].sort(),
    fares: unique(card.fares.map((fare) => JSON.stringify({ kind: fare.kind, ageRange: fare.ageRange, ageBand: fare.ageBand, fare: fare.fare, currency: fare.currency }))).sort(),
  });
  if (unique(cards.map(signature)).length > 1) return { status: "needs_selection", reason: "departure_offers_differ", fields: ["date"], options: dates };
  const first = cards[0];
  return { status: "ready", summary: {
    dates, hotel: first.hotel, hotelId: first.hotelId, packageId: first.packageId, currency: first.currency,
    prices: first.prices, fares: first.fares, conditions: first.conditions,
    sourceOfferIds: unique(cards.flatMap((card) => card.sourceOfferIds)),
  } };
}

function renderFare(fare: OfferFare, currency: string): string {
  const money = (n: number) => `${n.toLocaleString("mn-MN")}${currency === "MNT" ? "₮" : ` ${currency}`}`;
  if (fare.kind === "unknown") return "Үнэ баталгаажаагүй";
  if (fare.kind === "free") return "Үнэгүй";
  return fare.kind === "range" ? `${money(fare.min)} - ${money(fare.max)}` : money(fare.amount);
}

/** Returns no customer price text for a failed or incomplete selection. */
export function renderTripOfferReply(result: TripOfferResult, options: { fareKinds?: PassengerKind[]; showTotal?: boolean } = {}): string | null {
  if (result.status !== "ready") return null;
  const { offer } = result;
  const labels = { adult: "Том хүн", child: "Хүүхэд", infant: "Нярай" };
  const lines = [offer.date, offer.hotel].filter(Boolean) as string[];
  if (offer.passengerPrices.length) {
    for (const p of offer.passengerPrices) lines.push(`${labels[p.kind]}${p.ageRange ? ` (${p.ageRange})` : ""} x ${p.count}: ${renderFare(p.fare, offer.currency)}`);
  } else for (const f of offer.fares.filter((fare) => !options.fareKinds?.length || options.fareKinds.includes(fare.kind))) {
    if (f.fare.kind !== "unknown") lines.push(`${labels[f.kind]}${f.ageRange ? ` (${f.ageRange})` : ""}: ${renderFare(f.fare, offer.currency)}`);
  }
  if (!offer.passengerPrices.length && options.fareKinds?.length && !offer.fares.some((fare) => options.fareKinds!.includes(fare.kind) && fare.fare.kind !== "unknown")) return null;
  if (offer.total && options.showTotal !== false) lines.push(`Нийт: ${renderFare(offer.total, offer.currency)}`);
  lines.push(...offer.conditions);
  return unique(lines).join("\n");
}
