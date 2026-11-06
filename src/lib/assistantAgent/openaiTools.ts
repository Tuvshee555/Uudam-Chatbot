/**
 * One OpenAI chat completion with function calling, for the admin assistant's agent loop.
 *
 * The rest of the repo calls OpenAI in JSON mode with one user message
 * (openaiFallback.ts); a tool loop needs the message list, the tool definitions and the
 * model's tool calls back. Usage is recorded the same way (aiUsage.recordAiUsage, so the
 * day's spend and AI_DAILY_BUDGET_USD see it), a billing or key failure is reported as an
 * outage, and a failure is thrown as AgentModelError with its kind so the caller can tell
 * the admin the real cause in plain words.
 */
import { aiErrorCode, aiFailureKind, reportAiOutage, type AiFailureKind } from "../aiHealth";
import { recordAiUsage } from "../aiUsage";
import { fixMojibake } from "../encoding";
import { getEnv } from "../env";
import { logError, logInfo } from "../observability";
import { fetchWithRetry } from "../resilience";
import type { ChatFn, ChatResult, ToolCall } from "./types";

const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export const AGENT_SOURCE = "travel.ops.ai_agent";

export type AgentModelFailure = AiFailureKind | "timeout" | "no_key";

export class AgentModelError extends Error {
  kind: AgentModelFailure;

  constructor(kind: AgentModelFailure, message: string) {
    super(message);
    this.name = "AgentModelError";
    this.kind = kind;
  }
}

function toolCallsOf(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const call = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } };
    if (typeof call?.id !== "string" || typeof call.function?.name !== "string") return [];
    return [{ id: call.id, type: "function" as const, function: { name: call.function.name, arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}" } }];
  });
}

/** The default ChatFn: OpenAI's chat completions with tools, temperature 0, no retries beyond one. */
export const openAIToolChat: ChatFn = async (input) => {
  let key = "";
  try { key = getEnv().openaiApiKey; } catch { key = process.env.OPENAI_API_KEY || ""; }
  if (!key) throw new AgentModelError("no_key", "OPENAI_API_KEY is not configured");
  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages,
    tools: input.tools,
    tool_choice: input.toolChoice || "auto",
    temperature: 0,
    parallel_tool_calls: true,
    max_completion_tokens: input.maxOutputTokens ?? 4_000,
  };
  const startedAt = Date.now();
  const post = (timeoutMs: number) => fetchWithRetry(OPENAI_CHAT_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, { upstream: "openai.chat", timeoutMs, maxRetries: 0, retryBaseDelayMs: 300, metricPrefix: "openai" });
  try {
    let response: Response;
    try {
      ({ response } = await post(input.timeoutMs));
    } catch (first) {
      // One retry, only for a fast failure (a dropped connection, a 5xx) and only within the
      // call's own time: a timeout is never retried, or one call could eat the whole turn.
      const status = (first as { status?: unknown }).status;
      const left = input.timeoutMs - (Date.now() - startedAt);
      const quick = left > input.timeoutMs / 2 && !/time(?:d)?\s*out|abort/i.test(`${(first as Error)?.name} ${(first as Error)?.message}`);
      if (!quick || (typeof status === "number" && status < 500)) throw first;
      ({ response } = await post(left));
    }
    const data = await response.json() as {
      choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
      model?: string;
    };
    const usage = {
      prompt_tokens: data.usage?.prompt_tokens ?? 0,
      completion_tokens: data.usage?.completion_tokens ?? 0,
      total_tokens: data.usage?.total_tokens ?? 0,
      cached_tokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    };
    recordAiUsage({ model: input.model, source: AGENT_SOURCE, usage });
    const message = data.choices?.[0]?.message ?? {};
    const content = typeof message.content === "string" ? fixMojibake(message.content) : null;
    logInfo("assistant.agent.model_call", { model: input.model, durationMs: Date.now() - startedAt, usage, tools: toolCallsOf(message.tool_calls).map((call) => call.function.name) });
    const result: ChatResult = { message: { content, tool_calls: toolCallsOf(message.tool_calls) }, usage, finishReason: String(data.choices?.[0]?.finish_reason ?? "") };
    return result;
  } catch (error) {
    const kind = aiFailureKind(error);
    const timedOut = error instanceof Error && /time(?:d)?\s*out|abort/i.test(`${error.name} ${error.message}`);
    logError("assistant.agent.model_failed", { model: input.model, failure_kind: kind, error_code: aiErrorCode(error), message: error instanceof Error ? error.message : String(error) });
    void reportAiOutage(kind);
    throw new AgentModelError(timedOut ? "timeout" : kind, error instanceof Error ? error.message : String(error));
  }
};
