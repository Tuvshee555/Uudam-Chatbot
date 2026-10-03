import { recordCounter, recordHistogram } from "./observability";
import { replyPreferences } from "./chatbotReplyPolicy";

/** Aggregate diagnostics only; never customer text, IDs, destinations or phones. */
export function recordReplyPresentation(input: {
  reply: string; userText: string; path: "demo" | "webhook_code" | "webhook_ai"; latencyMs?: number;
}) {
  const tags = { path: input.path, detail: replyPreferences(input.userText).full ? "full" : "compact" };
  recordCounter("chatbot.reply_generated_total", 1, tags);
  recordHistogram("chatbot.reply_characters", input.reply.length, tags);
  recordHistogram("chatbot.reply_lines", input.reply.split("\n").filter((line) => line.trim()).length, tags);
  if (input.latencyMs !== undefined) recordHistogram("chatbot.reply_generation_latency_ms", input.latencyMs, tags);
  // A diagnostic, not a quality grade: a multi-part question may need more text.
  if (!replyPreferences(input.userText).full && input.reply.length > 700) recordCounter("chatbot.long_compact_reply_total", 1, tags);
}

export function recordPrimaryReplyDelivery(input: {
  path: "webhook_code" | "webhook_ai"; accepted: boolean; latencyMs: number;
}) {
  const tags = { path: input.path, outcome: input.accepted ? "accepted" : "failed" };
  recordCounter("chatbot.primary_reply_delivery_total", 1, tags);
  recordHistogram("chatbot.primary_reply_delivery_latency_ms", input.latencyMs, tags);
}
