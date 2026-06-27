import { createHmac } from "crypto";
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

function graphMessagesEndpoint(token: string) {
  const params = new URLSearchParams({ access_token: token });
  if (env.metaAppSecret) {
    params.set(
      "appsecret_proof",
      createHmac("sha256", env.metaAppSecret).update(token).digest("hex"),
    );
  }
  return `https://graph.facebook.com/v19.0/me/messages?${params.toString()}`;
}

function graphCommentEndpoint(commentId: string, token: string) {
  const params = new URLSearchParams({ access_token: token });
  if (env.metaAppSecret) {
    params.set(
      "appsecret_proof",
      createHmac("sha256", env.metaAppSecret).update(token).digest("hex"),
    );
  }
  return `https://graph.facebook.com/v19.0/${commentId}/comments?${params.toString()}`;
}

export async function sendTextMessage(
  recipientId: string,
  text: string,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  await postToMessenger(
    graphMessagesEndpoint(token),
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
    graphCommentEndpoint(commentId, token),
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
    graphMessagesEndpoint(token),
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
    title: label.slice(0, 25),
    payload: label.slice(0, 25),
  }));
  await postToMessenger(
    graphMessagesEndpoint(token),
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text, quick_replies: quickReplies },
    },
    trace,
  );
}

/**
 * Send several images as ONE swipeable gallery (generic template carousel)
 * instead of separate image bubbles. Each card shows a photo and optional
 * title. Up to 10 cards. Standard pages_messaging permission — no extra
 * approval. URLs must be publicly accessible HTTPS.
 *
 * This is the closest Messenger offers to "send all photos together": instead
 * of N separate image messages, the customer sees one horizontally-scrollable
 * card row.
 */
export async function sendImageCarousel(
  recipientId: string,
  cards: Array<{ imageUrl: string; title?: string; subtitle?: string }>,
  token: string,
  trace?: UpstreamTraceOptions,
) {
  const elements = cards.slice(0, 10).map((card) => ({
    title: (card.title || " ").slice(0, 80),
    ...(card.subtitle ? { subtitle: card.subtitle.slice(0, 80) } : {}),
    image_url: card.imageUrl,
  }));
  await postToMessenger(
    graphMessagesEndpoint(token),
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            image_aspect_ratio: "square",
            elements,
          },
        },
      },
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
    graphMessagesEndpoint(token),
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
