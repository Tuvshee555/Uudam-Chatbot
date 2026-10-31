/**
 * Message echoes: who sent a message from the Page (docs/meta-app-migration.md).
 *
 * An echo fires for EVERY message the Page sends: this bot, a consultant in Business Suite on
 * a computer, a consultant in the Pages/Business app on a phone, Meta's own automations (the
 * automated welcome greeting that silenced a real customer on 2026-10-30), and any other app
 * connected to the Page. What the first real echoes proved (production, 2026-10-31, 104 echoes
 * of 80 messages, each checked against Meta's own record of the message):
 *
 * - the bot's echoes carry its send metadata (and its id was recorded at send time);
 * - consultants on the phone AND Meta's own automations both arrive under ONE app id, Meta's
 *   inbox app — 57 phone replies, but also 5 automated replies 2–6 s after the customer and a
 *   comment private reply. The app id alone can never say "a person";
 * - Meta's record of the message (Conversations API tags) does: `source:mobile` is only ever a
 *   person; `source:web` is a person on a computer OR an automation, told apart by timing as
 *   the thread check already does (staffTakeover.ts classifyPageMessage).
 *
 * So an echo pauses the bot only when ALL hold: enforcement is on (ECHO_TAKEOVER_MODE=enforce),
 * its app id is a listed human surface (ECHO_HUMAN_APP_IDS — Meta's inbox app), and Meta's own
 * record of that exact message classifies it as a consultant (verifyHumanEcho). Anything else —
 * an unknown app, an automation, a message Meta's record does not show yet — is recorded and
 * NEVER treated as a person; the thread check on the customer's next message stays the backstop.
 */
import { getEnv } from "./env";
import { BOT_MESSAGE_METADATA } from "./messenger";
import { hashIdentifier, logInfo, logWarn, recordCounter } from "./observability";

export type EchoClassification = "bot" | "human" | "unknown";

/** What Meta's record of the echoed message proved; only "human" pauses the bot. */
export type EchoVerdict =
  | { verdict: "human"; origin: "staff_mobile" | "staff_web"; at: Date; text: string }
  | { verdict: "bot" | "automation" | "legacy" | "other" | "released" | "unverified"; reason: string };

/** Meta's record can trail the echo by a moment; one re-read covers it. */
export const ECHO_RECORD_RETRY_MS = 1500;

export type EchoEvent = {
  pageId: string;
  /** Which app's webhook delivered this echo (the old "current" app or the "next" one). */
  deliveredBy: "current" | "next";
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
 * Is this echo, from a human-surface app, really a consultant? Meta's record of that exact
 * message (by mid, in the customer's thread) is classified with the same rules as the thread
 * check, so an echo and the next-message check can never disagree about the same message.
 */
export async function verifyHumanEcho(input: { pageId: string; customerId: string; mid: string; token: string }): Promise<EchoVerdict> {
  const { fetchThreadMessages, takeoverContext, classifyThread } = await import("./staffTakeover");
  if (!input.mid || !input.token) return { verdict: "unverified", reason: "no_mid_or_token" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, ECHO_RECORD_RETRY_MS));
    const lookup = await fetchThreadMessages({ token: input.token, senderId: input.customerId, timeoutMs: 4000 });
    if (lookup.status !== "ok") return { verdict: "unverified", reason: lookup.reason };
    if (!lookup.messages.some((message) => message.id === input.mid)) continue;
    const context = await takeoverContext({ messages: lookup.messages, pageId: input.pageId, senderId: input.customerId });
    const found = classifyThread(lookup.messages, context).find(({ message }) => message.id === input.mid);
    if (!found || found.origin === "customer") return { verdict: "unverified", reason: "not_a_page_message" };
    if (found.origin !== "staff_mobile" && found.origin !== "staff_web") return { verdict: found.origin, reason: found.origin };
    // Staff handed the conversation back after this message: a late redelivery of it must not
    // take the conversation over again.
    if (context.botReleasedAt != null && found.at <= context.botReleasedAt) return { verdict: "released", reason: "before_release" };
    return { verdict: "human", origin: found.origin, at: new Date(found.at), text: String(found.message.message ?? "") };
  }
  return { verdict: "unverified", reason: "not_in_thread" };
}

/**
 * Durable observation row — the classification matrix is built from these. Fire-and-forget:
 * an insert failure must never delay or fail the webhook; the log line still records it.
 */
export async function recordEchoEvent(event: EchoEvent, classification: EchoClassification, verdict = ""): Promise<void> {
  const log = classification === "unknown" ? logWarn : logInfo;
  log("webhook.echo_observed", {
    pageId: event.pageId,
    deliveredBy: event.deliveredBy,
    customerHash: hashIdentifier(event.recipientId),
    appId: event.appId || null,
    hasBotMetadata: event.metadata === BOT_MESSAGE_METADATA,
    classification,
    verdict: verdict || null,
    textLength: event.textLength,
    attachmentTypes: event.attachmentTypes,
  });
  recordCounter("webhook.echo_observed_total", 1, { classification, verdict: verdict || "none", known_app: String(Boolean(event.appId)) });
  try {
    const { queryNeon, isNeonConfigured } = await import("./neonDb");
    if (!isNeonConfigured()) return;
    const { ensureTravelSchema } = await import("./travelSchema");
    if (!await ensureTravelSchema()) return;
    await queryNeon(
      `INSERT INTO travel_echo_events (page_id, recipient_id, mid, app_id, has_bot_metadata, classification, text_length, attachment_types, delivered_by, verdict)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [event.pageId, event.recipientId, event.mid, event.appId,
        event.metadata === BOT_MESSAGE_METADATA, classification, event.textLength, event.attachmentTypes.join(","), event.deliveredBy, verdict],
    );
  } catch (error) {
    logWarn("webhook.echo_record_failed", { classification, message: error instanceof Error ? `${error.name}: ${error.message.slice(0, 120)}` : "unknown" });
  }
}
