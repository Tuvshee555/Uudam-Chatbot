import { logInfo } from "./observability";

export function isMetaOutboundDisabled() {
  return (
    (process.env.VERCEL_ENV === "production" &&
      process.env.WEBHOOK_BOT_DISABLED !== "0") ||
    process.env.WEBHOOK_BOT_DISABLED === "1" ||
    process.env.WEBHOOK_BOT_DISABLED === "true"
  );
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
