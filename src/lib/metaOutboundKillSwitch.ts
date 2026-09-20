import { logInfo } from "./observability";

/**
 * Kill switch is opt-IN to disable, never opt-in to enable: an unset
 * WEBHOOK_BOT_DISABLED must mean "bot is on," in every environment,
 * including production. The previous version treated any value other than
 * the literal string "0" as disabling in production — which includes
 * `undefined` (unset) — so simply never having set the var (or removing it)
 * silently disabled the live bot. Confirmed live 2026-09-11: removing the
 * var from Vercel and redeploying did NOT bring the bot back, because this
 * function's own default was the thing silencing it, not the var's value.
 */
export function isMetaOutboundDisabled() {
  return process.env.WEBHOOK_BOT_DISABLED === "1" || process.env.WEBHOOK_BOT_DISABLED === "true";
}

export function logMetaOutboundSuppressed(source: string, trace?: {
  requestId?: string;
  correlationId?: string;
}) {
  logInfo("meta.outbound_suppressed", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source,
  });
}
