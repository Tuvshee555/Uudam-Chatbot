/**
 * The poster price table following a chatbot trip save.
 *
 * Why: a price changed in the trip editor (or any save other than the assistant's per-date edit)
 * left the poster table as it was. The poster PDF on the website then printed the old fare, and
 * the next Poster-tab save wrote that old fare back over the trip. The nightly parity check found
 * 16 posters in that state on 2026-11-11.
 *
 * How: when the save changed a price, the table is written again from the trip's price rows
 * (posterTableFromTrip) and kept only when the parity check's own poster comparison finds no
 * price difference in it (wording-only differences allowed). Otherwise, or on any error, the
 * caller keeps the table it had: never worse than before.
 */
import type { TravelTrip } from "../travelTypes";
import { posterTableFromTrip } from "./priceTableFromTrip";

type Row = Record<string, unknown>;

const PRICE_CODES = new Set(["poster_price", "poster_row_extra", "poster_row_unreadable", "poster_row_missing", "poster_choice_name"]);

function pricesChanged(trip: TravelTrip, before: TravelTrip | null | undefined): boolean {
  if (!before) return true;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return !same(trip.adult_price, before.adult_price) || !same(trip.child_price, before.child_price)
    || !same(trip.infant_price, before.infant_price) || !same(trip.departure_dates, before.departure_dates)
    || !same(trip.extra.price_groups, before.extra?.price_groups) || !same(trip.extra.age_rules, before.extra?.age_rules)
    || !same(trip.extra.package_options, before.extra?.package_options);
}

/** The table rebuilt from the trip, keeping the poster table's own note and other keys; null when there is none. */
export function rebuiltPosterTable(trip: TravelTrip, posterData: Row, now: Date): Row | null {
  const built = posterTableFromTrip(trip, now);
  if (!built.table) return null;
  const prior = posterData.price_table && typeof posterData.price_table === "object" && !Array.isArray(posterData.price_table)
    ? (posterData.price_table as Row) : {};
  return { ...prior, ...built.table };
}

/** The rebuilt table, or null to keep the poster's own. Never throws. */
export async function followedPosterPriceTable(rawTrip: TravelTrip, posterData: Row, rawBefore?: TravelTrip | null, now = new Date()): Promise<Row | null> {
  try {
    // The trip store hands over database rows (numeric columns may arrive as text): read them as the app does.
    const { mapTripRow } = await import("../travelDb");
    const trip = mapTripRow(rawTrip as unknown as Parameters<typeof mapTripRow>[0]);
    const before = rawBefore ? mapTripRow(rawBefore as unknown as Parameters<typeof mapTripRow>[0]) : null;
    if (!pricesChanged(trip, before)) return null;
    const table = rebuiltPosterTable(trip, posterData, now);
    if (!table) return null;
    if (JSON.stringify(table) === JSON.stringify(posterData.price_table)) return null;
    // Loaded here: the parity check reads half the app, and this module sits under the trip store.
    const { posterDifferences } = await import("../parityAudit");
    const problems = posterDifferences(trip, { ...posterData, price_table: table }, now).filter((diff) => PRICE_CODES.has(diff.code));
    return problems.length ? null : table;
  } catch {
    return null;
  }
}
