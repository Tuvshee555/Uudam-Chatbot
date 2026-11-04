import { fixMojibake } from "./encoding";
import { askOpenAIChatParts } from "./openaiFallback";

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

export async function askOpenAIParts(
  parts: OpenAIPart[],
  options?: AskOpenAIOptions,
): Promise<OpenAIResult> {
  const result = await askOpenAIChatParts(parts, {
    source: options?.source,
    jsonMode: options?.jsonMode,
    timeoutMs: options?.timeoutMs,
    temperature: options?.temperature,
    maxOutputTokens: options?.maxOutputTokens,
    requestId: options?.requestId,
    correlationId: options?.correlationId,
    model: options?.openaiModel || options?.model,
    systemText: options?.systemInstruction,
  });

  if (!result) {
    throw new Error(
      "OpenAI request failed or OPENAI_API_KEY is not configured.",
    );
  }

  return {
    text: fixMojibake(result.text),
    usage: result.usage,
  };
}
