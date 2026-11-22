/**
 * The assistant's set_date_sale (2026-11-22): a sale fare and/or «Онцлох» on ONE departure date.
 *
 * Like a day's seat state (set_date_state) it is written straight on the website's departure row
 * (websiteTripSync.changeDepartureDeal → Departure.salePrice / saleChildPrice / isFeatured), it does
 * not move the trip's version, and it is undone from the rows recorded at save. The regular fare
 * stays: the website shows it struck through beside the sale with the percent (departureDeals.ts).
 *
 * Planned here from the trip as read (its departureDeals overlay and its fares), so the agent's
 * card, validation and apply refuse the same things with the same Mongolian reasons, and the card
 * line ("12/9 хямдрал: 2,590,000₮ → 2,390,000₮ (−8%)") comes from the action alone. Pure and
 * browser-safe (no database).
 */
import { dealChangeText, dealOn, withoutDeals } from "./departureDeals";
import { resolveTripOfferFareCard, type OfferFare } from "./tripOffers";
import { tripDepartureDays, ulaanbaatarToday, websiteDays } from "./tripActionPlan";
import { shortDay } from "./tripDatePrice";
import { formatMnt } from "./tripFareChange";
import type { AITripAction, TravelTrip } from "./travelTypes";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_FARE = 200_000_000;

/** A date's sale fares and «Онцлох» as the website shows them (a sale only counts below the regular fare). */
export type DateSaleObserved = { sale_adult: number | null; sale_child: number | null; featured: boolean };

/** What the model (or a stored action) asks for one date. */
export type DateSaleRequest = {
  date: string;
  sale?: unknown;
  clear_sale?: unknown;
  featured?: unknown;
  from_adult?: unknown;
  from_child?: unknown;
};

export type DateSalePlan = {
  date: string;
  /** Only the sale fares that change (set semantics, MNT). */
  sale: { adult?: number; child?: number };
  /** The date's sale is removed (both fares back to the regular one). */
  clear_sale: boolean;
  /** «Онцлох» when it changes; undefined = kept. */
  featured?: boolean;
  /** The old prices the admin wrote ("2,590,000-аас"), kept for the card's note. */
  from: { adult?: number; child?: number };
  regular: { adult: number | null; child: number | null };
  observed: DateSaleObserved;
  notes: string[];
  /** Set when nothing would change: what the date already has. */
  already?: string;
};

export type DateSaleOutcome = { ok: true; plan: DateSalePlan } | { ok: false; reason: string; final: boolean };

// The admin's words that ask for a sale or «Онцлох» (the agent's guard: a model that slips in a sale
// nobody asked for is refused). Broad on purpose: it only lets the action through.
export const DATE_SALE_WORDS = /хямд|онцл|акц|урамшуул|\d\s*%|хувь|(?<!\p{L})(?:k?hy?a?md\p{L}*|xy?a?md\p{L}*|onts?l\p{L}*|ontsol\p{L}*|sale|discount|promo\p{L}*|featured|highlight\p{L}*|huvi\p{L}*)(?!\p{L})/iu;

// A message that clearly asks for a SALE (not a new regular price): the noun «хямдрал», «Онцлох»,
// "X-аас Y хүртэл хямдруул". The brain's simple mode must not read it as a regular price change.
const SALE_NOUNS = /хямдрал|онцло|(?<!\p{L})(?:k?h|x)y?a?mdral\p{L}*|(?<!\p{L})onts?l\p{L}*|(?<!\p{L})sale(?!\p{L})|(?:аас|ээс|оос|өөс)\s+[\d.,\s]+(?:сая|мянга|k|к)?\s*хүртэл\s+хямд|(?:aas|ees|oos)\s+[\d.,\s]+(?:saya|myanga|k)?\s*(?:hurtel|khurtel)\s+(?:k?h|x)y?a?md/iu;

export function asksDateSale(admin: string): boolean {
  return SALE_NOUNS.test(admin);
}

/** A sale fare as an action carries it: a whole positive tugrik amount; "bad" otherwise. */
function fareOf(value: unknown): number | undefined | "bad" {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/[\s,₮]/g, "")) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_FARE) return "bad";
  return Math.round(n);
}

function exactAmount(fare: OfferFare | undefined): number | null {
  return fare?.kind === "exact" && fare.amount > 0 ? fare.amount : null;
}

/**
 * The date's regular (not sale) fares: the website's own when the date already has a deal, else the
 * fares the resolver gives for that date on the trip without its sales (display card, so a full date
 * still has its fare). Several child bands: the trip's headline child fare, as the website column has.
 */
export function dateRegularFares(trip: TravelTrip, date: string, now: Date): { adult: number | null; child: number | null } {
  const deal = dealOn(trip, date);
  if (deal) return { adult: deal.regular_adult_price, child: deal.regular_child_price };
  const result = resolveTripOfferFareCard(withoutDeals(trip), { date }, now);
  if (result.status !== "ready") return { adult: null, child: null };
  const { adult, child } = result.offer.prices;
  const headlineChild = child?.kind === "unknown" && child.reason === "passenger_age_required" && typeof trip.child_price === "number" && trip.child_price > 0
    ? trip.child_price : null;
  return { adult: exactAmount(adult), child: exactAmount(child) ?? headlineChild };
}

/** The date's sale and «Онцлох» as the trip read shows them. */
export function dateSaleObserved(trip: TravelTrip, date: string): DateSaleObserved {
  const deal = dealOn(trip, date);
  return { sale_adult: deal?.sale_adult_price ?? null, sale_child: deal?.sale_child_price ?? null, featured: deal?.featured === true };
}

/**
 * Why a sale or «Онцлох» cannot be put on this day, or null: the day must be one of the trip's
 * departures still ahead and on the website (the row the sale is written on), not cancelled or gone.
 */
export function dateSaleProblem(trip: TravelTrip, date: string, now: Date = new Date()): string | null {
  if (!ISO.test(String(date || ""))) return "Огноог YYYY-MM-DD хэлбэрээр заана уу.";
  const day = shortDay(date);
  if (date < ulaanbaatarToday(now)) return `${day} өнгөрсөн өдөр тул хямдрал, «Онцлох» тавихгүй.`;
  const rows = websiteDays(trip).filter((row) => row.date === date);
  if (!rows.length) {
    return tripDepartureDays(trip, now).includes(date)
      ? `«${trip.route_name}» аяллын ${day}-ны гаралт вэбсайтад хараахан нийтлэгдээгүй тул хямдрал, «Онцлох» тавих боломжгүй. Аялал сайтад гарсны дараа дахин хэлнэ үү.`
      : `«${trip.route_name}» аялалд ${day}-нд гаралт алга.`;
  }
  if (rows.every((row) => row.status === "CANCELLED" || row.status === "DEPARTED")) {
    return `${day}-ны гаралт ${rows[0].status === "DEPARTED" ? "явсан" : "цуцлагдсан"} тул хямдрал, «Онцлох» тавихгүй.`;
  }
  return null;
}

const KIND_WORDS = { adult: "том хүний", child: "хүүхдийн" } as const;

/**
 * The exact change one set_date_sale makes on the trip as it is: only the parts that change, each
 * sale fare checked against the date's regular fare (a sale that is not lower is refused: the website
 * would not show it), a note when the old price the admin wrote is not the date's regular fare.
 */
export function planDateSale(trip: TravelTrip, request: DateSaleRequest, now: Date = new Date()): DateSaleOutcome {
  const date = text(request.date);
  const problem = dateSaleProblem(trip, date, now);
  // A day the trip really has (not on the website yet, past) is explained; a wrong day is asked again.
  if (problem) return { ok: false, reason: problem, final: ISO.test(date) && tripDepartureDays(trip, now).includes(date) };
  const day = shortDay(date);
  const sale = record(request.sale);
  const adult = fareOf(sale.adult);
  const child = fareOf(sale.child);
  if (adult === "bad" || child === "bad") return { ok: false, reason: `${day}: хямдралын үнийг төгрөгөөр, 0-ээс их дүнгээр заана уу.`, final: false };
  const clear = request.clear_sale === true;
  const featured = typeof request.featured === "boolean" ? request.featured : undefined;
  if (clear && (adult !== undefined || child !== undefined)) return { ok: false, reason: `${day}: хямдрал тавих, арилгахыг зэрэг заасан байна — аль нь болохыг тодруулна уу.`, final: false };
  if (!clear && adult === undefined && child === undefined && featured === undefined) {
    return { ok: false, reason: `${day}: хямдралын үнэ, хямдрал арилгах эсвэл «Онцлох»-ын аль нь болохыг заагаагүй байна.`, final: false };
  }
  const regular = dateRegularFares(trip, date, now);
  for (const [kind, amount] of [["adult", adult], ["child", child]] as const) {
    if (amount === undefined) continue;
    const base = regular[kind];
    if (base === null) {
      return { ok: false, reason: `${day}-ны ${KIND_WORDS[kind]} үндсэн үнэ тодорхойгүй тул хямдрал тавих боломжгүй — эхлээд тэр өдрийн үнийг тавина уу.`, final: true };
    }
    if (amount >= base) {
      return {
        ok: false,
        reason: `${day}-ны ${KIND_WORDS[kind]} хямдралын үнэ ${formatMnt(amount)} нь үндсэн үнэ ${formatMnt(base)}-өөс бага биш тул хямдрал болохгүй. Үндсэн үнийг өөрчлөх бол «${day}-ны үнийг ${formatMnt(amount)} болго» гэж бичнэ үү.`,
        final: true,
      };
    }
  }
  const observed = dateSaleObserved(trip, date);
  const notes: string[] = [];
  const from: DateSalePlan["from"] = {};
  for (const [kind, raw] of [["adult", request.from_adult], ["child", request.from_child]] as const) {
    const said = fareOf(raw);
    if (typeof said !== "number") continue;
    from[kind] = said;
    const base = regular[kind];
    if (base !== null && said !== base) {
      notes.push(`Та ${formatMnt(said)}-аас гэж бичсэн ч ${day}-ны ${KIND_WORDS[kind]} үндсэн үнэ ${formatMnt(base)} байна — сайт хуучин үнээр ${formatMnt(base)}-ийг зурж харуулна.`);
    }
  }
  const plan: DateSalePlan = { date, sale: {}, clear_sale: false, from, regular, observed, notes };
  if (adult !== undefined && adult !== observed.sale_adult) plan.sale.adult = adult;
  if (child !== undefined && child !== observed.sale_child) plan.sale.child = child;
  if (clear && (observed.sale_adult !== null || observed.sale_child !== null)) plan.clear_sale = true;
  if (featured !== undefined && featured !== observed.featured) plan.featured = featured;
  if (plan.sale.adult === undefined && plan.sale.child === undefined && !plan.clear_sale && plan.featured === undefined) {
    plan.already = clear && featured === undefined ? `${day}-нд хямдрал аль хэдийн алга` : `${day} аль хэдийн ийм хямдрал, «Онцлох»-той байна`;
  }
  return { ok: true, plan };
}

/** The stored action's own set_date_sale fields for a plan (regular fares and what the date showed ride along). */
export function dateSaleActionFields(plan: DateSalePlan): Partial<AITripAction> {
  const sale = { ...(plan.sale.adult !== undefined ? { adult: plan.sale.adult } : {}), ...(plan.sale.child !== undefined ? { child: plan.sale.child } : {}) };
  return {
    date: plan.date,
    ...(Object.keys(sale).length ? { sale } : {}),
    ...(plan.clear_sale ? { clear_sale: true } : {}),
    ...(plan.featured !== undefined ? { featured: plan.featured } : {}),
    ...(plan.from.adult !== undefined ? { from_adult: plan.from.adult } : {}),
    ...(plan.from.child !== undefined ? { from_child: plan.from.child } : {}),
    regular_adult: plan.regular.adult,
    regular_child: plan.regular.child,
    observed_deal: plan.observed,
  };
}

const amountOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

function observedOf(value: unknown): DateSaleObserved | undefined {
  const row = record(value);
  if (!("featured" in row) && !("sale_adult" in row) && !("sale_child" in row)) return undefined;
  return { sale_adult: amountOrNull(row.sale_adult), sale_child: amountOrNull(row.sale_child), featured: row.featured === true };
}

/** Only the keys set_date_sale reads, cleaned (a model's extra keys never reach apply or the stored proposal). */
export function sanitizeDateSaleAction(action: Row): AITripAction {
  const kept: Row = {};
  for (const key of ["action", "trip_id", "match", "expected_updated_at", "summary"]) if (action[key] !== undefined) kept[key] = action[key];
  kept.action = "set_date_sale";
  if (typeof kept.trip_id === "string") kept.trip_id = kept.trip_id.trim();
  kept.date = text(action.date);
  const sale = record(action.sale);
  const saleKept: Row = {};
  // A bad amount is kept as it is, so the planner refuses it with its reason.
  for (const kind of ["adult", "child"]) if (sale[kind] !== undefined && sale[kind] !== null) saleKept[kind] = fareOf(sale[kind]) === "bad" ? sale[kind] : fareOf(sale[kind]);
  if (Object.keys(saleKept).length) kept.sale = saleKept;
  if (action.clear_sale === true) kept.clear_sale = true;
  if (typeof action.featured === "boolean") kept.featured = action.featured;
  for (const key of ["from_adult", "from_child"]) { const amount = fareOf(action[key]); if (typeof amount === "number") kept[key] = amount; }
  for (const key of ["regular_adult", "regular_child"]) if (key in action) kept[key] = amountOrNull(action[key]);
  const observed = observedOf(action.observed_deal);
  if (observed) kept.observed_deal = observed;
  return kept as unknown as AITripAction;
}

/** The request a stored action makes (for validation and apply, which plan it again). */
export function dateSaleRequestOf(action: AITripAction): DateSaleRequest {
  return { date: text(action.date), sale: action.sale, clear_sale: action.clear_sale, featured: action.featured, from_adult: action.from_adult, from_child: action.from_child };
}

/** What changeDepartureDeal writes for the action: undefined keeps a column, null clears it. */
export function dateSaleWrite(action: AITripAction): { salePrice?: number | null; saleChildPrice?: number | null; isFeatured?: boolean } {
  const sale = record(action.sale);
  const adult = fareOf(sale.adult);
  const child = fareOf(sale.child);
  return {
    ...(action.clear_sale === true ? { salePrice: null, saleChildPrice: null } : {}),
    ...(typeof adult === "number" ? { salePrice: adult } : {}),
    ...(typeof child === "number" ? { saleChildPrice: child } : {}),
    ...(typeof action.featured === "boolean" ? { isFeatured: action.featured } : {}),
  };
}

/**
 * The card lines of one set_date_sale, from the action itself (its stored regular fares and what the
 * date showed), so the card reads the same before and after the save:
 *   "12/9 хямдрал: 2,590,000₮ → 2,390,000₮ (−8%)", "12/9 хүүхдийн хямдрал: …",
 *   "12/9: хямдрал арилна (2,390,000₮ → 2,590,000₮)", "12/9: «Онцлох» болно" / "12/9: «Онцлох» хасна".
 * `trip` only fills regular fares an older action did not record.
 */
export function dateSaleLines(action: AITripAction, trip?: TravelTrip | null, now: Date = new Date()): string[] {
  const date = text(action.date);
  const day = shortDay(date);
  const recorded = "regular_adult" in action || "regular_child" in action;
  // An older action without its recorded fares: read from the trip as loaded (a list row may lack them).
  const fromTrip = <T,>(read: () => T): T | null => {
    if (!trip || !ISO.test(date)) return null;
    try { return read(); } catch { return null; }
  };
  const fallback = recorded ? null : fromTrip(() => dateRegularFares(trip!, date, now));
  const regularAdult = recorded ? amountOrNull(action.regular_adult) : fallback?.adult ?? null;
  const regularChild = recorded ? amountOrNull(action.regular_child) : fallback?.child ?? null;
  const observed = observedOf(action.observed_deal) ?? fromTrip(() => dateSaleObserved(trip!, date)) ?? undefined;
  const sale = record(action.sale);
  const adult = fareOf(sale.adult);
  const child = fareOf(sale.child);
  const lines: string[] = [];
  if (typeof adult === "number") {
    lines.push(`${day} хямдрал: ${dealChangeText(regularAdult, adult)}`);
    if (observed?.sale_adult != null && observed.sale_adult !== adult) lines.push(`${day} одоогийн хямдрал: ${formatMnt(observed.sale_adult)} → ${formatMnt(adult)}`);
  }
  if (typeof child === "number") {
    lines.push(`${day} хүүхдийн хямдрал: ${dealChangeText(regularChild, child)}`);
    if (observed?.sale_child != null && observed.sale_child !== child) lines.push(`${day} хүүхдийн одоогийн хямдрал: ${formatMnt(observed.sale_child)} → ${formatMnt(child)}`);
  }
  if (action.clear_sale === true) {
    const cleared: string[] = [];
    if (observed?.sale_adult != null) cleared.push(`${day}: хямдрал арилна (${formatMnt(observed.sale_adult)} → ${formatMnt(regularAdult)})`);
    if (observed?.sale_child != null) cleared.push(`${day}: хүүхдийн хямдрал арилна (${formatMnt(observed.sale_child)} → ${formatMnt(regularChild)})`);
    lines.push(...(cleared.length ? cleared : [`${day}: хямдрал арилна`]));
  }
  if (action.featured === true) lines.push(`${day}: «Онцлох» болно`);
  if (action.featured === false) lines.push(`${day}: «Онцлох» хасна`);
  return lines.length ? lines : [`${day}: хямдрал`];
}
