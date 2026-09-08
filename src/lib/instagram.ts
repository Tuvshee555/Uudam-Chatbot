import { createHmac } from "crypto";
import { getEnv } from "./env";
import { isMetaOutboundDisabled, logMetaOutboundSuppressed } from "./metaOutboundKillSwitch";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";
import { BOT_MESSAGE_METADATA, type UpstreamTraceOptions } from "./messenger";

const env = getEnv();

function graphMessagesEndpoint(igUserId: string, token: string) {
  const params = new URLSearchParams({ access_token: token });
  if (env.metaAppSecret) {
    params.set(
      "appsecret_proof",
      createHmac("sha256", env.metaAppSecret).update(token).digest("hex"),
    );
  }
  return `https://graph.facebook.com/v19.0/${igUserId}/messages?${params.toString()}`;
}

export async function sendTextMessage(
  igUserId: string,
  recipientId: string,
  text: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed(trace?.source || "meta.instagram", trace);
    return;
  }

  const startedAt = Date.now();
  const { attempts } = await fetchWithRetry(
    graphMessagesEndpoint(igUserId, token),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: recipientId },
        message: { text, metadata: BOT_MESSAGE_METADATA },
      }),
    },
    {
      upstream: "meta.instagram",
      timeoutMs: env.metaApiTimeoutMs,
      maxRetries: 0,
      retryBaseDelayMs: env.metaRetryBaseDelayMs,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      metricPrefix: "meta_api",
    },
  );

  logInfo("meta.instagram.request_success", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: trace?.source || "unknown",
    attempts,
    durationMs: Date.now() - startedAt,
  });
}

/**
 * Send inline quick-reply buttons after a text message. Instagram Messaging
 * supports the same quick_replies field as Messenger — same endpoint shape,
 * IG-scoped sender id instead of "me".
 */
export async function sendQuickReplies(
  igUserId: string,
  recipientId: string,
  text: string,
  labels: string[],
  token: string,
  trace?: UpstreamTraceOptions,
) {
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed(trace?.source || "meta.instagram", trace);
    return;
  }

  const quickReplies = labels.slice(0, 11).map((label) => ({
    content_type: "text",
    title: label.slice(0, 25),
    payload: label.slice(0, 25),
  }));

  const startedAt = Date.now();
  const { attempts } = await fetchWithRetry(
    graphMessagesEndpoint(igUserId, token),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: recipientId },
        message: { text, quick_replies: quickReplies, metadata: BOT_MESSAGE_METADATA },
      }),
    },
    {
      upstream: "meta.instagram",
      timeoutMs: env.metaApiTimeoutMs,
      maxRetries: 0,
      retryBaseDelayMs: env.metaRetryBaseDelayMs,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      metricPrefix: "meta_api",
    },
  );

  logInfo("meta.instagram.request_success", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: trace?.source || "unknown",
    attempts,
    durationMs: Date.now() - startedAt,
  });
}
