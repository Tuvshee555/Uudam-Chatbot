// Mirrors partner tour pages into poster trips.
//
//   node --import tsx scripts/sync-global-travel.ts            # sync every configured tour
//   node --import tsx scripts/sync-global-travel.ts --dry-run  # show what would change, write nothing
//   node --import tsx scripts/sync-global-travel.ts --force    # write even when the page is unchanged
//
// On a schedule this runs through /api/cron/partner-sync instead; both call runPartnerSync, so a
// manual run and a scheduled run do exactly the same thing. See src/lib/partnerSync/run.ts.
import { loadEnvConfig } from "@next/env";
import { runPartnerSync } from "../src/lib/partnerSync/run";

async function main() {
  loadEnvConfig(process.cwd());
  const flags = { dryRun: process.argv.includes("--dry-run"), force: process.argv.includes("--force") };
  const results = await runPartnerSync(flags);
  for (const result of results) {
    const { lines, ...summary } = result;
    console.log(JSON.stringify({ ...summary, changes: lines.length }));
    for (const line of lines) console.log("   " + line);
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
    await closeNeonPool();
  });
