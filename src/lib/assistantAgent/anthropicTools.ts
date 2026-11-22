/**
 * The admin assistant's agent loop on Claude (Anthropic Messages API, tool use), behind a switch:
 * ASSISTANT_PROVIDER=anthropic (deps.ts). OpenAI's gpt-4.1 (openaiTools.ts) stays the default.
 *
 * Why (owner, 2026-11-22): "maybe lower the model and we can try it like sonnet" — the same
 * replays are run on both models and the one that asks, understands and proposes better is kept.
 *
 * The loop speaks one message format (types.ts ChatMessage, OpenAI-shaped); this file turns it into
 * a Messages API request and the response back:
 * - system messages become the top-level `system`; tool results go back as `tool_result` blocks of
 *   one user message (parallel results together); the model's own content blocks (thinking blocks
 *   included) are kept in `raw` and sent back unchanged, as the API requires.
 * - No forced tool choice on Claude Sonnet 5.5 (a 400): `auto`, and the prompt says to end every turn
 *   with one terminal tool; the loop already reads a text-only answer as a reply.
 * - The prompt prefix (system, tools, the documents in the first message) is cached automatically.
 * - Effort defaults to `medium` (ASSISTANT_ANTHROPIC_EFFORT), the starting point for multistep tool use.
 * - A safety decline is re-run server-side on a fallback model (`fallbacks: "default"`); one that still
 *   declines ends the turn as a model failure.
 * Usage is recorded like every AI call (aiUsage), so the System page shows the spend per model.
 */
import Anthropic from "@anthropic-ai/sdk";
import { reportAiOutage, type AiFailureKind } from "../aiHealth";
import { recordAiUsage } from "../aiUsage";
import { logError, logInfo } from "../observability";
import { AGENT_SOURCE, AgentModelError } from "./openaiTools";
import type { ChatFn, ChatMessage, ChatResult, ToolCall, ToolDefinition } from "./types";

export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5-5";
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Effort = (typeof EFFORTS)[number];
// Room for the model's thinking as well as the reply (a 60-line description section for two trips).
const MIN_MAX_TOKENS = 16_000;
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

type MessageParam = Anthropic.Beta.BetaMessageParam;
type ContentBlockParam = Anthropic.Beta.BetaContentBlockParam;

export function anthropicEffort(value = process.env.ASSISTANT_ANTHROPIC_EFFORT): Effort {
  const wanted = String(value || "").trim().toLowerCase();
  return (EFFORTS as readonly string[]).includes(wanted) ? (wanted as Effort) : "medium";
}

function toolInput(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The loop's messages as a Messages API request: one system text, user and assistant turns alternating. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: MessageParam[] } {
  const system: string[] = [];
  const out: MessageParam[] = [];
  const pushUser = (blocks: ContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last?.role === "user" && Array.isArray(last.content)) last.content.push(...blocks);
    else out.push({ role: "user", content: blocks });
  };
  for (const message of messages) {
    if (message.role === "tool") { pushUser([{ type: "tool_result", tool_use_id: message.tool_call_id, content: message.content }]); continue; }
    if (message.role !== "assistant") {
      if (message.role === "system") system.push(message.content);
      else pushUser([{ type: "text", text: message.content }]);
      continue;
    }
    // The model's own turn: its blocks exactly as it sent them (thinking blocks must come back unchanged).
    if (Array.isArray(message.raw) && message.raw.length) { out.push({ role: "assistant", content: message.raw as ContentBlockParam[] }); continue; }
    const blocks: ContentBlockParam[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.tool_calls || []) blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: toolInput(call.function.arguments) });
    if (blocks.length) out.push({ role: "assistant", content: blocks });
  }
  return { system: system.join("\n\n"), messages: out };
}

/** The loop's function tools as Messages API tools (the same JSON schemas). */
export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Beta.BetaTool[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: { type: "object", ...tool.function.parameters } as Anthropic.Beta.BetaTool.InputSchema,
  }));
}

/** A Messages API response as the loop's result: the text, the tool calls, the blocks to send back, the usage. */
export function fromAnthropicMessage(response: Anthropic.Beta.BetaMessage): ChatResult {
  const text = response.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
  const calls: ToolCall[] = response.content.flatMap((block) => (block.type === "tool_use"
    ? [{ id: block.id, type: "function" as const, function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) } }]
    : []));
  const usage = response.usage;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const prompt = usage.input_tokens + cacheRead + cacheWrite;
  return {
    message: { content: text || null, ...(calls.length ? { tool_calls: calls } : {}), raw: response.content },
    usage: { prompt_tokens: prompt, completion_tokens: usage.output_tokens, total_tokens: prompt + usage.output_tokens, cached_tokens: cacheRead },
    finishReason: response.stop_reason ?? undefined,
  };
}

/** A failed call as the loop's failure kinds (the same notes and outage alerts as the OpenAI path). */
export function anthropicFailure(error: unknown): { kind: AiFailureKind | "timeout" | "no_key"; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof Anthropic.APIConnectionTimeoutError) return { kind: "timeout", message };
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) return { kind: "unauthorized", message };
  if (error instanceof Anthropic.RateLimitError) return { kind: "quota", message };
  if (error instanceof Anthropic.BadRequestError && /credit balance|billing/i.test(message)) return { kind: "credits_exhausted", message };
  if (error instanceof Anthropic.InternalServerError || error instanceof Anthropic.APIConnectionError) return { kind: "provider", message };
  return { kind: "other", message };
}

/** The Claude chat for the agent loop, on a given client (tests pass one with a fake fetch). */
export function anthropicChatWith(client: Anthropic, options: { effort?: Effort } = {}): ChatFn {
  return async (input) => {
    const { system, messages } = toAnthropicMessages(input.messages);
    const startedAt = Date.now();
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: input.model,
        max_tokens: Math.max(MIN_MAX_TOKENS, input.maxOutputTokens ?? 0),
        ...(system ? { system } : {}),
        messages,
        tools: toAnthropicTools(input.tools),
        tool_choice: { type: "auto" },
        output_config: { effort: options.effort ?? anthropicEffort() },
        // The whole prefix up to the latest block is cached: every round re-sends the same documents.
        cache_control: { type: "ephemeral" },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
      }, { timeout: input.timeoutMs, maxRetries: 1 });
    } catch (error) {
      const failure = anthropicFailure(error);
      logError("assistant.agent.model_failed", { provider: "anthropic", model: input.model, kind: failure.kind, message: failure.message.slice(0, 300), durationMs: Date.now() - startedAt });
      if (failure.kind !== "timeout" && failure.kind !== "no_key") void reportAiOutage(failure.kind);
      throw new AgentModelError(failure.kind, failure.message);
    }
    const result = fromAnthropicMessage(response);
    recordAiUsage({ model: input.model, source: AGENT_SOURCE, usage: result.usage });
    logInfo("assistant.agent.model_call", { provider: "anthropic", model: input.model, durationMs: Date.now() - startedAt, usage: result.usage, stop: response.stop_reason, tools: (result.message.tool_calls || []).map((call) => call.function.name) });
    // Declined even after the server's fallback: nothing usable came back.
    if (response.stop_reason === "refusal") throw new AgentModelError("other", `refused: ${response.stop_details?.category ?? "unknown"}`);
    return result;
  };
}

let shared: Anthropic | null = null;

/** The default Claude chat: ANTHROPIC_API_KEY from the environment. */
export const anthropicToolChat: ChatFn = async (input) => {
  if (!process.env.ANTHROPIC_API_KEY) throw new AgentModelError("no_key", "ANTHROPIC_API_KEY is not configured");
  shared ??= new Anthropic();
  return anthropicChatWith(shared)(input);
};
