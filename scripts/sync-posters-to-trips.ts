import { closeNeonPool, queryNeon } from "../src/lib/neonDb";
import { syncAllPosterTrips } from "../src/lib/poster/db";

function backupSuffix() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

async function countRows(table: string) {
  const result = await queryNeon<{ count: number }>(
    `SELECT count(*)::int AS count FROM ${table}`,
  );
  return result?.rows[0]?.count ?? 0;
}

async function main() {
  const backup = `travel_trip_entries_backup_${backupSuffix()}`;
  const beforeTrips = await countRows("travel_trip_entries");

  await queryNeon(`CREATE TABLE ${backup} AS TABLE travel_trip_entries`);
  await queryNeon(`DELETE FROM travel_trip_entries`);

  const synced = await syncAllPosterTrips();
  const afterTrips = await countRows("travel_trip_entries");
  const linkedTrips = await queryNeon<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM travel_trip_entries
      WHERE COALESCE(extra->>'poster_trip_id', '') <> ''`,
  );

  console.log(JSON.stringify({
    backup,
    beforeTrips,
    synced,
    afterTrips,
    linkedTrips: linkedTrips?.rows[0]?.count ?? 0,
  }, null, 2));
}

main()
  .finally(() => closeNeonPool())
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
