/* eslint-disable @typescript-eslint/no-explicit-any */
import { fixMojibake } from "./encoding";
import { getEnv } from "./env";
import {
  classifyError,
  logError,
  logInfo,
  recordCounter,
  recordHistogram,
} from "./observability";
import {
  executeWithCircuitBreaker,
  fetchWithRetry,
  logRetryFailure,
} from "./resilience";
import { askOpenAIFallbackParts } from "./openaiFallback";

const DEFAULT_MODEL = "gemini-2.5-flash";
const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";
const env = getEnv();

function extractOutputText(data: any): string {
  const chunks: string[] = [];
  if (Array.isArray(data?.candidates)) {
    for (const candidate of data.candidates) {
      const parts = candidate?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (typeof part?.text === "string") {
          chunks.push(part.text);
        }
      }
    }
  }

  return chunks.join("").trim();
}

export type GeminiUsage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
};

export type GeminiResult = {
  text: string;
  usage: GeminiUsage;
};

export type AskGeminiOptions = {
  requestId?: string;
  correlationId?: string;
  source?: string;
  jsonMode?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  model?: string;
  /** Sampling temperature. Defaults to 0 for deterministic, factual extraction. */
  temperature?: number;
  /** Large structured extractions need room for one JSON action per trip. */
  maxOutputTokens?: number;
  /**
   * Rules/persona sent via the model's dedicated system channel instead of
   * being mixed into the user turn. Keeps instructions authoritative over
   * customer-authored text (prompt-injection hardening) and improves rule
   * adherence.
   */
  systemInstruction?: string;
  /**
   * When true, use OpenAI as the PRIMARY model and fall back to Gemini if
   * OpenAI fails. Used for file reading/parsing, where OpenAI is more reliable.
   * Chat answering leaves this off so Gemini (better Mongolian) stays primary.
   */
  preferOpenAI?: boolean;
  /** Override the OpenAI model when preferOpenAI=true (default: gpt-4o-mini). */
  openaiModel?: string;
};

/**
 * A single piece of model input: either plain text, or an inline binary
 * (PDF / image) the model reads natively. Used for file uploads where the
 * admin sends a price list as a document or photo.
 */
export type GeminiPart =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } };

function toRestParts(parts: GeminiPart[]): unknown[] {
  return parts.map((part) => {
    if ("inlineData" in part) {
      return {
        inline_data: {
          mime_type: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    return { text: part.text };
  });
}

export async function askGemini(
  prompt: string,
  options?: AskGeminiOptions,
): Promise<GeminiResult> {
  return askGeminiParts([{ text: prompt }], options);
}

export async function askGeminiParts(
  parts: GeminiPart[],
  options?: AskGeminiOptions,
): Promise<GeminiResult> {
  const key = env.geminiApiKey;
  const model = options?.model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const timeoutMs = options?.timeoutMs ?? env.geminiTimeoutMs;
  const maxRetries = options?.maxRetries ?? env.geminiMaxRetries;
  const startedAt = Date.now();
  const source = options?.source || "unknown";

  // Temperature 0 by default: for reading prices/dates and producing structured
  // edits we want deterministic, factual output — not "creative" guesses.
  const temperature =
    typeof options?.temperature === "number" ? options.temperature : 0;
  const hasNativePdf = parts.some(
    (part) => "inlineData" in part && part.inlineData.mimeType === "application/pdf",
  );

  // File reading uses OpenAI as the primary model (more reliable for parsing).
  // Native PDF parts stay on Gemini because Chat Completions image_url does not
  // reliably accept application/pdf; rendered JPEG page evidence still uses
  // OpenAI first. If OpenAI is configured, try it first for supported parts.
  if (options?.preferOpenAI && env.openaiApiKey && !hasNativePdf) {
    const openaiResult = await askOpenAIFallbackParts(parts, {
      source,
      jsonMode: options?.jsonMode,
      timeoutMs,
      temperature,
      maxOutputTokens: options?.maxOutputTokens,
      requestId: options?.requestId,
      correlationId: options?.correlationId,
      model: options?.openaiModel,
      systemText: options?.systemInstruction,
    });
    if (openaiResult) return openaiResult;
    logInfo("openai.falling_back_to_gemini", { source });
    // OpenAI failed — continue to the Gemini path below as the backup.
  }
  const generationConfig: Record<string, unknown> = { temperature };
  if (typeof options?.maxOutputTokens === "number") {
    generationConfig.maxOutputTokens = Math.trunc(options.maxOutputTokens);
  }
  if (options?.jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }
  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: toRestParts(parts) }],
    generationConfig,
  };
  if (options?.systemInstruction?.trim()) {
    requestBody.systemInstruction = {
      parts: [{ text: options.systemInstruction }],
    };
  }

  try {
    const { response, attempts } = await executeWithCircuitBreaker(
      {
        upstream: "gemini.generateContent",
        failureThreshold: env.geminiCircuitFailureThreshold,
        cooldownMs: env.geminiCircuitCooldownMs,
        requestId: options?.requestId,
        correlationId: options?.correlationId,
      },
      () =>
        fetchWithRetry(
          `${GEMINI_API_BASE}/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: {
              "x-goog-api-key": key,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
          },
          {
            upstream: "gemini.generateContent",
            timeoutMs,
            maxRetries,
            retryBaseDelayMs: env.geminiRetryBaseDelayMs,
            requestId: options?.requestId,
            correlationId: options?.correlationId,
            metricPrefix: "gemini",
          },
        ),
    );

    const data = await response.json();
    const raw =
      extractOutputText(data) || "Уучлаарай, систем түр алдаатай байна.";

    const usageMeta = data?.usageMetadata ?? {};
    const usage: GeminiUsage = {
      prompt_tokens: usageMeta.promptTokenCount ?? 0,
      completion_tokens: usageMeta.candidatesTokenCount ?? 0,
      total_tokens:
        usageMeta.totalTokenCount ??
        (usageMeta.promptTokenCount ?? 0) +
          (usageMeta.candidatesTokenCount ?? 0),
    };

    const durationMs = Date.now() - startedAt;
    recordCounter("gemini.calls_total", 1, { model, source, attempts });
    recordHistogram("gemini.end_to_end_latency_ms", durationMs, {
      model,
      source,
      attempts,
    });
    recordHistogram("gemini.prompt_tokens", usage.prompt_tokens, {
      model,
      source,
    });
    recordHistogram("gemini.completion_tokens", usage.completion_tokens, {
      model,
      source,
    });
    recordHistogram("gemini.total_tokens", usage.total_tokens, {
      model,
      source,
    });

    logInfo("gemini.request_success", {
      requestId: options?.requestId,
      correlationId: options?.correlationId,
      source,
      model,
      attempts,
      durationMs,
      usage,
      upstreamRequestId:
        response.headers.get("x-request-id") ||
        response.headers.get("x-goog-request-id"),
    });

    return { text: fixMojibake(raw), usage };
  } catch (error) {
    const classification = classifyError(error);
    recordCounter("gemini.failures_total", 1, {
      model,
      source,
      category: classification.category,
    });
    logRetryFailure("gemini.generateContent", error, {
      requestId: options?.requestId,
      correlationId: options?.correlationId,
      source,
      model,
      durationMs: Date.now() - startedAt,
    });
    logError("gemini.request_failed", {
      requestId: options?.requestId,
      correlationId: options?.correlationId,
      source,
      model,
      classification,
      message: error instanceof Error ? error.message : String(error),
    });

    // Gemini is down/overloaded (503) or timed out. Try OpenAI as a fallback
    // so the admin's request still succeeds. Only for retryable upstream
    // failures — a bad request or auth error should surface as-is.
    if (
      env.openaiApiKey &&
      !hasNativePdf &&
      (classification.category === "upstream_5xx" ||
        classification.category === "timeout" ||
        classification.retryable === true)
    ) {
      logInfo("gemini.falling_back_to_openai", { source, model });
      const fallback = await askOpenAIFallbackParts(parts, {
        source,
        jsonMode: options?.jsonMode,
        timeoutMs,
        temperature,
        maxOutputTokens: options?.maxOutputTokens,
        requestId: options?.requestId,
        correlationId: options?.correlationId,
        // Without these, an outage silently dropped the caller's system
        // rules (persona, REFER protocol, anti-injection guard) and downgraded
        // to the default OpenAI model — the fallback answered as a generic
        // assistant instead of the travel bot it's standing in for.
        model: options?.openaiModel,
        systemText: options?.systemInstruction,
      });
      if (fallback) return fallback;
    }

    throw error;
  }
}
