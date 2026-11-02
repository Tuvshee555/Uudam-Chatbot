import { askOpenAIChatParts } from "./openaiFallback";
import { understandingModelName } from "./modelConfig";
import type { AskJson } from "./tripUnderstanding";

const UNDERSTANDING_TIMEOUT_MS = 8_000;

/** The model call behind tripUnderstanding.ts — JSON only, deterministic. */
export function understandingModel(trace?: { requestId?: string; correlationId?: string }): AskJson {
  return async (systemText, userText) => {
    const result = await askOpenAIChatParts([{ text: userText }], {
      systemText,
      jsonMode: true,
      temperature: 0,
      maxOutputTokens: 600,
      timeoutMs: UNDERSTANDING_TIMEOUT_MS,
      model: understandingModelName(),
      source: "trip_understanding",
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
    });
    return result?.text ?? null;
  };
}
