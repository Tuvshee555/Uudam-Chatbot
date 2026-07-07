import { waitUntil } from "@vercel/functions";
import { askGemini } from "./gemini";
import {
  dbGetCustomerMemory,
  dbGetHistorySince,
  dbUpsertCustomerMemory,
  type HistoryRow,
} from "./travelDb";
import { getCustomerDocumentMemoryText } from "./customerDocuments";
import { classifyError, logWarn, recordCounter } from "./observability";

const EMPTY_MEMORY = "";
const MAX_MEMORY_CHARS = 12_000;
const MEMORY_TRANSCRIPT_LIMIT = 80;
// Must comfortably exceed MAX_MEMORY_CHARS in tokens (Mongolian Cyrillic runs
// ~1.5-2 chars/token). The previous 2,500 cap silently truncated any memory
// past ~4-5k chars on EVERY merge — the tail headings (unresolved questions,
// context notes) were amputated and the loss compounded merge after merge.
const MEMORY_MAX_OUTPUT_TOKENS = 8_192;
// A failed merge is retried naturally on the next turn (rows are never pruned
// before the cursor covers them), so this call gets a tight budget instead of
// the 45s/2-retry default that used to block the webhook.
const MEMORY_TIMEOUT_MS = 10_000;

/**
 * True when a proposed merged memory looks like the model dropped a large part
 * of the existing memory (output truncation, bad generation). Saving such a
 * merge would permanently destroy accumulated facts — the caller must keep the
 * old memory and NOT advance the cursor so the merge retries next turn.
 */
export function isSuspiciousMemoryShrink(previous: string, next: string): boolean {
  const prev = previous.trim();
  if (prev.length < 800) return false; // small memories legitimately fluctuate
  return next.trim().length < prev.length * 0.5;
}

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
  const base = normalizeCustomerMemoryText(memory?.memory_text || EMPTY_MEMORY);
  const attachmentMemory = await getCustomerDocumentMemoryText(senderId).catch(() => "");
  return normalizeCustomerMemoryText(
    [base, attachmentMemory].filter((part) => part.trim()).join("\n\n"),
  );
}

/**
 * Runs the memory merge WITHOUT blocking the reply path. On Vercel, waitUntil
 * keeps the work alive after the response is sent; anywhere else it degrades
 * to a detached promise (updateCustomerMemoryAfterTurn never rejects — every
 * failure is caught, counted, and retried naturally on the next turn).
 *
 * The old pattern awaited the merge inline while holding the per-conversation
 * lock: a 45s-timeout, 2-retry Gemini call serialized behind every reply,
 * so a customer sending three quick messages could wait a minute+ for the
 * third answer.
 */
export function scheduleCustomerMemoryUpdate(input: {
  senderId: string;
  requestId?: string;
  correlationId?: string;
  source?: string;
}): void {
  const work = updateCustomerMemoryAfterTurn(input);
  try {
    waitUntil(work);
  } catch {
    // Not running on Vercel (tests, local node) — detached execution is fine.
    void work;
  }
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
      maxOutputTokens: MEMORY_MAX_OUTPUT_TOKENS,
      timeoutMs: MEMORY_TIMEOUT_MS,
      maxRetries: 0,
    });
    const nextMemory = normalizeCustomerMemoryText(result.text);
    if (!nextMemory) return;
    if (isSuspiciousMemoryShrink(existing?.memory_text || "", nextMemory)) {
      recordCounter("conversation_memory.suspicious_shrink_total", 1, { source });
      logWarn("conversation_memory.suspicious_shrink_rejected", {
        requestId: input.requestId,
        correlationId: input.correlationId,
        source,
        previousChars: (existing?.memory_text || "").length,
        proposedChars: nextMemory.length,
      });
      return;
    }

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
