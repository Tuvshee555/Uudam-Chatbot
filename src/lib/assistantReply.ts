/**
 * One typed instruction in, one reply out: the brain first (assistantBrain.ts), the
 * model only for what the brain does not understand. The reply is either a proposal
 * saved as a change request, a question with choices, or a short note that nothing
 * needs changing.
 *
 * Three stops sit in front of the model: no database (nothing could be saved or
 * applied, so the admin is told instead of being shown a proposal that cannot work),
 * the day's spend at AI_DAILY_BUDGET_USD (the deterministic edits keep working), and a
 * bulk paste (a price list is not one instruction; the brain would read one line of it).
 */
import { think, type AssistantAskPayload } from "./assistantBrain";
import { aiBudgetMessage, aiBudgetState } from "./aiUsage";
import { logError, logInfo, recordCounter } from "./observability";
import { ensureTravelSchema, listTrips } from "./travelDb";
import { generateAIProposal, persistProposal } from "./travelAI";
import type { AIChangeProposal } from "./travelTypes";

export type AssistantReply =
  | { kind: "proposal"; proposal: AIChangeProposal; request_id: number | null; source: "brain" | "model" }
  | { kind: "ask"; ask: AssistantAskPayload }
  | { kind: "note"; text: string };

export const DB_DOWN_NOTE = "Өгөгдлийн сан холбогдоогүй байна — одоогоор өөрчлөлт хадгалах, хэрэгжүүлэх боломжгүй. Хэдэн минутын дараа дахин оролдоно уу; үргэлжилбэл «Систем» хэсгийг шалгаарай.";

// A paste this big is a list, not an instruction: the model reads it whole (and in
// batches when it is a price list), the brain never reads one line of it as the command.
const BULK_CHARS = 1_500;
const BULK_LINES = 8;

export function looksLikeBulkText(instruction: string): boolean {
  return instruction.length >= BULK_CHARS || instruction.split(/\r?\n/).filter((line) => line.trim()).length >= BULK_LINES;
}

async function modelReply(instruction: string, options: { context?: string; trips: Awaited<ReturnType<typeof listTrips>>; focusTrips?: Awaited<ReturnType<typeof listTrips>> }): Promise<AssistantReply> {
  const budget = await aiBudgetState();
  if (budget.exceeded) {
    recordCounter("ai.budget_stop_total", 1, { route: "api.admin.ai_change" });
    return { kind: "note", text: aiBudgetMessage(budget) };
  }
  const generated = await generateAIProposal(instruction, { context: options.context, trips: options.trips, focusTrips: options.focusTrips });
  return { kind: "proposal", proposal: generated.proposal, request_id: generated.request_id, source: "model" };
}

export async function generateAssistantReply(instruction: string, options: { context?: string; now?: Date } = {}): Promise<AssistantReply> {
  const ready = await ensureTravelSchema().catch(() => false);
  if (!ready) return { kind: "note", text: DB_DOWN_NOTE };
  let trips: Awaited<ReturnType<typeof listTrips>>;
  try {
    trips = await listTrips({ limit: 250, includeArchived: true });
  } catch (error) {
    // A warm instance keeps "schema ensured" while the database goes away: the read fails here.
    logError("assistant.catalogue_unreadable", { message: error instanceof Error ? error.message : String(error) });
    return { kind: "note", text: DB_DOWN_NOTE };
  }
  if (!trips.length) return modelReply(instruction, { context: options.context, trips });
  if (looksLikeBulkText(instruction)) {
    // Pages of text with not one number in them are neither a price list nor an instruction.
    if (!/\d/.test(instruction)) return { kind: "note", text: "Энэ урт текстэнд огноо, үнэ, тоо алга — юуг өөрчлөхийг нэг өгүүлбэрээр бичээрэй, эсвэл файлаа оруулаарай." };
    return modelReply(instruction, { context: options.context, trips });
  }
  const outcome = think({ text: instruction, trips, now: options.now, context: options.context });
  logInfo("assistant.brain", { outcome: outcome.kind, intent: outcome.intent.kind, trip: "trip" in outcome && outcome.trip ? outcome.trip.id : undefined });
  if (outcome.kind === "proposal") {
    const request_id = await persistProposal(instruction, outcome.proposal);
    return { kind: "proposal", proposal: outcome.proposal, request_id, source: "brain" };
  }
  if (outcome.kind === "ask") return { kind: "ask", ask: outcome.ask };
  if (outcome.kind === "note") return { kind: "note", text: outcome.text };
  return modelReply(instruction, { context: options.context, trips, focusTrips: outcome.focus });
}
