import { createHmac } from "crypto";
import { getEnv } from "./env";
import { logInfo } from "./observability";
import { fetchWithRetry } from "./resilience";
import type { UpstreamTraceOptions } from "./messenger";

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
  const startedAt = Date.now();
  const { attempts } = await fetchWithRetry(
    graphMessagesEndpoint(igUserId, token),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_type: "RESPONSE",
        recipient: { id: recipientId },
        message: { text },
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
