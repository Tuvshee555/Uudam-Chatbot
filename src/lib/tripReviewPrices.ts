/**
 * The price section of a new-trip review: ONE list of price cards tied to the departure calendar.
 *
 * Until 2026-11-06 the review showed a flat «Үнэ» box (adult / child / infant) and, behind a vague
 * link, a second editor that listed the same dates again with their own fares. The two did not
 * agree with each other. Here a card is one price shared by one or more departure days:
 *
 *   - «all»  the trip's own fares (adult_price / child_price / infant_price): every calendar day
 *            that no other card names. This is the default: one price for all the days.
 *   - «own»  one extra.price_groups row per distinct price (hotel, package, passenger bands ...):
 *            the days that have their own price.
 *
 * Days that share the same price are ONE card (rows that only differ by date are merged, and a row
 * that only repeats the trip's own fares folds into the «all» card), a day is in one card, a day
 * taken off the calendar leaves its card, a day added later joins the «all» card, which is then
 * empty and marked as not priced yet. What is saved (tripReview.reviewedFields) goes through the
 * same merge, so the saved rows are the cards on screen.
 *
 * The saved shape does not change: base fares plus extra.price_groups, read by the bot, the
 * website and the poster as before. When every day has its own card the base fares follow the
 * cheapest card (the website's «from» price), as the file reader writes them.
 *
 * Pure: no database, no model, no React. The review component calls these on the trip's fields.
 */
import { passengerPricingRows, pricingDates } from "./adminDatePricing";
import type { PriceGroup } from "./adminTypes";
import { withDerivedSummaryFields } from "./priceGroups";
import { validateTripDataChange, type TripFactInput } from "./tripDataValidation";
import { isInfantShapedAge } from "./travelFastPathsSearch";
import { departureDays, hasPrice, isYmd, mongoliaToday, publishPriceGap, setDepartureDays, weekdayOf } from "./tripReview";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type FareKind = "adult" | "child" | "infant";
export const ALL_CARD = "all";
export const FREE_NOTE = "Үнэгүй";

/** One passenger band of a card: the child and infant fare have their own box, the rest are extra rows. */
export type CardBand = { index: number; role: "child" | "infant" | "other"; row: Row };

export type PriceCard = {
  /** «all» for the trip's own fares, «g<n>» for a price_groups row. */
  key: string;
  kind: "all" | "own";
  /** Calendar days (YYYY-MM-DD) the card prices, sorted. */
  days: string[];
  /** Departure texts that are not one calendar day (a weekly rule). */
  other: string[];
  /** Days the card names that are not on the calendar. */
  strays: string[];
  /** Days already gone. */
  past: string[];
  /** A row without any date: it applies to every departure. */
  everyDate: boolean;
  hotel: string;
  packageId: string;
  adult: number | null;
  child: number | null;
  infant: number | null;
  single: number | null;
  bands: CardBand[];
  /** The price row itself (own cards); the trip's fares are not a row. */
  group: Row;
  /** Not entirely in the past: only these need their adult and child fare. */
  upcoming: boolean;
  missing: { adult: boolean; child: boolean };
  /** Days another card with the same hotel and package also lists (two prices for one thing). */
  clash: string[];
};

export type PriceModel = {
  calendar: string[];
  /** The trip leaves in more than one year: every day is then written with its year. */
  spansYears: boolean;
  cards: PriceCard[];
  hasOwn: boolean;
  /** The «all» card is shown (some day is priced by the trip's own fares, or there are no rows). */
  showsAll: boolean;
  /** Calendar days no price row names. */
  uncovered: string[];
  /** The lowest adult fare of the upcoming cards: the website's «from» price. */
  headline: number | null;
  /** Upcoming cards still lacking the adult or the child fare. */
  missingCards: number;
};

/* ----------------------------------------------------------------- reading */

export function reviewPriceGroups(fields: Row): Row[] {
  const extra = record(fields.extra);
  const groups = Array.isArray(extra.price_groups) && extra.price_groups.length ? extra.price_groups
    : Array.isArray(extra.departure_date_groups) ? extra.departure_date_groups : [];
  return groups.map(record);
}

const DATE_KEYS = ["dates", "date_keys", "display_dates"];
// Derived from the passenger bands (priceGroups.withDerivedSummaryFields) or an identity: not part of "the same price".
const DERIVED_KEYS = ["id", "child_price", "infant_price", "child_age", "infant_age"];

function clean(value: unknown): unknown {
  if (Array.isArray(value)) {
    const list = value.map(clean).filter((entry) => entry !== undefined);
    return list.length ? list : undefined;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Row).map(([key, entry]) => [key, clean(entry)] as const)
      .filter(([, entry]) => entry !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === null || value === undefined || value === "") return undefined;
  return typeof value === "string" ? value.trim() || undefined : value;
}

/** Two price rows with the same signature differ only by the days they name. */
function signature(group: Row): string {
  const rest: Row = {};
  for (const [key, value] of Object.entries(group)) {
    if (DATE_KEYS.includes(key) || DERIVED_KEYS.includes(key) || key === "passenger_prices") continue;
    rest[key] = value;
  }
  if (text(rest.currency).toUpperCase() === "MNT") delete rest.currency;
  const bands = passengerPricingRows(group).map((band) => ({ ...band, currency: text(band.currency) || "MNT" }));
  return JSON.stringify(clean({ ...rest, passenger_prices: bands }) ?? {});
}

type Entry = { indexes: number[]; group: Row; days: string[]; other: string[] };

const union = (a: string[], b: string[]) => Array.from(new Set([...a, ...b]));

/** The price rows with the rows that only differ by date merged: one entry per distinct price. */
function entriesOf(groups: Row[], now: Date): Entry[] {
  const bySignature = new Map<string, Entry>();
  const entries: Entry[] = [];
  groups.forEach((group, index) => {
    const { days, other } = departureDays(pricingDates(group, now), now);
    const key = signature(group);
    const found = bySignature.get(key);
    if (found) {
      found.indexes.push(index);
      found.days = union(found.days, days).sort();
      found.other = union(found.other, other);
      return;
    }
    const entry: Entry = { indexes: [index], group, days, other };
    bySignature.set(key, entry);
    entries.push(entry);
  });
  return entries;
}

const keyOf = (entry: Entry) => `g${entry.indexes[0]}`;

/** The row as it is saved: its days under every date key, so no stale key can bring a removed day back. */
function written(entry: Entry): Row {
  const dates = [...entry.days, ...entry.other];
  return { ...entry.group, dates, date_keys: dates, display_dates: dates };
}

const ADULT_BAND = /том\s*хүн|adult/i;

function rolesOf(bands: Row[]): Array<"child" | "infant" | "other"> {
  let child = false;
  let infant = false;
  return bands.map((band) => {
    const label = text(band.label).toLowerCase();
    if (isInfantShapedAge(label, text(band.age_range))) {
      if (infant) return "other";
      infant = true;
      return "infant";
    }
    if (ADULT_BAND.test(label) || child) return "other";
    child = true;
    return "child";
  });
}

function bandsOf(group: Row): CardBand[] {
  const rows = passengerPricingRows(group) as Row[];
  const roles = rolesOf(rows);
  return rows.map((row, index) => ({ index, role: roles[index], row }));
}

const priceOf = (bands: CardBand[], role: "child" | "infant"): number | null => {
  const band = bands.find((entry) => entry.role === role);
  return band ? num(band.row.price) : null;
};

const isUpcoming = (days: string[], other: string[], today: string) => (!days.length && !other.length) || other.length > 0 || days.some((day) => day >= today);

function optionKey(card: { hotel: string; packageId: string }) {
  return `${card.hotel.toLowerCase().replace(/\s+/g, " ")}|${card.packageId.toLowerCase().replace(/\s+/g, " ")}`;
}

function ownCard(entry: Entry, calendar: Set<string>, today: string, now: Date): PriceCard {
  const group = written(entry);
  const bands = bandsOf(group);
  const upcoming = isUpcoming(entry.days, entry.other, today);
  const gap = upcoming ? publishPriceGap({ extra: { price_groups: [group] } }, now) : { adult: false, child: false };
  return {
    key: keyOf(entry), kind: "own", days: entry.days, other: entry.other,
    strays: entry.days.filter((day) => !calendar.has(day)),
    past: entry.days.filter((day) => day < today),
    everyDate: !entry.days.length && !entry.other.length,
    hotel: text(group.hotel), packageId: text(group.package_id),
    adult: num(group.adult_price), child: priceOf(bands, "child"), infant: priceOf(bands, "infant"), single: num(group.single_price),
    bands, group, upcoming, missing: { adult: gap.adult, child: gap.child }, clash: [],
  };
}

/**
 * A price row that is only the trip's own fares written again (no hotel, package, single-room extra,
 * name, note or extra band, the same adult / child / infant) is not a price of its own: its days are
 * priced by the trip's fares, so they belong to the «all days» card. Only while some day is priced by
 * the trip's fares anyway: when every day has a card the trip's fares are just the cheapest of them.
 */
function foldIntoDefault(entries: Entry[], fields: Row, now: Date): Entry[] {
  const base = baseOf(fields);
  if (!hasPrice(base.adult) || !entries.length) return entries;
  if (entries.some((entry) => !entry.days.length && !entry.other.length)) return entries;
  const { days: calendar, other: calendarOther } = departureDays(fields.departure_dates, now);
  const today = mongoliaToday(now);
  const named = new Set(entries.flatMap((entry) => entry.days));
  const namedOther = new Set(entries.flatMap((entry) => entry.other));
  const open = calendar.some((day) => day >= today && !named.has(day)) || calendarOther.some((entry) => !namedOther.has(entry));
  if (!open) return entries;
  const known = new Set(calendar);
  const same = signature(baseRowOf(base));
  const kept = entries.filter((entry) => !(entry.days.length && !entry.other.length && entry.days.every((day) => known.has(day)) && signature(entry.group) === same));
  return kept.length === entries.length ? entries : kept;
}

/** The trip's own fares as a price row, to compare cards with. */
function baseRowOf(base: Base): Row {
  const bands = setBandPrice(setBandPrice([], "child", base.child, "MNT"), "infant", base.infant, "MNT");
  return withBands({ ...blankRow(), adult_price: base.adult }, bands);
}

/** The review's price cards for a trip's fields. */
export function priceModel(fields: Row, now = new Date()): PriceModel {
  return modelOf(fields, now, true);
}

/** `fold` false: the cards exactly as the rows are saved, to tell what the trip's own fares stand for. */
function modelOf(fields: Row, now: Date, fold: boolean): PriceModel {
  const today = mongoliaToday(now);
  const { days: calendar, other: calendarOther } = departureDays(fields.departure_dates, now);
  const known = new Set(calendar);
  const found = entriesOf(reviewPriceGroups(fields), now);
  const entries = fold ? foldIntoDefault(found, fields, now) : found;
  const own = entries.map((entry) => ownCard(entry, known, today, now))
    .sort((a, b) => Number(b.everyDate) - Number(a.everyDate) || (a.days[0] ?? "~").localeCompare(b.days[0] ?? "~"));
  const everyDate = own.some((card) => card.everyDate);
  const named = new Set(own.flatMap((card) => card.days));
  const namedOther = new Set(own.flatMap((card) => card.other));
  const uncovered = everyDate ? [] : calendar.filter((day) => !named.has(day));
  const uncoveredOther = everyDate ? [] : calendarOther.filter((entry) => !namedOther.has(entry));
  // With price rows but no calendar day at all there is nothing for an «all days» card to price.
  const showsAll = !everyDate && (!own.length || uncovered.length > 0 || uncoveredOther.length > 0);

  const cards: PriceCard[] = [];
  if (showsAll) {
    const upcoming = isUpcoming(uncovered, uncoveredOther, today);
    cards.push({
      key: ALL_CARD, kind: "all", days: uncovered, other: uncoveredOther, strays: [], past: uncovered.filter((day) => day < today), everyDate: false, hotel: "", packageId: "",
      adult: num(fields.adult_price), child: num(fields.child_price), infant: num(fields.infant_price), single: null,
      bands: [], group: {}, upcoming,
      missing: { adult: upcoming && !hasPrice(fields.adult_price), child: upcoming && !hasPrice(fields.child_price) },
      clash: [],
    });
  }
  // Two cards with the same hotel and package must not list one day: that day would have two prices.
  for (const card of own) {
    const others = own.filter((other) => other !== card && optionKey(other) === optionKey(card));
    card.clash = card.days.filter((day) => others.some((other) => other.days.includes(day)));
  }
  cards.push(...own);

  const upcomingAdults = cards.filter((card) => card.upcoming && hasPrice(card.adult)).map((card) => card.adult as number);
  const years = new Set([...calendar, ...own.flatMap((card) => card.days)].map((day) => day.slice(0, 4)));
  return {
    calendar, spansYears: years.size > 1, cards, hasOwn: own.length > 0, showsAll, uncovered,
    headline: upcomingAdults.length ? Math.min(...upcomingAdults) : null,
    missingCards: cards.filter((card) => card.missing.adult || card.missing.child).length,
  };
}

/* ----------------------------------------------------------------- writing */

const BASE_KEY: Record<FareKind, string> = { adult: "adult_price", child: "child_price", infant: "infant_price" };

type Base = { adult: number | null; child: number | null; infant: number | null };

/** The trip's «from» fares when every day has its own card: the cheapest upcoming card's adult, child and infant. */
function derivedBase(model: PriceModel): Base | null {
  const priced = model.cards.filter((card) => card.kind === "own" && hasPrice(card.adult));
  const upcoming = priced.filter((card) => card.upcoming);
  const pool = upcoming.length ? upcoming : priced;
  if (!pool.length) return null;
  const cheapest = pool.reduce((best, card) => ((card.adult as number) < (best.adult as number) ? card : best));
  return { adult: cheapest.adult, child: cheapest.child, infant: cheapest.infant };
}

const baseOf = (fields: Row): Base => ({ adult: num(fields.adult_price), child: num(fields.child_price), infant: num(fields.infant_price) });
const sameBase = (a: Base, b: Base) => a.adult === b.adult && a.child === b.child && a.infant === b.infant;

/**
 * The trip's own fares after a change. With every day on its own card they follow the cheapest
 * card. When a day is left without a card, the fares that were only that «from» price go: the
 * day shows as not priced yet instead of silently taking the cheapest card's price.
 */
function settleBase(previous: Row, next: Row, now: Date): Row {
  return foldRows(settleBaseOnly(previous, next, now), now);
}

function settleBaseOnly(previous: Row, next: Row, now: Date): Row {
  // Before folding: a row equal to the «from» fare is that fare's own card, not a repeat of a typed default.
  const model = modelOf(next, now, false);
  if (!model.hasOwn) return next;
  if (!model.showsAll) {
    const base = derivedBase(model);
    return base ? { ...next, adult_price: base.adult, child_price: base.child, infant_price: base.infant } : next;
  }
  const before = modelOf(previous, now, false);
  const was = before.hasOwn && !before.showsAll ? derivedBase(before) : null;
  if (was && sameBase(baseOf(previous), was)) return { ...next, adult_price: null, child_price: null, infant_price: null };
  return next;
}

/** The price rows without the ones that only repeat the trip's own fares (see foldIntoDefault). */
function foldRows(fields: Row, now: Date): Row {
  const entries = entriesOf(reviewPriceGroups(fields), now);
  const kept = foldIntoDefault(entries, fields, now);
  if (kept === entries) return fields;
  return { ...fields, extra: { ...record(fields.extra), price_groups: kept.map(written), departure_date_groups: [] } };
}

function commit(previous: Row, fields: Row, entries: Entry[], now: Date): Row {
  // Rows that became the same price merge; the saved rows carry every day under one spelling.
  const merged = entriesOf(entries.map(written), now).map(written);
  const extra = { ...record(fields.extra), price_groups: merged, departure_date_groups: [] };
  return settleBase(previous, { ...fields, extra }, now);
}

/**
 * The price rows as the review shows them, ready to save: rows that differ only by date are one row
 * listing all their days, and a row that only repeats the trip's own fares is left to those fares.
 * The saved rows then always match the cards on screen. They stay under the key they came from.
 */
export function normalizePriceRows(fields: Row, now = new Date()): Row {
  const groups = reviewPriceGroups(fields);
  if (!groups.length) return fields;
  const extra = record(fields.extra);
  const key = Array.isArray(extra.price_groups) && extra.price_groups.length ? "price_groups" : "departure_date_groups";
  const kept = foldIntoDefault(entriesOf(groups, now), fields, now);
  return { ...fields, extra: { ...extra, [key]: kept.map(written) } };
}

function entryOf(entries: Entry[], key: string): Entry | undefined {
  return entries.find((entry) => keyOf(entry) === key);
}

function replaceEntry(entries: Entry[], key: string, patch: (entry: Entry) => Entry | null): Entry[] {
  return entries.flatMap((entry) => {
    if (keyOf(entry) !== key) return [entry];
    const next = patch(entry);
    return next ? [next] : [];
  });
}

function withGroup(entry: Entry, group: Row): Entry {
  return { ...entry, group };
}

/** A price row with its passenger bands set and the flat child / infant fares derived from them. */
function withBands(group: Row, bands: Row[]): Row {
  return withDerivedSummaryFields({ ...group, passenger_prices: bands } as unknown as PriceGroup) as unknown as Row;
}

function setBandPrice(bands: Row[], role: "child" | "infant", value: number | null, currency: string): Row[] {
  const roles = rolesOf(bands);
  const index = roles.indexOf(role);
  if (index < 0) {
    if (value === null) return bands;
    const band = { label: role === "child" ? "Хүүхэд" : "Нярай", age_range: "", price: value, currency, ...(value === 0 ? { note: FREE_NOTE } : {}) };
    // Keep the child fare ahead of the infant fare.
    const firstInfant = role === "child" ? roles.indexOf("infant") : -1;
    return firstInfant < 0 ? [...bands, band] : [...bands.slice(0, firstInfant), band, ...bands.slice(firstInfant)];
  }
  if (value === null && !text(bands[index].age_range)) return bands.filter((_, i) => i !== index);
  return bands.map((band, i) => {
    if (i !== index) return band;
    const note = value === 0 ? FREE_NOTE : text(band.note) === FREE_NOTE ? "" : band.note;
    return { ...band, price: value, ...(note !== undefined ? { note } : {}) };
  });
}

/** The trip's own fare (the «all» card). */
export function setBaseFare(fields: Row, kind: FareKind, value: number | null, now = new Date()): Row {
  return settleBase(fields, { ...fields, [BASE_KEY[kind]]: value }, now);
}

/** One fare of a price row's card; a free infant is 0 with the «Үнэгүй» note. */
export function setCardFare(fields: Row, key: string, kind: FareKind, value: number | null, now = new Date()): Row {
  if (key === ALL_CARD) return setBaseFare(fields, kind, value, now);
  const entries = entriesOf(reviewPriceGroups(fields), now);
  const next = replaceEntry(entries, key, (entry) => {
    const group = entry.group;
    if (kind === "adult") return withGroup(entry, { ...group, adult_price: value, adult_price_range: null });
    const bands = passengerPricingRows(group) as Row[];
    return withGroup(entry, withBands(group, setBandPrice(bands, kind, value, text(group.currency) || "MNT")));
  });
  return commit(fields, fields, next, now);
}

/** Hotel, package, single-room extra, name or note of a price row. */
export function patchCard(fields: Row, key: string, patch: Row, now = new Date()): Row {
  if (key === ALL_CARD) return fields;
  const entries = entriesOf(reviewPriceGroups(fields), now);
  return commit(fields, fields, replaceEntry(entries, key, (entry) => withGroup(entry, { ...entry.group, ...patch })), now);
}

/** All passenger bands of a price row replaced (the extra age / height rows are edited as a list). */
export function setCardBands(fields: Row, key: string, bands: Row[], now = new Date()): Row {
  if (key === ALL_CARD) return fields;
  const entries = entriesOf(reviewPriceGroups(fields), now);
  return commit(fields, fields, replaceEntry(entries, key, (entry) => withGroup(entry, withBands(entry.group, bands))), now);
}

/**
 * An extra age / height band on a price row. The child fare keeps its own box, so a row without
 * one gets an empty child band first: otherwise the new band would be read as the child fare.
 */
export function addExtraBand(fields: Row, key: string, now = new Date()): Row {
  if (key === ALL_CARD) return fields;
  const entries = entriesOf(reviewPriceGroups(fields), now);
  const next = replaceEntry(entries, key, (entry) => {
    const bands = passengerPricingRows(entry.group) as Row[];
    const currency = text(entry.group.currency) || "MNT";
    const withChild = rolesOf(bands).includes("child") ? bands : [...bands, { label: "Хүүхэд", age_range: "", price: null, currency }];
    return withGroup(entry, withBands(entry.group, [...withChild, { label: "", age_range: "", price: null, currency }]));
  });
  return commit(fields, fields, next, now);
}

const blankRow = (): Row => ({
  label: "", dates: [], display_dates: [], date_keys: [], adult_price: null, adult_price_range: null, child_price: null, infant_price: null,
  child_age: "", infant_age: "", passenger_prices: [], note: "",
});

/**
 * These days get a price of their own. The new card starts empty (a copy would be the same price,
 * and the same price is one card): the admin types it, the old price stays on the card they left.
 * A hotel or package of the card they came from is kept.
 */
export function splitDays(fields: Row, fromKey: string, days: string[], now = new Date()): Row {
  const wanted = new Set(days);
  if (!wanted.size) return fields;
  const entries = entriesOf(reviewPriceGroups(fields), now);
  let kept = entries;
  let source: Row = {};
  if (fromKey !== ALL_CARD) {
    const from = entryOf(entries, fromKey);
    if (!from) return fields;
    source = from.group;
    kept = replaceEntry(entries, fromKey, (entry) => {
      const left = entry.days.filter((day) => !wanted.has(day));
      return left.length || entry.other.length ? { ...entry, days: left } : null;
    });
  }
  const fresh: Entry = {
    indexes: [Number.MAX_SAFE_INTEGER], days: Array.from(wanted).sort(), other: [],
    group: { ...blankRow(), ...(text(source.hotel) ? { hotel: source.hotel } : {}), ...(text(source.package_id) ? { package_id: source.package_id } : {}) },
  };
  return commit(fields, fields, [...kept, fresh], now);
}

/** These days leave one card for another card, or back to the trip's own fares (toKey = «all»). */
export function moveDays(fields: Row, fromKey: string, days: string[], toKey: string, now = new Date()): Row {
  const wanted = new Set(days);
  if (!wanted.size || fromKey === toKey || fromKey === ALL_CARD) return fields;
  const entries = entriesOf(reviewPriceGroups(fields), now);
  if (!entryOf(entries, fromKey)) return fields;
  if (toKey !== ALL_CARD && !entryOf(entries, toKey)) return fields;
  const moved = entries.map((entry) => {
    if (keyOf(entry) === fromKey) return { ...entry, days: entry.days.filter((day) => !wanted.has(day)) };
    if (keyOf(entry) === toKey) return { ...entry, days: union(entry.days, Array.from(wanted)).sort() };
    return entry;
  }).filter((entry) => entry.days.length || entry.other.length || keyOf(entry) !== fromKey);
  return commit(fields, fields, moved, now);
}

/** A price row removed: its days are priced by the trip's own fares again. */
export function dropCard(fields: Row, key: string, now = new Date()): Row {
  if (key === ALL_CARD) return fields;
  const entries = entriesOf(reviewPriceGroups(fields), now);
  return commit(fields, fields, replaceEntry(entries, key, () => null), now);
}

/**
 * Another hotel or package for the same days: a new empty card with the same days. Until it is
 * told apart by its hotel or package, the days show as listed twice.
 */
export function addOption(fields: Row, key: string, now = new Date()): Row {
  const entries = entriesOf(reviewPriceGroups(fields), now);
  const from = entryOf(entries, key);
  if (!from) return fields;
  return commit(fields, fields, [...entries, { indexes: [Number.MAX_SAFE_INTEGER], days: from.days, other: from.other, group: blankRow() }], now);
}

/** The calendar changed: the cards follow (a removed day leaves its card, a new day joins the «all» card). */
export function withCalendarDays(fields: Row, days: string[], now = new Date()): Row {
  return settleBase(fields, setDepartureDays(fields, days, now), now);
}

/** Days with a price that are not on the calendar: put them on it. */
export function addStraysToCalendar(fields: Row, now = new Date()): Row {
  const model = priceModel(fields, now);
  const strays = model.cards.flatMap((card) => card.strays);
  if (!strays.length) return fields;
  const { days, other } = departureDays(fields.departure_dates, now);
  return { ...fields, departure_dates: [...union(days, strays).sort(), ...other] };
}

/** Days with a price that are not on the calendar: take their price off. */
export function dropStrays(fields: Row, now = new Date()): Row {
  const known = new Set(departureDays(fields.departure_dates, now).days);
  const entries = entriesOf(reviewPriceGroups(fields), now).flatMap((entry) => {
    const days = entry.days.filter((day) => known.has(day));
    return days.length || entry.other.length || !entry.days.length ? [{ ...entry, days }] : [];
  });
  return commit(fields, fields, entries, now);
}

/* ----------------------------------------------------------------- what the save would refuse */

export type BandProblem = { index: number; kind: "same_name" | "no_name" };

const labelKey = (value: unknown) => text(value).toLowerCase().replace(/\s+/g, " ");

/**
 * Extra bands of a card that the save would refuse or the traveller could not tell apart: a priced
 * band with no age or height and the same name as another such band (two «Хүүхэд» at two prices),
 * or with no name at all. The admin names them or gives each an age range.
 */
export function bandProblems(card: Pick<PriceCard, "bands">): BandProblem[] {
  const ageless = card.bands.filter((band) => !text(band.row.age_range));
  return card.bands.flatMap((band): BandProblem[] => {
    if (band.role !== "other" || num(band.row.price) === null || text(band.row.age_range)) return [];
    const name = labelKey(band.row.label);
    if (!name) return [{ index: band.index, kind: "no_name" }];
    return ageless.some((other) => other.index !== band.index && labelKey(other.row.label) === name) ? [{ index: band.index, kind: "same_name" }] : [];
  });
}

export const BAND_PROBLEM_TEXT: Record<BandProblem["kind"], string> = {
  same_name: "Энэ нь хүүхдийн үнэтэй ижил нэртэй, насны хүрээгүй байна. Насны хүрээг бичих эсвэл өөр нэр өгнө үү (ж: «Хүүхэд ор эзлэхгүй»).",
  no_name: "Нэр эсвэл насны хүрээгээ бичнэ үү, тэгэхгүй бол энэ үнэ хэнд хамаарахыг ялгах боломжгүй.",
};

// What tripDataValidation refuses about fares, in the words the admin uses (the save would stop on these, draft or not).
const FARE_PROBLEM_CODES = ["conflicting_price_groups", "overlapping_age_categories", "invalid_age_range", "invalid_base_price"];
const rowOfPath = (path: string) => /price_groups\[(\d+)\]/.exec(path)?.[1];

/**
 * Fare problems the save would refuse, in plain Mongolian, found on the reviewed trip before anything
 * is saved (the same audit the server runs, on the fields as they would be saved).
 */
export function priceProblems(fields: Row, now = new Date()): string[] {
  const { days, other } = departureDays(fields.departure_dates, now);
  const saved = normalizePriceRows({ ...fields, departure_dates: [...days, ...other] }, now);
  const out = new Set<string>();
  for (const issue of validateTripDataChange(saved as TripFactInput, null, now).errors) {
    if (!FARE_PROBLEM_CODES.includes(issue.code)) continue;
    if (issue.code === "conflicting_price_groups") {
      const [a, b] = issue.paths.map((path) => rowOfPath(path));
      out.add(a !== undefined && a === b
        ? "Нэг үнийн картанд ижил ангилалд хоёр өөр үнэ байна (жишээ нь хоёр «Хүүхэд»). Хоёр дахь үнийн насны хүрээг эсвэл нэрийг ялгаж бичнэ үү, эсвэл нэгийг нь хасна уу."
        : "Ижил буудал, багцтай хоёр үнийн картанд нэг өдөр өөр үнэ байна. Буудал эсвэл багцаар нь ялгана уу, эсвэл нэг картыг болино уу.");
    } else if (issue.code === "overlapping_age_categories") out.add("Насны ангилал хоорондоо давхцаж байна. Насны хүрээг давхцуулахгүйгээр бичнэ үү.");
    else if (issue.code === "invalid_age_range") out.add("Насны хүрээний доод хязгаар нь дээд хязгаараас их байна.");
    else out.add("Үнэ нь сөрөг биш бүхэл тоо байх ёстой.");
  }
  return Array.from(out);
}

/* ----------------------------------------------------------------- reading aloud */

export const formatMnt = (value: number) => `${value.toLocaleString("en-US")}₮`;

/** «1/14 Пү, 1/21 Пү +2 · 3,390,000₮»: a card in a short line, for a drop-down list on a phone. */
export function cardShort(card: PriceCard, showYear = false): string {
  const all = [...card.days.map((day) => dayLabel(day, showYear)), ...card.other];
  const days = all.length > 3 ? `${all.slice(0, 2).join(", ")} +${all.length - 2}` : all.join(", ");
  const name = [card.hotel, card.packageId].filter(Boolean).join(" · ");
  return [name, days || (card.everyDate ? "Бүх өдөр" : ""), card.adult !== null ? formatMnt(card.adult) : ""].filter(Boolean).join(" · ");
}

/** «11/22 Бя»; with the year («2027/1/14 Пү») when the trip leaves in more than one year. */
export function dayLabel(ymd: string, showYear = false): string {
  if (!isYmd(ymd)) return ymd;
  const [year, month, day] = ymd.split("-").map(Number);
  return `${showYear ? `${year}/` : ""}${month}/${day} ${weekdayOf(ymd).slice(0, 2)}`;
}

/** «11/22, 11/29 — Том хүн 2,190,000₮ · Хүүхэд 1,890,000₮»: one card in one line. */
export function cardSummary(card: PriceCard, showYear = false): string {
  const days = [...card.days.map((day) => dayLabel(day, showYear)), ...card.other].join(", ");
  const fares = [
    card.adult !== null ? `Том хүн ${formatMnt(card.adult)}` : "",
    card.child !== null ? `Хүүхэд ${formatMnt(card.child)}` : "",
    card.infant === 0 ? "Нярай үнэгүй" : card.infant !== null ? `Нярай ${formatMnt(card.infant)}` : "",
  ].filter(Boolean).join(" · ");
  return [days || (card.everyDate ? "Бүх өдөр" : ""), fares || "үнэ оруулаагүй"].filter(Boolean).join(" — ");
}
