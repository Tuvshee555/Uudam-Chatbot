/**
 * A poster price table written from the trip's own price rows (extra.price_groups).
 *
 * Why: the chatbot trip is where prices are kept (the assistant, the trip editor, the partner
 * sync all write price_groups). The poster table is a second copy: the poster PDF prints it and a
 * Poster-tab save reads it back over the trip. Where the poster was typed by hand (date ranges,
 * one column per package, an old fare) it drifted from the trip. This writes the table again from
 * the trip, one row per hotel/package and price, upcoming dates only, in the exact shape the
 * poster reader (tripMapper.mapPriceGroups) reads back.
 *
 * The caller must still check the read-back (parityAudit.posterDifferences) before saving: a
 * trip whose rows the poster shape cannot hold returns a table that reads back differently.
 * Pure.
 */
import { pricingDays } from "../adminDatePricing";
import { isInfantShapedAge } from "../travelFastPathsSearch";
import { posterDateText } from "./priceTableWrite";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const records = (value: unknown): Row[] => (Array.isArray(value) ? value.map(record) : []);
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);
const PACKAGE_SEPARATOR = " · ";

/** Today in Ulaanbaatar (UTC+8), as the parity check and the website count "upcoming". */
function ubToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

type Tier = { header: string; infant: boolean; price: number | null; free: boolean };

/** The header a passenger tier is printed under: its own label, with the age band added when the label lacks it. */
function tierHeader(label: string, ageRange: string, infant: boolean): string {
  const base = label || (infant ? "Нярай" : "Хүүхэд");
  if (!ageRange || /\d/.test(base)) return base;
  return `${base} ${ageRange}`;
}

function tiersOf(group: Row, ages: Row): Tier[] {
  const listed = records(group.passenger_prices);
  if (listed.length) {
    const tiers = listed.map((tier) => {
      const label = text(tier.label);
      const ageRange = text(tier.age_range);
      const infant = isInfantShapedAge(label.toLowerCase(), ageRange);
      const price = num(tier.price);
      return { header: tierHeader(label, ageRange, infant), infant, price, free: price === 0 || /үнэгүй/i.test(text(tier.note)) };
    });
    // An infant fare kept only on the row (bands list the children) is still a fare the card quotes.
    const infant = num(group.infant_price);
    if (!tiers.some((tier) => tier.infant) && infant != null) {
      tiers.push({ header: tierHeader("Нярай", text(group.infant_age) || text(ages.infant), true), infant: true, price: infant, free: infant === 0 });
    }
    return tiers;
  }
  const out: Tier[] = [];
  const child = num(group.child_price);
  // A row without its own bands is read with the trip's (age_rules), as the fare card reads it.
  if (child != null) out.push({ header: tierHeader("Хүүхэд", text(group.child_age) || text(ages.child), false), infant: false, price: child, free: child === 0 });
  const infant = num(group.infant_price);
  if (infant != null) out.push({ header: tierHeader("Нярай", text(group.infant_age) || text(ages.infant), true), infant: true, price: infant, free: infant === 0 });
  return out;
}

const money = (value: number) => `${value.toLocaleString("en-US")}₮`;

function sellerCell(group: Row, packages: Array<{ id: string; label: string }>): string {
  const hotel = text(group.hotel);
  const packageId = text(group.package_id);
  const pack = packageId ? packages.find((option) => option.id === packageId)?.label || packageId : "";
  if (hotel && pack) return `${hotel}${PACKAGE_SEPARATOR}${pack}`;
  return hotel || pack;
}

export type PosterTableFromTrip = { table: Row } | { table: null; reason: string };

/**
 * The poster table for `extra.price_groups`, or why there is none (no rows, a foreign currency,
 * nothing upcoming). Rows with the same hotel/package and the same prices share one row.
 */
export type TripPrices = {
  adult_price: number | null;
  child_price: number | null;
  infant_price: number | null;
  departure_dates: string[];
  extra: Row;
};

/** The trip's one fare row when it has no price rows of its own: its base fares on its departures. */
function baseFareRow(trip: TripPrices): Row | null {
  if (trip.adult_price == null) return null;
  const ages = record(trip.extra.age_rules);
  return {
    dates: trip.departure_dates,
    adult_price: trip.adult_price,
    child_price: trip.child_price,
    infant_price: trip.infant_price,
    child_age: text(ages.child),
    infant_age: text(ages.infant),
  };
}

export function posterTableFromTrip(trip: TripPrices, now: Date): PosterTableFromTrip {
  const extra = record(trip.extra);
  const own = records(extra.price_groups);
  const base = own.length ? null : baseFareRow(trip);
  const groups = own.length ? own : base ? [base] : [];
  if (!groups.length) return { table: null, reason: "no price rows and no base fare" };
  if (groups.some((group) => text(group.currency) && text(group.currency) !== "MNT")) return { table: null, reason: "a price row is not in tugrug" };
  const packages = records(extra.package_options)
    .map((option) => ({ id: text(option.id) || text(option.label), label: text(option.label) || text(option.id) }))
    .filter((option) => option.id);
  const today = ubToday(now);

  type Draft = { seller: string; dates: string[]; dateText: string; adult: string; tiers: Tier[]; single: number | null };
  const drafts: Draft[] = [];
  for (const group of groups) {
    // A full date keeps its row: the card still prints its prices (the partner page does too). Cancelled is gone.
    if (text(group.status) === "cancelled") continue;
    const allDays = pricingDays(group, now);
    const days = allDays.filter((day) => day >= today);
    const stored = Array.isArray(group.dates) ? group.dates.map(String).filter(Boolean) : [];
    // A row dated only in the past sells nothing any more.
    if (allDays.length && !days.length) continue;
    // A row with no calendar day ("Баасан гараг бүр", or none) keeps its own date text.
    const dateText = days.length ? "" : stored.join(", ");
    const range = record(group.adult_price_range);
    const adultValue = num(group.adult_price);
    const adult = num(range.min) != null && num(range.max) != null && num(range.max)! > num(range.min)!
      ? `${num(range.min)!.toLocaleString("en-US")}-${money(num(range.max)!)}`
      : adultValue != null ? money(adultValue) : "";
    drafts.push({ seller: sellerCell(group, packages), dates: days, dateText, adult, tiers: tiersOf(group, record(extra.age_rules)), single: num(group.single_price) });
  }
  if (!drafts.length) return { table: null, reason: "nothing upcoming" };

  // Columns: children in first-seen order, then infants, each header once.
  const childHeaders: string[] = [];
  const infantHeaders: string[] = [];
  for (const draft of drafts) {
    for (const tier of draft.tiers) {
      const list = tier.infant ? infantHeaders : childHeaders;
      if (!list.includes(tier.header)) list.push(tier.header);
    }
  }
  const hasSeller = drafts.some((draft) => draft.seller);
  const hasSingle = drafts.some((draft) => draft.single != null);
  const columns = [
    ...(hasSeller ? ["Буудал"] : []),
    "Том хүн",
    ...childHeaders,
    ...infantHeaders,
    ...(hasSingle ? ["Ганцаараа явах"] : []),
  ];

  const cellsOf = (draft: Draft): string[] => {
    const passenger = (header: string) => {
      const tier = draft.tiers.find((entry) => entry.header === header);
      if (!tier || tier.price == null) return "-";
      return tier.free ? "Үнэгүй" : money(tier.price);
    };
    return [
      ...(hasSeller ? [draft.seller || "-"] : []),
      draft.adult || "-",
      ...childHeaders.map(passenger),
      ...infantHeaders.map(passenger),
      ...(hasSingle ? [draft.single != null ? money(draft.single) : "-"] : []),
    ];
  };

  // Same seller and same cells: one row with every date.
  const merged = new Map<string, { cells: string[]; dates: Set<string>; dateText: string }>();
  for (const draft of drafts) {
    const cells = cellsOf(draft);
    const key = JSON.stringify([cells, draft.dateText]);
    const row = merged.get(key) || { cells, dates: new Set<string>(), dateText: draft.dateText };
    draft.dates.forEach((day) => row.dates.add(day));
    merged.set(key, row);
  }
  const rows = [...merged.values()]
    .map((row) => ({ dates: row.dates.size ? posterDateText([...row.dates], true) : row.dateText, cells: row.cells, first: [...row.dates].sort()[0] || "" }))
    .sort((a, b) => (a.first < b.first ? -1 : a.first > b.first ? 1 : 0))
    .map(({ dates, cells }) => ({ dates, cells }));
  return { table: { columns, rows } };
}
