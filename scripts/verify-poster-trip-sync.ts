import { mapPosterTripToFields } from "../src/lib/poster/tripMapper";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { cleanFields } from "../src/lib/travelDb";

type PosterRow = {
  id: string;
  title: string;
  data: unknown;
};

type TripRow = {
  id: string;
  route_name: string;
  duration_text: string;
  adult_price: number | null;
  child_price: number | null;
  departure_dates: string[];
  hotel: string;
  has_food: boolean | null;
  extra: Record<string, unknown>;
};

function posterRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function itineraryCount(data: unknown) {
  return asArray(posterRecord(data).days).filter((item) => {
    if (!item || typeof item !== "object") return false;
    const day = item as Record<string, unknown>;
    return Boolean(day.route || day.summary || day.hotel);
  }).length;
}

function sameStringArray(a: unknown, b: unknown) {
  const left = asArray(a).map(String);
  const right = asArray(b).map(String);
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

async function main() {
  const posterResult = await queryNeon<PosterRow>(
    `SELECT id, title, data FROM poster_trips ORDER BY updated_at DESC`,
  );
  const tripResult = await queryNeon<TripRow>(
    `SELECT id, route_name, duration_text, adult_price, child_price,
            departure_dates, hotel, has_food, extra
       FROM travel_trip_entries
      WHERE COALESCE(extra->>'poster_trip_id', '') <> ''`,
  );

  const posters = posterResult?.rows ?? [];
  const trips = tripResult?.rows ?? [];
  const tripsByPoster = new Map<string, TripRow>();
  for (const trip of trips) {
    const posterId = typeof trip.extra?.poster_trip_id === "string" ? trip.extra.poster_trip_id : "";
    if (posterId) tripsByPoster.set(posterId, trip);
  }

  const issues: Array<{ poster: string; issue: string }> = [];
  for (const poster of posters) {
    const trip = tripsByPoster.get(poster.id);
    if (!trip) {
      issues.push({ poster: poster.title, issue: "missing linked trip" });
      continue;
    }

    const mapped = cleanFields(mapPosterTripToFields(posterRecord(poster.data)));
    if (mapped.route_name && trip.route_name !== mapped.route_name) {
      issues.push({ poster: poster.title, issue: `route mismatch: ${trip.route_name}` });
    }
    if (mapped.duration_text && trip.duration_text !== mapped.duration_text) {
      issues.push({ poster: poster.title, issue: `duration mismatch: ${trip.duration_text}` });
    }
    if (mapped.adult_price != null && trip.adult_price !== mapped.adult_price) {
      issues.push({ poster: poster.title, issue: `adult price mismatch: ${trip.adult_price}` });
    }
    if (mapped.child_price != null && trip.child_price !== mapped.child_price) {
      issues.push({ poster: poster.title, issue: `child price mismatch: ${trip.child_price}` });
    }
    if (mapped.departure_dates && !sameStringArray(trip.departure_dates, mapped.departure_dates)) {
      issues.push({
        poster: poster.title,
        issue: `departure dates mismatch: ${JSON.stringify(trip.departure_dates)} / ${JSON.stringify(mapped.departure_dates)}`,
      });
    }
    if (mapped.hotel && trip.hotel !== mapped.hotel) {
      issues.push({ poster: poster.title, issue: "hotel mismatch" });
    }
    if (mapped.has_food !== undefined && trip.has_food !== mapped.has_food) {
      issues.push({ poster: poster.title, issue: `food mismatch: ${trip.has_food}` });
    }
    if (mapped.extra?.included_items && !sameStringArray(trip.extra?.included_items, mapped.extra.included_items)) {
      issues.push({ poster: poster.title, issue: "included items mismatch" });
    }
    if (mapped.extra?.excluded_items && !sameStringArray(trip.extra?.excluded_items, mapped.extra.excluded_items)) {
      issues.push({ poster: poster.title, issue: "excluded items mismatch" });
    }

    const expectedItineraryDays = itineraryCount(poster.data);
    const actualItineraryDays = asArray(trip.extra?.itinerary_days).length;
    if (actualItineraryDays !== expectedItineraryDays) {
      issues.push({
        poster: poster.title,
        issue: `itinerary day count mismatch: ${actualItineraryDays}/${expectedItineraryDays}`,
      });
    }
  }

  const duplicateLinks = trips.length - tripsByPoster.size;
  if (duplicateLinks !== 0) {
    issues.push({ poster: "(all)", issue: `${duplicateLinks} duplicate poster links` });
  }

  console.log(JSON.stringify({
    posterCount: posters.length,
    linkedTripCount: trips.length,
    unmatchedIssueCount: issues.length,
    issues,
  }, null, 2));

  if (issues.length > 0) process.exit(1);
}

main()
  .finally(() => closeNeonPool())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
