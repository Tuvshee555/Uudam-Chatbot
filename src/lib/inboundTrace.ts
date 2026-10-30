import { AsyncLocalStorage } from "node:async_hooks";

/**
 * What happened to ONE inbound customer message, collected while the webhook handles it
 * and written as one persisted `webhook.inbound_outcome` event (observability.ts allowlist,
 * travel_error_logs). Runtime logs are kept for an hour on this plan, so without it a
 * message missing from the conversation table could not be explained: on 2026-10-10 one
 * customer message was redelivered 31 times, failed every time, and left no trace.
 * Holds counts and reasons only — never message text, phone numbers or raw sender ids.
 */
export type InboundOutcome = {
  /** The customer's text reached travel_conversations. */
  stored: boolean;
  /** The rows this attempt wrote for it (removed again if the attempt fails before sending). */
  userRowIds: number[];
  /** Messages accepted by Meta for this customer. */
  sent: number;
  /** Meta sends that failed. */
  sendFailed: number;
  /** Why no reply was sent, when the handler decided to stay silent. */
  silent: string | null;
  /** The reply path that answered (deliverFastPathReply failTag, "model", …). */
  route: string | null;
};

const store = new AsyncLocalStorage<InboundOutcome>();

export function newInboundOutcome(): InboundOutcome {
  return { stored: false, userRowIds: [], sent: 0, sendFailed: 0, silent: null, route: null };
}

/** Runs one message's handling with its outcome collector. */
export function traceInbound<T>(outcome: InboundOutcome, run: () => Promise<T>): Promise<T> {
  return store.run(outcome, run);
}

/** Records part of the current message's outcome; a no-op outside a traced message. */
export function noteInbound(update: (outcome: InboundOutcome) => void): void {
  const outcome = store.getStore();
  if (outcome) update(outcome);
}

/** Counts one Meta send for the current message: accepted, or failed (the error is rethrown). */
export async function tracedSend<T>(send: Promise<T>): Promise<T> {
  try {
    const result = await send;
    noteInbound((outcome) => { outcome.sent += 1; });
    return result;
  } catch (error) {
    noteInbound((outcome) => { outcome.sendFailed += 1; });
    throw error;
  }
}

/** The status staff read: answered, silent (with a reason), stored only, or not stored. */
export function inboundStatus(outcome: InboundOutcome): "answered" | "silent" | "stored_no_reply" | "not_stored" {
  if (outcome.sent > 0) return "answered";
  if (outcome.silent) return "silent";
  return outcome.stored ? "stored_no_reply" : "not_stored";
}
