/**
 * One typed instruction in, one reply out: the brain first (assistantBrain.ts), the
 * model only for what the brain does not understand. The reply is either a proposal
 * saved as a change request, a question with choices, or a short note that nothing
 * needs changing.
 */
import { think, type AssistantAskPayload } from "./assistantBrain";
import { logInfo } from "./observability";
import { ensureTravelSchema, listTrips } from "./travelDb";
import { generateAIProposal, persistProposal } from "./travelAI";
import type { AIChangeProposal } from "./travelTypes";

export type AssistantReply =
  | { kind: "proposal"; proposal: AIChangeProposal; request_id: number | null; source: "brain" | "model" }
  | { kind: "ask"; ask: AssistantAskPayload }
  | { kind: "note"; text: string };

export async function generateAssistantReply(instruction: string, options: { context?: string; now?: Date } = {}): Promise<AssistantReply> {
  const ready = await ensureTravelSchema();
  const trips = ready ? await listTrips({ limit: 250, includeArchived: true }) : [];
  if (trips.length) {
    const outcome = think({ text: instruction, trips, now: options.now, context: options.context });
    logInfo("assistant.brain", { outcome: outcome.kind, intent: outcome.intent.kind, trip: "trip" in outcome && outcome.trip ? outcome.trip.id : undefined });
    if (outcome.kind === "proposal") {
      const request_id = await persistProposal(instruction, outcome.proposal);
      return { kind: "proposal", proposal: outcome.proposal, request_id, source: "brain" };
    }
    if (outcome.kind === "ask") return { kind: "ask", ask: outcome.ask };
    if (outcome.kind === "note") return { kind: "note", text: outcome.text };
    const generated = await generateAIProposal(instruction, { context: options.context, trips, focusTrips: outcome.focus });
    return { kind: "proposal", proposal: generated.proposal, request_id: generated.request_id, source: "model" };
  }
  const generated = await generateAIProposal(instruction, { context: options.context, trips });
  return { kind: "proposal", proposal: generated.proposal, request_id: generated.request_id, source: "model" };
}
