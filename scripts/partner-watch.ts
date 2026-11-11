// Checks every trip made from a partner's page against that page again (src/lib/partnerWatch).
//
//   npm run partner:watch                       # check up to 50 trips, apply seat states, record every check
//   npm run partner:watch -- --dry-run          # read and compare only: nothing written, nothing recorded
//   npm run partner:watch -- --trip <trip-id>   # one trip
//
// The same runPartnerWatch runs from /api/cron/partner-watch (GitHub Actions, every 6 hours), so a
// manual run and a scheduled run do exactly the same thing.
import { loadEnvConfig } from "@next/env";
import { runPartnerWatch } from "../src/lib/partnerWatch/run";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main() {
  loadEnvConfig(process.cwd());
  const dryRun = process.argv.includes("--dry-run");
  const tripId = flag("--trip");
  if (process.argv.includes("--trip") && (!tripId || tripId.startsWith("--"))) throw new Error("--trip needs a trip id");
  const results = await runPartnerWatch({ dryRun, tripId });
  if (!results.length) console.log(tripId ? `No trip ${tripId} with a partner page.` : "No trip made from a partner page.");
  for (const result of results) {
    const { applied, pending, notes, ...summary } = result;
    console.log(JSON.stringify({ ...summary, applied: applied.length, pending: pending.length, ...(dryRun ? { dry_run: true } : {}) }));
    for (const line of applied) console.log(`   ✓ ${line.text} — ${line.message}`);
    for (const item of pending) console.log(`   • ${item.text}${item.reason ? ` [${item.reason}]` : ""}${item.instruction ? `  → ${item.instruction}` : ""}`);
    for (const note of notes) console.log(`   ⓘ ${note}`);
  }
  if (results.some((result) => result.status === "failed")) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { closeNeonPool } = await import("../src/lib/neonDb");
    const { closeBookingPool } = await import("../src/lib/websiteTripSync");
    await closeBookingPool();
    await closeNeonPool();
  });
