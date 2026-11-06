/**
 * The trip editor's state, to and from a trip's saved fields. Moved out of
 * pages/admin.tsx (over the 2,000-line cap) so the same mapping serves an
 * existing trip, a brand-new one and a trip read from a file that has not been
 * saved yet (the AI review opens the full editor on it). Pure: no React, no API.
 */
import type {
  AnswerHint, BookingTerms, DiscountGroup, ExtraFee, ItineraryDay, PriceGroup, RoomPrice, SourceProvenance, TravelTrip,
} from "./adminTypes";
import { emptyBookingTerms, toBookingTermsForm } from "./adminTypes";
import { deriveChildRules, withDerivedSummaryFields } from "./priceGroups";
import { documentedFreeFare } from "./tripCompleteness";
import { resolveAgeRules } from "./ageRules";
import { websiteDetailsPatch } from "./websiteTripDetails";
import { sameParityValue } from "./tripWebsiteParityValue";

type Row = Record<string, unknown>;
const record = (value: unknown): Row => (value && typeof value === "object" && !Array.isArray(value) ? value as Row : {});
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? value as T[] : []);

export const BLANK_TRIP_DRAFT: Record<string, string> = {
  category: "Аялал", operator_name: "UUDAM TRAVEL AGENCY", route_name: "", duration_text: "", adult_price: "", child_price: "", infant_price: "",
  child_price_free: "", infant_price_free: "", age_infant: "0-23 сар", age_child: "2-11 нас", age_adult: "12+ нас", currency: "MNT",
  seats_total: "", seats_left: "", seats_percent_left: "", sale_badge_enabled: "false", sale_badge_label: "ХЯМДРАЛ", sale_badge_ends: "",
  departure_dates: "", status: "active", has_food: "unknown", notes: "", hotel: "", source_description: "", hotelProfiles: "[]",
};

export type TripEditorState = {
  tripDraft: Record<string, string>;
  tripPhotoUrls: string[];
  tripAliases: string[];
  tripPriceGroups: PriceGroup[];
  tripDiscounts: DiscountGroup[];
  tripExtraFees: ExtraFee[];
  tripDepartureRule: string;
  tripIncludedItems: string[];
  tripExcludedItems: string[];
  tripRoomPrices: RoomPrice[];
  tripItineraryDays: ItineraryDay[];
  tripImportantNotes: string[];
  tripBookingTerms: BookingTerms;
  tripCustomerVisible: boolean;
  tripNeedsHumanReview: boolean;
  tripReviewReasons: string[];
  tripSourceProvenance: SourceProvenance[];
  tripAnswerHints: AnswerHint[];
};

export function blankEditorState(): TripEditorState {
  return {
    tripDraft: { ...BLANK_TRIP_DRAFT }, tripPhotoUrls: [], tripAliases: [], tripPriceGroups: [], tripDiscounts: [], tripExtraFees: [],
    tripDepartureRule: "", tripIncludedItems: [], tripExcludedItems: [], tripRoomPrices: [], tripItineraryDays: [], tripImportantNotes: [],
    tripBookingTerms: emptyBookingTerms(), tripCustomerVisible: true, tripNeedsHumanReview: false, tripReviewReasons: [],
    tripSourceProvenance: [], tripAnswerHints: [],
  };
}

const money = (value: unknown) => (value == null ? "" : String(value));
const str = (value: unknown) => (typeof value === "string" ? value : "");
const strList = (value: unknown) => (Array.isArray(value) ? value.map((item) => String(item ?? "")) : []);

/**
 * A price row with every field the editor reads. Rows read from a file or a
 * partner can lack a label, note, age range or currency; the editor's controls
 * assume they exist (an undefined age range crashed the price editor, 2026-11-05).
 */
export function completePriceGroup(raw: unknown): PriceGroup {
  const group = record(raw);
  const dates = strList(group.dates);
  return {
    ...group,
    label: str(group.label),
    dates,
    display_dates: strList(group.display_dates).length ? strList(group.display_dates) : dates,
    date_keys: strList(group.date_keys).length ? strList(group.date_keys) : dates,
    adult_price: typeof group.adult_price === "number" ? group.adult_price : null,
    adult_price_range: (group.adult_price_range as PriceGroup["adult_price_range"]) ?? null,
    child_price: typeof group.child_price === "number" ? group.child_price : null,
    infant_price: typeof group.infant_price === "number" ? group.infant_price : null,
    child_age: str(group.child_age),
    infant_age: str(group.infant_age),
    note: str(group.note),
    passenger_prices: list<Row>(group.passenger_prices).map((band) => ({
      ...band,
      label: str(band.label),
      age_range: str(band.age_range),
      price: typeof band.price === "number" ? band.price : null,
      currency: str(band.currency) || "MNT",
    })) as PriceGroup["passenger_prices"],
  } as PriceGroup;
}
const asInt = (value: string): number | null => {
  const digits = String(value || "").replace(/[^\d]/g, "");
  return digits ? Number.parseInt(digits, 10) : null;
};

/** A trip (saved, or only read from a file) as the editor's state. */
export function tripToEditorState(trip: Partial<TravelTrip> & { extra?: Row }): TripEditorState {
  const extra = record(trip.extra);
  const badge = record(extra.marketing_badge);
  const ages = resolveAgeRules(extra as TravelTrip["extra"]);
  return {
    tripDraft: {
      category: trip.category || "",
      operator_name: trip.operator_name || "",
      route_name: trip.route_name || "",
      duration_text: trip.duration_text || "",
      adult_price: money(trip.adult_price),
      child_price: money(trip.child_price),
      infant_price: money(trip.infant_price),
      child_price_free: documentedFreeFare(extra, "child") ? "true" : "",
      infant_price_free: documentedFreeFare(extra, "infant") ? "true" : "",
      age_infant: ages.infant,
      age_child: ages.child,
      age_adult: ages.adult,
      currency: trip.currency || "MNT",
      seats_total: money(trip.seats_total),
      seats_left: money(trip.seats_left),
      seats_percent_left: typeof badge.seats_percent_left === "number" ? String(badge.seats_percent_left) : "",
      sale_badge_enabled: badge.sale_enabled === true ? "true" : "false",
      sale_badge_label: typeof badge.sale_label === "string" ? badge.sale_label : "ХЯМДРАЛ",
      sale_badge_ends: typeof badge.sale_ends_at === "string" ? badge.sale_ends_at : "",
      departure_dates: (trip.departure_dates || []).join(", "),
      status: trip.status || "active",
      has_food: trip.has_food == null ? "unknown" : trip.has_food ? "true" : "false",
      notes: trip.notes || "",
      hotel: trip.hotel || "",
      source_description: trip.source_description || "",
      hotelProfiles: JSON.stringify(list(extra.hotel_profiles)),
    },
    tripPhotoUrls: trip.photo_urls || [],
    tripAliases: list<string>(extra.aliases),
    // As saved: completing the rows here made an unchanged trip look edited and saved it again.
    // The controls themselves tolerate a missing field (parseAgeRange); the review completes file rows.
    tripPriceGroups: list<PriceGroup>(extra.price_groups),
    tripDiscounts: list<DiscountGroup>(extra.discounts),
    tripExtraFees: list<ExtraFee>(extra.extra_fees),
    tripDepartureRule: typeof extra.departure_rule === "string" ? extra.departure_rule : "",
    tripIncludedItems: list<string>(extra.included_items),
    tripExcludedItems: list<string>(extra.excluded_items),
    tripRoomPrices: list<RoomPrice>(extra.room_prices),
    tripItineraryDays: list<ItineraryDay>(extra.itinerary_days),
    tripImportantNotes: list<string>(extra.important_notes),
    tripBookingTerms: toBookingTermsForm(extra.booking_terms),
    tripCustomerVisible: typeof extra.customer_visible === "boolean" ? extra.customer_visible : true,
    tripNeedsHumanReview: typeof extra.needs_human_review === "boolean" ? extra.needs_human_review : false,
    tripReviewReasons: list<string>(extra.review_reasons),
    tripSourceProvenance: list<SourceProvenance>(extra.source_provenance),
    tripAnswerHints: list<AnswerHint>(extra.answer_hints),
  };
}

/** The hotels of a trip as the editor holds them (a JSON string in the draft). */
export function parseHotelProfiles(value: string | undefined): Array<{ name: string; url: string; description: string; media: Array<{ url: string; caption: string }> }> {
  try {
    // Fields the editor does not show (a partner's hotel id) ride along untouched.
    return list<Row>(JSON.parse(value || "[]")).map((profile) => ({
      ...profile,
      name: typeof profile.name === "string" ? profile.name : "",
      url: typeof profile.url === "string" ? profile.url : "",
      description: typeof profile.description === "string" ? profile.description : "",
      media: list<Row>(profile.media).map((item) => ({ url: typeof item.url === "string" ? item.url : "", caption: typeof item.caption === "string" ? item.caption : "" })),
    }));
  } catch {
    return [];
  }
}

/**
 * The departure field's text as entries. A comma next to a date separates two dates; a comma
 * inside a schedule ("Даваа, Пүрэв гараг бүр") is part of it and stays one entry.
 */
export function splitDepartureText(value: string): string[] {
  return String(value || "").split(/\s*,\s*(?=\d)|(?<=\d)\s*,\s*/).map((entry) => entry.trim()).filter(Boolean);
}

/**
 * "9 өдөр 8 шөнө" as the structured numbers the bot, the website sync and the departure end
 * dates read first. Written with the text, so a length changed in the editor reaches them.
 */
export function structuredDuration(text: string): { duration_days: number; duration_nights: number | null } | null {
  const days = /(\d{1,3})\s*өдөр/iu.exec(text || "");
  if (!days || Number(days[1]) < 1) return null;
  const nights = /(\d{1,3})\s*шөнө/iu.exec(text || "");
  return { duration_days: Number(days[1]), duration_nights: nights ? Number(nights[1]) : null };
}

/**
 * The fields to save from the editor's state. `editingTrip` is the trip as it
 * was opened, or null for a trip not saved yet. `hadProfiles` says the opened
 * (unsaved) trip had a hotel list, so removing every hotel saves an empty one.
 */
export function editorStateToFields(state: TripEditorState, editingTrip: TravelTrip | null, options: { hadProfiles?: boolean } = {}) {
  const { tripDraft } = state;
  const profiles = parseHotelProfiles(tripDraft.hotelProfiles)
    .map((profile) => ({ ...profile, name: profile.name.trim(), url: profile.url.trim(), media: profile.media.filter((item) => item.url.trim()) }))
    .filter((profile) => profile.name);
  const hadProfiles = options.hadProfiles ?? Array.isArray(editingTrip?.extra?.hotel_profiles);
  const duration = structuredDuration(tripDraft.duration_text || "");
  return {
    category: tripDraft.category || "Аялал",
    operator_name: tripDraft.operator_name || "UUDAM TRAVEL AGENCY",
    route_name: tripDraft.route_name || "",
    duration_text: tripDraft.duration_text || "",
    adult_price: asInt(tripDraft.adult_price || ""),
    child_price: asInt(tripDraft.child_price || ""),
    infant_price: asInt(tripDraft.infant_price || ""),
    currency: tripDraft.currency || "MNT",
    seats_total: asInt(tripDraft.seats_total || ""),
    seats_left: asInt(tripDraft.seats_left || ""),
    status: tripDraft.status || "active",
    has_food: tripDraft.has_food === "unknown" ? null : tripDraft.has_food === "true",
    notes: tripDraft.notes || "",
    hotel: tripDraft.hotel || "",
    departure_dates: splitDepartureText(tripDraft.departure_dates || ""),
    source_description: tripDraft.source_description || "",
    photo_urls: state.tripPhotoUrls,
    extra: {
      // Website-only fields typed on a trip that is not saved yet are kept too (against an empty base).
      ...(tripDraft.websiteDetails ? { website_details_patch: websiteDetailsPatch(editingTrip?.extra?.website_details, JSON.parse(tripDraft.websiteDetails)) } : {}),
      ...(profiles.length || hadProfiles ? { hotel_profiles: profiles } : {}),
      ...(duration ?? {}),
      aliases: state.tripAliases.filter(Boolean),
      price_groups: state.tripPriceGroups.map(withDerivedSummaryFields),
      discounts: state.tripDiscounts,
      child_rules: deriveChildRules(state.tripPriceGroups, {
        child: tripDraft.child_price_free === "true",
        infant: tripDraft.infant_price_free === "true",
      }),
      extra_fees: state.tripExtraFees,
      departure_rule: state.tripDepartureRule.trim(),
      included_items: state.tripIncludedItems.filter(Boolean),
      excluded_items: state.tripExcludedItems.filter(Boolean),
      room_prices: state.tripRoomPrices,
      itinerary_days: state.tripItineraryDays.map((day, index) => ({ ...day, day: index + 1 })),
      important_notes: state.tripImportantNotes.filter(Boolean),
      booking_terms: state.tripBookingTerms,
      customer_visible: state.tripCustomerVisible,
      needs_human_review: state.tripNeedsHumanReview,
      review_reasons: state.tripReviewReasons.filter(Boolean),
      source_provenance: state.tripSourceProvenance,
      answer_hints: state.tripAnswerHints,
      age_rules: {
        infant: (tripDraft.age_infant || "").trim(),
        child: (tripDraft.age_child || "").trim(),
        adult: (tripDraft.age_adult || "").trim(),
      },
      marketing_badge: {
        sale_enabled: tripDraft.sale_badge_enabled === "true",
        sale_label: (tripDraft.sale_badge_label || "ХЯМДРАЛ").trim(),
        sale_ends_at: /^\d{4}-\d{2}-\d{2}$/.test(tripDraft.sale_badge_ends || "") ? tripDraft.sale_badge_ends : null,
        seats_percent_left: (() => {
          const value = asInt(tripDraft.seats_percent_left || "");
          return value == null ? null : Math.max(0, Math.min(100, value));
        })(),
      },
    },
  };
}

/**
 * True when the editor would write a trip's sale badge only because the trip had
 * none: the switched-off default is the same as no badge. Without this, opening a
 * badge-less trip and pressing save sent a change (found 2026-11-05).
 */
export function isDefaultBadge(before: unknown, after: unknown): boolean {
  if (before !== undefined && before !== null) return false;
  const badge = record(after);
  return badge.sale_enabled !== true && (badge.sale_label === "ХЯМДРАЛ" || !badge.sale_label) && !badge.sale_ends_at && badge.seats_percent_left == null;
}

/**
 * Only what the editor changed: the top-level fields and the extra keys that differ from what
 * it showed when it opened (`baseline`, built by editorStateToFields from the same state).
 * Defaults the editor fills in (age bands, a switched-off sale badge) are in both, so they never
 * count as an edit; a list emptied by hand (hotels) does.
 */
export function changedEditorFields(baseline: Row, fields: Row): Row {
  const changed: Row = Object.fromEntries(Object.entries(fields).filter(([key, value]) => key !== "extra" && !sameParityValue(baseline[key], value)));
  const before = record(baseline.extra);
  const extra = Object.fromEntries(Object.entries(record(fields.extra)).filter(([key, value]) => !sameParityValue(before[key], value)));
  return Object.keys(extra).length ? { ...changed, extra } : changed;
}

/**
 * The full editor's changes folded back into a trip read from a file: what
 * the admin changed wins; everything else, and what only the review keeps
 * (source quotes, the program's own length, transport, photo credits), stays.
 */
export function mergeEditorResult(before: Row, edited: Row): Row {
  return { ...before, ...edited, extra: { ...record(before.extra), ...record(edited.extra) } };
}
