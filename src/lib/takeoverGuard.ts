/**
 * The last check before the bot's message leaves (messenger.ts postToMessenger): does a person own
 * this conversation right now? The webhook checks at the start of a turn, but a reply takes seconds
 * to compose — a consultant who answers in that window (their echo pauses the customer at once,
 * webhook.ts) must not see the bot's message land under theirs. Only a person's pause blocks:
 * "operator_reply" (a consultant wrote in Messenger) and "manual" ("Би хариулна" in the admin).
 * The bot's own markers ("booked_customer", "handoff") never block its own sends.
 *
 * A failed read lets the message through: the turn already passed the takeover check, and failing
 * closed would turn a database blip into silence for every customer.
 */
import { hashIdentifier, logInfo, logWarn, recordCounter } from "./observability";

export const HUMAN_OWNER_REASONS: ReadonlySet<string> = new Set(["operator_reply", "manual"]);

export class StaffTakeoverSendBlocked extends Error {
  constructor(readonly reason: string) {
    super(`staff_takeover_send_blocked:${reason}`);
    this.name = "StaffTakeoverSendBlocked";
  }
}

export function isStaffTakeoverSendBlocked(error: unknown): error is StaffTakeoverSendBlocked {
  return error instanceof StaffTakeoverSendBlocked;
}

export async function assertBotMaySend(recipientId: string, trace?: { requestId?: string; source?: string }): Promise<void> {
  if (!recipientId) return;
  let reason: string | null = null;
  try {
    const { dbPauseReason } = await import("./travelSessionDb");
    reason = await dbPauseReason(recipientId);
  } catch (error) {
    logWarn("meta.messenger.takeover_check_failed", { requestId: trace?.requestId, source: trace?.source || "unknown",
      message: error instanceof Error ? error.name : "unknown" });
    return;
  }
  if (!reason || !HUMAN_OWNER_REASONS.has(reason)) return;
  logInfo("meta.messenger.blocked_staff_takeover", { requestId: trace?.requestId, source: trace?.source || "unknown",
    recipientHash: hashIdentifier(recipientId), pauseReason: reason });
  recordCounter("meta.messenger.blocked_staff_takeover_total", 1, { reason });
  throw new StaffTakeoverSendBlocked(reason);
}
