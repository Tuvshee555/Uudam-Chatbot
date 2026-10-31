import { tracedSend } from "./inboundTrace";
import { createHmac } from "crypto";
import { appSecretForToken, getEnv } from "./env";
import { isMetaOutboundDisabled, logMetaOutboundSuppressed } from "./metaOutboundKillSwitch";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";
import { BOT_MESSAGE_METADATA, quickReplyTitle, type UpstreamTraceOptions } from "./messenger";
import { GRAPH_API_BASE } from "./metaGraph";

const env = getEnv();

function graphMessagesEndpoint(igUserId: string, token: string) {
  const params = new URLSearchParams({ access_token: token });
  // env.ts maps each page token to its issuing app's secret (the app migration runs two apps).
  const secret = appSecretForToken(token);
  if (secret) {
    params.set(
      "appsecret_proof",
      createHmac("sha256", secret).update(token).digest("hex"),
    );
  }
  return `${GRAPH_API_BASE}/${igUserId}/messages?${params.toString()}`;
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
  const { attempts } = await tracedSend(fetchWithRetry(
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
  ));

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
    title: quickReplyTitle(label),
    payload: label.slice(0, 1000),
  }));

  const startedAt = Date.now();
  const { attempts } = await tracedSend(fetchWithRetry(
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
  ));

  logInfo("meta.instagram.request_success", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: trace?.source || "unknown",
    attempts,
    durationMs: Date.now() - startedAt,
  });
}
