import { createHmac } from "crypto";
import { getEnv } from "./env";
import { isMetaOutboundDisabled, logMetaOutboundSuppressed } from "./metaOutboundKillSwitch";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";

const env = getEnv();

// Messenger commonly re-compresses oversized/tall PNG uploads. For Cloudinary
// images, serve a high-quality JPEG variant first so Meta fetches a readable
// poster-sized asset instead of an over-large PNG.
//
// The height cap only exists to bound a pathological upload; it must never
// bite a real poster. `c_limit` scales BOTH axes to fit, so a height cap that
// is too low silently narrows the poster — and narrower is exactly what makes
// Messenger's own re-compression turn poster text to mush. A 1440px cap made
// 5-slice posters unreadable; a 4096px cap still shrank a full 2160x5160
// single-page poster to 1715px wide *and* inflated it from 721KB to 2199KB,
// because resampling defeats the source JPEG's own encoding. Full-height
// passthrough is both sharper and smaller, so keep the cap well clear of any
// real poster and let width carry the quality.
const MESSENGER_IMAGE_TRANSFORM = "f_jpg,q_100,c_limit,w_2160,h_8192";

export function toMessengerImageUrl(imageUrl: string): string {
  if (!imageUrl.startsWith("https://res.cloudinary.com/")) return imageUrl;
  if (!imageUrl.includes("/image/upload/")) return imageUrl;
  const transformed = `/image/upload/${MESSENGER_IMAGE_TRANSFORM}/`;
  if (imageUrl.includes(transformed)) return imageUrl;
  return imageUrl.replace("/image/upload/", transformed);
}

export type UpstreamTraceOptions = {
  requestId?: string;
  correlationId?: string;
  source?: string;
};

export const BOT_MESSAGE_METADATA = "uudam-bot-message";

async function postToMessenger(
  endpoint: string,
  body: Record<string, unknown>,
  trace?: UpstreamTraceOptions,
) {
  if (isMetaOutboundDisabled()) {
    logMetaOutboundSuppressed(trace?.source || "meta.messenger", trace);
    return;
  }

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
      message: { text, metadata: BOT_MESSAGE_METADATA },
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
  const quickReplies = labels.slice(0, 11).map((label) => ({
    content_type: "text",
    title: label.slice(0, 25),
    payload: label.slice(0, 25),
  }));
  await postToMessenger(
    graphMessagesEndpoint(token),
    {
      messaging_type: "RESPONSE",
      recipient: { id: recipientId },
      message: { text, quick_replies: quickReplies, metadata: BOT_MESSAGE_METADATA },
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
    image_url: toMessengerImageUrl(card.imageUrl),
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
        metadata: BOT_MESSAGE_METADATA,
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
          payload: { url: toMessengerImageUrl(imageUrl), is_reusable: true },
        },
        metadata: BOT_MESSAGE_METADATA,
      },
    },
    trace,
  );
}
