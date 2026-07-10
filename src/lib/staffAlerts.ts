import { getEnv } from "./env";
import { sendTextMessage, type UpstreamTraceOptions } from "./messenger";
import { logError, logInfo, logWarn, recordCounter } from "./observability";

const env = getEnv();

export type StaffLeadAlert = {
  kind: "handoff" | "booking";
  platform: string;
  customerMessage: string;
  contactPhone?: string;
};

export function buildAlertText(alert: StaffLeadAlert): string {
  const heading =
    alert.kind === "handoff"
      ? "🔔 Шинэ хүсэлт — хэрэглэгч хүнтэй ярихыг хүсэв"
      : "🔔 Шинэ хүсэлт — захиалгын сонирхол";
  const channel = alert.platform === "instagram" ? "Instagram" : "Facebook";
  const lines = [
    heading,
    `Суваг: ${channel}`,
    `Зурвас: "${alert.customerMessage.slice(0, 300)}"`,
  ];
  if (alert.contactPhone) lines.push(`Утас: ${alert.contactPhone}`);
  lines.push("Дэлгэрэнгүйг админ самбарын «Хүсэлтүүд» хэсгээс хараарай.");
  return lines.join("\n");
}

/**
 * Sends a plain-text message to a Telegram chat via the Bot API. Telegram has
 * no 24-hour messaging window, so it delivers staff alerts even when the
 * Messenger RESPONSE-type ping is blocked by Meta policy. Throws on failure so
 * the caller can record it.
 */
async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
): Promise<void> {
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(env.metaApiTimeoutMs),
    },
  );
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`telegram_send_failed:${response.status}:${body.slice(0, 200)}`);
  }
}

/**
 * Best-effort staff notification for a new lead across every configured
 * channel. Never throws — a failed staff alert must not break customer-facing
 * webhook delivery.
 *
 * Two independent channels:
 *   1. Messenger PSIDs (STAFF_NOTIFY_PSIDS) — subject to Meta's 24h window, so
 *      it silently fails unless the staff account messaged the page recently.
 *   2. Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_STAFF_CHAT_IDS) — no 24h window,
 *      the reliable fallback.
 *
 * The lead already exists in the DB regardless; this only controls the ping.
 * If NO channel is configured, or every configured channel fails, that is
 * logged at ERROR level (not warn) — a delivered-nowhere lead is exactly the
 * silent lead loss this hardening exists to surface.
 */
export async function notifyStaffOfLead(
  alert: StaffLeadAlert,
  trace?: UpstreamTraceOptions,
): Promise<void> {
  const text = buildAlertText(alert);
  let attempted = 0;
  let delivered = 0;

  for (const psid of env.staffNotifyPsids) {
    attempted += 1;
    try {
      await sendTextMessage(psid, text, env.tokenPage, trace);
      delivered += 1;
      recordCounter("staff_alert.sent_total", 1, { kind: alert.kind, channel: "messenger" });
      logInfo("staff_alert.sent", { kind: alert.kind, channel: "messenger" });
    } catch (error) {
      recordCounter("staff_alert.failed_total", 1, { kind: alert.kind, channel: "messenger" });
      logWarn("staff_alert.failed", {
        kind: alert.kind,
        channel: "messenger",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (env.telegramBotToken && env.telegramStaffChatIds.length > 0) {
    for (const chatId of env.telegramStaffChatIds) {
      attempted += 1;
      try {
        await sendTelegramMessage(env.telegramBotToken, chatId, text);
        delivered += 1;
        recordCounter("staff_alert.sent_total", 1, { kind: alert.kind, channel: "telegram" });
        logInfo("staff_alert.sent", { kind: alert.kind, channel: "telegram" });
      } catch (error) {
        recordCounter("staff_alert.failed_total", 1, { kind: alert.kind, channel: "telegram" });
        logWarn("staff_alert.failed", {
          kind: alert.kind,
          channel: "telegram",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (attempted === 0) {
    // Deliberately no notify channel configured (owner checks the admin
    // dashboard's Хүсэлтүүд/leads tab instead of real-time pings) — this is
    // expected, not a failure. The lead itself is already saved in the DB
    // regardless of whether a ping goes out; log level is quiet on purpose.
    recordCounter("staff_alert.no_channel_total", 1, { kind: alert.kind });
    logInfo("staff_alert.no_channel_configured", { kind: alert.kind });
    return;
  }
  if (delivered === 0) {
    recordCounter("staff_alert.all_channels_failed_total", 1, { kind: alert.kind });
    logError("staff_alert.all_channels_failed", {
      kind: alert.kind,
      attempted,
      hint: "Every staff-alert channel failed. Messenger RESPONSE pings are blocked outside Meta's 24h window — configure Telegram as a reliable fallback.",
    });
  }
}
