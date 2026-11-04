import { fixMojibake } from "./encoding";
import { askOpenAIChatParts } from "./openaiFallback";
import type { AiFailureKind } from "./aiHealth";

export type OpenAIUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type OpenAIResult = {
  text: string;
  usage: OpenAIUsage;
};

export type AskOpenAIOptions = {
  requestId?: string;
  correlationId?: string;
  source?: string;
  jsonMode?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  model?: string;
  temperature?: number;
  maxOutputTokens?: number;
  systemInstruction?: string;
  openaiModel?: string;
  preferOpenAI?: boolean;
  skipOpenAIFallback?: boolean;
};

export type OpenAIPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

/**
 * The model that writes customer replies when no rule-based path could (OPENAI_REPLY_MODEL
 * overrides). gpt-4.1 since 2026-11-04, replacing gpt-4o: the same family the trip
 * understanding step already runs on, a lower price, and a cached-prompt price a quarter of
 * its normal one (gpt-4o: half) — the reply prompt is ~37k tokens, almost all of it the same
 * from one message to the next. This call was two thirds of the OpenAI bill.
 */
export const REPLY_MODEL = "gpt-4.1";

export async function askOpenAI(
  prompt: string,
  options?: AskOpenAIOptions,
): Promise<OpenAIResult> {
  return askOpenAIParts([{ text: prompt }], options);
}

/** What a failed OpenAI call was really about, readable on the thrown error. */
export type AiCallFailure = { kind: AiFailureKind; code?: string; message: string };

export class AiCallError extends Error {
  failure: AiCallFailure | null;

  constructor(failure: AiCallFailure | null) {
    super(describeAiFailure(failure));
    this.name = "AiCallError";
    this.failure = failure;
  }
}

/** The kind of a failed call when the error came from askOpenAIParts; undefined otherwise. */
export function aiCallFailureKind(error: unknown): AiFailureKind | undefined {
  return error instanceof AiCallError ? error.failure?.kind : undefined;
}

export function describeAiFailure(failure: AiCallFailure | null): string {
  if (!failure) return "OpenAI request failed or OPENAI_API_KEY is not configured.";
  switch (failure.kind) {
    case "credits_exhausted":
      return "OpenAI credit balance exhausted (insufficient_quota): the provider refuses every request until billing is topped up.";
    case "unauthorized":
      return "OpenAI API key rejected (unauthorized): check OPENAI_API_KEY.";
    case "quota":
      return `OpenAI rate limit (429): ${failure.message}`;
    case "provider":
      return `OpenAI did not answer (timeout or network): ${failure.message}`;
    default:
      return `OpenAI request failed: ${failure.message}`;
  }
}

export async function askOpenAIParts(
  parts: OpenAIPart[],
  options?: AskOpenAIOptions,
): Promise<OpenAIResult> {
  let failure: AiCallFailure | null = null;
  const result = await askOpenAIChatParts(parts, {
    source: options?.source,
    jsonMode: options?.jsonMode,
    timeoutMs: options?.timeoutMs,
    maxRetries: options?.maxRetries,
    temperature: options?.temperature,
    maxOutputTokens: options?.maxOutputTokens,
    requestId: options?.requestId,
    correlationId: options?.correlationId,
    model: options?.openaiModel || options?.model,
    systemText: options?.systemInstruction,
    onFailure: (info) => { failure = info; },
  });

  if (!result) {
    throw new AiCallError(failure);
  }

  return {
    text: fixMojibake(result.text),
    usage: result.usage,
  };
}
