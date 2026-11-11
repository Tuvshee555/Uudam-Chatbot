import { CASE_SCENARIOS } from "./understandingScenarioCases";
import { CLASS_SCENARIOS } from "./understandingScenarioClasses";
import { OWNER_SCENARIOS } from "./understandingScenarioOwner";
import type { Scenario } from "./understandingScenarioTypes";

export * from "./understandingScenarioTypes";
export { CATALOGUE, ARCHIVED, titleOf } from "./understandingCatalogue";

/**
 * The scenario list of the understanding suite: the owner's 17 historical conversations
 * (CASE-1 .. CASE-17) with unseen paraphrases, the owner's ten paraphrases (OP-1 .. OP-10),
 * and the need classes around them (positive controls, staff takeover, provider down, policies,
 * services, existing booking, missing external data, context, several constraints at once).
 */
export const SCENARIOS: Scenario[] = [...CASE_SCENARIOS, ...OWNER_SCENARIOS, ...CLASS_SCENARIOS];

const seen = new Set<string>();
for (const entry of SCENARIOS) {
  if (seen.has(entry.id)) throw new Error(`understanding scenarios: duplicate id ${entry.id}`);
  seen.add(entry.id);
  if (!entry.turns.length) throw new Error(`understanding scenarios: ${entry.id} has no turns`);
}
