import type { TripMutationFields } from "./travelTypes";

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

/**
 * Older imports sometimes repeated one age band several times in a price
 * group, each with a different fare. That is not a selectable offer: the
 * canonical trip validator rightly rejects it. Keep the row that matches the
 * group's explicit child/infant fare (or the first row when no flat fare is
 * available) so a website-only edit is never blocked by stale duplicate data.
 */
function repairPassengerPrices(groups: unknown[]): unknown[] {
  return groups.map(group => {
    const source = record(group);
    const rows = Array.isArray(source.passenger_prices) ? source.passenger_prices : [];
    if (!rows.length) return group;

    const preferredChildFare = numberOrNull(source.child_price);
    const preferredInfantFare = numberOrNull(source.infant_price);
    const byBand = new Map<string, UnknownRecord>();

    for (const rowValue of rows) {
      const row = record(rowValue);
      const label = text(row.label) || text(row.category) || text(row.age_group);
      const ageRange = text(row.age_range) || text(row.age);
      const currency = text(row.currency) || text(source.currency) || "MNT";
      const key = `${label.toLowerCase()}|${ageRange.toLowerCase()}|${currency.toUpperCase()}`;
      const current = byBand.get(key);
      if (!current) {
        byBand.set(key, row);
        continue;
      }

      const candidateFare = numberOrNull(row.price);
      const currentFare = numberOrNull(current.price);
      const preferredFare = /нярай|infant/i.test(`${label} ${ageRange}`)
        ? preferredInfantFare
        : preferredChildFare;
      if (preferredFare !== null && candidateFare === preferredFare && currentFare !== preferredFare) {
        byBand.set(key, row);
      }
    }

    return { ...source, passenger_prices: [...byBand.values()] };
  });
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
 * Converts the shared customer-facing fields from the website's trip shape to
 * the canonical chatbot record. Website-only editorial metadata deliberately
 * stays on the website; it cannot affect a chatbot answer or a poster.
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
        breakfast: strings(day.meals).some(meal => /өглөө/i.test(meal)),
        lunch: strings(day.meals).some(meal => /өдөр/i.test(meal)),
        dinner: strings(day.meals).some(meal => /орой/i.test(meal)),
      },
      ...(text(day.image) ? { photo: text(day.image) } : {}),
    }))
    .filter(day => day.title || day.description || day.hotel);

  const metadataPriceGroups = Array.isArray(metadata.price_groups) ? metadata.price_groups : [];
  const priceGroups = repairPassengerPrices(metadataPriceGroups.length
    ? metadataPriceGroups
    : Array.isArray(priorExtra.price_groups) ? priorExtra.price_groups : []);
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
    ...priorExtra,
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
      seats_total: null,
      seats_left: null,
      has_food: typeof trip.foodIncluded === "boolean" ? trip.foodIncluded : null,
      status: trip.isPublished === false ? "draft" : "active",
      notes: text(trip.description),
      hotel: text(trip.hotel),
      source_description: text(trip.summary),
      photo_urls: photos,
      extra,
    },
  };
}
