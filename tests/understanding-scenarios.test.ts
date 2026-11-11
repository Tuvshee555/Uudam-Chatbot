import test from "node:test";
import { SCENARIOS } from "./helpers/understandingScenarios";
import { loadOpenScenarios, runScenarios, type RunMode } from "./helpers/understandingScenarioRunner";

/**
 * Conversation-level UNDERSTANDING scenario suite: customer conversations replayed through the
 * signed webhook on an invented catalogue (mocked clock: November 2026) with a mocked model,
 * judged by assertable predicates on what the customer would see (tests/helpers/understandingScenarioTypes.ts).
 * It measures understanding, not keywords: the same need is asked in Cyrillic, Latin and with
 * typos, with and without a model, while staff own the chat, and ordinary questions must still
 * be answered (positive controls) so over-caution shows up as failures too.
 *
 * Environment (all optional):
 *  SCENARIO_MODE    assert (default): every scenario is a subtest that fails on a failed predicate; scenarios
 *                   listed in tests/fixtures/understanding-scenarios-open.json run as test.todo (known open,
 *                   visible, never silently dropped).
 *                   strict: like assert, but the open list is ignored.
 *                   report: nothing ever fails; use with SCENARIO_REPORT to measure a branch.
 *  SCENARIO_REPORT  path of the JSON report (array of rows, see ReportRow).
 *  SCENARIO_ONLY    regular expression on scenario ids.
 *  SCENARIO_DUMP=1  print every turn with its reply and verdict.
 * Compare two reports with: node scripts/conversation-scenario-report.mjs before.json after.json
 *
 * This is a designed scenario set, not production accuracy: its pass rates must never be quoted as one.
 */
test("understanding scenarios", async (context) => {
  const requested = process.env.SCENARIO_MODE;
  const mode: RunMode = requested === "report" || requested === "strict" ? requested : "assert";
  const rows = await runScenarios(context, SCENARIOS, {
    mode,
    reportPath: process.env.SCENARIO_REPORT || undefined,
    only: process.env.SCENARIO_ONLY ? new RegExp(process.env.SCENARIO_ONLY) : undefined,
    dump: process.env.SCENARIO_DUMP === "1",
    open: mode === "assert" ? loadOpenScenarios() : undefined,
  });
  const judged = rows.filter((row) => !row.setup);
  const failed = judged.filter((row) => row.verdict === "fail");
  console.log(`UNDERSTANDING_SCENARIOS mode=${mode} scenarios=${new Set(rows.map((row) => row.id)).size} judged_turns=${judged.length} pass=${judged.length - failed.length} fail=${failed.length}`);
});
