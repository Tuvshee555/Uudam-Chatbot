import { queryNeon } from "../src/lib/neonDb";
import { patchTrip } from "../src/lib/travelDb";
import { flushWebsiteSync, closeBookingPool } from "../src/lib/websiteTripSync";

type WebsiteTrip = {
  sourceTripId: string;
  title: string;
  description: string | null;
  summary: string | null;
};

async function main() {
  const flagged = await queryNeon<{ trip_id: string }>(
    "SELECT trip_id FROM trip_website_sync WHERE content_conflict=TRUE ORDER BY trip_id",
  );
  const tripIds = flagged?.rows.map(row => row.trip_id) || [];
  if (process.argv.includes("--flush-only")) {
    const result = await flushWebsiteSync(undefined, 50);
    console.log(JSON.stringify({ processed: result.processed }, null, 2));
    return;
  }
  if (process.argv.includes("--inspect")) {
    const conflicts = await queryNeon<{ sourceTripId: string; contentConflicts: unknown }>(`
      SELECT "sourceTripId", "sourceMetadata"->'contentConflicts' AS "contentConflicts"
      FROM "Trip" WHERE "sourceTripId"=ANY($1::text[])
      ORDER BY "sourceTripId"
    `, [tripIds]);
    console.log(JSON.stringify(conflicts?.rows || [], null, 2));
    return;
  }
  if (!tripIds.length) {
    console.log("No website/chatbot content conflicts need reconciliation.");
    return;
  }

  // The current website copy is the staff-facing version. Bring the only
  // remaining live text divergence into the canonical chatbot trip first.
  const mismatch = await queryNeon<WebsiteTrip>(`
    SELECT "sourceTripId", title, description, summary FROM "Trip"
    WHERE "sourceTripId"=$1
  `, ["trip-hohhot-health-bus-2026"]);
  const websiteTrip = mismatch?.rows[0];
  if (websiteTrip) {
    const canonical = await patchTrip(websiteTrip.sourceTripId, {
      route_name: websiteTrip.title,
      notes: websiteTrip.description || websiteTrip.title,
      extra: { website_summary: websiteTrip.summary || "" },
    });
    if (!canonical) throw new Error(`Canonical trip not found: ${websiteTrip.sourceTripId}`);
  }

  // Queue every flagged canonical row without changing its customer data. The
  // next projection recomputes the conflict state from live values.
  await queryNeon(
    "UPDATE travel_trip_entries SET updated_at=NOW() WHERE id=ANY($1::text[])",
    [tripIds],
  );
  let processed = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await flushWebsiteSync(undefined, tripIds.length + 2);
    processed += result.processed;
    const pending = await queryNeon<{ count: number }>(
      "SELECT count(*)::int AS count FROM trip_website_sync WHERE revision>synced_revision",
    );
    if (!Number(pending?.rows[0]?.count)) break;
  }
  const remaining = await queryNeon<{ trip_id: string }>(
    "SELECT trip_id FROM trip_website_sync WHERE content_conflict=TRUE ORDER BY trip_id",
  );
  if (remaining?.rows.length) {
    throw new Error(`Unresolved content conflicts: ${remaining.rows.map(row => row.trip_id).join(", ")}`);
  }
  console.log(JSON.stringify({ reconciled: tripIds.length, processed }, null, 2));
}

main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : "Website trip reconciliation failed");
    process.exitCode = 1;
  })
  .finally(async () => { await closeBookingPool(); });
