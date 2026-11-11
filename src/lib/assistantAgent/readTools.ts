/**
 * The agent's read tools over the catalogue: search_trips and get_trip.
 *
 * search_trips uses the brain's matcher (aliases, Latin spellings, places; every status,
 * since the admin may mean an archived or draft trip) plus a date filter, so "12/2 дүүрсэн"
 * with no name finds the trips that actually leave on 12/2 instead of the recently edited
 * ones. get_trip shows the model everything an edit touches — the version, every coming
 * date with its website state (PAUSED kept as "paused", never read as open), compact price
 * rows, age bands, the program day by day, the photos with their positions, the poster's
 * hero and day photos, visibility, the website link and whether the trip is partner-synced.
 * Nothing here writes.
 */
import { ageRulesFromExtra } from "../ageRules";
import { pricingDays } from "../adminDatePricing";
import { stripAnswerTags } from "../assistantBrain";
import { BOOKING_WEBSITE_URL, storedWebsiteTripSlug } from "../bookingWebsite";
import { departureAvailability } from "../departureAvailability";
import { parseDepartureDateText } from "../travelDates";
import { findTripMatches } from "../travelFastPathsSearch";
import { soundAlikeTrips } from "./fuzzyTripSearch";
import { upcomingDepartures } from "../tripFareBlock";
import { departureDayOf } from "../tripScheduleChange";
import type { TravelTrip } from "../travelTypes";
import { hashedSlugFor, withoutUrls } from "./links";
import type { PosterPhotoView } from "./types";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {});
const text = (value: unknown): string => (typeof value === "string" ? value.trim() : "");
const MAX_SEARCH_RESULTS = 8;

export function isPartnerTrip(trip: Pick<TravelTrip, "extra">): boolean {
  return Boolean(text(record(trip.extra?.partner_sync).source_url));
}

export function isVisible(trip: Pick<TravelTrip, "extra" | "status">): boolean {
  return trip.extra?.customer_visible !== false && trip.status !== "archived";
}

/** "Today" as a Ulaanbaatar calendar day (YYYY-MM-DD). */
export function ubToday(now: Date): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

export type DayState = "open" | "low" | "full" | "paused" | "cancelled" | "not_on_website";

function stateOf(status: string, seatsLeft: number | null): DayState {
  const value = status.toUpperCase();
  if (value === "ALMOST_FULL") return seatsLeft === 0 ? "full" : "low";
  if (value === "SOLD_OUT" || seatsLeft === 0) return "full";
  if (value === "PAUSED") return "paused";
  if (value === "CANCELLED") return "cancelled";
  return "open";
}

export type DepartureView = { date: string; state: DayState; website_status: string | null; seats_left: number | null };

/** Every coming departure of the trip with its per-date state from the website overlay. */
export function tripDepartures(trip: TravelTrip, now: Date): DepartureView[] {
  const today = ubToday(now);
  const days = new Map<string, DepartureView>();
  for (const row of departureAvailability(trip)) {
    if (row.date < today || row.status.toUpperCase() === "DEPARTED") continue;
    days.set(row.date, { date: row.date, state: stateOf(row.status, row.seatsLeft), website_status: row.status.toUpperCase(), seats_left: row.seatsLeft });
  }
  const listed = (() => { try { return upcomingDepartures(trip, now); } catch { return []; } })();
  for (const date of listed) if (date >= today && !days.has(date)) days.set(date, { date, state: "not_on_website", website_status: null, seats_left: null });
  for (const entry of trip.departure_dates) {
    const day = departureDayOf(trip, entry, now);
    if (day && day >= today && !days.has(day)) days.set(day, { date: day, state: "not_on_website", website_status: null, seats_left: null });
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** A date the admin typed ("12/2", "12 сарын 2", "2026-12-02") as YYYY-MM-DD, or null. */
export function isoDateOf(value: string, now: Date): string | null {
  const raw = String(value || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return parseDepartureDateText(raw, now)[0] ?? null;
}

export type TripSummaryView = {
  trip_id: string; name: string; status: string; visible: boolean; partner: boolean;
  next_dates: string[]; leaves_on_date?: boolean; version: string;
};

function summaryOf(trip: TravelTrip, now: Date, date?: string | null): TripSummaryView {
  const departures = tripDepartures(trip, now).filter((day) => day.state !== "cancelled");
  return {
    trip_id: trip.id, name: trip.route_name, status: trip.status, visible: isVisible(trip), partner: isPartnerTrip(trip),
    next_dates: departures.slice(0, 4).map((day) => day.date),
    ...(date ? { leaves_on_date: departures.some((day) => day.date === date) } : {}),
    version: trip.updated_at,
  };
}

/** Trips matching the admin's words (every status), narrowed to those leaving on `date` when one is given. */
export function searchTrips(trips: TravelTrip[], input: { query?: string; date?: string }, now: Date): { results: TripSummaryView[]; note?: string } {
  const query = withoutUrls(stripAnswerTags(String(input.query || ""))).trim();
  const date = input.date ? isoDateOf(input.date, now) : null;
  if (input.date && !date) return { results: [], note: `«${input.date}» огноо уншигдсангүй (ж: 12/2, 12 сарын 2, 2026-12-02).` };
  let pool: TravelTrip[];
  if (query) {
    const byId = new Map(trips.map((trip) => [trip.id, trip]));
    const asActive = trips.map((trip) => (trip.status === "active" ? trip : { ...trip, status: "active" as const }));
    const matched = findTripMatches(query, asActive)
      .filter((match) => !match.matchedWords.length || match.matchedWords.some((word) => !/^\d+$/.test(word)))
      .map((match) => byId.get(match.trip.id) ?? match.trip);
    // Names typed the way they sound ("hailan chuhai" for «… Жухай – Хайлин арал»): a trip that
    // sounds like two or more of the words comes first, one-word sound-alikes after the matcher's.
    const alike = soundAlikeTrips(query, trips);
    const strong = alike.filter((entry) => entry.matched >= 2).map((entry) => entry.trip);
    const weak = alike.filter((entry) => entry.matched < 2).map((entry) => entry.trip);
    // Exactly one trip sounds like two or more of the admin's words: that is the trip. Listing the
    // one-word near-misses next to it let the model pick one of them instead (live run 2026-11-06).
    if (strong.length === 1 && !date) {
      return { results: [summaryOf(strong[0], now, null)], note: `«${strong[0].route_name}» нь таны 2-оос олон үгтэй дуудлагаараа таарч байна — энэ аялал.` };
    }
    const seen = new Set<string>();
    pool = [...strong, ...matched, ...weak].filter((trip) => (seen.has(trip.id) ? false : (seen.add(trip.id), true)));
    if (!pool.length) {
      const folded = query.toLowerCase();
      pool = trips.filter((trip) => trip.route_name.toLowerCase().includes(folded) || trip.id.toLowerCase() === folded);
    }
  } else {
    pool = trips.filter((trip) => trip.status !== "archived" && trip.status !== "cancelled");
  }
  let results = pool.map((trip) => summaryOf(trip, now, date));
  if (date) results = results.filter((entry) => entry.leaves_on_date);
  if (!query && !date) results = results.slice(0, MAX_SEARCH_RESULTS);
  const note = !results.length
    ? date ? `${date}-нд гарах аялал ${query ? `«${query}» нэрээр ` : ""}олдсонгүй.` : `«${query}» нэртэй аялал олдсонгүй.`
    : results.length > MAX_SEARCH_RESULTS ? `${results.length} аялал таарлаа; эхний ${MAX_SEARCH_RESULTS}-г харууллаа — нарийсгаж хайна уу.` : undefined;
  return { results: results.slice(0, MAX_SEARCH_RESULTS), ...(note ? { note } : {}) };
}

function money(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clip(value: unknown, max: number): string {
  const raw = text(value);
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/** The price rows as the model needs them to target one date: index, dates, fares, passenger tiers. */
export function priceRowsOf(trip: TravelTrip, now: Date) {
  const groups = Array.isArray(trip.extra?.price_groups) ? (trip.extra.price_groups as unknown[]) : [];
  return groups.slice(0, 30).map((group, index) => {
    const row = record(group);
    const tiers = Array.isArray(row.passenger_prices) ? row.passenger_prices.map(record) : [];
    return {
      row: index + 1,
      ...(text(row.label) ? { label: text(row.label) } : {}),
      ...(text(row.hotel) ? { hotel: text(row.hotel) } : {}),
      ...(text(row.package_id) ? { package_id: text(row.package_id) } : {}),
      dates: pricingDays(row, now),
      adult: money(row.adult_price),
      child: money(row.child_price),
      infant: money(row.infant_price),
      ...(money(row.single_price) != null ? { single: money(row.single_price) } : {}),
      ...(tiers.length ? { passengers: tiers.map((tier) => ({ label: text(tier.label), age_range: text(tier.age_range), price: money(tier.price) })) } : {}),
    };
  });
}

function itineraryOf(trip: TravelTrip, poster: PosterPhotoView | null) {
  const days = Array.isArray(trip.extra?.itinerary_days) ? (trip.extra.itinerary_days as unknown[]).map(record) : [];
  return days.slice(0, 40).map((day, index) => {
    const number = typeof day.day === "number" ? day.day : index + 1;
    const meals = record(day.meals);
    const posterPhoto = poster?.days.find((entry) => entry.day === number)?.photo || null;
    return {
      day: number,
      title: clip(day.title, 120),
      description: clip(day.description, 420),
      ...(text(day.hotel) ? { hotel: clip(day.hotel, 120) } : {}),
      meals: { breakfast: meals.breakfast ?? null, lunch: meals.lunch ?? null, dinner: meals.dinner ?? null },
      ...(text(day.meal_note) ? { meal_note: clip(day.meal_note, 160) } : {}),
      photo: text(day.photo) || posterPhoto,
    };
  });
}

/** Everything the model may need to edit one trip exactly. */
export function tripDetailView(trip: TravelTrip, now: Date, poster: PosterPhotoView | null) {
  const slug = storedWebsiteTripSlug(trip);
  const partner = isPartnerTrip(trip);
  return {
    trip_id: trip.id,
    name: trip.route_name,
    aliases: Array.isArray(trip.extra?.aliases) ? (trip.extra.aliases as unknown[]).filter((alias) => typeof alias === "string").slice(0, 10) : [],
    version: trip.updated_at,
    status: trip.status,
    visible_on_site: isVisible(trip),
    website: {
      published: trip.extra?.website_published === true,
      // An unpublished page answers "not found": its address is never handed out as a link (2026-11-11,
      // an archived trip's link was given and the owner found a dead page).
      link: slug && trip.extra?.website_published === true ? `${BOOKING_WEBSITE_URL}/mn/trips/${encodeURIComponent(slug)}` : null,
      ...(slug && trip.extra?.website_published !== true ? { link_note: "Сайтад нийтлэгдээгүй — хуудас нь «олдсонгүй» гэж харагдана. Холбоос бүү өг." } : {}),
      slug: slug || null,
      generated_slug: hashedSlugFor(trip.id),
    },
    partner,
    ...(partner ? { partner_note: "Хамтрагчийн сайтаас 30 минут тутам шинэчлэгддэг: үнэ, огноо, огнооны төлөвийг гараар засахгүй." } : {}),
    duration: trip.duration_text,
    base_fares: { adult: trip.adult_price, child: trip.child_price, infant: trip.infant_price, currency: trip.currency },
    departures: tripDepartures(trip, now),
    departure_texts: trip.departure_dates.slice(0, 30),
    price_rows: priceRowsOf(trip, now),
    age_rules: ageRulesFromExtra(trip.extra),
    seats: { total: trip.seats_total, left: trip.seats_left },
    has_food: trip.has_food,
    hotel: trip.hotel,
    transport_type: trip.extra?.transport_type ?? null,
    itinerary_days: itineraryOf(trip, poster),
    photos: trip.photo_urls.slice(0, 30).map((url, index) => ({ position: index + 1, url })),
    poster: poster ? { hero: poster.hero, day_photos: poster.days.filter((day) => day.photo) } : null,
    notes: clip(trip.notes, 600),
  };
}

const DETAIL_MAX_CHARS = 14_000;

/** The detail as the JSON the model reads, cut down (program text first) to stay inside the token budget. */
export function tripDetailJson(trip: TravelTrip, now: Date, poster: PosterPhotoView | null): string {
  const view = tripDetailView(trip, now, poster);
  let json = JSON.stringify(view);
  if (json.length <= DETAIL_MAX_CHARS) return json;
  view.itinerary_days = view.itinerary_days.map((day) => ({ ...day, description: clip(day.description, 160) }));
  json = JSON.stringify(view);
  if (json.length <= DETAIL_MAX_CHARS) return json;
  view.price_rows = view.price_rows.slice(0, 12);
  view.departure_texts = view.departure_texts.slice(0, 8);
  return JSON.stringify(view).slice(0, DETAIL_MAX_CHARS);
}
