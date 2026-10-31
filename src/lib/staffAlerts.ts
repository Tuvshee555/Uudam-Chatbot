import { getEnv } from "./env";
import { sendTextMessage, type UpstreamTraceOptions } from "./messenger";
import { logError, logInfo, logWarn, recordCounter } from "./observability";
import type { ReadinessIssue } from "./readiness";

export type StaffLeadAlert = {
  kind: "handoff" | "booking";
  platform: string;
  customerMessage: string;
  contactPhone?: string;
  /** The customer, so the ping is recorded on (and de-duplicated per) their lead. */
  senderId?: string;
  leadId?: number;
};

export type StaffAlertDeliveryResult = {
  attempted: number;
  delivered: number;
  /** Staff were already pinged for this lead in the last ten minutes. */
  deduped?: boolean;
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

type TelegramChat = { ok: boolean; type?: string; error?: string };
const CHAT_CHECK_TTL_MS = 30 * 60_000;
const chatChecks = new Map<string, { at: number; result: TelegramChat }>();

/**
 * What kind of Telegram chat a staff alert would go to. Lead alerts carry customer messages
 * and phone numbers, so they go to a private chat or a group, never a broadcast channel
 * (whose audience can be public). Cached for 30 minutes; never throws.
 */
export async function telegramChatCheck(botToken: string, chatId: string, timeoutMs: number, now = Date.now()): Promise<TelegramChat> {
  const cached = chatChecks.get(chatId);
  if (cached && now - cached.at < CHAT_CHECK_TTL_MS) return cached.result;
  let result: TelegramChat;
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/getChat?chat_id=${encodeURIComponent(chatId)}`,
      { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: { type?: string } };
    result = body.ok ? { ok: true, type: String(body.result?.type || "") } : { ok: false, error: `telegram_get_chat_${response.status}` };
  } catch {
    result = { ok: false, error: "telegram_unreachable" };
  }
  chatChecks.set(chatId, { at: now, result });
  return result;
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
  timeoutMs: number,
): Promise<void> {
  const chat = await telegramChatCheck(botToken, chatId, timeoutMs);
  if (!chat.ok) throw new Error(chat.error || "telegram_chat_unavailable");
  if (chat.type === "channel") throw new Error("telegram_broadcast_channel_refused");
  const response = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!response.ok) {
    throw new Error(`telegram_send_failed:${response.status}`);
  }
}

/**
 * Best-effort staff notification for a new lead across every configured
 * channel. Never throws — a failed staff alert must not break customer-facing
 * webhook delivery.
 *
 * The durable source of truth is the admin Leads tab: the lead already exists in the DB
 * regardless; this only controls the ping. Each ping's outcome is recorded on the lead
 * (sent / failed / no channel) so the Leads tab shows whether staff were reached, and a
 * lead pinged in the last ten minutes is not pinged again (a customer writing several
 * messages in a row reopens the lead each time without flooding the staff chat).
 */
export async function notifyStaffOfLead(
  alert: StaffLeadAlert,
  trace?: UpstreamTraceOptions,
): Promise<StaffAlertDeliveryResult> {
  const target = { leadId: alert.leadId, senderId: alert.senderId };
  const leads = await import("./travelLeadsDb").catch(() => null);
  if (leads && await leads.leadRecentlyNotified(target).catch(() => false)) {
    logInfo("staff_alert.deduped", { kind: alert.kind });
    return { attempted: 0, delivered: 0, deduped: true };
  }
  const result = await notifyStaff(buildAlertText(alert), alert.kind, trace);
  if (leads) {
    const status = result.attempted === 0 ? "no_channel" : result.delivered > 0 ? "sent" : "failed";
    await leads.recordLeadNotification(target, status).catch(() => {});
  }
  return result;
}

export function hasStaffAlertChannel(env = getEnv()): boolean {
  return env.staffNotifyPsids.length > 0 || Boolean(env.telegramBotToken && env.telegramStaffChatIds.length > 0);
}

/** Every configured staff channel receives `text`; `kind` labels logs and metrics. Never throws. */
export async function notifyStaff(
  text: string,
  kind: string,
  trace?: UpstreamTraceOptions,
): Promise<StaffAlertDeliveryResult> {
  const env = getEnv();
  const alert = { kind };
  let attempted = 0;
  let delivered = 0;

  for (const psid of env.staffNotifyPsids) {
    attempted += 1;
    try {
      await sendTextMessage(psid, text, env.tokenPage, { ...trace, allowDuringTakeover: true });
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
        await sendTelegramMessage(env.telegramBotToken, chatId, text, env.metaApiTimeoutMs);
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
    recordCounter("staff_alert.no_channel_total", 1, { kind: alert.kind });
    logError("staff_alert.no_channel_configured", {
      kind: alert.kind,
      hint: "A lead was created but no realtime staff alert channel is configured. Keep the admin Leads tab monitored, or configure TELEGRAM_BOT_TOKEN with TELEGRAM_CHAT_ID (or STAFF_NOTIFY_PSIDS).",
    });
    return { attempted, delivered };
  }
  if (delivered === 0) {
    recordCounter("staff_alert.all_channels_failed_total", 1, { kind: alert.kind });
    logError("staff_alert.all_channels_failed", {
      kind: alert.kind,
      attempted,
      hint: "Every configured staff-alert channel failed. The lead is still in the admin Leads tab; check the Telegram bot and chat, or Messenger staff-ping permissions.",
    });
  }
  return { attempted, delivered };
}

/**
 * The admin system check: is any staff channel able to deliver right now? Telegram is asked
 * what the configured chat is (no message is sent); a broadcast channel is refused.
 */
export async function staffAlertIssues(env = getEnv()): Promise<ReadinessIssue[]> {
  if (!hasStaffAlertChannel(env)) {
    return [{ key: "staff_alert_channel", severity: "warning",
      message: "Ажилтанд шууд мэдэгдэх суваг (Telegram) тохируулаагүй — шинэ хүсэлтийг зөвхөн «Хүсэлтүүд» хэсгээс харна." }];
  }
  if (!env.telegramBotToken || !env.telegramStaffChatIds.length) return [];
  const checks = await Promise.all(env.telegramStaffChatIds.map((chatId) => telegramChatCheck(env.telegramBotToken!, chatId, env.metaApiTimeoutMs)));
  if (checks.some((check) => check.ok && check.type === "channel")) {
    return [{ key: "staff_alert_channel", severity: "critical",
      message: "Telegram мэдэгдлийн чат нь нийтийн суваг (channel) байна — хэрэглэгчийн мэдээлэл явуулахгүй. Ажилтны групп эсвэл хувийн чат тохируулна уу." }];
  }
  if (!checks.some((check) => check.ok)) {
    return [{ key: "staff_alert_channel", severity: "critical",
      message: "Telegram мэдэгдлийн бот/чат хүрэхгүй байна — шинэ хүсэлтийн мэдэгдэл очихгүй. «Хүсэлтүүд» хэсгийг хянана уу." }];
  }
  return [];
}

/** Safe description for the admin system page (chat kind only, never the token or id). */
export async function staffAlertChannelStatus(env = getEnv()) {
  const telegram = env.telegramBotToken && env.telegramStaffChatIds.length
    ? await Promise.all(env.telegramStaffChatIds.map((chatId) => telegramChatCheck(env.telegramBotToken!, chatId, env.metaApiTimeoutMs)))
    : [];
  return {
    messengerRecipients: env.staffNotifyPsids.length,
    telegram: telegram.map((check) => ({ reachable: check.ok, chatType: check.type || null, error: check.error || null })),
  };
}
