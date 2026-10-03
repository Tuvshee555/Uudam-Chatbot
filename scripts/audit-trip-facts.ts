import { auditTripCatalog } from "../src/lib/tripDataValidation";
import { closeNeonPool, withNeonClient } from "../src/lib/neonDb";

async function main() {
  // Raw rows expose legacy defects. Catalog read helpers can perform maintenance.
  const report = await withNeonClient(async client => {
    await client.query("BEGIN READ ONLY");
    try {
      const result = await client.query("SELECT * FROM travel_trip_entries ORDER BY id");
      const audit = auditTripCatalog(result.rows);
      await client.query("COMMIT");
      return audit;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  });
  if (!report) throw new Error("Database is not configured; no catalog was audited.");
  const output = process.argv.includes("--summary") ? {
    total: report.total,
    tripsWithErrors: report.tripsWithErrors,
    tripsWithWarnings: report.tripsWithWarnings,
    issueCounts: report.results.flatMap(result => result.issues).reduce<Record<string, number>>((counts, issue) => {
      counts[issue.code] = (counts[issue.code] || 0) + 1;
      return counts;
    }, {}),
  } : report;
  console.log(JSON.stringify(output, null, 2));
  if (report.tripsWithErrors > 0) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}).finally(() => closeNeonPool());
