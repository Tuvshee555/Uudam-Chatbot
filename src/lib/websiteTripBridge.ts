import type { TripMutationFields } from "./travelTypes";
import { sameParityValue } from "./tripWebsiteParityValue";
import { duration } from "./connectedTripMapping";
import { websiteDepartureDateKey } from "./websiteDepartureDate";
import { currentWebsiteDepartureRows } from "./websiteDepartureRows";

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

function mapWebsiteTrip(input: unknown): { sourceTripId: string; fields: TripMutationFields } {
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
    .filter(day => day.title || day.description || day.hotel || "photo" in day || Object.values(day.meals).some(Boolean));

  const metadataPriceGroups = Array.isArray(metadata.price_groups) ? metadata.price_groups : [];
  const priceGroups = owns(metadata, "price_groups")
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
      child_price: fareOrNull(trip.childPrice, trip.currency),
      infant_price: fareOrNull(trip.infantPrice, trip.currency),
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

/** A reverse sync is a three-way edit, never a replacement of a stale snapshot. */
export function websiteTripPatch(input: unknown, previousInput: unknown, canonicalInput: unknown): TripMutationFields {
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
  const next = mapWebsiteTrip(nextInput).fields;
  if (!owns(incoming, "currency") && !owns(previous, "currency")) delete next.currency;
  const before = Object.keys(previous).length ? mapWebsiteTrip(previous).fields : null;
  const baselineExtra = record(baselineSource.extra);
  const conflicts = Array.isArray(canonicalExtra.shared_conflicts) ? [...canonicalExtra.shared_conflicts] : [];
  const fields: TripMutationFields = {};
  const extra: UnknownRecord = {};
  const accept = (path: string, current: unknown, base: unknown, incoming: unknown, set: () => void) => {
    if (sameParityValue(current, incoming)) return;
    if (sameParityValue(current, base)) { set(); return; }
    const conflict = { field: path, chatbot: current ?? null, website: incoming ?? null, base: base ?? null };
    if (!conflicts.some((entry) => sameParityValue(entry, conflict))) conflicts.push(conflict);
  };
  for (const [key, value] of Object.entries(next)) {
    if (key === "extra" || key === "operator_name") continue;
    if (sameParityValue(canonical[key], value)) continue;
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
    const base = before?.extra && owns(before.extra, key) ? before.extra[key] : baselineExtra[key];
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
      if (!date) continue;
      for (const fare of ["price", "childPrice", "infantPrice"] as const) {
        if (!owns(row, fare)) continue;
        const typed = numberOrNull(row[fare]);
        const before = saved.has(date) ? numberOrNull(saved.get(date)![fare]) : null;
        if (typed === null || sameParityValue(typed, before)) continue;
        const priceKey = fare === "price" ? "adult_price" : fare === "childPrice" ? "child_price" : "infant_price";
        const forDate = groups.filter((group) => [...strings(group.dates), ...strings(group.date_keys)].includes(date))
          .map((group) => ({ label: text(group.label) || text(group.hotel) || "Үнэ", [priceKey]: group[priceKey] ?? null }));
        const conflict = { field: `departure.${date}.${fare}`, chatbot: forDate, website: typed, base: before };
        if (!conflicts.some((entry) => sameParityValue(entry, conflict))) conflicts.push(conflict);
      }
    }
  }
  if (!sameParityValue(conflicts, canonicalExtra.shared_conflicts || [])) extra.shared_conflicts = conflicts;
  for (const [key, value] of Object.entries(extra)) {
    if (sameParityValue(value, canonicalExtra[key])) delete extra[key];
  }
  if (Object.keys(extra).length) fields.extra = extra;
  return fields;
}
