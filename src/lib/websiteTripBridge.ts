import type { TripMutationFields } from "./travelTypes";
import { sameParityValue } from "./tripWebsiteParityValue";
import { duration } from "./connectedTripMapping";
import { websiteDepartureDateKey } from "./websiteDepartureDate";
import { currentWebsiteDepartureRows } from "./websiteDepartureRows";
import { mergeWebsiteDateFares } from "./websiteDateFares";
import { parseTripDepartureDateText } from "./travelDates";
import { legacyUnstatedMeals } from "./tripExtraSchema";

type UnknownRecord = Record<string, unknown>;

export class WebsiteTripPayloadError extends Error {}

const owns = (value: UnknownRecord, key: string) => Object.prototype.hasOwnProperty.call(value, key);

export function websiteTripSourceId(input: unknown): string {
  const trip = record(input);
  const id = text(trip.sourceTripId);
  if (!id) throw new WebsiteTripPayloadError("Website trip is missing sourceTripId");
  return id;
}

export function validateWebsiteTripPayload(input: unknown): void {
  websiteTripSourceId(input);
  const trip = record(input);
  const fail = (field: string): never => { throw new WebsiteTripPayloadError(`Invalid website trip field: ${field}`); };
  for (const key of ["title", "summary", "description", "hotel", "departureRule", "image"]) {
    if (owns(trip, key) && trip[key] !== null && typeof trip[key] !== "string") fail(key);
  }
  if (owns(trip, "title") && !text(trip.title)) fail("title");
  for (const key of ["extraImages", "included", "excluded", "importantNotes"]) {
    if (owns(trip, key) && (!Array.isArray(trip[key]) || !(trip[key] as unknown[]).every(item => typeof item === "string"))) fail(key);
  }
  for (const key of ["price", "childPrice", "infantPrice"]) {
    if (owns(trip, key) && trip[key] !== null && (numberOrNull(trip[key]) === null || Number(trip[key]) < 0)) fail(key);
  }
  for (const key of ["durationDays", "durationNights"]) {
    if (owns(trip, key) && (!Number.isInteger(trip[key]) || Number(trip[key]) < (key === "durationDays" ? 1 : 0))) fail(key);
  }
  for (const key of ["isPublished", "foodIncluded"]) {
    if (owns(trip, key) && !(key === "foodIncluded" && trip[key] === null) && typeof trip[key] !== "boolean") fail(key);
  }
  if (owns(trip, "currency") && !/^[a-z]{3}$/i.test(text(trip.currency))) fail("currency");
  if (owns(trip, "sourceMetadata") && (trip.sourceMetadata === null || typeof trip.sourceMetadata !== "object" || Array.isArray(trip.sourceMetadata))) fail("sourceMetadata");
  for (const key of ["departures", "itinerary"]) {
    if (!owns(trip, key)) continue;
    if (!Array.isArray(trip[key])) fail(key);
    for (const value of trip[key] as unknown[]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) fail(key);
      const row = record(value);
      if (key === "departures") {
        const date = dateKey(row.startDate);
        if (!date) fail("departures.startDate");
        if (!["OPEN", "ALMOST_FULL", "SOLD_OUT", "PAUSED", "CANCELLED", "DEPARTED"].includes(text(row.status).toUpperCase())) fail("departures.status");
        for (const fare of ["price", "childPrice", "infantPrice"]) {
          if (owns(row, fare) && row[fare] !== null && (numberOrNull(row[fare]) === null || Number(row[fare]) < 0)) fail(`departures.${fare}`);
        }
        if (owns(row, "seatsLeft") && row.seatsLeft !== null && (!Number.isInteger(row.seatsLeft) || Number(row.seatsLeft) < 0)) fail("departures.seatsLeft");
      } else {
        for (const field of ["title", "description", "accommodation", "image"]) {
          if (owns(row, field) && row[field] !== null && typeof row[field] !== "string") fail(`itinerary.${field}`);
        }
        if (owns(row, "meals") && (!Array.isArray(row.meals) || !(row.meals as unknown[]).every(item => typeof item === "string"))) fail("itinerary.meals");
      }
    }
    if (key === "departures") canonicalDepartures(trip[key] as unknown[]);
  }
  const metadata = record(trip.sourceMetadata);
  for (const key of ["price_groups", "hotel_profiles", "hotel_links"]) {
    if (owns(metadata, key) && (!Array.isArray(metadata[key]) || !(metadata[key] as unknown[]).every(item => item && typeof item === "object" && !Array.isArray(item)))) fail(`sourceMetadata.${key}`);
  }
  if (owns(metadata, "age_rules") && (!metadata.age_rules || typeof metadata.age_rules !== "object" || Array.isArray(metadata.age_rules))) fail("sourceMetadata.age_rules");
  const manual = record(record(metadata.canonicalExtraPatch).values);
  for (const [key, value] of Object.entries(manual)) {
    if (["aliases", "destinations", "review_reasons"].includes(key) && (!Array.isArray(value) || !value.every(item => typeof item === "string"))) fail(`canonicalExtraPatch.${key}`);
    if (["customer_visible", "needs_human_review"].includes(key) && typeof value !== "boolean") fail(`canonicalExtraPatch.${key}`);
    if (key === "transport_type" && typeof value !== "string") fail(`canonicalExtraPatch.${key}`);
    if (key === "booking_terms" && (!value || typeof value !== "object" || Array.isArray(value) || !Object.values(value).every(item => typeof item === "string"))) fail(`canonicalExtraPatch.${key}`);
    if (["discounts", "extra_fees", "room_prices", "answer_hints"].includes(key) && (!Array.isArray(value) || !value.every(item => item && typeof item === "object" && !Array.isArray(item)))) fail(`canonicalExtraPatch.${key}`);
  }
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type FareKind = "adult" | "child" | "infant";

/**
 * The website stores an adult fare of 0 for "Үнэ лавлах" (its column is not
 * nullable), but a child or infant fare of 0 is a published free fare, shown
 * there as "Үнэгүй". Only that zero survives; any other tugrik amount under
 * 1,000 is a typo and stays unknown.
 */
function fareOrNull(value: unknown, currency: unknown, kind: FareKind = "adult"): number | null {
  const amount = numberOrNull(value);
  if (amount === null) return null;
  if (amount === 0 && kind !== "adult") return 0;
  return String(currency || "MNT").toUpperCase() === "MNT" && amount < 1000 ? null : amount;
}

/** A tugrik fare the bridge cannot carry: 1-999₮, or an adult 0 meant as "ask us". */
function droppedFare(value: unknown, currency: unknown, kind: FareKind): boolean {
  const amount = numberOrNull(value);
  return amount !== null && fareOrNull(amount, currency, kind) === null && !(kind === "adult" && amount === 0);
}

const FREE_LABEL: Record<"child" | "infant", string> = { child: "Хүүхэд", infant: "Нярай" };

/**
 * The bot reads a 0 fare as free only beside a documented "Үнэгүй" rule
 * (isDocumentedFreeFare); a bare 0 means "not confirmed". This keeps the
 * trip-wide free rule — the same entry deriveChildRules writes for the admin's
 * "free" checkbox — in step with a 0 or a priced fare from the website.
 */
export function withBaseFreeFareRule(rules: unknown, kind: "child" | "infant", free: boolean): UnknownRecord[] {
  const label = FREE_LABEL[kind];
  const kept = (Array.isArray(rules) ? rules : []).map(record).filter((rule) =>
    !(rule.price === 0 && /үнэгүй/i.test(text(rule.note)) && text(rule.label) === label && !text(rule.age_range)));
  return free ? [...kept, { label, age_range: "", price: 0, currency: "MNT", note: "Үнэгүй" }] : kept;
}

function isBaseFreeFare(rules: unknown, kind: "child" | "infant"): boolean {
  return (Array.isArray(rules) ? rules : []).map(record).some((rule) =>
    rule.price === 0 && /үнэгүй/i.test(text(rule.note)) && text(rule.label) === FREE_LABEL[kind] && !text(rule.age_range));
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function dateKey(value: unknown): string {
  return websiteDepartureDateKey(value);
}

/** Retained cancelled rows are history, not competing current departures. */
function canonicalDepartures(values: unknown[]): UnknownRecord[] {
  const byDay = new Map<string, UnknownRecord[]>();
  for (const row of currentWebsiteDepartureRows(values.map(record))) {
    const day = dateKey(row.startDate);
    if (!day) throw new WebsiteTripPayloadError("Invalid website trip field: departures.startDate");
    const group = byDay.get(day) || [];
    group.push(row);
    byDay.set(day, group);
  }
  return Array.from(byDay.values(), rows => {
    if (rows.length === 1) return rows[0];
    const current = rows.filter(row => !["CANCELLED", "DEPARTED"].includes(text(row.status).toUpperCase()));
    const facts = (row: UnknownRecord) => ({ status: availabilityStatus(row.status), seatsLeft: numberOrNull(row.seatsLeft),
      price: numberOrNull(row.price), childPrice: numberOrNull(row.childPrice), infantPrice: numberOrNull(row.infantPrice) });
    if (current.length === 0 && rows.every(row => sameParityValue(facts(row), facts(rows[0])))) return rows[0];
    throw new WebsiteTripPayloadError("Invalid website trip field: departures.startDate");
  });
}

/** Today in Ulaanbaatar, "YYYY-MM-DD". */
function mongoliaToday(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ulaanbaatar", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/**
 * The calendar days a schedule names, read through the stored write-time
 * resolution first ("10 сарын 8" → 2026-10-08) and the date parser otherwise.
 * Null when an entry is a rule rather than a day ("Пүрэв гараг бүр") or cannot
 * be read: such a schedule is the chatbot's to keep.
 */
function scheduleDays(values: unknown, resolved: unknown): Map<string, string> | null {
  const known = new Map<string, string>();
  for (const entry of Array.isArray(resolved) ? resolved.map(record) : []) {
    if (typeof entry.text === "string" && typeof entry.ymd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.ymd)) known.set(entry.text.trim(), entry.ymd);
  }
  const days = new Map<string, string>();
  for (const value of strings(values)) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(value) ? [value] : known.has(value) ? [known.get(value)!] : parseTripDepartureDateText(value);
    if (iso.length !== 1) return null;
    if (!days.has(iso[0])) days.set(iso[0], value);
  }
  return days;
}

function futureDays(days: Map<string, string>, today: string): string[] {
  return [...days.keys()].filter((day) => day >= today).sort();
}

const sameDays = (left: string[], right: string[]) => left.length === right.length && left.every((day, index) => day === right[index]);

function durationText(days: unknown, nights: unknown): string {
  const dayCount = Math.max(1, Math.trunc(numberOrNull(days) ?? 1));
  const nightCount = Math.max(0, Math.trunc(numberOrNull(nights) ?? Math.max(0, dayCount - 1)));
  return `${dayCount} өдөр ${nightCount} шөнө`;
}

function availabilityStatus(value: unknown): "OPEN" | "ALMOST_FULL" | "SOLD_OUT" | "PAUSED" | "CANCELLED" {
  const status = text(value).toUpperCase();
  if (status === "ALMOST_FULL") return "ALMOST_FULL";
  if (status === "SOLD_OUT") return "SOLD_OUT";
  if (status === "CANCELLED" || status === "DEPARTED") return "CANCELLED";
  if (status === "PAUSED") return "PAUSED";
  return "OPEN";
}

/**
 * Converts customer-facing trip fields, without erasing canonical seat counts,
 * source provenance or unrelated metadata. Partial saves use websiteTripPatch.
 */
export function websiteTripToCanonicalFields(input: unknown): {
  sourceTripId: string;
  fields: TripMutationFields;
} {
  validateWebsiteTripPayload(input);
  const trip = record(input);
  if (owns(trip, "durationDays") !== owns(trip, "durationNights")) throw new WebsiteTripPayloadError("Both duration fields are required without a previous snapshot");
  return mapWebsiteTrip(input);
}

type MealKey = "breakfast" | "lunch" | "dinner";
type MealState = Record<MealKey, boolean | null>;
const MEAL_KEYS: readonly MealKey[] = ["breakfast", "lunch", "dinner"];
/*
 * How a meal phrase typed on the website reads. Twin of dayMealSlots in the website's
 * src/lib/itineraryMeals.ts (uudam-booking-web: SLOTS, NOT_INCLUDED, ALL_MEALS): the website
 * draws ✓/✗ from its copy and this one decides what the bot is told, so the two must read
 * every phrase the same way. Change both together.
 */
const MEAL_PATTERNS: Record<MealKey, RegExp> = {
  breakfast: /өглөө|breakfast/iu,
  lunch: /(?:^|[^\p{L}])(?:өдөр|өдрийн|үдийн|lunch)/iu,
  dinner: /орой|dinner/iu,
};
/** A meal phrase that says the meal is NOT included ("Орой ороогүй", "Өдрийн хоол өөрийн зардлаар", "Орой үгүй"). */
const MEAL_NOT_INCLUDED = /ороогүй|орохгүй|багтаагүй|багтахгүй|хоолгүй|өөрийн|өөрөө|үгүй|not included|excluded|own expense|self[- ]?paid/iu;
/** "3 хоол", "Бүх хоол", "Full board": all three meals at once. */
const ALL_MEALS = /(?:^|[^\p{L}\p{N}])(?:3|гурван)\s*(?:удаагийн\s*|удаа\s*)?хоол|бүх\s*хоол|full\s*board|all\s*meals/iu;

function mealStateOf(value: unknown): boolean | null {
  return value === true ? true : value === false ? false : null;
}

/**
 * What a website day's meal list names, read as the website reads it: true included, false
 * typed as not included, null named both ways (unknown). A meal the list does not name is absent.
 */
function namedMeals(listed: string[]): Partial<MealState> {
  const named: Partial<MealState> = {};
  for (const phrase of listed.flatMap(meal => meal.split(/[,;/]+/)).map(part => part.trim()).filter(Boolean)) {
    const included = !MEAL_NOT_INCLUDED.test(phrase);
    const keys = MEAL_KEYS.filter(key => MEAL_PATTERNS[key].test(phrase));
    for (const key of keys.length ? keys : ALL_MEALS.test(phrase) ? MEAL_KEYS : []) {
      named[key] = key in named && named[key] !== included ? null : included;
    }
  }
  return named;
}

/**
 * What each chatbot day's meals were at the last sync, by the chatbot's day number. The website
 * lists only included meals, so "not included" (false) and "not stated" (null) live in the sync's
 * `sourceMetadata.itineraryMeals`; a trip synced before that existed falls back to the chatbot's
 * own days from the last sync.
 */
function websiteMealStates(itineraryMeals: unknown, priorDays: unknown): Map<number, MealState> {
  const states = new Map<number, MealState>();
  const legacy = new Set<number>();
  (Array.isArray(priorDays) ? priorDays : []).map(record).forEach((day, index) => {
    const meals = record(day.meals);
    const dayNumber = Number(day.day) || index + 1;
    states.set(dayNumber, { breakfast: mealStateOf(meals.breakfast), lunch: mealStateOf(meals.lunch), dinner: mealStateOf(meals.dinner) });
    if (legacyUnstatedMeals(meals, day.meal_note)) legacy.add(dayNumber);
  });
  (Array.isArray(itineraryMeals) ? itineraryMeals : []).map(record).forEach((day) => {
    const dayNumber = Number(day.dayNumber);
    if (!(dayNumber > 0)) return;
    const state = { breakfast: mealStateOf(day.breakfast), lunch: mealStateOf(day.lunch), dinner: mealStateOf(day.dinner) };
    // websiteItineraryMeals sends a legacy all-false day as "not stated"; the chatbot day still
    // holds its false, and the three-way comparison below reads that stored value.
    if (legacy.has(dayNumber) && MEAL_KEYS.every(key => state[key] === null) && !text(day.note)) return;
    states.set(dayNumber, state);
  });
  return states;
}

/**
 * The website day this one was before the save: what that day listed (null when there is no
 * earlier website copy to compare with) and the states of the chatbot day it was drawn from.
 */
type PriorWebsiteDay = { meals: string[] | null; before: MealState | undefined };

/**
 * Where a website day was in the copy this save replaced. The website renumbers its days 1..n on
 * every save (booking-web src/server/tripInput.ts normalizeItinerary), so a day is found by its
 * ItineraryDay id, by position only when it has none; -1 for a day the save added.
 */
function previousWebsiteDayIndex(day: UnknownRecord, index: number, previousDays: UnknownRecord[]): number {
  return day.id ? previousDays.findIndex((entry) => entry.id === day.id) : index;
}

/**
 * A meal the website names is what it says. One it does not name stays what the chatbot day it
 * came from said (true, false or not stated), unless that day listed it and the save took it off
 * (not included). A day the save added states nothing it does not name. With no earlier website
 * copy, a meal the sync drew as included and the website no longer lists was taken off; one with
 * no stored state (a trip made on the website, a day the chatbot never had) stays not stated, as
 * the website itself reads an unnamed meal.
 */
function websiteDayMealStates(listed: string[], prior: PriorWebsiteDay | null): MealState {
  const now = namedMeals(listed);
  const was = prior?.meals ? namedMeals(prior.meals) : null;
  const state = (key: MealKey): boolean | null => {
    if (key in now) return now[key] ?? null;
    if (!prior) return null;
    const before = prior.before?.[key];
    if (was) return was[key] === true ? false : before ?? null;
    return before === true ? false : before ?? null;
  };
  return { breakfast: state("breakfast"), lunch: state("lunch"), dinner: state("dinner") };
}

/** `previousItinerary`: the website days this save replaced, which tell each day's identity. */
function mapWebsiteTrip(input: unknown, previousItinerary?: unknown): { sourceTripId: string; fields: TripMutationFields } {
  const trip = record(input);
  const sourceTripId = websiteTripSourceId(trip);

  const metadata = record(trip.sourceMetadata);
  const priorSource = record(metadata.connectedSource);
  const priorExtra = record(priorSource.extra);
  const departures = Array.isArray(trip.departures) ? canonicalDepartures(trip.departures) : [];
  const dates = departures.map(departure => dateKey(departure.startDate)).filter(Boolean);
  const uniqueDates = [...new Set(dates)];
  const image = text(trip.image);
  const photos = [...new Set([image, ...strings(trip.extraImages)].filter(Boolean))];
  const mealStates = websiteMealStates(metadata.itineraryMeals, priorExtra.itinerary_days);
  const previousDays = Array.isArray(previousItinerary) ? previousItinerary.map(record) : null;
  const priorDay = (day: UnknownRecord, index: number): PriorWebsiteDay | null => {
    if (!previousDays) return { meals: null, before: mealStates.get(Number(day.dayNumber) || index + 1) };
    const oldIndex = previousWebsiteDayIndex(day, index, previousDays);
    const oldDay = previousDays[oldIndex];
    return oldDay ? { meals: strings(oldDay.meals), before: mealStates.get(Number(oldDay.dayNumber) || oldIndex + 1) } : null;
  };
  const itinerary = (Array.isArray(trip.itinerary) ? trip.itinerary.map(record) : [])
    .map((day, index) => ({
      day: index + 1,
      title: text(day.title),
      description: text(day.description),
      hotel: text(day.accommodation),
      meals: websiteDayMealStates(strings(day.meals), priorDay(day, index)),
      ...(text(day.image) ? { photo: text(day.image) } : {}),
    }))
    .filter(day => day.title || day.description || day.hotel || "photo" in day || Object.values(day.meals).some(Boolean));

  const metadataPriceGroups = Array.isArray(metadata.price_groups) ? metadata.price_groups : [];
  const priceGroups = owns(metadata, "price_groups")
    ? metadataPriceGroups
    : Array.isArray(priorExtra.price_groups) ? priorExtra.price_groups : [];
  const simpleDepartureGroups = departures
    .map(departure => {
      const date = dateKey(departure.startDate);
      if (!date) return null;
      const childPrice = fareOrNull(departure.childPrice, trip.currency, "child");
      const infantPrice = fareOrNull(departure.infantPrice, trip.currency, "infant");
      return {
        dates: [date],
        adult_price: fareOrNull(departure.price, trip.currency),
        child_price: childPrice,
        infant_price: infantPrice,
        ...(childPrice === 0 ? { child_price_free: true } : {}),
        ...(infantPrice === 0 ? { infant_price_free: true } : {}),
      };
    })
    .filter((group): group is NonNullable<typeof group> => Boolean(group));

  // The length as numbers too: the bot, the reply checker and the next sync read these first, so a
  // website length edit that changed only the text was answered with the old length and then
  // projected back over the website's edit.
  const lengthDays = Math.max(1, Math.trunc(numberOrNull(trip.durationDays) ?? 1));
  const lengthNights = Math.max(0, Math.trunc(numberOrNull(trip.durationNights) ?? Math.max(0, lengthDays - 1)));
  const extra = {
    duration_days: lengthDays,
    // Never as many nights as days: the save refuses that pair, and the website edit would not land at all.
    duration_nights: lengthNights < lengthDays ? lengthNights : null,
    website_summary: text(trip.summary),
    included_items: strings(trip.included),
    excluded_items: strings(trip.excluded),
    important_notes: strings(trip.importantNotes),
    departure_rule: text(trip.departureRule),
    itinerary_days: itinerary,
    customer_visible: trip.isPublished !== false,
    website_departure_availability: departures
      .map(departure => {
        const date = dateKey(departure.startDate);
        return date ? {
          date,
          status: availabilityStatus(departure.status),
          seatsLeft: numberOrNull(departure.seatsLeft),
        } : null;
      })
      .filter((value): value is NonNullable<typeof value> => Boolean(value)),
    // A source with hotel/package pricing is richer than the website's simple
    // scalar editor. Preserve it; otherwise capture per-date website prices.
    price_groups: owns(metadata, "price_groups") || priceGroups.length ? priceGroups : simpleDepartureGroups,
    ...(Array.isArray(metadata.hotel_profiles) ? { hotel_profiles: metadata.hotel_profiles } : {}),
    ...(Array.isArray(metadata.hotel_links) ? { hotel_links: metadata.hotel_links } : {}),
    ...(owns(metadata, "age_rules")
      ? { age_rules: record(metadata.age_rules) }
      : {}),
  };

  const fields: TripMutationFields = {
      operator_name: text(priorSource.operator_name) || "UUDAM TRAVEL AGENCY",
      route_name: text(trip.title),
      duration_text: durationText(trip.durationDays, trip.durationNights),
      adult_price: fareOrNull(trip.price, trip.currency),
      child_price: fareOrNull(trip.childPrice, trip.currency, "child"),
      infant_price: fareOrNull(trip.infantPrice, trip.currency, "infant"),
      currency: text(trip.currency).toUpperCase() || "MNT",
      departure_dates: uniqueDates,
      has_food: typeof trip.foodIncluded === "boolean" ? trip.foodIncluded : null,
      status: trip.isPublished === false ? "draft" : "active",
      notes: text(trip.description),
      hotel: text(trip.hotel),
      photo_urls: photos,
      extra,
  };
  // Missing properties are not removals. The website can send only the fields
  // changed in this save, including an explicit empty string/list or false.
  const direct: Record<string, string[]> = {
    route_name: ["title"], duration_text: ["durationDays", "durationNights"],
    adult_price: ["price"], child_price: ["childPrice"], infant_price: ["infantPrice"],
    currency: ["currency"], departure_dates: ["departures"], has_food: ["foodIncluded"],
    status: ["isPublished"], notes: ["description"], hotel: ["hotel"], photo_urls: ["image", "extraImages"],
  };
  for (const [key, sources] of Object.entries(direct)) {
    if (!sources.some(source => owns(trip, source))) delete (fields as UnknownRecord)[key];
  }
  const structured: Record<string, string> = {
    duration_days: "durationDays", duration_nights: "durationNights",
    website_summary: "summary", included_items: "included", excluded_items: "excluded", important_notes: "importantNotes",
    departure_rule: "departureRule", itinerary_days: "itinerary", customer_visible: "isPublished", website_departure_availability: "departures",
  };
  for (const [key, source] of Object.entries(structured)) {
    if (!owns(trip, source)) delete (extra as UnknownRecord)[key];
  }
  if (!owns(trip, "departures") && !owns(metadata, "price_groups")) delete (extra as UnknownRecord).price_groups;
  if (!Object.keys(extra).length) delete fields.extra;
  return { sourceTripId, fields };
}

/** Canonical fields (or conflict paths) each website field writes. */
const WEBSITE_FIELD_TARGETS: Record<string, string[]> = {
  title: ["route_name"], description: ["notes"], hotel: ["hotel"], currency: ["currency"],
  price: ["adult_price"], childPrice: ["child_price", "extra.child_rules"], infantPrice: ["infant_price", "extra.child_rules"],
  durationDays: ["duration_text", "extra.duration_days"], durationNights: ["duration_text", "extra.duration_nights"], foodIncluded: ["has_food"],
  isPublished: ["status", "extra.customer_visible"], image: ["photo_urls"], extraImages: ["photo_urls"],
  departures: ["departure_dates", "extra.website_departure_availability", "extra.price_groups", "departure."],
  summary: ["extra.website_summary"], included: ["extra.included_items"], excluded: ["extra.excluded_items"],
  importantNotes: ["extra.important_notes"], departureRule: ["extra.departure_rule"], itinerary: ["extra.itinerary_days"],
  "sourceMetadata.price_groups": ["extra.price_groups", "departure."], "sourceMetadata.age_rules": ["extra.age_rules"],
  "sourceMetadata.hotel_profiles": ["extra.hotel_profiles"], "sourceMetadata.hotel_links": ["extra.hotel_links"],
};

export type SharedConflict = { field: string; chatbot: unknown; website: unknown; base: unknown; at?: string };
export type WebsiteTripPatchReport = {
  fields: TripMutationFields;
  /** Canonical paths this save changed ("route_name", "extra.included_items"). */
  applied: string[];
  /** Conflicts this save recorded; earlier ones are not repeated. */
  conflicts: SharedConflict[];
  /** Website fields the save changed that the canonical record did not take. */
  ignored: Array<{ field: string; reason: string }>;
};

/** A reverse sync is a three-way edit, never a replacement of a stale snapshot. */
export function websiteTripPatch(input: unknown, previousInput: unknown, canonicalInput: unknown): TripMutationFields {
  return websiteTripPatchReport(input, previousInput, canonicalInput).fields;
}

/**
 * websiteTripPatch plus an account of every website field the save changed:
 * applied, recorded as a conflict, already equal, or ignored with a reason.
 * `changedFields` is the website's own list of fields its staff edited; with
 * it, a field that silently produced nothing is reported instead of read as a
 * successful sync (a Чунчин title edit was lost that way on 2026-10-16).
 */
export function websiteTripPatchReport(input: unknown, previousInput: unknown, canonicalInput: unknown, changedFields?: readonly string[]): WebsiteTripPatchReport {
  validateWebsiteTripPayload(input);
  const canonical = record(canonicalInput);
  const canonicalExtra = record(canonical.extra);
  const incoming = record(input);
  const sourceTripId = websiteTripSourceId(input);
  if (text(canonical.id) && text(canonical.id) !== sourceTripId) throw new WebsiteTripPayloadError("Canonical trip identity does not match");
  const previous = record(previousInput);
  if (Object.keys(previous).length && websiteTripSourceId(previous) !== sourceTripId) throw new WebsiteTripPayloadError("Previous trip identity does not match");
  const baselineSource = record(record(incoming.sourceMetadata).connectedSource);
  if (text(baselineSource.id) && text(baselineSource.id) !== sourceTripId) throw new WebsiteTripPayloadError("Source snapshot identity does not match");
  // Coupled controls (cover/gallery, day/night counts and currency/fares) need
  // the unchanged half from the saved website snapshot, not an invented default.
  const currentDuration = duration(text(canonical.duration_text));
  const nextInput = {
    currency: canonical.currency,
    durationDays: currentDuration.days,
    durationNights: currentDuration.nights,
    ...previous,
    ...incoming,
    sourceMetadata: { ...record(previous.sourceMetadata), ...record(incoming.sourceMetadata) },
  };
  if (!owns(incoming, "durationDays") && !owns(incoming, "durationNights") && !owns(previous, "durationDays") && !owns(previous, "durationNights")) {
    delete (nextInput as UnknownRecord).durationDays;
    delete (nextInput as UnknownRecord).durationNights;
  }
  if (owns(incoming, "durationDays") !== owns(incoming, "durationNights") && !text(canonical.duration_text) && !owns(previous, "durationDays") && !owns(previous, "durationNights")) {
    throw new WebsiteTripPayloadError("The unchanged duration field is unavailable");
  }
  const currentPhotos = strings(canonical.photo_urls);
  if (owns(incoming, "image") && !owns(incoming, "extraImages") && !owns(previous, "extraImages")) (nextInput as UnknownRecord).extraImages = currentPhotos.slice(1);
  if (owns(incoming, "extraImages") && !owns(incoming, "image") && !owns(previous, "image")) (nextInput as UnknownRecord).image = currentPhotos[0] || "";
  // Both readings of the itinerary find each day in the website copy this save replaced (by
  // ItineraryDay id), so its meal states are the ones of the day it was, not of its new number.
  const previousItinerary = Array.isArray(previous.itinerary) ? previous.itinerary : undefined;
  const next = mapWebsiteTrip(nextInput, previousItinerary).fields;
  if (!owns(incoming, "currency") && !owns(previous, "currency")) delete next.currency;
  const before = Object.keys(previous).length ? mapWebsiteTrip(previous, previousItinerary).fields : null;
  const baselineExtra = record(baselineSource.extra);
  const conflicts = (Array.isArray(canonicalExtra.shared_conflicts) ? [...canonicalExtra.shared_conflicts] : []) as SharedConflict[];
  const priorConflicts = conflicts.length;
  const recordedAt = new Date().toISOString();
  const addConflict = (conflict: SharedConflict) => {
    if (!conflicts.some((entry) => sameConflict(entry, conflict))) conflicts.push({ ...conflict, at: recordedAt });
  };
  const fields: TripMutationFields = {};
  const extra: UnknownRecord = {};
  const accept = (path: string, current: unknown, base: unknown, incoming: unknown, set: () => void) => {
    if (sameParityValue(current, incoming)) return;
    if (sameParityValue(current, base)) { set(); return; }
    addConflict({ field: path, chatbot: current ?? null, website: incoming ?? null, base: base ?? null });
  };
  // While the canonical notes are empty the website shows the poster subtitle
  // (or the title) as its description, so that is what a website edit replaced.
  // Comparing against the empty notes turned every description edit on such a
  // trip into a conflict.
  const descriptionFallbacks = [text(record(baselineSource.poster).subtitle), text(canonical.route_name), text(baselineSource.route_name)].filter(Boolean);
  // The website's schedule could not be taken because the chatbot keeps this trip's dates as a rule.
  let scheduleIsRule = false;
  for (const [key, value] of Object.entries(next)) {
    if (key === "extra" || key === "operator_name") continue;
    if (sameParityValue(canonical[key], value)) continue;
    if (key === "status" && !["draft", "archived"].includes(String(canonical.status))) continue;
    if (before && sameParityValue(value, before[key as keyof TripMutationFields])) continue;
    const baseValue = before ? before[key as keyof TripMutationFields] : baselineSource[key];
    if (key === "departure_dates") {
      // The chatbot writes its dates as Mongolian text ("10 сарын 8"), the website as
      // calendar days. Compared as text, a date added on the website turned into a
      // conflict on every trip spelt that way, and the bot never offered the new date.
      // Days are compared; the chatbot's spelling is kept for days both still have.
      const today = mongoliaToday();
      const current = scheduleDays(canonical.departure_dates, canonicalExtra.departure_dates_resolved);
      const incoming = scheduleDays(value, null);
      const base = scheduleDays(baseValue, canonicalExtra.departure_dates_resolved);
      if (!current || !incoming) { scheduleIsRule = true; continue; }
      const [currentDays, incomingDays] = [futureDays(current, today), futureDays(incoming, today)];
      if (sameDays(currentDays, incomingDays)) continue;
      const baseDays = base ? futureDays(base, today) : null;
      if (baseDays && sameDays(baseDays, incomingDays)) continue;
      if (baseDays && sameDays(currentDays, baseDays)) {
        // Only the website changed the schedule: past entries stay as they are, days it
        // still has keep the chatbot's wording, new days are added as calendar days.
        const kept = [...current.entries()].filter(([day]) => day < today).map(([, spelling]) => spelling);
        Object.assign(fields, { departure_dates: [...kept, ...incomingDays.map((day) => current.get(day) ?? day)] });
        continue;
      }
      accept(key, currentDays, baseDays ?? baseValue, incomingDays, () => Object.assign(fields, { [key]: value }));
      continue;
    }
    if (key === "duration_text" && sameParityValue(duration(String(canonical[key] || "")), duration(String(baseValue || "")))) {
      Object.assign(fields, { [key]: value }); continue;
    }
    // Empty notes are the fallback text the website was showing.
    const current = key === "notes" && !text(canonical.notes) && descriptionFallbacks.some((shown) => sameParityValue(baseValue, shown)) ? baseValue : canonical[key];
    accept(key, current, baseValue, value,
      () => Object.assign(fields, { [key]: value }));
  }
  // The trip's departures after this save; a website fare for any other date creates nothing.
  const liveDates = new Set([...(next.departure_dates ?? []), ...strings(canonical.departure_dates)].map(dateKey).filter(Boolean));
  let fareDates = new Set<string>();
  let priceGroupsMerged = false;
  for (const [key, value] of Object.entries(next.extra || {})) {
    if (before && sameParityValue(value, before.extra?.[key])) continue;
    // Seats and sold-out states belong to the website (bookings decrement them
    // there); the canonical copy only mirrors them, so it never conflicts.
    if (key === "website_departure_availability") { extra[key] = value; continue; }
    const base = before?.extra && owns(before.extra, key) ? before.extra[key] : baselineExtra[key];
    // The length numbers follow a website length edit the way duration_text does: taken when the
    // chatbot's own number is unset or unchanged since the website's base; otherwise a conflict.
    if ((key === "duration_days" || key === "duration_nights") && (canonicalExtra[key] == null || sameParityValue(canonicalExtra[key], base))) {
      extra[key] = value;
      continue;
    }
    // Per-date fares merge one date and option at a time (websiteDateFares.ts); the two
    // stores never hold identical lists, so a whole-list comparison always conflicted.
    // A chatbot record with no fare table yet is the simplest case of the same merge:
    // nothing on its side to overwrite, so the website's per-date fares are adopted.
    // Compared as whole lists instead, every date or fare edit on such a trip became an
    // "extra.price_groups" conflict and the edit never reached the bot.
    if (key === "price_groups" && Array.isArray(value) && value.length) {
      const merge = mergeWebsiteDateFares(canonicalExtra.price_groups ?? [], base, value, liveDates);
      // Whatever the cells said, the two lists are never compared whole: a label, an
      // ordering or a website-only key is not a fare, and comparing the lists as one
      // value recorded an "extra.price_groups" conflict that then blocked every later
      // fare save on the trip as "open_conflict" (2026-11-03).
      fareDates = merge.dates;
      priceGroupsMerged = true;
      if (merge.groups) extra.price_groups = merge.groups;
      merge.conflicts.forEach(addConflict);
      continue;
    }
    if (key === "itinerary_days" && before && Array.isArray(value)) {
      // Meals compare in three states: read as booleans, a chatbot "not stated" -> "not included"
      // edit looked unchanged and the website's copy silently put "not stated" back.
      const facts = (raw: unknown) => (Array.isArray(raw) ? raw : []).map((item, index) => {
        const day = record(item), meals = record(day.meals);
        return { day: Number(day.day) || index + 1, title: text(day.title), description: text(day.description), hotel: text(day.hotel),
          meals: { breakfast: mealStateOf(meals.breakfast), lunch: mealStateOf(meals.lunch), dinner: mealStateOf(meals.dinner) } };
      });
      if (sameParityValue(facts(canonicalExtra[key]), facts(base)) || sameParityValue(facts(canonicalExtra[key]), facts(value))) {
        const previousDays = Array.isArray(previous.itinerary) ? previous.itinerary.map(record) : [];
        const incomingDays = Array.isArray(record(input).itinerary) ? record(input).itinerary as unknown[] : [];
        const canonicalDays = Array.isArray(canonicalExtra[key]) ? canonicalExtra[key] as unknown[] : [];
        extra[key] = value.map((item, index) => {
          const day = record(item), incomingDay = record(incomingDays[index]);
          const oldIndex = previousWebsiteDayIndex(incomingDay, index, previousDays);
          const oldDay = previousDays[oldIndex], canonicalDay = record(canonicalDays[oldIndex]);
          const merged = { ...canonicalDay, ...day };
          if (oldDay && sameParityValue(oldDay.image, incomingDay.image)) {
            if (canonicalDay.photo) merged.photo = canonicalDay.photo;
            else delete merged.photo;
          } else if (oldDay && !sameParityValue(canonicalDay.photo, oldDay.image) && !sameParityValue(canonicalDay.photo, incomingDay.image)) {
            accept(`extra.itinerary_days.${index + 1}.photo`, canonicalDay.photo, oldDay.image, incomingDay.image, () => {});
            if (canonicalDay.photo) merged.photo = canonicalDay.photo;
            else delete merged.photo;
          }
          return merged;
        });
        continue;
      }
    }
    accept(`extra.${key}`, key === "customer_visible" ? canonicalExtra[key] !== false : canonicalExtra[key], base, value, () => { extra[key] = value; });
  }
  const manual = record(record(record(input).sourceMetadata).canonicalExtraPatch);
  const manualBase = record(manual.base);
  for (const [key, value] of Object.entries(record(manual.values))) {
    if (!["aliases", "booking_terms", "discounts", "extra_fees", "room_prices", "answer_hints", "review_reasons", "customer_visible", "needs_human_review", "transport_type", "destinations"].includes(key)) continue;
    accept(`extra.${key}`, canonicalExtra[key], manualBase[key], value, () => { extra[key] = value; });
  }
  // Fares a consultant typed for single departures on the website (2026-10-30: every one was
  // dropped, because the projection writes `price_groups` into every trip's metadata — often an
  // empty list — and owning the key read as hotel/package pricing).
  // - A trip with hotel/package pricing keeps it over the website's single fare per departure
  //   (which package a single fare belongs to is the owner's call): the typed fare is recorded
  //   as a visible conflict beside the package fares for that date, never dropped silently.
  // - A trip without such pricing takes the typed fare as that date's fare, as mapWebsiteTrip
  //   does for trips whose metadata has no price groups; a fare left empty is the trip's own.
  const nextMetadata = record(nextInput.sourceMetadata);
  const metadataGroups = nextMetadata.price_groups;
  const sourceGroups = record(record(nextMetadata.connectedSource).extra).price_groups;
  const packagePriced = (Array.isArray(metadataGroups) && metadataGroups.length > 0) || (Array.isArray(sourceGroups) && sourceGroups.length > 0);
  if (!packagePriced && owns(nextMetadata, "price_groups") && !owns(record(incoming.sourceMetadata), "price_groups")
    && owns(incoming, "departures") && Array.isArray(incoming.departures)) {
    const base = {
      adult_price: numberOrNull(fields.adult_price ?? canonical.adult_price),
      child_price: numberOrNull(fields.child_price ?? canonical.child_price),
      infant_price: numberOrNull(fields.infant_price ?? canonical.infant_price),
    };
    const perDate = currentWebsiteDepartureRows(incoming.departures.map(record)).flatMap((row) => {
      const date = dateKey(row.startDate);
      const typed = { adult_price: numberOrNull(row.price), child_price: numberOrNull(row.childPrice), infant_price: numberOrNull(row.infantPrice) };
      const differs = (Object.keys(typed) as Array<keyof typeof typed>).some((key) => typed[key] !== null && typed[key] !== base[key]);
      return date && differs ? [{ dates: [date], adult_price: typed.adult_price ?? base.adult_price,
        child_price: typed.child_price ?? base.child_price, infant_price: typed.infant_price ?? base.infant_price }] : [];
    });
    const current = Array.isArray(canonicalExtra.price_groups) ? canonicalExtra.price_groups : [];
    if (!sameParityValue(perDate, current)) extra.price_groups = perDate;
  }
  if (packagePriced && owns(incoming, "departures") && Array.isArray(incoming.departures)) {
    const savedRows = Array.isArray(previous.departures) ? currentWebsiteDepartureRows(previous.departures.map(record)) : [];
    const saved = new Map(savedRows.map((row) => [dateKey(row.startDate), row]));
    const groups = (Array.isArray(canonicalExtra.price_groups) ? canonicalExtra.price_groups : []).map(record);
    for (const row of currentWebsiteDepartureRows(incoming.departures.map(record))) {
      const date = dateKey(row.startDate);
      // The date-pricing editor writes each fare into the row too; its price groups already settled it.
      if (!date || fareDates.has(date)) continue;
      for (const fare of ["price", "childPrice", "infantPrice"] as const) {
        if (!owns(row, fare)) continue;
        const typed = numberOrNull(row[fare]);
        const before = saved.has(date) ? numberOrNull(saved.get(date)![fare]) : null;
        if (typed === null || sameParityValue(typed, before)) continue;
        const priceKey = fare === "price" ? "adult_price" : fare === "childPrice" ? "child_price" : "infant_price";
        const forDate = groups.filter((group) => [...strings(group.dates), ...strings(group.date_keys)].includes(date))
          .map((group) => ({ label: text(group.label) || text(group.hotel) || "Үнэ", [priceKey]: group[priceKey] ?? null }));
        addConflict({ field: `departure.${date}.${fare}`, chatbot: forDate, website: typed, base: before });
      }
    }
  }
  // A free (0) child/infant fare is only read as free beside its "Үнэгүй" rule.
  for (const kind of ["child", "infant"] as const) {
    const key = kind === "child" ? "child_price" : "infant_price";
    if (!owns(fields, key)) continue;
    const rules = owns(extra, "child_rules") ? extra.child_rules : canonicalExtra.child_rules;
    const updated = withBaseFreeFareRule(rules, kind, fields[key] === 0);
    if (!sameParityValue(updated, Array.isArray(rules) ? rules : [])) extra.child_rules = updated;
  }
  if (!sameParityValue(conflicts, canonicalExtra.shared_conflicts || [])) extra.shared_conflicts = conflicts;
  for (const [key, value] of Object.entries(extra)) {
    if (sameParityValue(value, canonicalExtra[key])) delete extra[key];
  }
  if (Object.keys(extra).length) fields.extra = extra;

  const applied = [
    ...Object.keys(fields).filter((key) => key !== "extra"),
    ...Object.keys(extra).filter((key) => key !== "shared_conflicts").map((key) => `extra.${key}`),
  ];
  const recorded = conflicts.slice(priorConflicts);
  const ignored: WebsiteTripPatchReport["ignored"] = [];
  for (const field of changedFields || []) {
    const targets = WEBSITE_FIELD_TARGETS[field];
    if (!targets) continue;
    const fare = field === "price" ? "adult" : field === "childPrice" ? "child" : field === "infantPrice" ? "infant" : null;
    if (fare && droppedFare(incoming[field], nextInput.currency, fare)) {
      ignored.push({ field, reason: "fare_below_1000" });
      continue;
    }
    const landed = targets.some((target) => {
      if (applied.includes(target) || recorded.some((conflict) => conflict.field === target || conflict.field.startsWith(target))) return true;
      // The fare table was merged cell by cell: every fare this save typed was applied,
      // recorded as a conflict above, or already the chatbot's own value.
      if (target === "extra.price_groups" && priceGroupsMerged) return true;
      // Already the canonical value (an earlier delivery, or both sides agree).
      const nextValue = target.startsWith("extra.") ? (next.extra as UnknownRecord | undefined)?.[target.slice(6)] : next[target as keyof TripMutationFields];
      const current = target.startsWith("extra.") ? canonicalExtra[target.slice(6)] : canonical[target];
      return nextValue !== undefined && sameParityValue(current, nextValue);
    });
    // Seats and statuses of a rule-scheduled trip still land; the website's new or
    // removed days do not, and staff must hear that even though part of the save did.
    if (field === "departures" && scheduleIsRule) {
      ignored.push({ field, reason: "recurring_schedule" });
      continue;
    }
    if (landed) continue;
    // Blocked by a disagreement recorded by an earlier save, still unresolved.
    if (conflicts.some((conflict) => targets.some((target) => conflict.field === target || conflict.field.startsWith(target)))) {
      ignored.push({ field, reason: "open_conflict" });
    } else ignored.push({ field, reason: "not_applied" });
  }
  return { fields, applied, conflicts: recorded, ignored };
}

/** Same disagreement, whenever it was recorded. */
export function sameConflict(left: unknown, right: unknown): boolean {
  const a = record(left), b = record(right);
  return sameParityValue([a.field, a.chatbot ?? null, a.website ?? null, a.base ?? null], [b.field, b.chatbot ?? null, b.website ?? null, b.base ?? null]);
}
