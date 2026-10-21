import { auditTripPair, parityRecord } from "../../src/lib/tripWebsiteParity";
import { websiteDepartureSchedule } from "../../src/lib/connectedTripMapping";
import { websiteAvailabilityForResync, websiteTripPayload } from "../../src/lib/websiteTripPayload";
import { websiteTripToCanonicalFields, WebsiteTripPayloadError } from "../../src/lib/websiteTripBridge";
import { websiteDepartureDateKey } from "../../src/lib/websiteDepartureDate";
import type { TravelTrip } from "../../src/lib/travelTypes";

type Row = Record<string, unknown>;
export type WebsiteParityInput = { website: Row; source: TravelTrip & Row; poster?: Row };
export type InvalidWebsiteParityPair = {
  websiteId: unknown; sourceTripId: unknown; slug: unknown; error: string;
};

function auditPair({ website, source, poster }: WebsiteParityInput, now: Date) {
  // Validate before projecting availability: malformed dates must become a
  // private record-level finding, rather than a RangeError aborting the audit.
  const mapped = websiteTripToCanonicalFields(website).fields;
  const departures = Array.isArray(website.departures) ? website.departures.map(parityRecord) : [];
  const canonicalAvailability = parityRecord(mapped.extra).website_departure_availability;
  const availability = (Array.isArray(canonicalAvailability) ? canonicalAvailability : []).map((value) => {
    const departure = parityRecord(value);
    const date = websiteDepartureDateKey(departure.date);
    if (!date) throw new WebsiteTripPayloadError("Invalid website trip field: departures.startDate");
    return websiteAvailabilityForResync({ date, status: String(departure.status), seatsLeft: departure.seatsLeft as number | null },
      parityRecord(website.sourceMetadata).canonicalOffers);
  });
  const liveSource: TravelTrip = { ...source, extra: { ...source.extra, website_departure_availability: availability } };
  const projected = websiteTripPayload(liveSource, websiteDepartureSchedule(liveSource, now), now);
  const projectionFareDifferences = ["price", "childPrice", "infantPrice"].filter(key =>
    (key === "price" ? projected.price ?? 0 : projected[key as "childPrice" | "infantPrice"]) !== website[key])
    .map(key => ({ field: key, websiteValue: website[key], expectedProjection: projected[key as "price" | "childPrice" | "infantPrice"] ?? (key === "price" ? 0 : null) }));
  return { ...auditTripPair(website, source, poster), projectionFareDifferences,
    generatedDepartureCount: projected.departures.length, storedDepartureCount: departures.length,
    publishedCanonicalVisibilityMatches: website.isPublished === (["active", "sold_out", "paused"].includes(String(source.status))
      && parityRecord(source.extra).customer_visible !== false),
  };
}

/** Invalid customer facts are findings; programmer, schema and database errors still fail the run. */
export function auditWebsiteParityPairs(inputs: WebsiteParityInput[], now = new Date()) {
  const pairs: ReturnType<typeof auditPair>[] = [];
  const invalidPairs: InvalidWebsiteParityPair[] = [];
  for (const input of inputs) {
    try {
      pairs.push(auditPair(input, now));
    } catch (error) {
      if (!(error instanceof WebsiteTripPayloadError)) throw error;
      invalidPairs.push({ websiteId: input.website.id, sourceTripId: input.website.sourceTripId,
        slug: input.website.slug, error: error.message });
    }
  }
  return { pairs, invalidPairs };
}
