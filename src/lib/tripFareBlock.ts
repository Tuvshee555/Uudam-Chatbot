/**
 * The ONE place a trip's fares are turned into customer text.
 *
 * Prices used to be written out in 16 places, each reading the trip's raw
 * fields its own way (flat adult_price / child_price, price_groups, poster
 * tables, free-text age bands), while the reply checker read the canonical
 * resolver in tripOffers.ts. When they disagreed the checker rejected the
 * bot's own answer and the customer got silence: 75 of 233 answers for 12 of
 * 32 live trips on 2026-10-10. This block reads only the resolver, so what it
 * prints is, by construction, what the checker believes.
 *
 * Two labels are added beside the resolver's fares (2026-11-05), neither of them
 * a new number: a row's single supplement (the resolver's own supplemental fare,
 * which the checker accepts) and the condition a passenger label states when it
 * is not an age ("1,2–1,4 м", "оргүй"), read from the raw row only to name a
 * fare the resolver already priced.
 */
import type { TravelTrip } from "./travelTypes";
import { parseDepartureDateText } from "./travelDates";
import { passengerLabelCondition } from "./passengerCondition";
import { tripSupportsDate } from "./tripFacts";
import { lowSeatDates } from "./departureAvailability";
import { normalizeTripOffers, renderTripOfferReply, resolveTripOffer, resolveTripOfferFareCard, type NormalizedPassengerFare, type OfferFare, type PassengerKind, type ResolvedTripOffer, type TripOfferResult, type TripOfferSelection } from "./tripOffers";

const ORDER: PassengerKind[] = ["adult", "child", "infant"];
const LABEL: Record<PassengerKind, string> = { adult: "Том хүн", child: "Хүүхэд", infant: "Нярай" };
// A departure that is not on sale is not offered at any price.
const NOT_ON_SALE = new Set(["sold_out", "paused", "cancelled", "unavailable", "departed"]);
const MAX_PRICE_GROUPS = 3;
/** The website's and the AI catalogue's own words for a price row's single_price. */
export const SINGLE_FARE_LABEL = "Ганцаараа явах (өрөөндөө ганцаараа)";

/**
 * Departures with identical passenger fares. `lines` are only those fares (and the
 * hotel/package heading), so dates differing only by single supplement stay one group;
 * `singles` holds each supplement with the dates it applies to.
 */
export type FareGroup = { dates: string[]; lines: string[]; singles?: Array<{ price: string; dates: string[] }> };
type Row = Record<string, unknown>;

function money(fare: OfferFare, currency: string): string | null {
  const fmt = (n: number) => `${n.toLocaleString("en-US")}${currency === "MNT" ? "₮" : ` ${currency}`}`;
  if (fare.kind === "free") return "Үнэгүй";
  if (fare.kind === "exact") return currency === "MNT" && fare.amount < 1000 ? null : fmt(fare.amount);
  if (fare.kind === "range") return `${fare.min.toLocaleString("en-US")}–${fmt(fare.max)}`;
  return null;
}

function bandStart(fare: NormalizedPassengerFare): number {
  return fare.ageBand?.unit === "month" ? fare.ageBand.min : fare.ageBand?.unit === "birth_year" ? -fare.ageBand.max : 0;
}

const rowsOf = (value: unknown): Row[] => Array.isArray(value)
  ? value.filter((item): item is Row => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
const textOf = (value: unknown): string => typeof value === "string" ? value.trim() : "";

function fareKey(fare: OfferFare): string | null {
  if (fare.kind === "exact") return `exact:${fare.amount}`;
  if (fare.kind === "free") return "free";
  if (fare.kind === "range") return `range:${fare.min}-${fare.max}`;
  return null;
}

/** The fare a raw passenger row states, keyed like fareKey (the resolver's money() reading). */
function rawFareKey(entry: Row): string | null {
  const amount = entry.price ?? entry.amount;
  const range = entry.price_range && typeof entry.price_range === "object" ? entry.price_range as Row : null;
  if (range && typeof range.min === "number" && typeof range.max === "number") return range.min === range.max ? `exact:${range.min}` : `range:${range.min}-${range.max}`;
  if (typeof amount === "number" && amount > 0) return `exact:${amount}`;
  if (amount === 0 && (entry.free === true || /үнэгүй|\bfree\b/i.test(textOf(entry.note)))) return "free";
  return null;
}

/** The passenger kind the resolver reads from a row's kind/category/label (tripOffers passengerKind). */
function rawKind(entry: Row): PassengerKind | null {
  const label = (textOf(entry.kind) || textOf(entry.category) || textOf(entry.label)).toLowerCase().replace(/\s+/g, " ");
  if (/adult|том хүн|насанд хүр/.test(label)) return "adult";
  if (/infant|нярай/.test(label)) return "infant";
  if (/child|хүүхэд/.test(label)) return "child";
  return null;
}

const conditionCache = new WeakMap<TravelTrip, Map<string, Set<string>>>();

/** Conditions written in passenger labels that carry no age_range, by "<kind>|<fare>". */
function passengerConditions(trip: TravelTrip): Map<string, Set<string>> {
  const cached = conditionCache.get(trip);
  if (cached) return cached;
  const extra = (trip.extra || {}) as Row;
  const conditions = new Map<string, Set<string>>();
  const groups = [extra, ...rowsOf(extra.departure_date_groups), ...rowsOf(extra.price_groups), ...rowsOf(extra.discounts), ...rowsOf(extra.discount_groups)];
  for (const group of groups) {
    for (const entry of [...rowsOf(group.passenger_prices), ...rowsOf(group.child_rules), ...rowsOf(group.child_price_rules)]) {
      if (textOf(entry.age_range)) continue;
      const kind = rawKind(entry);
      const fare = rawFareKey(entry);
      if (!kind || !fare) continue;
      const condition = passengerLabelCondition(textOf(entry.label), kind);
      const key = `${kind}|${fare}`;
      // A bare "Хүүхэд" row at the same fare makes the condition uncertain for that fare.
      conditions.set(key, new Set([...(conditions.get(key) || []), condition || ""]));
    }
  }
  conditionCache.set(trip, conditions);
  return conditions;
}

/**
 * The condition of a passenger fare whose label is not an age ("1,2–1,4 м", "оргүй").
 * The resolver keeps only age_range, so such a fare printed as a bare "• Хүүхэд: …"
 * and read as every child's price. Null unless exactly one condition is written
 * for that kind at that fare. A condition the resolver itself carries wins.
 */
export function fareCondition(trip: TravelTrip, fare: Pick<NormalizedPassengerFare, "kind" | "ageRange" | "fare" | "priority"> & { condition?: string | null }): string | null {
  // What the label says beside its age ("6-11 нас оргүй") is the resolver's to read.
  if (typeof fare.condition === "string" && fare.condition) return fare.condition;
  if (fare.ageRange || fare.priority <= 0) return null;
  const key = fareKey(fare.fare);
  const found = key ? passengerConditions(trip).get(`${fare.kind}|${key}`) : undefined;
  return found && found.size === 1 ? [...found][0] || null : null;
}

/** "• Хүүхэд /2-11 нас/: 2,490,000₮" lines, one per distinct fare, adults first. */
export function fareLines(fares: NormalizedPassengerFare[], currency: string, trip?: TravelTrip): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const kind of ORDER) {
    for (const fare of fares.filter((f) => f.kind === kind).sort((a, b) => bandStart(a) - bandStart(b))) {
      const price = money(fare.fare, fare.currency || currency);
      if (!price) continue;
      // The adult band ("12+ нас") is implied by "Том хүн"; others name their band,
      // or the condition their label states when it is not an age.
      const condition = trip ? fareCondition(trip, fare) : null;
      const scope = [kind !== "adult" ? fare.ageRange : "", condition].filter(Boolean).join(", ");
      const band = scope ? ` /${scope}/` : "";
      const line = `• ${LABEL[kind]}${band}: ${price}`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
  }
  return lines;
}

/**
 * The price row's single_price for this resolved offer ("1,111,111₮"), read from the
 * rows the offer's fares came from, so a hotel's own supplement is printed under
 * that hotel. The reply checker accepts the same rows' supplemental fares (tripFacts
 * quotablePrices). Null when none, or when the rows disagree.
 */
function singleFarePrice(trip: TravelTrip, offer: Pick<ResolvedTripOffer, "id" | "sourceOfferIds" | "currency">, now: Date): string | null {
  const ids = new Set([offer.id, ...offer.sourceOfferIds]);
  const sources = normalizeTripOffers(trip, now).filter((source) => ids.has(source.id) && source.source !== "discount");
  // A row's own supplement wins over one written on the whole trip.
  const ranked = [sources.filter((source) => source.source !== "base"), sources.filter((source) => source.source === "base")];
  for (const group of ranked) {
    const prices = [...new Set(group.flatMap((source) => source.supplementalFares.filter((fare) => fare.label === "single"))
      .map((fare) => money(fare.fare, fare.currency || offer.currency)).filter((price): price is string => Boolean(price) && price !== "Үнэгүй"))];
    if (prices.length === 1) return prices[0];
    if (prices.length > 1) return null;
  }
  return null;
}

/**
 * A group's single supplement lines, after its passenger fares: one line when every date
 * of the group has the same supplement, else one line per supplement naming its dates
 * ("• Ганцаараа явах … — 12/2: 1,111,111₮"), as the website's room prices do.
 */
function singleLines(group: FareGroup, now: Date): string[] {
  const singles = group.singles || [];
  if (singles.length === 1 && singles[0].dates.length === group.dates.length) return [`• ${SINGLE_FARE_LABEL}: ${singles[0].price}`];
  // The nearest dates' supplements only: one that changes every date made each of a 4-variant
  // card's blocks 16 lines long, several Messenger messages for one card.
  const nearest = [...singles].sort((a, b) => [...a.dates].sort()[0].localeCompare([...b.dates].sort()[0])).slice(0, MAX_SINGLE_LINES);
  const lines = nearest.map((single) => `• ${SINGLE_FARE_LABEL} — ${single.dates.map((date) => shortDate(date, now)).join(", ")}: ${single.price}`);
  return singles.length > nearest.length ? [...lines, "• Бусад өдрийн ганцаараа явах үнийг өдрөө бичвэл хэлье."] : lines;
}
const MAX_SINGLE_LINES = 2;

/**
 * renderTripOfferReply, with the condition of a passenger fare whose label is not an
 * age ("Хүүхэд (1,2–1,4 м): …"), the same condition the trip card prints.
 */
export function renderOfferReplyWithConditions(trip: TravelTrip, result: TripOfferResult, options: Parameters<typeof renderTripOfferReply>[1] = {}): string | null {
  const reply = renderTripOfferReply(result, options);
  if (!reply || result.status !== "ready") return reply;
  const conditioned = result.offer.fares.flatMap((fare) => {
    const condition = fareCondition(trip, fare);
    return condition ? [{ fare, condition }] : [];
  });
  if (!conditioned.length) return reply;
  return reply.split("\n").map((line) => {
    const match = /^(Том хүн|Хүүхэд|Нярай)((?: x \d+)?): (.+)$/u.exec(line);
    if (!match) return line;
    const amounts = (match[3].match(/\d[\d\s,.  ]*/g) || []).map((part) => Number(part.replace(/\D/g, ""))).filter((n) => n > 0);
    const hit = conditioned.filter(({ fare }) => LABEL[fare.kind] === match[1] && (fare.fare.kind === "free" ? /Үнэгүй/.test(match[3])
      : fare.fare.kind === "exact" ? amounts.length === 1 && amounts[0] === fare.fare.amount
        : fare.fare.kind === "range" && amounts.length === 2 && amounts[0] === fare.fare.min && amounts[1] === fare.fare.max));
    const conditions = [...new Set(hit.map(({ condition }) => condition))];
    return conditions.length === 1 ? `${match[1]} (${conditions[0]})${match[2]}: ${match[3]}` : line;
  }).join("\n");
}

/** "10/13"; a date a year or more away keeps its year ("2027.10.13") so it cannot be read as the nearer one. */
export function shortDate(iso: string, now = new Date()): string {
  // Only a real YYYY-MM-DD is reformatted; anything else ("Ням гараг бүр") is already text.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  const [y, m, d] = iso.split("-").map(Number);
  const yearAway = Date.UTC(y, m - 1, d) - now.getTime() > 330 * 24 * 60 * 60 * 1000;
  return yearAway ? `${y}.${m}.${d}` : `${m}/${d}`;
}

/** A departure that can still be booked: a sold-out, paused, cancelled or departed date is not. */
export function dateIsOnSale(trip: TravelTrip, date: string, now = new Date()): boolean {
  const sale = resolveTripOffer(trip, { date }, now);
  return !(sale.status === "unavailable" && NOT_ON_SALE.has(sale.reason));
}

function todayInUb(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** A price row whose label is a name, not just its dates. */
function hasNamedPackageRows(trip: TravelTrip, now: Date): boolean {
  const groups = Array.isArray(trip.extra?.price_groups) ? trip.extra.price_groups : [];
  return groups.some((group) => {
    const label = group && typeof group === "object" && typeof (group as Record<string, unknown>).label === "string"
      ? ((group as Record<string, unknown>).label as string).trim() : "";
    if (!label) return false;
    // Strip what a date label is made of; anything left is a package name.
    const rest = label.replace(/\d+/g, " ").replace(/сар(ын)?|өдөр|гараг|болгон|бүр|ны|ний|-р|оны|[,./–\-·:]/gi, " ").replace(/\s+/g, " ").trim();
    return rest.length > 2 && parseDepartureDateText(label, now).length === 0;
  });
}

/**
 * Departures a customer can still book, as "10/13, 10/20, …", or null when the
 * resolver knows no dated departures (weekly schedules keep their own text).
 */
export function onSaleDepartureText(trip: TravelTrip, now = new Date(), limit = 10): string | null {
  const upcoming = upcomingDepartures(trip, now);
  if (!upcoming.length) return null;
  const open = upcoming.filter((date) => {
    const sale = resolveTripOffer(trip, { date }, now);
    return !(sale.status === "unavailable" && NOT_ON_SALE.has(sale.reason));
  });
  if (!open.length) return "Ойрын гарах өдрүүдийн суудал дүүрсэн байна.";
  return dateList(open.slice(0, limit), trip, now) + (open.length > limit ? " …" : "");
}

/** "10/13, 10/15 (цөөн суудал), 10/20": only a date staff flagged carries the note. */
function dateList(dates: string[], trip: TravelTrip, now: Date): string {
  const low = lowSeatDates(trip, todayInUb(now));
  return dates.map((date) => shortDate(date, now) + (low.has(date) ? " (цөөн суудал)" : "")).join(", ");
}

/** Bookable dates flagged "few seats left", nearest first. */
export function onSaleLowDates(trip: TravelTrip, now = new Date()): string[] {
  const low = lowSeatDates(trip, todayInUb(now));
  return upcomingDepartures(trip, now).filter((date) => low.has(date));
}

/**
 * Trips that sell some fare at exactly this price on an upcoming bookable date,
 * with the fare's label ("Том хүн", "Хүүхэд /2-11 нас/") and the dates it applies
 * to. Read from the same fare lines the card prints, so the reply checker agrees.
 */
export function tripsAtPrice(trips: TravelTrip[], price: number, now = new Date()): Array<{ trip: TravelTrip; label: string; dates: string[] }> {
  const amount = `${price.toLocaleString("en-US")}₮`;
  const found: Array<{ trip: TravelTrip; label: string; dates: string[] }> = [];
  for (const trip of trips) {
    if (trip.status !== "active") continue;
    const groups = onSaleFareGroups(trip, upcomingDepartures(trip, now).slice(0, 16), now);
    let label = "";
    const dates: string[] = [];
    for (const group of groups) {
      // Passenger fares only: a single supplement (group.singles) is never "a trip at this price".
      const line = group.lines.find((entry) => entry.startsWith("• ") && entry.endsWith(`: ${amount}`));
      if (!line) continue;
      label ||= line.slice(2, line.lastIndexOf(":"));
      dates.push(...group.dates);
    }
    if (label) found.push({ trip, label, dates: [...new Set(dates)].sort() });
  }
  return found;
}

/** Every upcoming departure the canonical resolver knows for this trip. */
export function upcomingDepartures(trip: TravelTrip, now = new Date()): string[] {
  const today = todayInUb(now);
  return [...new Set(normalizeTripOffers(trip, now).filter((offer) => offer.source !== "discount").flatMap((offer) => offer.dates))]
    // A date the trip facts call a contradiction (the same day copied into
    // later years by an old sync) is not advertised; the reply checker rejects it.
    .filter((date) => date >= today && tripSupportsDate(trip, date, now) !== "contradiction").sort();
}

/**
 * The fare lines of a trip card, or null when the resolver has no dated fares
 * (weekly "<гараг> бүр" schedules) and the caller keeps its own text.
 */
export function buildFarePriceLines(trip: TravelTrip, now = new Date()): { lines: string[]; onSale: string[] } | null {
  // Price rows named for what they include ("Онгоцны тийзтэй үнэ" vs "тийзгүй")
  // are packages the resolver does not model yet; the caller keeps its own
  // labelled text for those trips rather than losing the labels.
  if (hasNamedPackageRows(trip, now)) return null;
  const upcoming = upcomingDepartures(trip, now);
  if (!upcoming.length) return null;
  const groups = onSaleFareGroups(trip, upcoming.slice(0, 16), now);
  if (!groups.length) {
    const allClosed = upcoming.slice(0, 16).every((date) => {
      const sale = resolveTripOffer(trip, { date }, now);
      return sale.status === "unavailable" && NOT_ON_SALE.has(sale.reason);
    });
    return allClosed ? { lines: ["Ойрын гарах өдрүүдийн суудал дүүрсэн байна."], onSale: [] } : null;
  }
  const lines = ["💰 Үнэ:"];
  // The nearest prices only: a trip sold per hotel on 16 dates made a card
  // longer than one Messenger message. Later dates are listed below.
  const shown = shownFareGroups(groups);
  if (shown.length === 1) lines.push(...shown[0].lines, ...singleLines(shown[0], now));
  else shown.forEach((group, index) => {
    // Hotels and packages of the same dates share one date heading.
    const sameDates = index > 0 && shown[index - 1].dates.join(",") === group.dates.join(",");
    lines.push("", ...(sameDates ? [] : [`${dateList(group.dates, trip, now)}:`]), ...group.lines, ...singleLines(group, now));
  });
  if (groups.length > shown.length) lines.push("", "Бусад гарах өдрийн үнийг хүсвэл өдрөө бичээрэй.");
  return { lines, onSale: [...new Set(groups.flatMap((group) => group.dates))].sort() };
}

/** The price and dates part of a trip card (see buildFarePriceLines). */
export function buildFareSection(trip: TravelTrip, now = new Date()): string[] | null {
  const block = buildFarePriceLines(trip, now);
  if (!block) return null;
  if (!block.onSale.length) return block.lines;
  const { onSale } = block;
  return [...block.lines, "", "📅 Гарах өдрүүд:", dateList(onSale.slice(0, 10), trip, now) + (onSale.length > 10 ? " …" : "")];
}

type FareVariant = { lines: string[]; single: string | null };

/**
 * Upcoming departures that are on sale, grouped by identical passenger fares, in
 * date order. A date sold per hotel gives one group per hotel, headed "Буудал: …".
 * The single supplement is kept beside the group, not in its key: two dates at one
 * fare with different supplements split into two groups, and the trip card took
 * that for a fare table and dropped its prices (2026-11-05 review).
 */
export function onSaleFareGroups(trip: TravelTrip, dates: string[], now = new Date()): FareGroup[] {
  const groups: FareGroup[] = [];
  const add = (date: string, { lines, single }: FareVariant) => {
    let group = groups.find((entry) => entry.lines.join("|") === lines.join("|"));
    if (group) group.dates.push(date);
    else groups.push(group = { dates: [date], lines, singles: [] });
    if (!single) return;
    const same = group.singles!.find((entry) => entry.price === single);
    if (same) same.dates.push(date);
    else group.singles!.push({ price: single, dates: [date] });
  };
  for (const date of dates) {
    const sale = resolveTripOffer(trip, { date }, now);
    if (sale.status === "unavailable" && NOT_ON_SALE.has(sale.reason)) continue;
    for (const variant of dateVariants(trip, date, {}, [], now)) add(date, variant);
  }
  return groups;
}

/**
 * One date's fare lines per hotel and package, headed "Буудал: …" / "Багц: …". The resolver
 * asks hotel then package (or package then hotel); each choice is followed at most two levels
 * deep. A hotel or package that is full is left out while the date still sells another one.
 */
function dateVariants(trip: TravelTrip, date: string, selection: TripOfferSelection, heading: string[], now: Date): FareVariant[] {
  const card = resolveTripOfferFareCard(trip, { ...selection, date }, now);
  if (card.status === "ready") {
    const lines = fareLines(card.offer.fares, card.offer.currency, trip);
    // A hotel sold in one package resolves without being asked for it: still name the package,
    // or the block reads (to a customer and to the reply checker) as the previous block's package.
    const named = card.offer.packageId && heading.length && !heading.some((line) => line.startsWith("Багц: "))
      ? [...heading, `Багц: ${card.offer.packageId}`] : heading;
    // Each hotel's (and package's) own single supplement sits under it.
    return lines.length ? [{ lines: [...named, ...lines], single: singleFarePrice(trip, card.offer, now) }] : [];
  }
  if (card.status !== "needs_selection" || heading.length >= 2) return [];
  const field = card.fields.includes("hotel") ? "hotel" : card.fields.includes("package") ? "package" : null;
  if (!field) return [];
  return card.options.flatMap((option) => {
    const next: TripOfferSelection = field === "hotel" ? { ...selection, hotel: option } : { ...selection, packageId: option };
    const sale = resolveTripOffer(trip, { ...next, date }, now);
    if (sale.status === "unavailable" && NOT_ON_SALE.has(sale.reason)) return [];
    return dateVariants(trip, date, next, [...heading, field === "hotel" ? `Буудал: ${option}` : `Багц: ${option}`], now);
  });
}

/**
 * The groups a card prints: every hotel/package of the nearest date (a 2 hotels × 2 packages
 * trip has four, and a cap of three hid the fourth), then the next ones up to MAX_PRICE_GROUPS.
 */
function shownFareGroups(groups: FareGroup[]): FareGroup[] {
  if (!groups.length) return groups;
  const dates = [...new Set(groups.flatMap((group) => group.dates))].sort();
  const nearest = groups.filter((group) => group.dates.includes(dates[0]));
  const cap = Math.max(MAX_PRICE_GROUPS, nearest.length);
  const picked = new Set(nearest);
  // Whole dates only: a date whose hotels/packages do not all fit is left for "Бусад гарах өдөр…",
  // never shown with one of its packages missing.
  for (const date of dates.slice(1)) {
    const missing = groups.filter((group) => group.dates.includes(date) && !picked.has(group));
    if (picked.size + missing.length > cap) break;
    missing.forEach((group) => picked.add(group));
  }
  return groups.filter((group) => picked.has(group));
}
