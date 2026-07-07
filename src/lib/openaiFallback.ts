/* eslint-disable @typescript-eslint/no-explicit-any */
import { fixMojibake } from "./encoding";
import { getEnv } from "./env";
import {
  classifyError,
  logError,
  logInfo,
  recordCounter,
} from "./observability";
import { fetchWithRetry } from "./resilience";
import type { GeminiPart, GeminiResult } from "./gemini";

const OPENAI_API_BASE = "https://api.openai.com/v1/chat/completions";
const env = getEnv();

/**
 * OpenAI fallback for when Gemini is overloaded (503) or times out.
 *
 * Gemini Flash periodically returns 503 "Service Unavailable" during global
 * capacity spikes. Rather than failing the admin's upload, we transparently
 * retry supported requests against OpenAI (GPT-4o-mini), which reads rendered
 * page images via base64 data URLs. Native PDF parts remain on Gemini.
 *
 * Returns null if no OpenAI key is configured, so the caller can rethrow the
 * original Gemini error instead of masking it.
 */
export async function askOpenAIFallbackParts(
  parts: GeminiPart[],
  options?: {
    source?: string;
    jsonMode?: boolean;
    timeoutMs?: number;
    temperature?: number;
    maxOutputTokens?: number;
    requestId?: string;
    correlationId?: string;
    /** Override model for this call (e.g. gpt-4o for file parsing). */
    model?: string;
    /** Rules/persona sent as an OpenAI system message (mirrors Gemini systemInstruction). */
    systemText?: string;
  },
): Promise<GeminiResult | null> {
  const key = env.openaiApiKey;
  if (!key) return null;
  if (
    parts.some(
      (part) =>
        "inlineData" in part && part.inlineData.mimeType === "application/pdf",
    )
  ) {
    return null;
  }

  const model = options?.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
  const source = options?.source || "unknown";
  const startedAt = Date.now();

  // Convert Gemini parts → OpenAI content blocks. Text stays text; rendered
  // image binaries become data-URL image_url blocks.
  const content: any[] = parts.map((part) => {
    if ("inlineData" in part) {
      return {
        type: "image_url",
        image_url: {
          url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`,
        },
      };
    }
    return { type: "text", text: part.text };
  });

  const messages: Array<Record<string, unknown>> = [];
  if (options?.systemText?.trim()) {
    messages.push({ role: "system", content: options.systemText });
  }
  messages.push({ role: "user", content });

  const requestBody: Record<string, unknown> = {
    model,
    messages,
    temperature:
      typeof options?.temperature === "number" ? options.temperature : 0,
  };
  if (options?.jsonMode) {
    requestBody.response_format = { type: "json_object" };
  }
  if (typeof options?.maxOutputTokens === "number") {
    requestBody.max_completion_tokens = Math.trunc(options.maxOutputTokens);
  }

  try {
    const { response } = await fetchWithRetry(
      OPENAI_API_BASE,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(requestBody),
      },
      {
        upstream: "openai.chat",
        timeoutMs: options?.timeoutMs ?? env.geminiTimeoutMs,
        maxRetries: 1,
        retryBaseDelayMs: env.geminiRetryBaseDelayMs,
        requestId: options?.requestId,
        correlationId: options?.correlationId,
        metricPrefix: "openai",
      },
    );

    const data = await response.json();
    const raw =
      (typeof data?.choices?.[0]?.message?.content === "string"
        ? data.choices[0].message.content
        : ""
      ).trim() || "Уучлаарай, систем түр алдаатай байна.";

    const usage = data?.usage ?? {};
    recordCounter("openai.fallback_success_total", 1, { model, source });
    logInfo("openai.fallback_success", {
      source,
      model,
      durationMs: Date.now() - startedAt,
      usage: {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
    });

    return {
      text: fixMojibake(raw),
      usage: {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
      },
    };
  } catch (error) {
    recordCounter("openai.fallback_failures_total", 1, {
      model,
      source,
      category: classifyError(error).category,
    });
    logError("openai.fallback_failed", {
      source,
      model,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
