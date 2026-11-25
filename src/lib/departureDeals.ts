/**
 * A sale fare and an «Онцлох» flag on ONE departure date (2026-11-22).
 *
 * Both live on the website's departure row (Departure.salePrice / saleChildPrice / isFeatured), the
 * row both admins, the website and the bot read, so a sale set in either admin or by the assistant is
 * true everywhere at once. The chatbot's website sync never writes those columns, so a resync keeps it.
 *
 * Read with the trips (websiteTripSync.withWebsiteDepartureAvailability) into
 * extra.website_departure_deals — derived, never saved (tripExtraSchema DERIVED_EXTRA_KEYS). The fare
 * resolver turns each sale into an unconditional discount on that date only (tripOffers), so every
 * price answer, the trip card and the reply checker quote the sale fare for that date and the regular
 * fare for the others. The percent is always worked out from the two fares, never stored, so it stays
 * right after the secondary brand lowers both (brandFares).
 */
import type { TravelTrip } from "./travelTypes";

export const DEALS_KEY = "website_departure_deals";

/** One upcoming departure date: its regular fares, its sale fares (only when lower) and «Онцлох». */
export type DepartureDeal = {
  date: string;
  regular_adult_price: number | null;
  regular_child_price: number | null;
  sale_adult_price: number | null;
  sale_child_price: number | null;
  featured: boolean;
};

type Row = Record<string, unknown>;

function amount(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** A sale fare counts only when it is below the regular fare. */
export function saleBelow(regular: number | null, sale: number | null): number | null {
  return regular !== null && sale !== null && sale < regular ? sale : null;
}

/** "−9%": how much lower the sale fare is, rounded; null when it is not a sale. */
export function salePercent(regular: number | null | undefined, sale: number | null | undefined): number | null {
  if (!(typeof regular === "number" && regular > 0 && typeof sale === "number" && sale > 0 && sale < regular)) return null;
  return Math.max(1, Math.round(((regular - sale) / regular) * 100));
}

/** One website departure row as a deal, or null when it has no sale and is not featured. */
export function dealFromRow(row: {
  date: string;
  price?: unknown; childPrice?: unknown; tripPrice?: unknown; tripChildPrice?: unknown;
  salePrice?: unknown; saleChildPrice?: unknown; isFeatured?: unknown;
}): DepartureDeal | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date)) return null;
  const regularAdult = amount(row.price) ?? amount(row.tripPrice);
  const regularChild = amount(row.childPrice) ?? amount(row.tripChildPrice);
  const saleAdult = saleBelow(regularAdult, amount(row.salePrice));
  const saleChild = saleBelow(regularChild, amount(row.saleChildPrice));
  const featured = row.isFeatured === true;
  if (saleAdult === null && saleChild === null && !featured) return null;
  return {
    date: row.date,
    regular_adult_price: regularAdult,
    regular_child_price: regularChild,
    sale_adult_price: saleAdult,
    sale_child_price: saleChild,
    featured,
  };
}

/** The trip's deals as read with it (empty when the website is not connected). */
export function departureDeals(trip: Pick<TravelTrip, "extra">): DepartureDeal[] {
  const raw = (trip.extra as Row | undefined)?.[DEALS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): DepartureDeal[] => {
    if (!entry || typeof entry !== "object") return [];
    const row = entry as Row;
    const date = typeof row.date === "string" ? row.date : "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
    const regularAdult = amount(row.regular_adult_price);
    const regularChild = amount(row.regular_child_price);
    return [{
      date,
      regular_adult_price: regularAdult,
      regular_child_price: regularChild,
      sale_adult_price: saleBelow(regularAdult, amount(row.sale_adult_price)),
      sale_child_price: saleBelow(regularChild, amount(row.sale_child_price)),
      featured: row.featured === true,
    }];
  });
}

export function dealOn(trip: Pick<TravelTrip, "extra">, date: string): DepartureDeal | null {
  return departureDeals(trip).find((deal) => deal.date === date) ?? null;
}

export function dealHasSale(deal: DepartureDeal | null | undefined): boolean {
  return Boolean(deal && (deal.sale_adult_price !== null || deal.sale_child_price !== null));
}

/** The biggest percent off of a date (adult first, else child). */
export function dealPercent(deal: DepartureDeal | null | undefined): number | null {
  if (!deal) return null;
  return salePercent(deal.regular_adult_price, deal.sale_adult_price) ?? salePercent(deal.regular_child_price, deal.sale_child_price);
}

/** "хямдрал −9%" beside a date in a reply, or "" when the date is not on sale. */
export function dealDateNote(trip: Pick<TravelTrip, "extra">, date: string): string {
  const percent = dealPercent(dealOn(trip, date));
  return percent ? `хямдрал −${percent}%` : "";
}

/** Upcoming dates staff marked «Онцлох». */
export function featuredDealDates(trip: Pick<TravelTrip, "extra">, today: string): string[] {
  return departureDeals(trip).filter((deal) => deal.featured && deal.date >= today).map((deal) => deal.date).sort();
}

/**
 * Each sale as the fare resolver's discount row: unconditional, on that one date, with the adult
 * and/or child sale fare. A fare that is not on sale is left out, so the regular one stays.
 */
export function dealDiscountRows(trip: Pick<TravelTrip, "extra">): Row[] {
  return departureDeals(trip).filter(dealHasSale).map((deal) => ({
    id: `date-sale-${deal.date}`,
    label: "Хямдрал",
    dates: [deal.date],
    date_keys: [deal.date],
    ...(deal.sale_adult_price !== null ? { adult_price: deal.sale_adult_price } : {}),
    ...(deal.sale_child_price !== null ? { child_price: deal.sale_child_price } : {}),
    // Which regular fare each sale replaces: of two child tiers on the date, only that one is on sale (tripOffers.ts).
    ...(deal.sale_adult_price !== null && deal.regular_adult_price ? { adult_replaces: deal.regular_adult_price } : {}),
    ...(deal.sale_child_price !== null && deal.regular_child_price ? { child_replaces: deal.regular_child_price } : {}),
    source_kind: "date_sale",
  }));
}

/**
 * The trip without its date sales: what the website projection is built from. The website keeps the
 * REGULAR fare in Departure.price and the sale in its own column; projected with the sale, the next
 * sync would write the sale fare as the regular one and the struck-through price would be lost.
 */
export function withoutDeals<T extends Pick<TravelTrip, "extra">>(trip: T): T {
  const extra = trip.extra as Row | undefined;
  if (!extra || !(DEALS_KEY in extra)) return trip;
  const { [DEALS_KEY]: _deals, ...rest } = extra;
  return { ...trip, extra: rest } as T;
}

/** "3,290,000₮ → 2,990,000₮ (−9%)" for admin cards and assistant replies. */
export function dealChangeText(regular: number | null, sale: number | null): string {
  const money = (n: number) => `${n.toLocaleString("en-US")}₮`;
  if (sale === null) return regular !== null ? money(regular) : "—";
  const percent = salePercent(regular, sale);
  return regular !== null ? `${money(regular)} → ${money(sale)}${percent ? ` (−${percent}%)` : ""}` : money(sale);
}
