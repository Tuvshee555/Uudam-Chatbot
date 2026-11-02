/**
 * HELD-OUT evaluation set. Written only after the engine changes are frozen; never tuned against.
 * Empty until then (scripts/chatbot-eval.ts refuses to score an empty set as a result).
 */
import type { EvalCase } from "./dev.cases";

export const heldoutCases: EvalCase[] = [];
