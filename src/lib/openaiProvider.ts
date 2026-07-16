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
