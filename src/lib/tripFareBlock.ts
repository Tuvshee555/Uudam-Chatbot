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
 */
import type { TravelTrip } from "./travelTypes";
import { parseDepartureDateText } from "./travelDates";
import { tripSupportsDate } from "./tripFacts";
import { normalizeTripOffers, resolveTripOffer, resolveTripOfferFareCard, type NormalizedPassengerFare, type OfferFare, type PassengerKind } from "./tripOffers";

const ORDER: PassengerKind[] = ["adult", "child", "infant"];
const LABEL: Record<PassengerKind, string> = { adult: "Том хүн", child: "Хүүхэд", infant: "Нярай" };
// A departure that is not on sale is not offered at any price.
const NOT_ON_SALE = new Set(["sold_out", "paused", "cancelled", "unavailable", "departed"]);
const MAX_PRICE_GROUPS = 3;

export type FareGroup = { dates: string[]; lines: string[] };

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

/** "• Хүүхэд /2-11 нас/: 2,490,000₮" lines, one per distinct fare, adults first. */
export function fareLines(fares: NormalizedPassengerFare[], currency: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const kind of ORDER) {
    for (const fare of fares.filter((f) => f.kind === kind).sort((a, b) => bandStart(a) - bandStart(b))) {
      const price = money(fare.fare, fare.currency || currency);
      if (!price) continue;
      // The adult band ("12+ нас") is implied by "Том хүн"; others name their band.
      const band = kind !== "adult" && fare.ageRange ? ` /${fare.ageRange}/` : "";
      const line = `• ${LABEL[kind]}${band}: ${price}`;
      if (!seen.has(line)) { seen.add(line); lines.push(line); }
    }
  }
  return lines;
}

/** "10/13"; a date a year or more away keeps its year ("2027.10.13") so it cannot be read as the nearer one. */
export function shortDate(iso: string, now = new Date()): string {
  const [y, m, d] = iso.split("-").map(Number);
  const yearAway = Date.UTC(y, m - 1, d) - now.getTime() > 330 * 24 * 60 * 60 * 1000;
  return yearAway ? `${y}.${m}.${d}` : `${m}/${d}`;
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
  return `${open.slice(0, limit).map((date) => shortDate(date, now)).join(", ")}${open.length > limit ? " …" : ""}`;
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
  const shown = groups.slice(0, MAX_PRICE_GROUPS);
  if (shown.length === 1) lines.push(...shown[0].lines);
  else for (const group of shown) lines.push("", `${group.dates.map((date) => shortDate(date, now)).join(", ")}:`, ...group.lines);
  if (groups.length > shown.length) lines.push("", "Бусад гарах өдрийн үнийг хүсвэл өдрөө бичээрэй.");
  return { lines, onSale: [...new Set(groups.flatMap((group) => group.dates))].sort() };
}

/** The price and dates part of a trip card (see buildFarePriceLines). */
export function buildFareSection(trip: TravelTrip, now = new Date()): string[] | null {
  const block = buildFarePriceLines(trip, now);
  if (!block) return null;
  if (!block.onSale.length) return block.lines;
  const { onSale } = block;
  return [...block.lines, "", "📅 Гарах өдрүүд:", `${onSale.slice(0, 10).map((date) => shortDate(date, now)).join(", ")}${onSale.length > 10 ? " …" : ""}`];
}

/**
 * Upcoming departures that are on sale, grouped by identical fares, in date
 * order. A date sold per hotel gives one group per hotel, headed "Буудал: …".
 */
export function onSaleFareGroups(trip: TravelTrip, dates: string[], now = new Date()): FareGroup[] {
  const groups: FareGroup[] = [];
  const add = (date: string, lines: string[]) => {
    const same = groups.find((group) => group.lines.join("|") === lines.join("|"));
    if (same) same.dates.push(date);
    else groups.push({ dates: [date], lines });
  };
  for (const date of dates) {
    const sale = resolveTripOffer(trip, { date }, now);
    if (sale.status === "unavailable" && NOT_ON_SALE.has(sale.reason)) continue;
    const card = resolveTripOfferFareCard(trip, { date }, now);
    if (card.status === "ready") {
      const lines = fareLines(card.offer.fares, card.offer.currency);
      if (lines.length) add(date, lines);
    } else if (card.status === "needs_selection" && card.fields.includes("hotel")) {
      for (const hotel of card.options) {
        // A hotel can be full while the date still sells at another one.
        const hotelSale = resolveTripOffer(trip, { date, hotel }, now);
        if (hotelSale.status === "unavailable" && NOT_ON_SALE.has(hotelSale.reason)) continue;
        const byHotel = resolveTripOfferFareCard(trip, { date, hotel }, now);
        if (byHotel.status !== "ready") continue;
        const lines = fareLines(byHotel.offer.fares, byHotel.offer.currency);
        if (lines.length) add(date, [`Буудал: ${hotel}`, ...lines]);
      }
    }
  }
  return groups;
}
