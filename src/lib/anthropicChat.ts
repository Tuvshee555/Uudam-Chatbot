/**
 * The bot's AI calls on Claude (Anthropic), behind one switch: AI_PROVIDER=anthropic with
 * ANTHROPIC_API_KEY set. Every caller keeps calling askOpenAIChatParts (openaiFallback.ts); that
 * function hands the call here first, and OpenAI answers only as a backup while its key exists.
 *
 * Why (owner, 2026-11-22): "make it only use anthropic key ... can use haiku on absolute stupid or
 * dont need ones". The admin assistant already won on Claude Sonnet 5.5 (anthropicTools.ts).
 *
 * Which Claude model a call gets follows the OpenAI model it asked for:
 * - the cheap mini steps (gpt-4o-mini, gpt-4.1-nano: photo queries and ranking, the health ping,
 *   chat memory, category labels) run on Claude Haiku 5.5 (AI_CLAUDE_FAST_MODEL);
 * - everything else (customer replies, which-trip understanding, files, documents, price photos)
 *   runs on Claude Sonnet 5.5 (AI_CLAUDE_SMART_MODEL).
 * Admin file work (travel.ops.*, price tables, file text) thinks before answering; the customer
 * steps answer at once (thinking off), as fast as the OpenAI models they replace.
 *
 * No temperature is sent (the models refuse non-default sampling). JSON mode becomes a rule in the
 * system text plus taking the one JSON object out of the reply. The system text is cached for an
 * hour, so the reply rules are paid for once per hour, not on every message.
 */
import Anthropic from "@anthropic-ai/sdk";
import { reportAiOutage, type AiFailureKind } from "./aiHealth";
import { aiEnvironment, recordAiUsage } from "./aiUsage";
import { anthropicFailure } from "./assistantAgent/anthropicTools";
import { fixMojibake } from "./encoding";
import { logError, logInfo, logWarn, recordCounter } from "./observability";
import type { OpenAIPart, OpenAIResult } from "./openaiProvider";

export const CLAUDE_SMART_DEFAULT = "claude-sonnet-5-5";
export const CLAUDE_FAST_DEFAULT = "claude-haiku-5-5";
const FAST_OPENAI_MODELS = /^(gpt-4o-mini|gpt-4\.1-nano)/i;
/** Admin and offline file work: worth thinking before answering (no customer is waiting). */
const CAREFUL_SOURCES = /^(travel\.ops|trip_price_table|assistant\.|customer_documents\.pdf)/;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];

export type ClaudeCallOptions = {
  source?: string;
  jsonMode?: boolean;
  timeoutMs?: number;
  maxOutputTokens?: number;
  requestId?: string;
  correlationId?: string;
  /** The OpenAI model the caller asked for (mapped to Claude) or a claude-* id. */
  model?: string;
  systemText?: string;
  truncationExpected?: boolean;
  maxRetries?: number;
  onFailure?: (failure: { kind: AiFailureKind; code?: string; message: string }) => void;
  /**
   * Text that starts the part of the prompt that changes from call to call. Everything before it
   * (a catalogue that is the same all day) is cached for five minutes, so the next messages of the
   * same conversation read it at a tenth of the price. Ignored when the text is not found.
   */
  cacheBefore?: string;
  /** Internal: the fast model is already the second try. */
  alternateModelAttempted?: boolean;
};

export function aiProvider(): "openai" | "anthropic" {
  return String(process.env.AI_PROVIDER || "").trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

/** Claude answers the bot's AI calls: switched on and a key present. */
export function claudeEnabled(): boolean {
  return aiProvider() === "anthropic" && Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/** OpenAI answers when Claude fails, unless switched off (AI_OPENAI_BACKUP=off) or no key. */
export function openaiBackupAllowed(): boolean {
  const setting = String(process.env.AI_OPENAI_BACKUP || "").trim().toLowerCase();
  return setting !== "off" && setting !== "false" && setting !== "0" && Boolean(process.env.OPENAI_API_KEY?.trim());
}

export const claudeSmartModel = () => process.env.AI_CLAUDE_SMART_MODEL?.trim() || CLAUDE_SMART_DEFAULT;
export const claudeFastModel = () => process.env.AI_CLAUDE_FAST_MODEL?.trim() || CLAUDE_FAST_DEFAULT;

/** The Claude model for a call that asked for an OpenAI model. */
export function claudeModelFor(requested: string | undefined, source = ""): string {
  const model = String(requested || "").trim();
  if (/^claude-/i.test(model)) return model;
  // Admin file and catalogue work is never a "simple" step, whatever model its caller names or
  // leaves out: the card rewrite after an answer (travel.ops.ai_clarify, no model named) went to
  // Haiku on 2026-11-22 and was cut off mid-JSON three times («not valid JSON yet»).
  if (CAREFUL_SOURCES.test(source)) return claudeSmartModel();
  return FAST_OPENAI_MODELS.test(model) ? claudeFastModel() : claudeSmartModel();
}

/** Room for an answer when the caller sets none: OpenAI's own output limit was the cap there. */
const UNCAPPED_MAX_TOKENS = 16_384;

const isHaiku = (model: string) => /haiku/i.test(model);

function effortFrom(value: string | undefined, fallback: Effort): Effort {
  const wanted = String(value || "").trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(wanted) ? (wanted as Effort) : fallback;
}

/** Thinking, effort and room for one call. */
export function claudeCallShape(model: string, source: string, maxOutputTokens: number | undefined) {
  const careful = CAREFUL_SOURCES.test(source) && !isHaiku(model);
  const requested = typeof maxOutputTokens === "number" && maxOutputTokens > 0 ? Math.trunc(maxOutputTokens) : UNCAPPED_MAX_TOKENS;
  if (careful) {
    return {
      thinking: { type: "adaptive" as const },
      effort: effortFrom(process.env.AI_CLAUDE_CAREFUL_EFFORT, "medium"),
      // Thinking counts against max_tokens: room for it on top of the answer.
      maxTokens: Math.min(64_000, requested + 16_000),
    };
  }
  return {
    // Haiku turns thinking off with "disabled"; Sonnet 5.5 refuses that and uses "between_tools"
    // (no tools here, so no thinking at all): the customer is waiting.
    thinking: isHaiku(model) ? ({ type: "disabled" as const }) : ({ type: "between_tools" as const }),
    effort: effortFrom(process.env.AI_CLAUDE_EFFORT, isHaiku(model) ? "low" : "medium"),
    maxTokens: requested,
  };
}

const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** The bot's parts as Messages API content: text, images, PDFs; the fixed head cached (cacheBefore). */
export function toClaudeContent(parts: OpenAIPart[], cacheBefore?: string): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  let cached = false;
  for (const part of parts) {
    if ("inlineData" in part) {
      const { mimeType, data } = part.inlineData;
      if (mimeType === "application/pdf") blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      else blocks.push({ type: "image", source: { type: "base64", media_type: (IMAGE_TYPES.has(mimeType) ? mimeType : "image/jpeg") as "image/jpeg", data } });
      continue;
    }
    const at = !cached && cacheBefore ? part.text.indexOf(cacheBefore) : -1;
    if (at > 0) {
      cached = true;
      blocks.push({ type: "text", text: part.text.slice(0, at), cache_control: { type: "ephemeral" } });
      blocks.push({ type: "text", text: part.text.slice(at) });
      continue;
    }
    if (part.text) blocks.push({ type: "text", text: part.text });
  }
  return blocks;
}

const JSON_RULE = "Return exactly one JSON object and nothing else: no explanation, no code fence.";

/** The one JSON object in a reply (a code fence or a stray sentence around it is dropped). */
export function jsonObjectText(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  return start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
}

let shared: Anthropic | null = null;
let clientForTests: Anthropic | null = null;

/** Tests hand in a client with a fake transport; null restores the real one. */
export function setClaudeClientForTests(client: Anthropic | null): void {
  clientForTests = client;
}

function client(): Anthropic {
  if (clientForTests) return clientForTests;
  shared ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return shared;
}

/**
 * One bot AI call on Claude. The same contract as askOpenAIChatParts: the reply text and usage,
 * or null after onFailure was told why. Nothing came back (empty or declined) is "REFER": no
 * answer, a staff lead, never an apology.
 */
export async function askClaudeChatParts(parts: OpenAIPart[], options: ClaudeCallOptions = {}): Promise<OpenAIResult | null> {
  const model = claudeModelFor(options.model, options.source);
  const source = options.source || "unknown";
  const shape = claudeCallShape(model, source, options.maxOutputTokens);
  const system = [options.systemText?.trim(), options.jsonMode ? JSON_RULE : ""].filter(Boolean).join("\n\n");
  const content = toClaudeContent(parts, options.cacheBefore);
  if (!content.length) return null;
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  let response: Anthropic.Message;
  try {
    // Streamed and collected: a long file answer never meets the non-streaming size limit.
    response = await client().messages.stream({
      model,
      max_tokens: shape.maxTokens,
      // The fixed rules cached for an hour: paid once, then read at a tenth of the price.
      ...(system ? { system: [{ type: "text" as const, text: system, cache_control: { type: "ephemeral" as const, ttl: "1h" as const } }] } : {}),
      messages: [{ role: "user", content }],
      thinking: shape.thinking,
      output_config: { effort: shape.effort },
    }, { signal: abort.signal, maxRetries: options.maxRetries ?? 1 }).finalMessage();
  } catch (error) {
    const timedOut = abort.signal.aborted;
    const failure = timedOut ? { kind: "timeout" as const, message: `timed out after ${timeoutMs} ms` } : anthropicFailure(error);
    const kind: AiFailureKind = failure.kind === "timeout" ? "provider" : failure.kind === "no_key" ? "unauthorized" : failure.kind;
    recordCounter("ai.claude_failures_total", 1, { model, source, kind });
    // Overloaded or rate-limited Sonnet: Haiku answers rather than nobody (as gpt-4o-mini did for gpt-4o).
    if ((kind === "quota" || kind === "provider") && !timedOut && !isHaiku(model) && !options.alternateModelAttempted) {
      logInfo("ai.claude_falling_back_to_model", { source, model, fallbackModel: claudeFastModel() });
      const alternate = await askClaudeChatParts(parts, { ...options, model: claudeFastModel(), alternateModelAttempted: true });
      if (alternate) return alternate;
    }
    logError("ai.claude_failed", { provider: "anthropic", source, model, failure_kind: kind, environment: aiEnvironment(), durationMs: Date.now() - startedAt, message: failure.message.slice(0, 300) });
    void reportAiOutage(kind);
    options.onFailure?.({ kind, message: failure.message });
    return null;
  } finally {
    clearTimeout(timer);
  }

  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").trim();
  if (response.stop_reason === "refusal") logWarn("ai.claude_refusal", { source, model, category: response.stop_details?.category ?? null });
  // A deliberately one-token ping (daily_health_check) often has no text on Claude: that is no failure, and it put a
  // false warning in the admin system check every day (2026-11-23).
  else if (!text && !options.truncationExpected) logWarn("ai.claude_empty_completion", { source, model, stop: response.stop_reason });
  else if (response.stop_reason === "max_tokens" && !options.truncationExpected) logWarn("ai.claude_incomplete_completion", { source, model, stop: response.stop_reason });
  const answer = response.stop_reason === "refusal" || !text ? "REFER" : options.jsonMode ? jsonObjectText(text) : text;

  const cacheRead = response.usage.cache_read_input_tokens ?? 0;
  const cacheWrite = response.usage.cache_creation_input_tokens ?? 0;
  const promptTokens = response.usage.input_tokens + cacheRead + cacheWrite;
  const usage = { prompt_tokens: promptTokens, completion_tokens: response.usage.output_tokens, total_tokens: promptTokens + response.usage.output_tokens };
  recordCounter("ai.claude_success_total", 1, { model, source });
  recordAiUsage({ model, source, usage: { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, cached_tokens: cacheRead } });
  logInfo("ai.claude_success", { source, model, durationMs: Date.now() - startedAt, usage, cacheRead, cacheWrite, stop: response.stop_reason });
  return { text: fixMojibake(answer), usage };
}
