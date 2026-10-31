/**
 * Message echoes during the Meta-app migration (docs/meta-app-migration.md).
 *
 * An echo fires for EVERY message the Page sends: this bot, a consultant in Business Suite on
 * a computer, a consultant in the Pages/Business app on a phone, Meta's own automations (the
 * automated welcome greeting that silenced a real customer on 2026-10-30), and any other app
 * connected to the Page. The echo's `app_id` says which app sent it — but no echo has ever
 * reached this webhook before (the old app could not hold the subscription), so there is no
 * evidence yet of which app ids Meta's inbox surfaces actually use, and Meta does not document
 * that desktop, phone and automations differ. Until real echoes prove the split:
 *
 * - every echo is RECORDED (shape and app id only, never message text);
 * - the bot's own echoes are known by its send metadata or its own app id;
 * - only app ids the owner has explicitly listed as human surfaces (ECHO_HUMAN_APP_IDS) may
 *   count as a consultant, and only in enforce mode (ECHO_TAKEOVER_MODE=enforce);
 * - an unknown app id is logged and counted, NEVER treated as a consultant — the thread
 *   lookup (staffTakeover.ts) remains the enforcement path meanwhile.
 */
import { getEnv } from "./env";
import { BOT_MESSAGE_METADATA } from "./messenger";
import { hashIdentifier, logInfo, logWarn, recordCounter } from "./observability";

export type EchoClassification = "bot" | "human" | "unknown";

export type EchoEvent = {
  pageId: string;
  /** The customer the Page message went to. */
  recipientId: string;
  mid: string;
  /** Meta sends a number or a string; normalised to a string ("" when absent). */
  appId: string;
  metadata: string;
  textLength: number;
  attachmentTypes: string[];
};

export function classifyEcho(event: Pick<EchoEvent, "appId" | "metadata">): EchoClassification {
  const env = getEnv();
  if (event.metadata === BOT_MESSAGE_METADATA) return "bot";
  if (env.metaAppId && event.appId && event.appId === env.metaAppId) return "bot";
  if (event.appId && env.echoHumanAppIds.includes(event.appId)) return "human";
  return "unknown";
}

/** Observe-only unless the owner has turned enforcement on after reviewing real echoes. */
export function echoEnforcementEnabled(): boolean {
  return getEnv().echoTakeoverMode === "enforce";
}

/**
 * Durable observation row — the classification matrix is built from these. Fire-and-forget:
 * an insert failure must never delay or fail the webhook; the log line still records it.
 */
export async function recordEchoEvent(event: EchoEvent, classification: EchoClassification): Promise<void> {
  const log = classification === "unknown" ? logWarn : logInfo;
  log("webhook.echo_observed", {
    pageId: event.pageId,
    customerHash: hashIdentifier(event.recipientId),
    appId: event.appId || null,
    hasBotMetadata: event.metadata === BOT_MESSAGE_METADATA,
    classification,
    textLength: event.textLength,
    attachmentTypes: event.attachmentTypes,
  });
  recordCounter("webhook.echo_observed_total", 1, { classification, known_app: String(Boolean(event.appId)) });
  try {
    const { queryNeon, isNeonConfigured } = await import("./neonDb");
    if (!isNeonConfigured()) return;
    const { ensureTravelSchema } = await import("./travelSchema");
    if (!await ensureTravelSchema()) return;
    await queryNeon(
      `INSERT INTO travel_echo_events (page_id, recipient_id, mid, app_id, has_bot_metadata, classification, text_length, attachment_types)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [event.pageId, event.recipientId, event.mid, event.appId,
        event.metadata === BOT_MESSAGE_METADATA, classification, event.textLength, event.attachmentTypes.join(",")],
    );
  } catch (error) {
    logWarn("webhook.echo_record_failed", { classification, message: error instanceof Error ? error.name : "unknown" });
  }
}
