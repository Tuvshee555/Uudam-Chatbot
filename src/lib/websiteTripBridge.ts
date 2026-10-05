import type { TripMutationFields } from "./travelTypes";
import { sameParityValue } from "./tripWebsiteParityValue";
import { duration } from "./connectedTripMapping";

type UnknownRecord = Record<string, unknown>;

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

function fareOrNull(value: unknown, currency: unknown): number | null {
  const amount = numberOrNull(value);
  if (amount === null) return null;
  return String(currency || "MNT").toUpperCase() === "MNT" && amount < 1000 ? null : amount;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function dateKey(value: unknown): string {
  const raw = text(value);
  const match = raw.match(/^\d{4}-\d{2}-\d{2}/);
  return match?.[0] || "";
}

function durationText(days: unknown, nights: unknown): string {
  const dayCount = Math.max(1, Math.trunc(numberOrNull(days) ?? 1));
  const nightCount = Math.max(0, Math.trunc(numberOrNull(nights) ?? Math.max(0, dayCount - 1)));
  return `${dayCount} өдөр ${nightCount} шөнө`;
}

function availabilityStatus(value: unknown): "OPEN" | "SOLD_OUT" | "PAUSED" | "CANCELLED" {
  const status = text(value).toUpperCase();
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
  const trip = record(input);
  const sourceTripId = text(trip.sourceTripId);
  if (!sourceTripId) throw new Error("Website trip is missing sourceTripId");

  const metadata = record(trip.sourceMetadata);
  const priorSource = record(metadata.connectedSource);
  const priorExtra = record(priorSource.extra);
  const departures = Array.isArray(trip.departures) ? trip.departures.map(record) : [];
  const dates = departures.map(departure => dateKey(departure.startDate)).filter(Boolean);
  const uniqueDates = [...new Set(dates)];
  const image = text(trip.image);
  const photos = [...new Set([image, ...strings(trip.extraImages)].filter(Boolean))];
  const itinerary = (Array.isArray(trip.itinerary) ? trip.itinerary.map(record) : [])
    .map((day, index) => ({
      day: index + 1,
      title: text(day.title),
      description: text(day.description),
      hotel: text(day.accommodation),
      meals: {
        breakfast: strings(day.meals).some(meal => /өглөө|breakfast/i.test(meal)),
        lunch: strings(day.meals).some(meal => /өдөр|lunch/i.test(meal)),
        dinner: strings(day.meals).some(meal => /орой|dinner/i.test(meal)),
      },
      ...(text(day.image) ? { photo: text(day.image) } : {}),
    }))
    .filter(day => day.title || day.description || day.hotel);

  const metadataPriceGroups = Array.isArray(metadata.price_groups) ? metadata.price_groups : [];
  const priceGroups = metadataPriceGroups.length
    ? metadataPriceGroups
    : Array.isArray(priorExtra.price_groups) ? priorExtra.price_groups : [];
  const simpleDepartureGroups = departures
    .map(departure => {
      const date = dateKey(departure.startDate);
      if (!date) return null;
      return {
        dates: [date],
        adult_price: fareOrNull(departure.price, trip.currency),
        child_price: fareOrNull(departure.childPrice, trip.currency),
        infant_price: fareOrNull(departure.infantPrice, trip.currency),
      };
    })
    .filter((group): group is NonNullable<typeof group> => Boolean(group));

  const extra = {
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
    price_groups: priceGroups.length ? priceGroups : simpleDepartureGroups,
    ...(record(metadata.age_rules).adult || record(metadata.age_rules).child || record(metadata.age_rules).infant
      ? { age_rules: record(metadata.age_rules) }
      : {}),
  };

  return {
    sourceTripId,
    fields: {
      operator_name: text(priorSource.operator_name) || "UUDAM TRAVEL AGENCY",
      route_name: text(trip.title),
      duration_text: durationText(trip.durationDays, trip.durationNights),
      adult_price: fareOrNull(trip.price, trip.currency),
      child_price: fareOrNull(trip.childPrice, trip.currency),
      infant_price: fareOrNull(trip.infantPrice, trip.currency),
      currency: text(trip.currency) || "MNT",
      departure_dates: uniqueDates,
      has_food: typeof trip.foodIncluded === "boolean" ? trip.foodIncluded : null,
      status: trip.isPublished === false ? "draft" : "active",
      notes: text(trip.description),
      hotel: text(trip.hotel),
      photo_urls: photos,
      extra,
    },
  };
}

/** A reverse sync is a three-way edit, never a replacement of a stale snapshot. */
export function websiteTripPatch(input: unknown, previousInput: unknown, canonicalInput: unknown): TripMutationFields {
  const canonical = record(canonicalInput);
  const canonicalExtra = record(canonical.extra);
  const next = websiteTripToCanonicalFields(input).fields;
  const previous = record(previousInput);
  const before = Object.keys(previous).length ? websiteTripToCanonicalFields(previous).fields : null;
  const baselineSource = record(record(record(input).sourceMetadata).connectedSource);
  const baselineExtra = record(baselineSource.extra);
  const conflicts = Array.isArray(canonicalExtra.shared_conflicts) ? [...canonicalExtra.shared_conflicts] : [];
  const fields: TripMutationFields = {};
  const extra: UnknownRecord = {};
  const accept = (path: string, current: unknown, base: unknown, incoming: unknown, set: () => void) => {
    if (sameParityValue(current, incoming) || sameParityValue(current, base)) { set(); return; }
    const conflict = { field: path, chatbot: current ?? null, website: incoming ?? null, base: base ?? null };
    if (!conflicts.some((entry) => sameParityValue(entry, conflict))) conflicts.push(conflict);
  };
  for (const [key, value] of Object.entries(next)) {
    if (key === "extra" || key === "operator_name") continue;
    if (key === "status" && !["draft", "archived"].includes(String(canonical.status))) continue;
    if (before && sameParityValue(value, before[key as keyof TripMutationFields])) continue;
    const baseValue = before ? before[key as keyof TripMutationFields] : baselineSource[key];
    if (key === "duration_text" && sameParityValue(duration(String(canonical[key] || "")), duration(String(baseValue || "")))) {
      Object.assign(fields, { [key]: value }); continue;
    }
    accept(key, canonical[key], baseValue, value,
      () => Object.assign(fields, { [key]: value }));
  }
  for (const [key, value] of Object.entries(next.extra || {})) {
    if (before && sameParityValue(value, before.extra?.[key])) continue;
    const base = ["price_groups", "age_rules"].includes(key) ? baselineExtra[key] : before?.extra?.[key] ?? baselineExtra[key];
    if (key === "itinerary_days" && before && Array.isArray(value)) {
      const facts = (raw: unknown) => (Array.isArray(raw) ? raw : []).map((item, index) => {
        const day = record(item), meals = record(day.meals);
        return { day: Number(day.day) || index + 1, title: text(day.title), description: text(day.description), hotel: text(day.hotel),
          meals: { breakfast: meals.breakfast === true, lunch: meals.lunch === true, dinner: meals.dinner === true } };
      });
      if (sameParityValue(facts(canonicalExtra[key]), facts(base)) || sameParityValue(facts(canonicalExtra[key]), facts(value))) {
        const previousDays = Array.isArray(previous.itinerary) ? previous.itinerary.map(record) : [];
        const incomingDays = Array.isArray(record(input).itinerary) ? record(input).itinerary as unknown[] : [];
        const canonicalDays = Array.isArray(canonicalExtra[key]) ? canonicalExtra[key] as unknown[] : [];
        extra[key] = value.map((item, index) => {
          const day = record(item), incomingDay = record(incomingDays[index]);
          const oldIndex = incomingDay.id ? previousDays.findIndex((entry) => entry.id === incomingDay.id) : index;
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
  if (conflicts.length) extra.shared_conflicts = conflicts;
  if (Object.keys(extra).length) fields.extra = extra;
  return fields;
}
