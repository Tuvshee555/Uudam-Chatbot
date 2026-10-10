import { loadEnvConfig } from "@next/env";
import { itineraryEndsInUlaanbaatar, itineraryStartsInUlaanbaatar } from "../src/lib/tripItineraryBoundaries";

loadEnvConfig(process.cwd());

type Day = {
  day?: unknown;
  title?: unknown;
  description?: unknown;
};

function text(day: Day | undefined) {
  return [day?.title, day?.description]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();
}

async function main() {
  const { withNeonClient } = await import("../src/lib/neonDb");
  const rows = await withNeonClient(async (client) => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query<{
        id: string;
        route_name: string;
        duration_text: string;
        status: string;
        itinerary: unknown;
        duration_days: unknown;
        duration_nights: unknown;
      }>(`
        SELECT id, route_name, duration_text, status,
               extra->'itinerary_days' AS itinerary,
               extra->'duration_days' AS duration_days,
               extra->'duration_nights' AS duration_nights
        FROM travel_trip_entries
        ORDER BY route_name
      `);
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });

  if (!rows) throw new Error("Database is not configured; no catalog was audited.");

  const detailsIndex = process.argv.indexOf("--details");
  if (detailsIndex >= 0) {
    const id = process.argv[detailsIndex + 1];
    console.log(JSON.stringify(rows.find((row) => row.id === id) || null, null, 2));
    return;
  }

  const report = rows.map((row) => {
    const days = Array.isArray(row.itinerary) ? (row.itinerary as Day[]) : [];
    const first = text(days[0]);
    const last = text(days.at(-1));
    return {
      id: row.id,
      route_name: row.route_name,
      duration_text: row.duration_text,
      status: row.status,
      day_count: days.length,
      first_day: first,
      last_day: last,
      starts_in_ulaanbaatar: itineraryStartsInUlaanbaatar(days[0]),
      ends_in_ulaanbaatar: itineraryEndsInUlaanbaatar(days.at(-1)),
    };
  });

  const output = process.argv.includes("--issues")
    ? report.filter((trip) => trip.day_count === 0 || !trip.starts_in_ulaanbaatar || !trip.ends_in_ulaanbaatar)
    : process.argv.includes("--active-last")
      ? report.filter((trip) => trip.status === "active").map((trip) => ({
          id: trip.id,
          route_name: trip.route_name,
          duration_text: trip.duration_text,
          day_count: trip.day_count,
          last_day: trip.last_day,
        }))
      : report;
  console.log(JSON.stringify(output, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeNeonPool } = await import("../src/lib/neonDb");
    await closeNeonPool();
  });
