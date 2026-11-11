/**
 * Canonical shape for the `extra` JSONB column on travel_trip_entries.
 *
 * Every write path (upsertTrip, patchTrip, trips-bulk) runs the incoming
 * extra blob through `normalizeExtra()` before it hits the database.  This
 * catches AI key-name drift (e.g. "departureGroups" instead of
 * "departure_date_groups"), coerces types, and auto-regenerates date_keys so
 * the bot's lookup never silently reads an empty array.
 */

import { generateDateKeys } from "./travelDates";
import { normalizePriceRange } from "./priceRange";

// ─── known keys ──────────────────────────────────────────────────────────────

import { isTransportType } from "./tripTransitDays";

const KNOWN_EXTRA_KEYS = new Set([
  "aliases",
  "price_groups",
  "discounts",
  "departure_date_groups", // legacy key emitted by older extraction prompts
  "child_rules",
  "extra_fees",
  "departure_rule",
  "recurring_schedule",
  "included_items",
  "excluded_items",
  "room_prices",
  "important_notes",
  "brochure_pdf_url",
  "source_file_name",
  "source_file_attachment_id",
  "original_title_text",
  "customer_visible",
  "source_provenance",
  "answer_hints",
  "needs_human_review",
  "review_reasons",
  "booking_terms",
  "departure_dates_resolved",
  "itinerary_days",
  "age_rules",
  "marketing_badge",
  "website_summary",
  // Set by the file-to-trip pipeline (tripProposalFinalize.ts) and the poster mapper.
  "transport_type",
  "duration_days",
  "duration_nights",
  "destinations",
  "photo_credits",
  "website_details_patch",
  // Hotels a trip stays at (name, link, photos, description) and the packages its price rows sell.
  // Each is written only when the input carries it, so a trip without them stays without them.
  "hotel_profiles",
  "hotel_links",
  "package_options",
  // The partner page a trip was made from (assistant link → new trip) and when it was read;
  // the partner watch (src/lib/partnerWatch) checks that page again.
  "source_url",
  "source_checked_at",
]);

/**
 * Display values the admin trips API adds to `extra` on every read (website
 * delivery state, the linked poster's photo count). They are recomputed each
 * time, so a client that sends a trip's extra back must never store them: a
 * stored copy goes stale and the completeness check would trust it.
 */
const DERIVED_EXTRA_KEYS = new Set(["website_sync", "poster_photo_count", "list_projection"]);

// ─── helpers ─────────────────────────────────────────────────────────────────

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim() !== "");
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return null;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function clampPercent(value: number | null): number | null {
  if (value == null) return null;
  return Math.max(0, Math.min(100, value));
}

function enrichDateKeys<T extends Record<string, unknown>>(group: T): T {
  const dates = asStringArray(group.dates);
  const existing = asStringArray(group.date_keys);
  const all = new Set<string>(existing);
  for (const d of dates) {
    for (const k of generateDateKeys(d)) all.add(k);
  }
  const displayDates = asStringArray(group.display_dates).length > 0
    ? asStringArray(group.display_dates)
    : dates;
  return { ...group, date_keys: Array.from(all), display_dates: displayDates };
}

/**
 * Per-row availability. A partner row always states it (the partner sync writes both keys); any
 * other row keeps a status or seat count only when it has one, so a row without them is unchanged.
 */
function priceRowAvailability(g: Record<string, unknown>): Record<string, unknown> {
  if (g.partner_source === true) {
    return { partner_source: true, status: asString(g.status), seats_left: asNumberOrNull(g.seats_left) };
  }
  const status = asString(g.status).trim();
  const seats = asNumberOrNull(g.seats_left);
  return {
    ...(status ? { status } : {}),
    ...(seats != null && seats >= 0 ? { seats_left: seats } : {}),
  };
}

/**
 * Which hotel a row is: `hotel_id` is the hotel's stable identity (the resolver and the validator
 * key on it before the name) and `hotel_profile_ids` the hotel profiles it stays at.
 */
function priceRowHotel(g: Record<string, unknown>): Record<string, unknown> {
  const hotel = asString(g.hotel).trim();
  const hotelId = asString(g.hotel_id).trim();
  const profileIds = [...new Set(asStringArray(g.hotel_profile_ids).map((id) => id.trim()))];
  return {
    ...(hotel ? { hotel } : {}),
    ...(hotelId ? { hotel_id: hotelId } : {}),
    ...(profileIds.length ? { hotel_profile_ids: profileIds } : {}),
  };
}

function normalizePriceGroups(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) =>
      enrichDateKeys({
        label: asString(g.label),
        ...priceRowAvailability(g),
        ...priceRowHotel(g),
        ...(asString(g.package_id || g.package).trim()
          ? { package_id: asString(g.package_id || g.package).trim() }
          : {}),
        dates: asStringArray(g.dates),
        display_dates: asStringArray(g.display_dates),
        date_keys: asStringArray(g.date_keys),
        adult_price: asNumberOrNull(g.adult_price),
        ...(normalizePriceRange(g.adult_price_range)
          ? { adult_price_range: normalizePriceRange(g.adult_price_range) }
          : {}),
        child_price: asNumberOrNull(g.child_price),
        infant_price: asNumberOrNull(g.infant_price),
        child_age: asString(g.child_age),
        infant_age: asString(g.infant_age),
        passenger_prices: normalizePassengerPrices(g.passenger_prices),
        ...(asNumberOrNull(g.single_price) != null ? { single_price: asNumberOrNull(g.single_price) } : {}),
        // A documented free child/infant fare (the website writes these for a 0₮ fare).
        ...(g.child_price_free === true ? { child_price_free: true } : {}),
        ...(g.infant_price_free === true ? { infant_price_free: true } : {}),
        note: asString(g.note || g.notes),
      }),
    );
}

function normalizeDiscountGroups(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === "object")
    .map((g) =>
      enrichDateKeys({
        label: asString(g.label),
        ...(asString(g.package_id || g.package).trim()
          ? { package_id: asString(g.package_id || g.package).trim() }
          : {}),
        dates: asStringArray(g.dates),
        display_dates: asStringArray(g.display_dates),
        date_keys: asStringArray(g.date_keys),
        adult_price: asNumberOrNull(g.adult_price),
        child_price: asNumberOrNull(g.child_price),
        infant_price: asNumberOrNull(g.infant_price),
        condition: asString(g.condition),
        note: asString(g.note || g.notes),
      }),
    );
}

function normalizeDepartureDateGroups(raw: unknown): Record<string, unknown>[] {
  // Legacy format: same shape as price_groups but stored under "departure_date_groups", so it is
  // normalised by the same rules. It used to keep only the flat fares, which silently dropped the
  // child/infant bands, hotel, package and single-room price a file reading put here.
  return normalizePriceGroups(raw);
}

function normalizePassengerPrices(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      label: asString(p.label),
      age_range: asString(p.age_range),
      price: asNumberOrNull(p.price),
      currency: asString(p.currency, "MNT"),
      // "Үнэгүй" marks this band as a documented free fare, not merely 0 —
      // see isDocumentedFreeFare, which reads this exact field. Dropped here
      // once already (silently, since this whitelist predates that feature),
      // which let a real free-fare save regress back to "missing data".
      note: asString(p.note),
    }));
}

function normalizeChildRules(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      label: asString(r.label),
      age_range: asString(r.age_range),
      price: asNumberOrNull(r.price),
      currency: asString(r.currency, "MNT"),
      note: asString(r.note || r.notes),
    }));
}

function normalizeExtraFees(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
    .map((f) => ({
      label: asString(f.label),
      amount: asNumberOrNull(f.amount),
      currency: asString(f.currency, "MNT"),
      applies_to: asString(f.applies_to),
      note: asString(f.note || f.notes),
    }));
}

function normalizeRoomPrices(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      room_type: asString(r.room_type),
      price: asNumberOrNull(r.price),
      currency: asString(r.currency, "MNT"),
      note: asString(r.note || r.notes),
    }));
}

function normalizeSourceProvenance(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object")
    .map((p) => ({
      file_name: asString(p.file_name),
      page: asNumberOrNull(p.page),
      source_text: asString(p.source_text),
      confidence: ["high", "medium", "low"].includes(asString(p.confidence))
        ? asString(p.confidence)
        : "medium",
    }));
}

/**
 * Booking terms a hot buyer asks before committing: deposit, payment method/
 * timing, required documents, visa requirement, cancellation/refund policy.
 * Freeform Mongolian strings (kept simple for the admin editor and the bot).
 * Absent/empty fields mean "unknown" — the bot REFERs rather than inventing.
 */
function normalizeBookingTerms(raw: unknown): Record<string, string> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    deposit: asString(src.deposit).trim(),
    payment: asString(src.payment).trim(),
    documents: asString(src.documents).trim(),
    visa: asString(src.visa).trim(),
    cancellation: asString(src.cancellation).trim(),
  };
}

/**
 * Write-time resolved departure dates: [{ text, ymd|null }]. Frozen ISO dates
 * so reads never re-guess the year. Coerces loosely and drops malformed rows.
 */
function normalizeResolvedDepartureDates(raw: unknown): Array<{ text: string; ymd: string | null }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ text: string; ymd: string | null }> = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const text = asString(rec.text);
    if (!text) continue;
    const ymd = typeof rec.ymd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rec.ymd) ? rec.ymd : null;
    out.push({ text, ymd });
  }
  return out;
}

/**
 * Day-by-day itinerary rows, editable in the trip form's own "Хөтөлбөр" tab
 * and mirrored onto the poster (tripToPoster in connectedTripMapping.ts).
 * Unlike posterItineraryDays() in poster/db.ts (which drops blank days —
 * that direction reads messy AI-extracted poster data), this normalizer
 * keeps blank rows: they are admin-authored, deliberate, and dropping a row
 * mid-edit would be confusing UX. Day numbers are always derived from array
 * position, never trusted from the input, matching the poster's own
 * normalizeTripData() renumbering convention.
 */
function normalizeItineraryDays(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
    .map((d, index) => {
      const title = asString(d.title);
      const description = asString(d.description);
      const hotel = asString(d.hotel);
      const photo = asString(d.photo).trim();
      const mealsRaw = d.meals && typeof d.meals === "object" ? (d.meals as Record<string, unknown>) : {};
      const mealNote = asString(d.meal_note).trim();
      // null = the source does not say whether the meal is included. It used to be
      // coerced to false, which turned "not stated" into "not included" on save; a
      // meal key that is missing altogether says nothing either (Boolean(undefined)
      // saved it as "not included"). Only an explicit false is "not included".
      const meal = (value: unknown) => (value === null || value === undefined ? null : Boolean(value));
      return {
        day: index + 1,
        title,
        description,
        ...(hotel ? { hotel } : {}),
        ...(photo.startsWith("https://") ? { photo } : {}),
        meals: {
          breakfast: meal(mealsRaw.breakfast),
          lunch: meal(mealsRaw.lunch),
          dinner: meal(mealsRaw.dinner),
        },
        ...(mealNote ? { meal_note: mealNote.slice(0, 300) } : {}),
      };
    });
}

export type StatedDayMeals = { breakfast: boolean | null; lunch: boolean | null; dinner: boolean | null };

/**
 * Before 2026-11 every meal a source did not state was saved as false, so a stored false
 * is not reliable on its own. A day whose three meals are all false and that has no meal
 * note is that legacy shape (live: 55 such days on 28 of 36 active trips), not a program
 * that says "no meals". A meal note ("хоол өөрийн зардлаар") makes it a stated fact.
 */
export function legacyUnstatedMeals(meals: unknown, mealNote?: unknown): boolean {
  const day = meals && typeof meals === "object" && !Array.isArray(meals) ? (meals as Record<string, unknown>) : {};
  return day.breakfast === false && day.lunch === false && day.dinner === false
    && !(typeof mealNote === "string" && mealNote.trim());
}

/**
 * A day's meals as its program states them: true included, false not included, null not
 * stated. The legacy all-false day reads as not stated; a day with some meals true and some
 * false keeps its false (the program listed some meals and not others). Every reader that
 * says "not included" (the website's ✗, the AI catalogue) goes through this one rule.
 */
export function statedDayMeals(meals: unknown, mealNote?: unknown): StatedDayMeals {
  if (legacyUnstatedMeals(meals, mealNote)) return { breakfast: null, lunch: null, dinner: null };
  const day = meals && typeof meals === "object" && !Array.isArray(meals) ? (meals as Record<string, unknown>) : {};
  const state = (value: unknown) => (value === true ? true : value === false ? false : null);
  return { breakfast: state(day.breakfast), lunch: state(day.lunch), dinner: state(day.dinner) };
}

/** An ISO date-time ("2026-11-11T06:00:00.000Z"), or "" for anything else. */
function isoTimestamp(value: unknown): string {
  const text = asString(value).trim();
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : "";
}

/**
 * A hotel link a customer may be sent to, or a hotel photo: https only. The website's hotel cards,
 * the bot's hotel answer and the AI catalogue show nothing else, so an "http:" link (or
 * "javascript:", or bare text) kept here was silently invisible everywhere; it is refused at save
 * time instead, with a warning. The partner sync keeps staff photos by this same rule.
 */
export function httpsLink(value: unknown): string {
  const url = asString(value).trim();
  return /^https:\/\/[^\s]+$/i.test(url) ? url.slice(0, 1000) : "";
}

/**
 * The hotels a trip stays at, as the website's "Буудал" cards and the admin editor read them:
 * { id?, name, url, description, media: [{ url, caption }], stars? }. `id` is the stable key a
 * price row's `hotel_profile_ids` / `hotel_id` link to (the partner's own hotel id when it has one).
 * A profile without a name, a link that is not https and a photo without an https URL are dropped,
 * each with a warning.
 */
function normalizeHotelProfiles(raw: unknown[], warnings: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let dropped = 0;
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) { dropped++; continue; }
    const profile = item as Record<string, unknown>;
    const name = asString(profile.name).trim();
    if (!name) { dropped++; continue; }
    const url = httpsLink(profile.url);
    if (!url && asString(profile.url).trim()) warnings.push(`«${name}» буудлын холбоос https биш тул хасагдлаа`);
    const mediaRaw = Array.isArray(profile.media) ? profile.media : [];
    const media = mediaRaw.flatMap((entry) => {
      const value = typeof entry === "string" ? { url: entry } : entry && typeof entry === "object" ? entry as Record<string, unknown> : {};
      const mediaUrl = httpsLink((value as Record<string, unknown>).url);
      return mediaUrl ? [{ url: mediaUrl, caption: asString((value as Record<string, unknown>).caption).trim().slice(0, 200) }] : [];
    });
    if (media.length < mediaRaw.length) warnings.push(`«${name}» буудлын ${mediaRaw.length - media.length} зураг https URL-гүй тул хасагдлаа`);
    const id = asString(profile.id).trim();
    const stars = asNumberOrNull(profile.stars);
    out.push({
      ...(id ? { id } : {}),
      name,
      url,
      description: asString(profile.description).trim(),
      media,
      ...(stars != null && stars >= 1 && stars <= 7 ? { stars } : {}),
    });
  }
  if (dropped) warnings.push(`${dropped} буудлын мэдээлэл нэргүй тул хасагдлаа`);
  return out;
}

/** The older hotel name -> link list ({ name, url }); a row without both is dropped with a warning. */
function normalizeHotelLinks(raw: unknown[], warnings: string[]): Record<string, unknown>[] {
  const out = raw.flatMap((item) => {
    const link = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const name = asString(link.name).trim();
    const url = httpsLink(link.url);
    return name && url ? [{ name, url }] : [];
  });
  if (out.length < raw.length) warnings.push(`${raw.length - out.length} буудлын холбоос нэр эсвэл https URL-гүй тул хасагдлаа`);
  return out;
}

/**
 * The packages a trip's price rows sell ({ id, label, note }). A price row's `package_id` is one of
 * these ids; the label is what a customer reads (the id stands in when there is none).
 */
function normalizePackageOptions(raw: unknown[], warnings: string[]): Record<string, unknown>[] {
  const seen = new Set<string>();
  const out = raw.flatMap((item) => {
    const option = typeof item === "string" ? { id: item } : item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const label = asString(option.label).trim();
    const id = asString(option.id).trim() || label;
    if (!id || seen.has(id)) return [];
    seen.add(id);
    return [{ id, label: label || id, note: asString(option.note).trim() }];
  });
  if (out.length < raw.length) warnings.push(`${raw.length - out.length} багцын сонголт нэргүй эсвэл давхардсан тул хасагдлаа`);
  return out;
}

/** A list key is written only when the input has it; a value that is not a list is dropped with a warning. */
function optionalList(
  raw: Record<string, unknown>, key: string, warnings: string[],
  normalize: (items: unknown[], warnings: string[]) => Record<string, unknown>[],
): Record<string, unknown> {
  if (!(key in raw) || raw[key] === undefined) return {};
  if (!Array.isArray(raw[key])) {
    warnings.push(`${key} жагсаалт биш тул хадгалагдсангүй`);
    return {};
  }
  return { [key]: normalize(raw[key] as unknown[], warnings) };
}

function normalizeAnswerHints(raw: unknown): Record<string, unknown>[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is Record<string, unknown> => !!h && typeof h === "object")
    .map((h) => ({
      intent: ["price", "discount", "comparison", "child_price", "included", "schedule"].includes(
        asString(h.intent),
      )
        ? asString(h.intent)
        : "price",
      question_pattern: asString(h.question_pattern),
      expected_answer_summary: asString(h.expected_answer_summary),
    }));
}

// ─── public API ──────────────────────────────────────────────────────────────

export type NormalizeExtraResult = {
  extra: Record<string, unknown>;
  /** Human-readable warnings about keys or values that were coerced / dropped. */
  warnings: string[];
};

/**
 * Normalise a raw `extra` object before writing it to the database.
 *
 * - Canonicalises every known key (type coercion, array enforcement)
 * - Auto-generates date_keys for every price_group / discount / departure_date_group
 * - Collects unknown keys into warnings so the admin can be alerted
 * - Preserves unknown top-level keys that were already in the DB (pass-through)
 *   so existing data is never silently dropped — just warned about
 */
export function normalizeExtra(
  raw: Record<string, unknown>,
): NormalizeExtraResult {
  const warnings: string[] = [];

  // Detect unknown keys from AI output
  const unknownKeys = Object.keys(raw).filter((k) => !KNOWN_EXTRA_KEYS.has(k) && !DERIVED_EXTRA_KEYS.has(k));
  if (unknownKeys.length > 0) {
    warnings.push(`Үл мэдэгдэх extra талбарууд (хадгалагдах боловч шалгана уу): ${unknownKeys.join(", ")}`);
  }

  const priceGroups = normalizePriceGroups(raw.price_groups);
  const discounts = normalizeDiscountGroups(raw.discounts);
  const departureDateGroups = normalizeDepartureDateGroups(raw.departure_date_groups);

  // Warn if the legacy departure_date_groups key appears without price_groups
  if (departureDateGroups.length > 0 && priceGroups.length === 0) {
    warnings.push(
      `departure_date_groups-ийг price_groups болгон хөрвүүлсэн (${departureDateGroups.length} бүлэг) — шалгана уу`,
    );
  }

  // Use price_groups as canonical; merge departure_date_groups in if price_groups is empty
  const canonicalPriceGroups =
    priceGroups.length > 0 ? priceGroups : departureDateGroups;

  // Warn about price groups missing dates
  const groupsMissingDates = canonicalPriceGroups.filter(
    (g) => (g.date_keys as string[]).length === 0,
  );
  if (groupsMissingDates.length > 0) {
    warnings.push(
      `${groupsMissingDates.length} үнийн бүлэгт огноо байхгүй — хайлтаар олдохгүй байж болно`,
    );
  }

  const extra: Record<string, unknown> = {
    // Pass through unknown keys so existing DB data isn't lost
    ...Object.fromEntries(
      Object.entries(raw).filter(([k]) => !KNOWN_EXTRA_KEYS.has(k) && !DERIVED_EXTRA_KEYS.has(k)),
    ),
    // Canonical known fields
    aliases: asStringArray(raw.aliases),
    price_groups: canonicalPriceGroups,
    discounts,
    departure_date_groups: departureDateGroups,
    child_rules: normalizeChildRules(raw.child_rules),
    extra_fees: normalizeExtraFees(raw.extra_fees),
    departure_rule: asString(raw.departure_rule),
    recurring_schedule: asString(raw.recurring_schedule),
    included_items: asStringArray(raw.included_items),
    excluded_items: asStringArray(raw.excluded_items),
    room_prices: normalizeRoomPrices(raw.room_prices),
    important_notes: asStringArray(raw.important_notes),
    brochure_pdf_url: asString(raw.brochure_pdf_url) || null,
    source_file_name: asString(raw.source_file_name),
    source_file_attachment_id: asString(raw.source_file_attachment_id) || null,
    original_title_text: asString(raw.original_title_text),
    customer_visible:
      typeof raw.customer_visible === "boolean" ? raw.customer_visible : true,
    source_provenance: normalizeSourceProvenance(raw.source_provenance),
    answer_hints: normalizeAnswerHints(raw.answer_hints),
    needs_human_review:
      typeof raw.needs_human_review === "boolean" ? raw.needs_human_review : false,
    review_reasons: asStringArray(raw.review_reasons),
    booking_terms: normalizeBookingTerms(raw.booking_terms),
    departure_dates_resolved: normalizeResolvedDepartureDates(raw.departure_dates_resolved),
    itinerary_days: normalizeItineraryDays(raw.itinerary_days),
    age_rules: normalizeAgeRules(raw.age_rules),
    marketing_badge: normalizeMarketingBadge(raw.marketing_badge),
    website_summary: asString(raw.website_summary).trim(),
    ...(isTransportType(raw.transport_type) ? { transport_type: raw.transport_type } : {}),
    ...(asNumberOrNull(raw.duration_days) !== null ? { duration_days: asNumberOrNull(raw.duration_days) } : {}),
    ...(asNumberOrNull(raw.duration_nights) !== null ? { duration_nights: asNumberOrNull(raw.duration_nights) } : {}),
    ...(asStringArray(raw.destinations).length ? { destinations: asStringArray(raw.destinations) } : {}),
    ...(Object.keys(normalizePhotoCredits(raw.photo_credits)).length ? { photo_credits: normalizePhotoCredits(raw.photo_credits) } : {}),
    ...(raw.website_details_patch && typeof raw.website_details_patch === "object" && !Array.isArray(raw.website_details_patch)
      ? { website_details_patch: raw.website_details_patch } : {}),
    ...optionalList(raw, "hotel_profiles", warnings, normalizeHotelProfiles),
    ...optionalList(raw, "hotel_links", warnings, normalizeHotelLinks),
    ...optionalList(raw, "package_options", warnings, normalizePackageOptions),
    ...(httpsLink(raw.source_url) ? { source_url: httpsLink(raw.source_url) } : {}),
    ...(isoTimestamp(raw.source_checked_at) ? { source_checked_at: isoTimestamp(raw.source_checked_at) } : {}),
  };

  return { extra, warnings };
}

/**
 * Where each photo came from, keyed by its URL — the website shows it as
 * "Зургийн эх сурвалж" (photoCredits.ts there reads the same shape).
 */
function normalizePhotoCredits(raw: unknown): Record<string, Record<string, string>> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [url, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^https?:\/\//.test(url) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const credit = value as Record<string, unknown>;
    const entry: Record<string, string> = {};
    for (const key of ["title", "subject", "author", "license", "licenseUrl", "page", "provider"]) {
      const text = asString(credit[key]).trim();
      if (text) entry[key] = text.slice(0, 300);
    }
    if (Object.keys(entry).length) out[url] = entry;
  }
  return out;
}

/**
 * Passenger age bands for this trip ("0-23 сар" / "2-11 нас" / "12+ нас").
 * Empty strings mean "not set" — see src/lib/ageRules.ts for the defaults the
 * admin form pre-fills and the rule that nothing unset is ever quoted.
 */
function normalizeAgeRules(raw: unknown): Record<string, string> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    infant: asString(src.infant).trim(),
    child: asString(src.child).trim(),
    adult: asString(src.adult).trim(),
  };
}

function normalizeMarketingBadge(raw: unknown): Record<string, unknown> {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const saleLabel = asString(src.sale_label, "ХЯМДРАЛ").trim() || "ХЯМДРАЛ";
  const endsAt = asString(src.sale_ends_at).trim();
  return {
    sale_enabled: src.sale_enabled === true,
    sale_label: saleLabel.slice(0, 24),
    // Last day the badge shows (Ulaanbaatar date). Without it the badge stayed
    // on forever and kept advertising a sale that had already ended.
    sale_ends_at: /^\d{4}-\d{2}-\d{2}$/.test(endsAt) ? endsAt : null,
    seats_percent_left: clampPercent(asNumberOrNull(src.seats_percent_left)),
  };
}

/** Normalize supplied fields only, without resetting unrelated stored facts. */
export function normalizeExtraPatch(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized = normalizeExtra(raw).extra;
  const keys = new Set(Object.keys(raw));
  if (keys.has("departure_date_groups") && !keys.has("price_groups")) keys.add("price_groups");
  for (const key of DERIVED_EXTRA_KEYS) keys.delete(key);
  return Object.fromEntries(Object.entries(normalized).filter(([key]) => keys.has(key)));
}

// ─── diff helpers (used by the UI proposal view) ─────────────────────────────

export type TripExtraDiff = {
  field: string;
  label: string;
  before: string;
  after: string;
  kind: "added" | "removed" | "changed";
};

/** Returns human-readable field-level diffs between an incoming proposal action
 *  and the existing trip currently in the DB. */
export function diffTripFields(
  incoming: Record<string, unknown>,
  existing: {
    adult_price: number | null;
    child_price: number | null;
    infant_price?: number | null;
    departure_dates: string[];
    status: string;
    seats_total: number | null;
    seats_left: number | null;
    duration_text: string;
    currency: string;
  },
): TripExtraDiff[] {
  const diffs: TripExtraDiff[] = [];
  const currency = (typeof incoming.currency === "string" ? incoming.currency : existing.currency) || "MNT";
  const fmt = (n: number | null) =>
    n == null ? "—" : `${n.toLocaleString("mn-MN")}${currency === "MNT" ? "₮" : ` ${currency}`}`;

  function push(field: string, label: string, before: string, after: string) {
    if (before === after) return;
    const kind: TripExtraDiff["kind"] =
      before === "—" ? "added" : after === "—" ? "removed" : "changed";
    diffs.push({ field, label, before, after, kind });
  }

  if ("adult_price" in incoming) {
    push("adult_price", "Том хүн үнэ", fmt(existing.adult_price), fmt(asNumberOrNull(incoming.adult_price)));
  }
  if ("child_price" in incoming) {
    push("child_price", "Хүүхэд үнэ", fmt(existing.child_price), fmt(asNumberOrNull(incoming.child_price)));
  }
  if ("infant_price" in incoming) {
    push("infant_price", "Нярай үнэ", fmt(existing.infant_price ?? null), fmt(asNumberOrNull(incoming.infant_price)));
  }
  if ("status" in incoming) {
    const statusLabel: Record<string, string> = {
      active: "Идэвхтэй", cancelled: "Цуцлагдсан", sold_out: "Суудал дүүрсэн", draft: "Ноорог", archived: "Архив",
    };
    const bef = statusLabel[existing.status] ?? existing.status;
    const aft = statusLabel[asString(incoming.status)] ?? asString(incoming.status);
    push("status", "Төлөв", bef, aft);
  }
  if ("seats_total" in incoming) {
    push("seats_total", "Нийт суудал", existing.seats_total == null ? "—" : String(existing.seats_total), asNumberOrNull(incoming.seats_total) == null ? "—" : String(asNumberOrNull(incoming.seats_total)));
  }
  if ("seats_left" in incoming) {
    push("seats_left", "Үлдсэн суудал", existing.seats_left == null ? "—" : String(existing.seats_left), asNumberOrNull(incoming.seats_left) == null ? "—" : String(asNumberOrNull(incoming.seats_left)));
  }
  if ("duration_text" in incoming) {
    push("duration_text", "Хугацаа", existing.duration_text || "—", asString(incoming.duration_text) || "—");
  }

  // Departure dates diff
  if (Array.isArray(incoming.departure_dates)) {
    const oldDates = new Set(existing.departure_dates);
    const newDates = new Set(incoming.departure_dates as string[]);
    const added = [...newDates].filter((d) => !oldDates.has(d));
    const removed = [...oldDates].filter((d) => !newDates.has(d));
    if (added.length > 0) {
      diffs.push({ field: "departure_dates_added", label: "Шинэ огноо нэмсэн", before: "", after: added.slice(0, 5).join(", ") + (added.length > 5 ? ` (+${added.length - 5})` : ""), kind: "added" });
    }
    if (removed.length > 0) {
      diffs.push({ field: "departure_dates_removed", label: "Огноо хасагдсан", before: removed.slice(0, 5).join(", ") + (removed.length > 5 ? ` (+${removed.length - 5})` : ""), after: "", kind: "removed" });
    }
  }

  return diffs;
}
