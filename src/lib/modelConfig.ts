import { logWarn } from "./observability";

/**
 * Which OpenAI model each step uses, from the environment, with a safe default.
 *
 *   OPENAI_REPLY_MODEL        free-text customer reply          (default gpt-4.1)
 *   TRIP_UNDERSTANDING_MODEL  which-trip / what-is-asked JSON   (default gpt-4.1-mini)
 *
 * A value that is not a known chat model (a typo such as "gpt4o", or a model this code has no
 * price for) is ignored with a warning: the provider would refuse every call, and a refused
 * reply call means an outage notice instead of an answer. Dated snapshots ("gpt-4o-2024-08-06")
 * of a known model are accepted.
 */
const KNOWN_CHAT_MODELS = new Set(["gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]);

// main moved customer replies to gpt-4.1 (openaiProvider REPLY_MODEL); kept here.
export const DEFAULT_REPLY_MODEL = "gpt-4.1";
// gpt-4.1-mini since 2026-11-02: on the held-out set it scored 103/112 against gpt-4.1's 101/112,
// at about a third of the cost per turn (docs/chatbot-accuracy-cost-report-2026-11.md).
export const DEFAULT_UNDERSTANDING_MODEL = "gpt-4.1-mini";

const warned = new Set<string>();

export function isKnownChatModel(value: string): boolean {
  return KNOWN_CHAT_MODELS.has(value.replace(/-\d{4}-\d{2}-\d{2}$/, ""));
}

function configured(envName: string, fallback: string): string {
  const value = (process.env[envName] || "").trim();
  if (!value) return fallback;
  if (isKnownChatModel(value)) return value;
  if (!warned.has(`${envName}=${value}`)) {
    warned.add(`${envName}=${value}`);
    logWarn("model_config.unknown_model", { envName, value, fallback });
  }
  return fallback;
}

export function replyModel(): string {
  return configured("OPENAI_REPLY_MODEL", DEFAULT_REPLY_MODEL);
}

export function understandingModelName(): string {
  return configured("TRIP_UNDERSTANDING_MODEL", DEFAULT_UNDERSTANDING_MODEL);
}
