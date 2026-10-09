import { logError, logInfo } from "./observability";
import { askOpenAIChatParts } from "./openaiFallback";

/**
 * Once a day, from the cron: a one-token OpenAI request. An empty balance or a
 * rejected key then shows in the admin system check even on a day no customer
 * writes. Never throws.
 */
export async function runDailyHealthCheck(): Promise<void> {
  try {
    const ping = await askOpenAIChatParts([{ text: "ok" }], {
      model: "gpt-4o-mini",
      maxOutputTokens: 1,
      temperature: 0,
      source: "daily_health_check",
    });
    logInfo("daily_health_check.openai", { ok: Boolean(ping) });
  } catch (error) {
    logError("daily_health_check.failed", { message: error instanceof Error ? error.message : String(error) });
  }
}
