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
      // One token always ends on "length"; that is not an incomplete answer and must not
      // put a warning in the admin system check every day.
      truncationExpected: true,
      source: "daily_health_check",
    });
    logInfo("daily_health_check.openai", { ok: Boolean(ping) });
  } catch (error) {
    logError("daily_health_check.failed", { message: error instanceof Error ? error.message : String(error) });
  }
  // The private customer-image store, tested end to end once a day; staff are told when it fails.
  try {
    const [{ checkCustomerImageStorage, customerImageStorageIssues }, { notifyStaff }] = await Promise.all([
      import("./customerImageStorage"), import("./staffAlerts"),
    ]);
    const issues = await customerImageStorageIssues(await checkCustomerImageStorage({ force: true }));
    if (issues.length) await notifyStaff(`⚠️ ${issues[0].message}`, "customer_image_storage");
  } catch (error) {
    logError("daily_health_check.storage_failed", { message: error instanceof Error ? error.name : "storage_check_failed" });
  }
  // The bot's sent-message ids are needed for three days (staffTakeover.ts); keep 30.
  try {
    await (await import("./outboundMessages")).pruneOutboundMessages();
  } catch (error) {
    logError("daily_health_check.outbound_prune_failed", { message: error instanceof Error ? error.name : "prune_failed" });
  }
  // Permanent deletions whose stored file could not be removed are tried again.
  try {
    const purged = await (await import("./customerDocumentPurge")).retryFailedStorageDeletions();
    if (purged) logInfo("daily_health_check.storage_deletions_retried", { purged });
  } catch (error) {
    logError("daily_health_check.storage_delete_retry_failed", { message: error instanceof Error ? error.name : "retry_failed" });
  }
}
