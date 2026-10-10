/**
 * Read-only: does the bot reject any of its own answers about the live catalog?
 * Every rejection is a customer who would get silence. No AI calls.
 *   npm run audit:self-consistency
 */
import { listTrips } from "../src/lib/travelDb";
import { closeNeonPool } from "../src/lib/neonDb";
import { checkSelfConsistency } from "../src/lib/selfConsistency";

async function main() {
  const report = checkSelfConsistency(await listTrips());
  const pct = report.answers ? Math.round((100 * report.failures.length) / report.answers) : 0;
  console.log(`Live trips: ${report.trips}. Answers built: ${report.answers}. Rejected by the bot's own checker: ${report.failures.length} (${pct}%).`);
  for (const failure of report.failures) {
    console.log(`\n✗ ${failure.routeName} — ${failure.question}\n${failure.reply.split("\n").slice(0, 12).join("\n")}`);
  }
  if (report.failures.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 2;
  })
  .finally(() => closeNeonPool().catch(() => {}));
