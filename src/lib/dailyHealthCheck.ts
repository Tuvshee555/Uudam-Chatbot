import { countWaitingLeads, waitingLeadsText } from "./aiHealth";
import { logError, logInfo } from "./observability";
import { askOpenAIChatParts } from "./openaiFallback";
import { notifyStaff } from "./staffAlerts";

/**
 * Once a day, from the cron: a one-token OpenAI request, so an empty balance
 * reaches staff (through the failure path's reportAiOutage) even on a day no
 * customer writes; and a reminder about leads nobody has opened. Never throws.
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
    const waiting = await countWaitingLeads();
    if (waiting > 0) await notifyStaff(`📋 ${waitingLeadsText(waiting)}`, "waiting_leads");
  } catch (error) {
    logError("daily_health_check.failed", { message: error instanceof Error ? error.message : String(error) });
  }
}
