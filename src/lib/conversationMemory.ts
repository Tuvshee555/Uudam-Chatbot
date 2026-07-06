import { askGemini } from "./gemini";
import {
  dbGetCustomerMemory,
  dbGetHistorySince,
  dbUpsertCustomerMemory,
  type HistoryRow,
} from "./travelDb";
import { classifyError, logWarn, recordCounter } from "./observability";

const EMPTY_MEMORY = "";
const MAX_MEMORY_CHARS = 12_000;
const MEMORY_TRANSCRIPT_LIMIT = 80;

export function normalizeCustomerMemoryText(text: string): string {
  return (text || "")
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/\r/g, "")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_MEMORY_CHARS);
}

function formatTranscript(rows: HistoryRow[]): string {
  return rows
    .map((row) => {
      const role = row.role === "user" ? "Customer" : "Assistant";
      const timestamp = row.created_at ? ` (${row.created_at})` : "";
      const attachmentNote = row.attachments.length
        ? ` [attachments: ${row.attachments.map((a) => a.type).join(", ")}]`
        : "";
      return `${role}${timestamp}${attachmentNote}: ${row.text}`;
    })
    .join("\n");
}

export function buildCustomerMemoryPrompt(input: {
  existingMemory: string;
  transcript: string;
}) {
  const existing = input.existingMemory.trim() || "No durable memory yet.";
  return [
    "You maintain long-term memory for a Mongolian travel agency chatbot.",
    "",
    "Update the customer's durable memory using ONLY the existing memory and the new transcript.",
    "Return the complete updated memory, not a diff.",
    "",
    "Memory must be structured and useful before future replies. Preserve every important fact, preference, decision, unresolved issue, product/trip discussed, objection, contact detail, and changed mind.",
    "If the customer contradicts or changes a previous preference/decision, keep the newest understanding and remove or mark the older one as outdated.",
    "Do not invent facts. Do not include generic chatbot behavior. Do not store trivial greetings, jokes, or repeated wording unless it changes intent.",
    "Keep details specific enough to resolve references like 'the one we talked about yesterday', 'same as before', 'next week', or 'that trip'.",
    "Use concise bullets under these headings:",
    "Customer identity/contact",
    "Preferences and constraints",
    "Trips/products discussed",
    "Decisions and current status",
    "Unresolved questions/follow-ups",
    "Important context notes",
    "",
    "Existing memory:",
    existing,
    "",
    "New transcript:",
    input.transcript.trim(),
    "",
    "Updated memory:",
  ].join("\n");
}

export async function getCustomerMemoryText(senderId: string): Promise<string> {
  const memory = await dbGetCustomerMemory(senderId);
  return normalizeCustomerMemoryText(memory?.memory_text || EMPTY_MEMORY);
}

export async function updateCustomerMemoryAfterTurn(input: {
  senderId: string;
  requestId?: string;
  correlationId?: string;
  source?: string;
}): Promise<void> {
  const source = input.source || "conversation_memory";
  try {
    const existing = await dbGetCustomerMemory(input.senderId);
    const lastConversationId = Number(existing?.last_conversation_id || 0);
    const rows = await dbGetHistorySince(
      input.senderId,
      lastConversationId,
      MEMORY_TRANSCRIPT_LIMIT,
    );
    if (rows.length === 0) return;

    const transcript = formatTranscript(rows);
    const prompt = buildCustomerMemoryPrompt({
      existingMemory: existing?.memory_text || EMPTY_MEMORY,
      transcript,
    });
    const result = await askGemini(prompt, {
      requestId: input.requestId,
      correlationId: input.correlationId,
      source,
      temperature: 0,
      maxOutputTokens: 2500,
    });
    const nextMemory = normalizeCustomerMemoryText(result.text);
    if (!nextMemory) return;

    const newestConversationId = Math.max(...rows.map((row) => row.id));
    await dbUpsertCustomerMemory({
      senderId: input.senderId,
      memoryText: nextMemory,
      lastConversationId: newestConversationId,
    });
    recordCounter("conversation_memory.updated_total", 1, { source });
  } catch (error) {
    recordCounter("conversation_memory.update_failed_total", 1, {
      source,
      category: classifyError(error).category,
    });
    logWarn("conversation_memory.update_failed", {
      requestId: input.requestId,
      correlationId: input.correlationId,
      source,
      classification: classifyError(error),
    });
  }
}
