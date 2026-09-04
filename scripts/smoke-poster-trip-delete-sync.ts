import { deletePosterTrip, savePosterTrip } from "../src/lib/poster/db";
import { deleteTrip } from "../src/lib/travelDb";
import { closeNeonPool, queryNeon } from "../src/lib/neonDb";

const data = {
  title: "DELETE SMOKE TEST",
  duration_days: 1,
  departures: [{ date: "2099-01-01" }],
  price_table: { columns: ["Том хүн"], rows: [{ cells: ["1,000₮"] }] },
  days: [{ day: 1, route: "Test", summary: "Temporary" }],
};

async function countLinked(posterId: string) {
  const poster = await queryNeon<{ count: number }>(
    `SELECT count(*)::int AS count FROM poster_trips WHERE id = $1`,
    [posterId],
  );
  const trip = await queryNeon<{ count: number }>(
    `SELECT count(*)::int AS count
       FROM travel_trip_entries
      WHERE extra->>'poster_trip_id' = $1`,
    [posterId],
  );
  return {
    poster: poster?.rows[0]?.count ?? 0,
    trip: trip?.rows[0]?.count ?? 0,
  };
}

function assertCounts(
  label: string,
  actual: { poster: number; trip: number },
  expected: { poster: number; trip: number },
) {
  if (actual.poster !== expected.poster || actual.trip !== expected.trip) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

async function main() {
  const id1 = `delete-trip-smoke-${Date.now()}`;
  const id2 = `delete-poster-smoke-${Date.now()}`;

  await savePosterTrip({ id: id1, title: "DELETE SMOKE TEST 1", data, source_file: "smoke.pdf" });
  const beforeTripDelete = await countLinked(id1);
  await deleteTrip(`trip-${id1}`);
  const afterTripDelete = await countLinked(id1);

  await savePosterTrip({ id: id2, title: "DELETE SMOKE TEST 2", data, source_file: "smoke.pdf" });
  const beforePosterDelete = await countLinked(id2);
  await deletePosterTrip(id2);
  const afterPosterDelete = await countLinked(id2);

  assertCounts("before trip delete", beforeTripDelete, { poster: 1, trip: 1 });
  assertCounts("after trip delete", afterTripDelete, { poster: 0, trip: 0 });
  assertCounts("before poster delete", beforePosterDelete, { poster: 1, trip: 1 });
  assertCounts("after poster delete", afterPosterDelete, { poster: 0, trip: 0 });

  console.log(JSON.stringify({
    beforeTripDelete,
    afterTripDelete,
    beforePosterDelete,
    afterPosterDelete,
  }, null, 2));
}

main()
  .finally(() => closeNeonPool())
  .catch(async (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
