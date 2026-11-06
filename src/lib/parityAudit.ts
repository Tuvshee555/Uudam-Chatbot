/**
 * Do the admin, the poster, the website and the bot agree about each trip?
 *
 * Pure comparisons for the nightly read-only check (scripts/audit-parity.ts).
 * Nothing here reads or writes a database: the script loads the rows inside a
 * read-only transaction and hands them over. Every comparison reuses the code
 * that produces the fact being compared, so a "difference" is what the
 * customer, the next sync or the next poster save would actually see:
 *
 *   1. website — websiteTripPayload (the projection the sync writes) against
 *      the website rows as they are now;
 *   2. poster  — the price_groups a Poster-tab save would write back
 *      (mapPosterTripToFields, the same mapper syncPosterTrip uses) against
 *      the chatbot's own, per date, hotel and package, read through the fare
 *      resolver; plus the poster's day count;
 *   3. bot     — the shared fare card (buildFareSection): present, every amount
 *      on it stored in the trip's price rows, in tugrik, and accepted by the
 *      reply checker (a refused card is a customer who gets silence);
 *   4. partner — the partner-synced trip against the partner's own data.
 */
import { isDeepStrictEqual } from "node:util";
import type { TravelTrip } from "./travelTypes";
import { websiteAvailabilityForResync, websiteTripPayload } from "./websiteTripPayload";
import { duration, expandRecurringWeekday, record, records, strings, websiteDayMeals, websiteDepartureSchedule } from "./connectedTripMapping";
import { currentWebsiteDepartureRows } from "./websiteDepartureRows";
import { websiteDepartureDateKey } from "./websiteDepartureDate";
import { departureSeatsAfterTripEdit } from "./departureSeats";
import { normalizeTripOffers, type OfferFare, type PassengerKind } from "./tripOffers";
import { buildFareSection, dateIsOnSale, onSaleFareGroups, shortDate, upcomingDepartures } from "./tripFareBlock";
import { verifyTripReply } from "./tripReplyVerification";
import { isReferReply } from "./reply";
import { mapPosterTripToFields } from "./poster/tripMapper";
import { splitPackagedHotelRows } from "./poster/packageRows";
import { normalizePosterPriceTable } from "./poster/priceTableNormalize";
import { normalizeExtraPatch } from "./tripExtraSchema";

type Row = Record<string, unknown>;
export type ParityArea = "website" | "poster" | "bot" | "partner";
/** 3 = a customer can see a wrong fact now, 2 = wrong on the next save/sync or needs staff, 1 = detail. */
export type ParitySeverity = 1 | 2 | 3;
export type ParityDifference = {
  area: ParityArea; severity: ParitySeverity; code: string;
  mn: string; en: string; items: string[];
};
export type WebsiteRows = {
  /** The website "Trip" row (with sourceMetadata), or null when the website has none. */
  trip: Row | null;
  /** "Departure" rows; startDate as text (never a JS Date read in the machine's zone). */
  departures: Row[];
  /** "ItineraryDay" rows with dayNumber > 0. */
  days: Row[];
  /** trip_website_sync says a chatbot change has not been delivered yet. */
  syncQueued?: boolean;
};
export type TripParityResult = {
  tripId: string; name: string; differences: ParityDifference[];
  /** A website page found by the published-state sweep, not one of the checked (on-sale) trips. */
  websitePageOnly?: boolean;
};

const MAX_ITEMS = 12;
const AREA_LABEL: Record<ParityArea, string> = {
  website: "Вэбсайт / Website", poster: "Постер / Poster", bot: "Бот / Bot", partner: "Түнш / Partner",
};
const ICON: Record<ParitySeverity, string> = { 3: "🔴", 2: "🟠", 1: "🟡" };
const KIND_LABEL: Record<PassengerKind, string> = { adult: "Том хүн", child: "Хүүхэд", infant: "Нярай" };

export function ubToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3600e3).toISOString().slice(0, 10);
}

export function money(value: unknown, currency = "MNT"): string {
  if (value === null || value === undefined || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return currency === "MNT" ? `${n.toLocaleString("en-US")}₮` : `${n.toLocaleString("en-US")} ${currency}`;
}

const sameNumber = (a: unknown, b: unknown) => (a === null || a === undefined || a === "" ? null : Number(a))
  === (b === null || b === undefined || b === "" ? null : Number(b));
const textOf = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function difference(area: ParityArea, severity: ParitySeverity, code: string, mn: string, en: string, items: string[] = []): ParityDifference {
  return { area, severity, code, mn, en, items };
}

/** "3/17, 3/24 · <detail>": dates sharing the exact same finding are listed together. */
function byDetail(entries: Array<{ date: string; detail: string }>, now: Date): string[] {
  const grouped = new Map<string, string[]>();
  for (const { date, detail } of entries) grouped.set(detail, [...(grouped.get(detail) || []), date]);
  return [...grouped].map(([detail, dates]) => `${[...new Set(dates)].sort().map((date) => shortDate(date, now)).join(", ")} · ${detail}`);
}

/** The trips the check covers: on sale and shown to customers. */
export function isCheckedTrip(trip: TravelTrip): boolean {
  return trip.status === "active" && trip.extra?.customer_visible !== false;
}

// ── 1. Chatbot → website ──────────────────────────────────────────────────────

/** The overlay listTrips puts on every trip (withWebsiteDepartureAvailability), from rows already read. */
export function withWebsiteOverlay(trip: TravelTrip, website: WebsiteRows): TravelTrip {
  if (!website.trip) return trip;
  const canonicalOffers = record(website.trip.sourceMetadata).canonicalOffers;
  const extra: Row = { ...trip.extra };
  if (website.departures.length) {
    extra.website_departure_availability = currentWebsiteDepartureRows(website.departures).map((row) => websiteAvailabilityForResync({
      date: websiteDepartureDateKey(row.startDate), status: String(row.status), seatsLeft: (row.seatsLeft ?? null) as number | null,
    }, canonicalOffers));
  }
  if (textOf(website.trip.slug)) {
    extra.website_slug = textOf(website.trip.slug);
    extra.website_published = Boolean(website.trip.isPublished);
  }
  return { ...trip, extra };
}

/** What the next chatbot → website sync would write (upsertWebsiteTrip's own inputs, without writing). */
export function projectWebsite(source: TravelTrip, website: WebsiteRows, now: Date) {
  const prior = website.trip;
  const priorMeta = record(prior?.sourceMetadata);
  const previousSnapshot = record(priorMeta.connectedSource);
  const seatsChanged = !prior || (Object.keys(previousSnapshot).length > 0
    && (previousSnapshot.seats_total !== source.seats_total || previousSnapshot.seats_left !== source.seats_left));
  const reopened = Boolean(previousSnapshot.status) && previousSnapshot.status !== "active" && source.status === "active";
  const availability = record(source.extra.partner_sync).source_url
    ? records(source.extra.partner_departure_availability)
    : currentWebsiteDepartureRows(website.departures).map((departure) => {
      const row = websiteAvailabilityForResync({
        date: websiteDepartureDateKey(departure.startDate), status: String(departure.status), seatsLeft: (departure.seatsLeft ?? null) as number | null,
      }, priorMeta.canonicalOffers);
      return { ...row,
        status: reopened && row.status !== "ALMOST_FULL" ? "OPEN" : row.status,
        seatsLeft: departureSeatsAfterTripEdit({
          tripChanged: seatsChanged,
          previousTripSeatsLeft: typeof previousSnapshot.seats_left === "number" ? previousSnapshot.seats_left : null,
          tripSeatsLeft: source.seats_left, rowSeatsLeft: row.seatsLeft,
        }),
      };
    });
  const liveSource: TravelTrip = { ...source, extra: { ...source.extra, website_departure_availability: availability } };
  return websiteTripPayload(liveSource, websiteDepartureSchedule(source, now), now);
}

/** Poster days that are itinerary days (photo-only slots are not). */
export function posterContentDays(poster: Row | null): Row[] {
  return records(poster?.days).filter((day) => textOf(day.route) || textOf(day.summary) || textOf(day.hotel));
}

function optionHotels(groups: unknown): string[] {
  return [...new Set(records(groups).map((group) => textOf(group.hotel)).filter(Boolean))].sort();
}

export function websiteDifferences(source: TravelTrip, poster: Row | null, website: WebsiteRows, now: Date): ParityDifference[] {
  const out: ParityDifference[] = [];
  const site = website.trip;
  if (!site) {
    return [difference("website", 3, "web_missing", "Вэбсайтад энэ аялал алга", "the website has no row for this trip")];
  }
  const meta = record(site.sourceMetadata);
  const conflictFields = records(meta.contentConflicts).map((entry) => textOf(entry.field)).filter(Boolean);
  // The website's delivery queue (websiteSyncPending): a staff edit there the chatbot has not received yet.
  const pending = record(meta.websiteSyncPending);
  const held = typeof pending.id !== "string" ? [] : pending.archive === true ? ["archive"]
    : pending.edits && typeof pending.edits === "object" ? Object.keys(record(pending.edits)) : ["whole trip"];
  const today = ubToday(now);
  const projected = projectWebsite(source, website, now);

  if (site.isPublished !== true) out.push(difference("website", 3, "web_published", "Вэбсайтад нуугдсан байна", "the website hides a trip the chatbot sells"));
  if (textOf(site.title) !== source.route_name.trim()) {
    out.push(difference("website", 2, "web_title", "Нэр өөр", "title differs", [`website «${textOf(site.title)}» · chatbot «${source.route_name}»`]));
  }
  const d = duration(source.duration_text);
  const days = source.extra.duration_days ?? d.days;
  const nights = source.extra.duration_nights ?? d.nights;
  if (!sameNumber(site.durationDays, days) || !sameNumber(site.durationNights, nights)) {
    out.push(difference("website", 2, "web_duration", "Хугацаа өөр", "duration differs",
      [`website ${site.durationDays ?? "—"} days/${site.durationNights ?? "—"} nights · chatbot ${days}/${nights}`]));
  }
  if (textOf(site.hotel) !== textOf(source.hotel)) {
    out.push(difference("website", 2, "web_hotel", "Буудлын нэр өөр", "hotel differs", [`website «${textOf(site.hotel) || "—"}» · chatbot «${textOf(source.hotel) || "—"}»`]));
  }
  const siteHotels = optionHotels(meta.price_groups);
  const botHotels = optionHotels(projected.priceGroups);
  if (!isDeepStrictEqual(siteHotels, botHotels)) {
    out.push(difference("website", 2, "web_option_hotels", "Үнийн сонголтын буудлууд өөр", "hotel options differ",
      [`website: ${siteHotels.join(", ") || "—"} · chatbot: ${botHotels.join(", ") || "—"}`]));
  }
  const currency = source.currency || "MNT";
  const headline = (["price", "childPrice", "infantPrice"] as const).filter((key) =>
    !sameNumber(site[key], key === "price" ? projected.price ?? 0 : projected[key]));
  if (headline.length) {
    out.push(difference("website", 3, "web_headline_price", "Картын үнэ өөр", "headline price differs",
      headline.map((key) => `${key}: website ${money(site[key], currency)} · chatbot ${money(key === "price" ? projected.price ?? 0 : projected[key], currency)}`)));
  }

  // Departures: every upcoming date the projection writes, against the website's current row.
  const rowsByDate = new Map<string, Row[]>();
  for (const row of website.departures) {
    const date = websiteDepartureDateKey(row.startDate);
    if (date) rowsByDate.set(date, [...(rowsByDate.get(date) || []), row]);
  }
  const terminal = (row: Row) => ["CANCELLED", "DEPARTED"].includes(String(row.status));
  const missing: string[] = [];
  const prices: Array<{ date: string; detail: string }> = [];
  const states: Array<{ date: string; detail: string }> = [];
  const projectedDates = new Set<string>();
  for (const dep of projected.departures) {
    const date = dep.start.slice(0, 10);
    if (date < today) continue;
    projectedDates.add(date);
    const live = (rowsByDate.get(date) || []).filter((row) => !terminal(row));
    const row = live[0] || (rowsByDate.get(date) || [])[0];
    if (!row) { if (dep.status !== "CANCELLED") missing.push(date); continue; }
    if (live.length > 1) states.push({ date, detail: `${live.length} open rows for one date` });
    for (const [key, label] of [["price", "adult"], ["childPrice", "child"], ["infantPrice", "infant"]] as const) {
      if (!sameNumber(row[key], dep[key])) prices.push({ date, detail: `${label}: website ${money(row[key], currency)} · chatbot ${money(dep[key], currency)}` });
    }
    if (String(row.status) !== dep.status) states.push({ date, detail: `website ${row.status} · chatbot ${dep.status}` });
    else if (!sameNumber(row.seatsLeft, dep.seatsLeft)) states.push({ date, detail: `seats left: website ${row.seatsLeft ?? "—"} · chatbot ${dep.seatsLeft ?? "—"}` });
  }
  const extra = [...rowsByDate].filter(([date, rows]) => date >= today && !projectedDates.has(date) && rows.some((row) => !terminal(row))).map(([date]) => date);
  if (prices.length) out.push(difference("website", 3, "web_departure_price", "Гарах өдрийн үнэ өөр", "departure price differs", byDetail(prices, now)));
  if (states.length) out.push(difference("website", 3, "web_departure_status", "Гарах өдрийн төлөв/суудал өөр", "departure status or seats differ", byDetail(states, now)));
  if (extra.length) {
    out.push(difference("website", 3, "web_departure_extra", "Вэбсайтад чатботод байхгүй өдөр нээлттэй", "the website sells a date the chatbot does not",
      [extra.sort().map((date) => shortDate(date, now)).join(", ")]));
  }
  // A weekly schedule ("Ням гараг бүр") is projected 12 weeks ahead from the day of the sync, so
  // each week one new date is the website's only after that trip syncs again.
  const weekly = new Set([...source.departure_dates, String(source.extra.departure_rule || "")].flatMap((text) => expandRecurringWeekday(text, now)));
  const rolling = missing.filter((date) => weekly.has(date));
  const absent = missing.filter((date) => !weekly.has(date));
  if (absent.length) {
    out.push(difference("website", 2, "web_departure_missing", "Вэбсайтад гарах өдөр алга", "a chatbot date is missing on the website",
      [absent.sort().map((date) => shortDate(date, now)).join(", ")]));
  }
  if (rolling.length) {
    // A week or two behind is the normal lag; more means the trip has not synced for a month.
    out.push(difference("website", rolling.length > 2 ? 2 : 1, "web_weekly_dates_behind", "Долоо хоног бүрийн аяллын шинэ өдөр вэбсайтад хараахан ороогүй",
      "a weekly trip's newest date is not on the website yet — it arrives the next time this trip syncs", [rolling.sort().map((date) => shortDate(date, now)).join(", ")]));
  }

  // Itinerary: the projection writes the poster's days (websiteTripSync upsertWebsiteTrip).
  const expectedDays = posterContentDays(poster);
  const siteDays = [...website.days].filter((day) => Number(day.dayNumber) > 0);
  if (expectedDays.length !== siteDays.length) {
    out.push(difference("website", 2, "web_days_count", "Хөтөлбөрийн өдрийн тоо өөр", "itinerary day count differs",
      [`website ${siteDays.length} · poster/chatbot ${expectedDays.length}`]));
  }
  const meals: string[] = [];
  expectedDays.forEach((day, index) => {
    const number = Number(day.day) || index + 1;
    const siteDay = siteDays.find((entry) => Number(entry.dayNumber) === number);
    if (!siteDay) return;
    const want = websiteDayMeals(day.meals);
    const have = strings(siteDay.meals);
    if (!isDeepStrictEqual([...have].sort(), [...want].sort())) meals.push(`day ${number}: website ${have.join("+") || "—"} · chatbot ${want.join("+") || "—"}`);
  });
  if (meals.length) out.push(difference("website", 1, "web_day_meals", "Өдрийн хоол өөр", "meals differ", meals));

  if (conflictFields.length) {
    out.push(difference("website", 2, "web_open_conflicts", "Вэбсайт ба чатбот зөрсөн, ажилтан сонгох ёстой", "open website↔chatbot conflicts — staff must pick a side in the editor",
      [[...new Set(conflictFields)].join(", ")]));
  }
  if (out.length && held.length) {
    out.push(difference("website", 1, "web_pending_staff_edit", "Вэбсайтын засвар чатбот руу явж амжаагүй", "a website edit is still on its way to the chatbot", [held.join(", ")]));
  }
  if (out.length && website.syncQueued) {
    out.push(difference("website", 1, "web_sync_queued", "Чатботын өөрчлөлт вэбсайт руу явахаар хүлээж байна", "a chatbot change is queued for the website — some of the above may clear on the next sync"));
  }
  return out;
}

const LIVE_STATUSES = new Set(["active", "sold_out", "paused"]);

/**
 * Published website pages of trips the chatbot does not sell: archived, cancelled or draft,
 * hidden from customers, unknown to the chatbot, or not linked to any chatbot trip. A sold-out
 * or paused trip stays published by design (every date reads closed). `trips` holds every
 * chatbot trip the pages name, whatever its status.
 */
export function unsoldWebsitePages(pages: Row[], trips: Map<string, TravelTrip>): TripParityResult[] {
  return pages.filter((page) => page.isPublished === true).flatMap((page) => {
    const tripId = textOf(page.sourceTripId);
    const trip = tripId ? trips.get(tripId) : undefined;
    const name = textOf(page.title) || textOf(page.slug) || "(untitled website trip)";
    const where = [`/mn/trips/${textOf(page.slug)}`];
    const found = (mn: string, en: string): TripParityResult[] => [{
      tripId: tripId || `website:${textOf(page.slug)}`, name, websitePageOnly: true,
      differences: [difference("website", 3, "web_published_unsold", mn, en, where)],
    }];
    if (!tripId) return found("Чатботод холбоогүй аялал вэбсайтад нийтлэгдсэн", "published on the website but linked to no chatbot trip — the bot cannot answer about it");
    if (!trip) return found("Чатботод байхгүй аялал вэбсайтад нийтлэгдсэн", "published on the website but the chatbot has no such trip");
    if (!LIVE_STATUSES.has(trip.status)) return found(`Чатботод «${trip.status}» төлөвтэй аялал вэбсайтад нийтлэгдсэн`, `published on the website but the chatbot trip is ${trip.status}`);
    if (trip.extra?.customer_visible === false) return found("Чатботод нуусан аялал вэбсайтад нийтлэгдсэн", "published on the website but hidden from customers in the chatbot");
    return [];
  });
}

// ── 2. Chatbot vs poster ──────────────────────────────────────────────────────

function fareText(fare: OfferFare, currency: string): string {
  if (fare.kind === "free") return "Үнэгүй";
  if (fare.kind === "exact") return money(fare.amount, currency);
  if (fare.kind === "range") return `${fare.min.toLocaleString("en-US")}–${money(fare.max, currency)}`;
  return "(no amount)";
}

const PASSENGER_ORDER = ["Том хүн", "Хүүхэд", "Нярай", "Ганцаараа"];
/** Adult, child, infant, single supplement — the card's own order — then by text. */
function byPassenger(a: string, b: string): number {
  const rank = (text: string) => { const at = PASSENGER_ORDER.findIndex((word) => text.startsWith(word)); return at < 0 ? PASSENGER_ORDER.length : at; };
  return rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0);
}

export type Quote = {
  /** What is charged: "Том хүн 1,000,000₮", "Ганцаараа 300,000₮", or "(missing)" when nothing is quoted. */
  prices: string[];
  /** The same fares with the age band / condition they are written for. */
  labelled: string[];
  /**
   * The prices not read from a price row (extra.price_groups) but inherited: the trip-wide
   * fare, an old per-date row or a discount. A Poster-tab save rewrites only price_groups, so
   * on the poster side these are never what the poster table prints.
   */
  inherited: string[];
  /** The resolver found this choice's fare rows contradictory ("conflict"): it quotes nothing. */
  conflict: boolean;
};

/**
 * "<date>|<hotel>|<package>" → what the fare card quotes for that choice on every upcoming
 * departure the trip itself sells: the website projection's own date × hotel × package
 * selections, each read through resolveTripOfferFareCard (the bot's card reads the same
 * resolver). A choice with no fare keeps the resolver's reason, "(missing)". Each price
 * remembers whether a price row produced it (see Quote.inherited).
 */
export function quoteMatrix(trip: TravelTrip, now: Date): Map<string, Quote> {
  const today = ubToday(now);
  const sources = new Map(normalizeTripOffers(trip, now).map((offer) => [offer.id, offer]));
  const fromRow = (offerId: string) => sources.get(offerId)?.source === "price_group";
  const matrix = new Map<string, Quote>();
  // Per key: the prices some entry read from a price row; any other price is inherited.
  const rowPrices = new Map<string, Set<string>>();
  const schedule = websiteDepartureSchedule(trip, now).filter((departure) => departure.start.slice(0, 10) >= today);
  for (const { selection, fareCard } of websiteTripPayload(trip, schedule, now).canonicalOffers.entries) {
    const date = String(selection.date);
    const ready = fareCard.status === "ready" ? fareCard.offer : null;
    const key = `${date}|${ready?.hotel || selection.hotel || selection.hotelId || ""}|${ready?.packageId || selection.packageId || ""}`;
    const quote: Quote = { prices: [], labelled: [], inherited: [], conflict: fareCard.status === "conflict" };
    const read = rowPrices.get(key) || new Set<string>();
    rowPrices.set(key, read);
    if (ready) {
      for (const fare of ready.fares) {
        const amount = fareText(fare.fare, fare.currency || ready.currency);
        const price = `${KIND_LABEL[fare.kind]} ${amount}`;
        quote.prices.push(price);
        if (fromRow(fare.sourceOfferId)) read.add(price);
        // The card never prints the adult band ("Том хүн" implies it), so it is no wording difference.
        const band = fare.kind !== "adult" && fare.ageRange ? ` ${fare.ageRange}` : "";
        quote.labelled.push(`${KIND_LABEL[fare.kind]}${band}${fare.condition ? ` (${fare.condition})` : ""} ${amount}`);
      }
      for (const id of ready.sourceOfferIds) {
        for (const fare of sources.get(id)?.supplementalFares.filter((entry) => entry.label === "single") || []) {
          const single = `Ганцаараа ${fareText(fare.fare, fare.currency)}`;
          quote.prices.push(single);
          quote.labelled.push(single);
          if (fromRow(id)) read.add(single);
        }
      }
    } else {
      quote.prices.push(`(${fareCard.status === "unavailable" || fareCard.status === "missing" ? fareCard.reason : fareCard.status})`);
    }
    const before = matrix.get(key);
    const prices = [...new Set([...(before?.prices || []), ...quote.prices])];
    const real = prices.filter((price) => !price.startsWith("("));
    const kept = (real.length ? real : prices).sort(byPassenger);
    matrix.set(key, {
      prices: kept,
      labelled: [...new Set([...(before?.labelled || []), ...quote.labelled])].sort(byPassenger),
      inherited: kept.filter((price) => !price.startsWith("(") && !read.has(price)),
      conflict: Boolean(before?.conflict) || quote.conflict,
    });
  }
  return matrix;
}

/** The trip as it would be after a Poster-tab save (syncPosterTrip): price rows rebuilt from the poster table. */
export function tripAfterPosterSave(trip: TravelTrip, poster: Row): TravelTrip | null {
  const mapped = mapPosterTripToFields(normalizePosterPriceTable(poster) as Parameters<typeof mapPosterTripToFields>[0]);
  const groups = mapped.extra?.price_groups;
  if (!Array.isArray(groups) || !groups.length) return null;
  const patch: Row = { price_groups: splitPackagedHotelRows(groups as unknown as Row[], trip.extra) };
  if (mapped.extra?.child_rules) patch.child_rules = mapped.extra.child_rules;
  if (mapped.extra?.age_rules) patch.age_rules = mapped.extra.age_rules;
  // The base adult and child fares are only written when the poster's own value changed
  // (syncPosterTrip compares it with the previous poster version); the infant fare and the
  // currency are written on every save.
  return {
    ...trip,
    ...(typeof mapped.infant_price === "number" ? { infant_price: mapped.infant_price } : {}),
    ...(typeof mapped.currency === "string" && mapped.currency ? { currency: mapped.currency } : {}),
    extra: { ...trip.extra, ...normalizeExtraPatch(patch) },
  };
}

/** A quote that prices something, not only a "(reason)" the resolver gave for having no fare. */
function priced(quote: Quote | undefined): quote is Quote {
  return Boolean(quote?.prices.some((price) => !price.startsWith("(")));
}

/** A poster-side quote with at least one price read from a poster table row (not only inherited). */
function fromPosterTable(quote: Quote | undefined): quote is Quote {
  return Boolean(quote?.prices.some((price) => !price.startsWith("(") && !quote.inherited.includes(price)));
}

export function posterDifferences(trip: TravelTrip, poster: Row | null, now: Date): ParityDifference[] {
  if (!poster) {
    return [difference("poster", 3, "poster_missing", "Постер алга — вэбсайт руу синк зогсоно", "the trip's poster is missing, so the website sync fails")];
  }
  const out: ParityDifference[] = [];
  const after = tripAfterPosterSave(trip, poster);
  if (after) {
    // Each side on its own dates: a poster row can add a date (its dates join the schedule).
    const bot = quoteMatrix(trip, now);
    const posterSide = quoteMatrix(after, now);
    // The days a poster row is dated, as the resolver's date reader places them.
    const rowDays = new Set(normalizeTripOffers(after, now).filter((offer) => offer.source === "price_group").flatMap((offer) => offer.dates));
    type Entry = { date: string; detail: string };
    const changed: Entry[] = [];
    const dropped: Entry[] = [];
    const added: Entry[] = [];
    const renamed: Entry[] = [];
    const wording: Entry[] = [];
    const unreadable: Entry[] = [];
    const scope = (key: string) => key.split("|").slice(1).filter(Boolean).join(" · ") || "all";
    const only = (left: string[], right: string[]) => left.filter((fare) => !right.includes(fare)).join("; ") || "(not quoted)";
    // A poster-side price the poster table does not print (the trip-wide fare) is marked as such.
    const shown = (quote: Quote, prices: string[]) => prices.map((price) => (quote.inherited.includes(price) ? `${price} (trip-wide, not on the poster)` : price));
    // Said of the reader, not the poster: a row labelled "2027: 01/03 - 01/10" is on the PDF
    // even when the reader dates it elsewhere.
    const whyUnread = (date: string) => (rowDays.has(date) ? "a poster row is dated this day, but its prices cannot be read" : "the date reader places no poster row on this day");
    const compare = (date: string, label: string, mine: Quote, theirs: Quote) => {
      if (!isDeepStrictEqual(mine.prices, theirs.prices)) {
        const theirsOnly = theirs.prices.filter((fare) => !mine.prices.includes(fare));
        if (theirsOnly.length && theirsOnly.every((fare) => theirs.inherited.includes(fare))) {
          // Every differing fare after the save is inherited: the poster table has no readable price for it.
          unreadable.push({ date, detail: `${label}: chatbot ${only(mine.prices, theirs.prices)} · after a Poster-tab save the trip-wide ${theirsOnly.join("; ")} (the poster row has no readable price for it)` });
        } else {
          changed.push({ date, detail: `${label}: chatbot ${only(mine.prices, theirs.prices)} · poster ${shown(theirs, theirsOnly).join("; ") || "(not quoted)"}` });
        }
      } else if (!isDeepStrictEqual(mine.labelled, theirs.labelled)) {
        wording.push({ date, detail: `${label}: chatbot ${only(mine.labelled, theirs.labelled)} · poster ${only(theirs.labelled, mine.labelled)}` });
      }
    };
    const keysOn = (matrix: Map<string, Quote>, date: string) => [...matrix.keys()].filter((key) => key.startsWith(`${date}|`));
    for (const date of new Set([...bot.keys(), ...posterSide.keys()].map((key) => key.split("|")[0]))) {
      const botKeys = keysOn(bot, date).filter((key) => priced(bot.get(key)));
      // Only quotes the poster table itself prices are poster data. A quote made of inherited
      // fares only, or a contradiction, means the table has no readable row for that choice.
      const posterKeys = keysOn(posterSide, date).filter((key) => fromPosterTable(posterSide.get(key)));
      const fallbacks = keysOn(posterSide, date).filter((key) => priced(posterSide.get(key)) && !fromPosterTable(posterSide.get(key))).map((key) => posterSide.get(key)!);
      const contradicted = keysOn(posterSide, date).some((key) => posterSide.get(key)!.conflict && !priced(posterSide.get(key)));
      const noPosterRow = (key: string) => {
        const mine = bot.get(key)!;
        // The save leaves the bot quoting the same fares: nothing anyone sees would change.
        if (fallbacks.some((quote) => isDeepStrictEqual(quote.prices, mine.prices))) return;
        const chatbot = `${scope(key)}: chatbot ${mine.prices.join("; ")}`;
        if (fallbacks.length) unreadable.push({ date, detail: `${chatbot} · after a Poster-tab save the trip-wide ${fallbacks[0].prices.join("; ")} (${whyUnread(date)})` });
        else if (contradicted) unreadable.push({ date, detail: `${chatbot} · after a Poster-tab save no price — the fare reader rejects these rows and the bot goes silent (${whyUnread(date)})` });
        else dropped.push({ date, detail: chatbot });
      };
      for (const key of botKeys.filter((entry) => posterKeys.includes(entry))) compare(date, scope(key), bot.get(key)!, posterSide.get(key)!);
      const botOnly = botKeys.filter((key) => !posterKeys.includes(key));
      const posterOnly = posterKeys.filter((key) => !botKeys.includes(key));
      if (botOnly.length && posterOnly.length && (botOnly.length === 1 || posterOnly.length === 1)) {
        // The poster names the date's hotel or package differently (often: none at all, one
        // "all" row): each chatbot choice is compared with the poster's row for that date.
        for (const mineKey of botOnly) {
          for (const theirsKey of posterOnly) {
            const label = `chatbot «${scope(mineKey)}» · poster «${scope(theirsKey)}»`;
            if (isDeepStrictEqual(bot.get(mineKey)!.prices, posterSide.get(theirsKey)!.prices)) renamed.push({ date, detail: label });
            else compare(date, label, bot.get(mineKey)!, posterSide.get(theirsKey)!);
          }
        }
      } else {
        botOnly.forEach(noPosterRow);
        for (const key of posterOnly) added.push({ date, detail: `${scope(key)}: poster ${shown(posterSide.get(key)!, posterSide.get(key)!.prices).join("; ")}` });
      }
    }
    // The poster PDF (the website's brochure link) prints this table, so a different fare is
    // on a customer's screen already; a Poster-tab save would also write it over the chatbot's.
    const trap = "the poster PDF shows it, and a Poster-tab save would write the poster table over the chatbot's prices";
    if (changed.length) out.push(difference("poster", 3, "poster_price", "Постерын үнийн хүснэгт чатботоос өөр", `poster price differs — ${trap}`, byDetail(changed, now)));
    if (added.length) out.push(difference("poster", 3, "poster_row_extra", "Постерын хүснэгтэд чатботод байхгүй үнэ бий", `the poster prices a date/hotel the chatbot does not — ${trap} and add it`, byDetail(added, now)));
    if (unreadable.length) {
      out.push(difference("poster", 2, "poster_row_unreadable", "Энэ үнийг постерын хүснэгтээс уншиж чадахгүй — Постер табаар хадгалбал бот аяллын ерөнхий үнийг хэлнэ",
        "no poster row the mapper can read for this price — after a Poster-tab save the bot would quote the trip-wide fare instead (or nothing); the poster PDF itself may print the right price", byDetail(unreadable, now)));
    }
    if (dropped.length) {
      out.push(difference("poster", 2, "poster_row_missing", "Постерын хүснэгтэд чатботын үнэ алга",
        "no poster row the mapper can read prices this, and the trip has no trip-wide fare — a Poster-tab save would leave the bot no price for it", byDetail(dropped, now)));
    }
    if (renamed.length) {
      out.push(difference("poster", 2, "poster_choice_name", "Постерын хүснэгтэд буудал/багцын нэр өөр (үнэ ижил)",
        "same prices, but the poster names the hotel/package differently — a Poster-tab save would rewrite the chatbot's hotel/package choice", byDetail(renamed, now)));
    }
    if (wording.length) out.push(difference("poster", 1, "poster_fare_wording", "Постерын насны ангилал/нөхцөл өөр (үнэ ижил)", "same prices, different age band or condition on the poster", byDetail(wording, now)));
  }
  const posterDays = posterContentDays(poster).length;
  const botDays = records(trip.extra.itinerary_days).length;
  if (posterDays !== botDays) {
    out.push(difference("poster", 1, "poster_days", "Постер ба чатботын хөтөлбөрийн өдрийн тоо өөр", "poster and chatbot itinerary day counts differ",
      [`poster ${posterDays} · chatbot ${botDays}`]));
  }
  const d = duration(trip.duration_text);
  const botDuration = typeof trip.extra.duration_days === "number" ? trip.extra.duration_days : d.days;
  if (typeof poster.duration_days === "number" && poster.duration_days !== botDuration) {
    out.push(difference("poster", 1, "poster_duration", "Постерын хугацаа өөр", "poster duration differs", [`poster ${poster.duration_days} days · chatbot ${botDuration}`]));
  }
  return out;
}

// ── 3. The bot's shared fare card ─────────────────────────────────────────────

/** Every fare amount the trip stores: its price rows, plus the trip-wide fares those rows inherit. */
export function storedAmounts(trip: TravelTrip): Set<number> {
  const amounts = new Set<number>();
  const add = (value: unknown) => { if (typeof value === "number" && Number.isFinite(value) && value > 0) amounts.add(value); };
  const addRow = (row: Row) => {
    for (const key of ["adult_price", "child_price", "infant_price", "single_price", "price", "amount"]) add(row[key]);
    for (const range of [record(row.adult_price_range), record(row.price_range)]) { add(range.min); add(range.max); }
    for (const nested of [...records(row.passenger_prices), ...records(row.child_rules), ...records(row.child_price_rules), ...records(row.room_prices)]) addRow(nested);
  };
  const extra = trip.extra || {};
  for (const key of ["price_groups", "departure_date_groups", "discounts", "discount_groups"]) records(extra[key]).forEach(addRow);
  add(trip.adult_price); add(trip.child_price); add(trip.infant_price);
  records(extra.child_rules).forEach(addRow);
  return amounts;
}

/** Problems with the amounts a card prints: one not stored on the trip, or one not in tugrik. */
export function cardAmountProblems(lines: string[], trip: TravelTrip): { unknown: string[]; foreign: string[] } {
  const stored = storedAmounts(trip);
  const unknown: string[] = [];
  const foreign: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("• ")) continue;
    const at = line.lastIndexOf(": ");
    if (at < 0) continue;
    const price = line.slice(at + 2);
    if (/^Үнэгүй/.test(price)) continue;
    if (!/₮/.test(price) && /\d/.test(price)) foreign.push(line.slice(2));
    for (const match of price.matchAll(/\d{1,3}(?:,\d{3})+|\d+/g)) {
      const amount = Number(match[0].replace(/,/g, ""));
      if (amount > 0 && !stored.has(amount)) unknown.push(`${line.slice(2)} (${amount.toLocaleString("en-US")} is not on any price row)`);
    }
  }
  return { unknown: [...new Set(unknown)], foreign: [...new Set(foreign)] };
}

/**
 * The bot's card for a trip as customers get it (`botTrip` = sanitizeTripForCustomers of the
 * trip with the website overlay). `refusedAnswers` are the questions selfConsistency found the
 * bot's own checker refusing for this trip.
 */
export function botDifferences(botTrip: TravelTrip, now: Date, refusedAnswers: string[] = []): ParityDifference[] {
  const out: ParityDifference[] = [];
  const card: string[] | null = buildFareSection(botTrip, now);
  const upcoming = upcomingDepartures(botTrip, now);
  const reason = () => !upcoming.length ? "no upcoming dated departure"
    : onSaleFareGroups(botTrip, upcoming.slice(0, 16), now).length ? "price rows are named packages the shared card does not print"
      : "no upcoming date has a fare the resolver can price";
  if (!card?.length) {
    out.push(difference("bot", 2, "bot_no_card", "Ботын нэгдсэн үнийн карт гарахгүй", "the bot has no shared fare card and falls back to the old raw-field price text", [reason()]));
  } else if (!card.some((line) => line.startsWith("• "))) {
    // No fare line: "seats full" (every near date closed) or the explicit no-fare sentence the
    // webhook turns into silence and a lead. Both are by design, unless the admin holds prices
    // for a date that is on sale: then the bot stays silent about a price staff typed in.
    const sellable = upcoming.some((date) => dateIsOnSale(botTrip, date, now));
    if (sellable && storedAmounts(botTrip).size) {
      out.push(difference("bot", 2, "bot_no_fare", "Админд үнэ байгаа ч бот үнэ хэлэхгүй — чимээгүй болж ажилтанд lead өгнө",
        "the admin holds prices but the bot quotes none: on price questions the customer gets silence and staff a lead", [reason()]));
    }
  } else {
    const problems = cardAmountProblems(card, botTrip);
    if (problems.unknown.length) out.push(difference("bot", 3, "bot_amount_unknown", "Ботын картад хадгалагдаагүй үнэ гарч байна", "the card prints an amount no price row holds", problems.unknown));
    if (problems.foreign.length) out.push(difference("bot", 3, "bot_foreign_currency", "Ботын картад төгрөг биш үнэ гарч байна", "the card prints a non-tugrik price (never a selling price)", problems.foreign));
    const reply = [`✈️ ${botTrip.route_name}`, "", ...card].join("\n");
    if (isReferReply(verifyTripReply({ reply, trips: [botTrip], now }))) {
      out.push(difference("bot", 3, "bot_card_refused", "Ботын шалгагч өөрийн картыг хүлээж авахгүй — бот чимээгүй болно", "the reply checker refuses the bot's own card, so the customer gets silence"));
    }
  }
  if (refusedAnswers.length) {
    out.push(difference("bot", 3, "bot_answer_refused", "Ботын хариултыг шалгагч хүлээж авахгүй — бот чимээгүй болно", "the reply checker refuses these bot answers, so the customer gets silence", refusedAnswers));
  }
  return out;
}

// ── 4. Partner trip vs the partner's own data ─────────────────────────────────

/** The fare cells verify-partner-sync compares, one sortable string per price row. */
export function partnerFareCells(value: unknown): string[] {
  const sorted = (items: unknown[]) => items.map((item) => JSON.stringify(item)).sort();
  return sorted(records(value).map((g) => ({
    dates: g.dates, hotel: g.hotel, package: g.package_id ?? null, adult: g.adult_price,
    infant: g.infant_price, single: g.single_price ?? null,
    passengers: sorted(records(g.passenger_prices).map((p) => ({ age: p.age_range, price: p.price }))),
    availability: g.availability ?? { status: g.status, seatsLeft: g.seats_left },
  })));
}

function cellText(cell: string): string {
  const row = JSON.parse(cell) as Row;
  const passengers = (row.passengers as string[]).map((entry) => { const p = JSON.parse(entry) as Row; return `${p.age || "?"} ${money(p.price)}`; });
  return `${strings(row.dates).join(",")} · ${row.hotel || "—"}${row.package ? ` · ${row.package}` : ""}: adult ${money(row.adult)}${passengers.length ? `, ${passengers.join(", ")}` : ""}${row.single ? `, single ${money(row.single)}` : ""}`;
}

/**
 * `expected` is what the partner sync would store now: partnerTripFields(tour, poster, trip.extra)
 * with its extra run through normalizeExtraPatch (the same as scripts/verify-partner-sync.ts).
 */
export function partnerDifferences(trip: TravelTrip, poster: Row | null, expected: { fields: Row; extra: Row; contentHash: string }): ParityDifference[] {
  const out: ParityDifference[] = [];
  const fieldKeys = ["adult_price", "child_price", "infant_price", "hotel", "notes", "departure_dates", "duration_text"] as const;
  const extraKeys = ["included_items", "excluded_items", "itinerary_days", "hotel_profiles"] as const;
  const fields = fieldKeys.filter((key) => !isDeepStrictEqual((trip as unknown as Row)[key], expected.fields[key]));
  const extras = extraKeys.filter((key) => !isDeepStrictEqual(trip.extra[key], expected.extra[key]));
  const money3 = new Set(["adult_price", "child_price", "infant_price", "departure_dates"]);
  if (fields.some((key) => money3.has(key))) {
    out.push(difference("partner", 3, "partner_prices_dates", "Түншийн үнэ/өдөр хадгалсанаас өөр", "stored prices or dates differ from the partner's",
      fields.filter((key) => money3.has(key)).map((key) => `${key}: stored ${JSON.stringify((trip as unknown as Row)[key])} · partner ${JSON.stringify(expected.fields[key])}`)));
  }
  const other = [...fields.filter((key) => !money3.has(key)), ...extras];
  if (other.length) out.push(difference("partner", 2, "partner_facts", "Түншийн мэдээлэл хадгалсанаас өөр", "stored trip facts differ from the partner's", [other.join(", ")]));
  const stored = partnerFareCells(trip.extra.price_groups);
  const want = partnerFareCells(expected.extra.price_groups);
  if (!isDeepStrictEqual(stored, want)) {
    const items = [...stored.filter((cell) => !want.includes(cell)).map((cell) => `stored only: ${cellText(cell)}`),
      ...want.filter((cell) => !stored.includes(cell)).map((cell) => `partner only: ${cellText(cell)}`)];
    out.push(difference("partner", 3, "partner_fares", "Түншийн үнийн мөр хадгалсанаас өөр", "price rows differ from the partner's", items));
  }
  const snapshot = record(poster?.partner_snapshot).contentHash;
  const status = record(poster?.partner_sync).status;
  if (snapshot !== expected.contentHash || status !== "complete") {
    out.push(difference("partner", 2, "partner_snapshot", "Постер түншийн сүүлийн өгөгдлөөр шинэчлэгдээгүй", "the poster is not on the partner's latest data",
      [`snapshot ${snapshot === expected.contentHash ? "current" : "stale"} · sync ${String(status ?? "—")}`]));
  }
  return out;
}

// ── Report ───────────────────────────────────────────────────────────────────

const AREA_ORDER: ParityArea[] = ["bot", "website", "partner", "poster"];

export function sortDifferences(differences: ParityDifference[]): ParityDifference[] {
  return [...differences].sort((a, b) => b.severity - a.severity || AREA_ORDER.indexOf(a.area) - AREA_ORDER.indexOf(b.area));
}

/** Every difference across trips, most serious first: severity, then bot → website → partner → poster, then size. */
export function topDifferences(results: TripParityResult[], limit = 5) {
  return results.flatMap((result) => result.differences.map((diff) => ({ result, diff })))
    .sort((a, b) => b.diff.severity - a.diff.severity
      || AREA_ORDER.indexOf(a.diff.area) - AREA_ORDER.indexOf(b.diff.area)
      || b.diff.items.length - a.diff.items.length)
    .slice(0, limit);
}

export function differenceLine(diff: ParityDifference): string {
  return `${ICON[diff.severity]} **${AREA_LABEL[diff.area]}** · ${diff.mn} / ${diff.en}`;
}

/** "N trips checked, M with differences" (+ website pages the chatbot does not sell, when any). */
export function summaryLine(results: TripParityResult[]): string {
  const checked = results.filter((result) => !result.websitePageOnly);
  const pages = results.length - checked.length;
  return `${checked.length} trips checked, ${checked.filter((result) => result.differences.length).length} with differences`
    + (pages ? `; ${pages} website page${pages === 1 ? "" : "s"} published for trips the chatbot does not sell` : "");
}

/** What the bot's card says about price, for the report's coverage line. */
export function fareCardKind(botTrip: TravelTrip, now: Date): "priced" | "no price line" | "none" {
  const card: string[] | null = buildFareSection(botTrip, now);
  return !card?.length ? "none" : card.some((line) => line.startsWith("• ")) ? "priced" : "no price line";
}

export function renderParityReport(results: TripParityResult[], meta: { generatedAt: string; notChecked?: string[]; coverage?: string[] }): string {
  const withDiffs = results.filter((result) => result.differences.length)
    .sort((a, b) => Math.max(0, ...b.differences.map((d) => d.severity)) - Math.max(0, ...a.differences.map((d) => d.severity)) || a.name.localeCompare(b.name));
  const checked = results.filter((result) => !result.websitePageOnly);
  const counts = (["website", "poster", "bot", "partner"] as ParityArea[])
    .map((area) => `${AREA_LABEL[area]} ${withDiffs.filter((result) => !result.websitePageOnly && result.differences.some((d) => d.area === area)).length}`);
  const lines = [
    `# Uudam parity check — ${meta.generatedAt}`,
    "",
    `**${summaryLine(results)}** · Шалгасан аялал: ${checked.length}, зөрүүтэй: ${checked.filter((result) => result.differences.length).length}`,
    "",
    `Trips with differences by area: ${counts.join(" · ")}`,
    "",
    "Зөвхөн уншсан, юу ч өөрчлөөгүй. / Read-only: nothing was changed. 🔴 customer sees it now · 🟠 next save/sync or staff must decide · 🟡 detail",
  ];
  if (meta.coverage?.length) lines.push("", ...meta.coverage.map((line) => `- ${line}`));
  if (meta.notChecked?.length) lines.push("", "## Шалгаж чадаагүй / Not checked", ...meta.notChecked.map((line) => `- ⚠️ ${line}`));
  const top = topDifferences(results, 10);
  if (top.length) {
    lines.push("", "## Хамгийн чухал / Most important");
    top.forEach(({ result, diff }, index) => lines.push(`${index + 1}. «${result.name}» — ${differenceLine(diff)}${diff.items[0] ? ` — ${diff.items[0]}` : ""}`));
  }
  for (const result of withDiffs) {
    lines.push("", `## «${result.name}»`, `\`${result.tripId}\``);
    for (const diff of sortDifferences(result.differences)) {
      lines.push(`- ${differenceLine(diff)}`);
      for (const item of diff.items.slice(0, MAX_ITEMS)) lines.push(`  - ${item}`);
      if (diff.items.length > MAX_ITEMS) lines.push(`  - … +${diff.items.length - MAX_ITEMS} more`);
    }
  }
  if (!withDiffs.length) lines.push("", "✅ Бүгд таарч байна. / Everything agrees.");
  return lines.join("\n") + "\n";
}
