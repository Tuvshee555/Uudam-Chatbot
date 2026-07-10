/**
 * Pre-answer reasoning step for the AI reply path.
 *
 * Before the final customer-facing reply is generated, a small, fast model
 * call analyzes the whole relationship — persistent customer memory, recent
 * conversation, and the current message — and produces a short private
 * analysis: the customer's real intent, what a vague reference ("тэр",
 * "same as before", "өчигдөр ярьсан") actually points to, which memory facts
 * matter, what was already explained (so the reply doesn't repeat it), and
 * whether the customer changed their mind.
 *
 * The analysis is injected into buildPrompt as a private block the answer
 * model must follow but never reveal. This step is a best-effort ENHANCEMENT:
 * any failure (timeout, outage, empty output) returns null and the reply path
 * continues exactly as it did without it. It must never block or break a
 * customer reply.
 *
 * Fast paths (price/seats/discount/compare/program) intentionally skip this —
 * they are deterministic and instant. Only messages that already require the
 * AI model get the extra reasoning call.
 */

import { askGemini } from "./gemini";
import { buildTemporalPromptContext } from "./travelDates";
import { isGenericConfirmationText } from "./travelFastPathsSearch";
import { classifyError, logWarn, recordCounter } from "./observability";

type ReasoningHistoryMessage = { role: "user" | "assistant"; text: string };

const MAX_HISTORY_TURNS = 12;
const MAX_HISTORY_LINE_CHARS = 300;
const MAX_TRIP_INDEX_LINES = 80;
const MAX_ANALYSIS_CHARS = 1_600;
const REASONING_TIMEOUT_MS = 12_000;
const REASONING_MAX_OUTPUT_TOKENS = 400;

/** Compact one-line-per-trip index so vague references can be resolved to a real trip name. */
export function buildTripIndexLines(
  trips: Array<{ route_name?: string | null; category?: string | null; duration_text?: string | null }>,
): string[] {
  const lines: string[] = [];
  for (const trip of trips) {
    const name = (trip.route_name || "").trim();
    if (!name) continue;
    const extras = [
      trip.category,
      isGenericConfirmationText(trip.duration_text) ? "" : trip.duration_text,
    ]
      .map((value) => (value || "").trim())
      .filter(Boolean)
      .join(", ");
    lines.push(extras ? `- ${name} (${extras})` : `- ${name}`);
    if (lines.length >= MAX_TRIP_INDEX_LINES) break;
  }
  return lines;
}

function formatHistoryForReasoning(history: ReasoningHistoryMessage[]): string[] {
  return history.slice(-MAX_HISTORY_TURNS).map((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    const text = message.text.length > MAX_HISTORY_LINE_CHARS
      ? `${message.text.slice(0, MAX_HISTORY_LINE_CHARS)}…`
      : message.text;
    return `${role}: ${text}`;
  });
}

export function buildReasoningPrompt(input: {
  customerMemory: string;
  history: ReasoningHistoryMessage[];
  userText: string;
  tripIndexLines: string[];
}): string {
  const lines: string[] = [];
  lines.push(
    "You are the private planning step for a Mongolian travel agency chatbot. Analyze the conversation BEFORE the reply is written. Output a short analysis only — NOT a customer reply.",
  );
  lines.push("");
  lines.push("Rules:");
  lines.push("- Base the analysis ONLY on the memory, conversation, and current message below. Never invent trips, prices, dates, or facts.");
  lines.push("- If the current message references something earlier ('тэр', 'энэ', 'өчигдөр ярьсан', 'same as before', 'дахиад', 'нөгөөх'), name exactly what it refers to, using the known trip names when one matches.");
  lines.push("- If the customer changed their mind versus an earlier preference or decision, the newest message wins — state what changed.");
  lines.push("- Note what has ALREADY been explained to this customer so the reply does not repeat it word-for-word.");
  lines.push("- If the detail the customer needs is not in memory or conversation, say the reply must come from the business Context or REFER — never suggest guessing.");
  lines.push("");
  lines.push("Output exactly these labeled lines (each 1-2 short sentences; write 'none' when empty):");
  lines.push("Intent: ...");
  lines.push("Refers to: ...");
  lines.push("Key memory facts: ...");
  lines.push("Already explained: ...");
  lines.push("Changed mind: ...");
  lines.push("Reply must: ...");
  lines.push("");
  lines.push("Time context:");
  lines.push(buildTemporalPromptContext(input.userText));
  lines.push("");
  if (input.tripIndexLines.length > 0) {
    lines.push("Known trips (names only, for resolving references):");
    lines.push(...input.tripIndexLines);
    lines.push("");
  }
  lines.push("Persistent customer memory:");
  lines.push(input.customerMemory.trim() || "(none yet)");
  lines.push("");
  const historyLines = formatHistoryForReasoning(input.history);
  if (historyLines.length > 0) {
    lines.push("Recent conversation:");
    lines.push(...historyLines);
    lines.push("");
  }
  lines.push(`Current message: ${input.userText}`);
  lines.push("");
  lines.push("Analysis:");
  return lines.join("\n");
}

export function normalizeReasoningText(text: string): string {
  return (text || "")
    .replace(/^```(?:markdown|md|text)?\s*/i, "")
    .replace(/```$/i, "")
    .replace(/\r/g, "")
    .trim()
    .slice(0, MAX_ANALYSIS_CHARS);
}

/**
 * Runs the pre-answer analysis. Returns the analysis text, or null when it
 * cannot be produced — callers must treat null as "answer without analysis",
 * never as an error.
 */
export async function analyzeBeforeReply(input: {
  customerMemory: string;
  history: ReasoningHistoryMessage[];
  userText: string;
  tripIndexLines: string[];
  requestId?: string;
  correlationId?: string;
  source?: string;
}): Promise<string | null> {
  const source = input.source || "reply_reasoning";
  if (!input.userText.trim()) return null;
  try {
    const prompt = buildReasoningPrompt({
      customerMemory: input.customerMemory,
      history: input.history,
      userText: input.userText,
      tripIndexLines: input.tripIndexLines,
    });
    const result = await askGemini(prompt, {
      requestId: input.requestId,
      correlationId: input.correlationId,
      source,
      temperature: 0,
      maxOutputTokens: REASONING_MAX_OUTPUT_TOKENS,
      timeoutMs: REASONING_TIMEOUT_MS,
      maxRetries: 0,
      preferOpenAI: true,
    });
    const analysis = normalizeReasoningText(result.text);
    if (!analysis) return null;
    recordCounter("reply_reasoning.completed_total", 1, { source });
    return analysis;
  } catch (error) {
    recordCounter("reply_reasoning.failed_total", 1, {
      source,
      category: classifyError(error).category,
    });
    logWarn("reply_reasoning.failed", {
      requestId: input.requestId,
      correlationId: input.correlationId,
      source,
      classification: classifyError(error),
    });
    return null;
  }
}
