import { getEnv } from "./env";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";

const env = getEnv();

export type UpstreamTraceOptions = {
  requestId?: string;
  correlationId?: string;
  source?: string;
};

async function postToMessenger(
  endpoint: string,
  body: Record<string, unknown>,
  trace?: UpstreamTraceOptions,
) {
  const startedAt = Date.now();
  const { attempts } = await fetchWithRetry(
    endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    {
      upstream: "meta.messenger",
      timeoutMs: env.metaApiTimeoutMs,
      maxRetries: 0,
      retryBaseDelayMs: env.metaRetryBaseDelayMs,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      metricPrefix: "meta_api",
    },
  );
  logInfo("meta.messenger.request_success", {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: trace?.source || "unknown",
    attempts,
    durationMs: Date.now() - startedAt,
  });
}

export async function sendTextMessage(
  recipientId: string,
  text: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text },
    },
    trace,
  );
}

export async function replyToComment(
  commentId: string,
  message: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/${commentId}/comments?access_token=${token}`,
    { message },
    trace,
  );
}

export async function sendTypingOn(
  recipientId: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
    {
      recipient: { id: recipientId },
      sender_action: "typing_on",
    },
    trace,
  );
}

/**
 * Send inline quick-reply buttons after a text message.
 * Buttons appear as tappable chips below the message in Messenger.
 * Labels must be ≤20 chars. Max 13 buttons (we cap at 5 to be safe).
 */
export async function sendQuickReplies(
  recipientId: string,
  text: string,
  labels: string[],
  token: string,
  trace?: UpstreamTraceOptions,
) {
  const quickReplies = labels.slice(0, 5).map((label) => ({
    content_type: "text",
    title: label.slice(0, 20),
    payload: label.slice(0, 20),
  }));
  await postToMessenger(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text, quick_replies: quickReplies },
    },
    trace,
  );
}

/**
 * Send an image to a Messenger recipient via the attachment API.
 * No extra Meta approval needed — standard pages_messaging permission covers this.
 * imageUrl must be a publicly accessible HTTPS URL.
 */
export async function sendImageMessage(
  recipientId: string,
  imageUrl: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    `https://graph.facebook.com/v19.0/me/messages?access_token=${token}`,
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "image",
          payload: { url: imageUrl, is_reusable: true },
        },
      },
    },
    trace,
  );
}
