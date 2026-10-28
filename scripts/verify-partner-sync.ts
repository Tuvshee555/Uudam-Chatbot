// Read-only end-to-end parity check: source API -> canonical trip -> public website data.
import { loadEnvConfig } from "@next/env";
import { Client } from "pg";
import { isDeepStrictEqual } from "node:util";
import { TOURS } from "../src/lib/partnerSync/run";
import { fetchGlobalTravelTour } from "../src/lib/partnerSync/globalTravel";
import { partnerTripFields } from "../src/lib/partnerSync/tripPayload";
import { normalizeExtraPatch } from "../src/lib/tripExtraSchema";
import { websiteTripPayload } from "../src/lib/websiteTripPayload";
import { websiteDepartureSchedule } from "../src/lib/connectedTripMapping";
import type { TravelTrip } from "../src/lib/travelTypes";

loadEnvConfig(process.cwd());
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};
const rows = (value: unknown) => Array.isArray(value) ? value.map(record) : [];
const sort = (items: unknown[]) => items.map((item) => JSON.stringify(item)).sort();
function fareCells(value: unknown) {
  return sort(rows(value).map((g) => ({
    dates: g.dates, hotel: g.hotel, package: g.package_id ?? null, adult: g.adult_price,
    infant: g.infant_price, single: g.single_price ?? null,
    passengers: sort(rows(g.passenger_prices).map((p) => ({ age: p.age_range, price: p.price }))),
    availability: g.availability ?? { status: g.status, seatsLeft: g.seats_left },
  })));
}
async function connect(url: string | undefined) {
  if (!url) throw new Error("Database configuration missing");
  const parsed = new URL(url); parsed.searchParams.set("sslmode", "verify-full");
  const client = new Client({ connectionString: parsed.toString(), connectionTimeoutMillis: 10000, statement_timeout: 20000 });
  await client.connect(); await client.query("BEGIN READ ONLY"); return client;
}
async function main() {
  const source = await connect(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL);
  let website: Client | undefined;
  try {
    website = await connect(process.env.BOOKING_DATABASE_URL);
    for (const config of TOURS) {
      const tour = await fetchGlobalTravelTour(config.slug);
      const trip = (await source.query("SELECT * FROM travel_trip_entries WHERE id=$1", [config.tripId])).rows[0] as TravelTrip;
      const poster = (await source.query("SELECT data FROM poster_trips WHERE id=$1", [config.posterId])).rows[0]?.data;
      const site = (await website.query('SELECT * FROM "Trip" WHERE "sourceTripId"=$1', [config.tripId])).rows[0];
      if (!trip || !poster || !site) throw new Error("Missing connected trip/poster/website record");
      const fields = partnerTripFields(tour, poster);
      const extra = normalizeExtraPatch(fields.extra ?? {});
      const errors: string[] = [];
      let checks = 0;
      const check = (label: string, actual: unknown, expected: unknown) => {
        checks++; if (!isDeepStrictEqual(actual, expected)) errors.push(label);
      };
      for (const key of ["adult_price", "child_price", "infant_price", "hotel", "notes", "departure_dates", "duration_text"] as const) check(`canonical.${key}`, trip[key], fields[key]);
      for (const key of ["included_items", "excluded_items", "itinerary_days", "hotel_profiles"]) check(`canonical.${key}`, trip.extra[key], extra[key]);
      check("canonical.all_fares", fareCells(trip.extra.price_groups), fareCells(extra.price_groups));
      check("poster.snapshot", poster.partner_snapshot.contentHash, tour.contentHash);
      check("poster.completed", poster.partner_sync.status, "complete");
      const now = new Date();
      const expectedTrip = { ...trip, ...fields, extra: { ...trip.extra, ...extra } } as TravelTrip;
      const projection = websiteTripPayload(expectedTrip, websiteDepartureSchedule(expectedTrip, now), now);
      check("website.all_fares", fareCells(site.sourceMetadata.price_groups), fareCells(projection.priceGroups));
      check("website.price", site.price, projection.price);
      check("website.childPrice", site.childPrice, projection.childPrice);
      check("website.infantPrice", site.infantPrice, projection.infantPrice);
      check("website.included", site.included, tour.includes);
      check("website.excluded", site.excluded, tour.excludes);
      check("website.description", site.description, tour.description);
      const departures = (await website.query('SELECT ("startDate" + interval \'8 hours\')::date::text AS date,status,price,"childPrice","infantPrice" FROM "Departure" WHERE "tripId"=$1', [site.id])).rows;
      for (const dep of projection.departures) {
        const actual = departures.find((d) => d.date === dep.start.slice(0, 10) && d.status !== "CANCELLED");
        // Past source departures can legitimately be projected as cancelled.
        const found = actual ?? departures.find((d) => d.date === dep.start.slice(0, 10));
        check(`website.departure.${dep.start}`, found && { status: found.status, price: found.price, child: found.childPrice, infant: found.infantPrice },
          { status: dep.status, price: dep.price, child: dep.childPrice, infant: dep.infantPrice });
      }
      const days = (await website.query('SELECT "dayNumber",title,description,accommodation,meals FROM "ItineraryDay" WHERE "tripId"=$1 AND "dayNumber">0 ORDER BY "dayNumber"', [site.id])).rows;
      check("website.itinerary", days, tour.days.map((day) => ({ dayNumber: day.day, title: day.title, description: day.lines.join("\n"), accommodation: day.accommodation,
        meals: [day.meals.breakfast ? "Өглөө" : "", day.meals.lunch ? "Өдөр" : "", day.meals.dinner ? "Орой" : ""].filter(Boolean) })));
      const duplicates = (await source.query("SELECT t.id,t.status,t.extra->'customer_visible' AS visible FROM poster_trips p JOIN travel_trip_entries t ON t.extra->>'poster_trip_id'=p.id WHERE p.data->>'source_url'=$1 AND t.id<>$2", [tour.sourceUrl, config.tripId])).rows;
      for (const duplicate of duplicates) {
        check(`duplicate.${duplicate.id}.hidden`, duplicate.status === "archived" || duplicate.visible === false, true);
        const duplicateSite = (await website.query('SELECT "isPublished" FROM "Trip" WHERE "sourceTripId"=$1', [duplicate.id])).rows;
        check(`duplicate.${duplicate.id}.website_hidden`, duplicateSite.every((entry) => entry.isPublished === false), true);
      }
      const delivered = (await source.query("SELECT revision=synced_revision AS synced FROM trip_website_sync WHERE trip_id=$1", [config.tripId])).rows[0];
      check("website.delivery_complete", delivered?.synced, true);
      console.log(JSON.stringify({ slug: config.slug, websiteSlug: site.slug, published: site.isPublished, sourceRows: tour.rows.length,
        priceGroups: projection.priceGroups.length, itineraryDays: tour.days.length, checks, errors, duplicatesArchived: duplicates.length }));
      if (errors.length) process.exitCode = 1;
    }
  } finally { await source.end(); await website?.end(); }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "Parity check failed"); process.exitCode = 1; });
