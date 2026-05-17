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
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const startedAt = Date.now();
  const source = options?.source || "unknown";

  const requestBody: Record<string, unknown> = {
    contents: [{ role: "user", parts: toRestParts(parts) }],
  };
  if (options?.jsonMode) {
    requestBody.generationConfig = { responseMimeType: "application/json" };
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
            timeoutMs: env.geminiTimeoutMs,
            maxRetries: env.geminiMaxRetries,
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
    throw error;
  }
}
