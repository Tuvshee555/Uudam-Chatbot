import type { NextApiRequest } from "next";
import { getEnv } from "./env";
import { withRedis } from "./redisState";
import {
  hashIdentifier,
  logError,
  logWarn,
  recordCounter,
  setGauge,
} from "./observability";
import { readRawBodyLimited } from "./webhookSecurity";

const env = getEnv();
const VERIFY_TOKEN = env.verifyToken;

export type Platform = "facebook" | "instagram";
export type PendingConversationPayload = {
  platform: Platform;
  senderId: string;
  text: string;
  pageId: string;
  igUserId?: string | null;
  token?: string;
  trace?: { requestId: string; correlationId: string };
};
export type PendingEnvelope = {
  payload: PendingConversationPayload;
  enqueuedAt: number;
  sequence: number;
};
export type EventClaimState = "acquired" | "already_completed" | "in_progress";
export type EventClaim = {
  state: EventClaimState;
  complete: () => Promise<void>;
  release: () => Promise<void>;
};

const PROCESSED_EVENT_TTL_MS = 2 * 60 * 1000;
const EVENT_PROCESSING_TTL_MS = Math.max(env.redisLockTtlMs * 2, 60_000);
const RECENT_TEXT_TTL_MS = 20 * 1000;
const RECENT_REPLY_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_PROCESSED_EVENTS = env.rateLimitMaxBuckets;
const MAX_RECENT_INCOMING_TEXTS = Math.max(
  1000,
  Math.floor(env.rateLimitMaxBuckets / 2),
);
const MAX_RECENT_REPLIES = Math.max(
  1000,
  Math.floor(env.rateLimitMaxBuckets / 2),
);
export const MAX_PENDING_CONVERSATIONS = env.webhookMaxPendingConversations;
export const MAX_PENDING_PER_CONVERSATION = 20;
export const MAX_INCOMING_TEXT_CHARS = 2_000;
const REDIS_CONVERSATION_UNLOCK_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;
const REDIS_CONVERSATION_REFRESH_LUA = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;
const processedEvents = new Map<string, number>();
const processingEvents = new Map<string, number>();
const activeConversations = new Set<string>();
const recentIncomingTexts = new Map<string, number>();
const recentReplies = new Map<string, { text: string; timestamp: number }>();
const pendingConversations = new Map<string, PendingEnvelope[]>();
let pendingConversationMessageCount = 0;
let pendingSequence = 0;
export class RetryableWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableWebhookError";
  }
}
export function isRetryableWebhookError(error: unknown) {
  return error instanceof RetryableWebhookError;
}
export function asRetryableWebhookError(error: unknown, reason: string) {
  if (isRetryableWebhookError(error)) return error;
  return new RetryableWebhookError(reason);
}
function recordConsistencyDegraded(
  domain: "replay" | "conversation",
  operation: string,
) {
  recordCounter("webhook.consistency_degraded_total", 1, { domain, operation });
  logError("webhook.consistency_degraded", { domain, operation });
}
export function verifyToken(token: unknown) {
  if (!VERIFY_TOKEN || typeof token !== "string") return false;
  return token === VERIFY_TOKEN;
}
export async function readRawBody(req: NextApiRequest): Promise<Buffer> {
  const contentLengthHeader = req.headers["content-length"];
  const contentLengthRaw = Array.isArray(contentLengthHeader)
    ? contentLengthHeader[0]
    : contentLengthHeader;
  return readRawBodyLimited(req, env.webhookMaxBodyBytes, contentLengthRaw);
}
function pruneProcessedEvents() {
  const now = Date.now();
  for (const [key, timestamp] of processedEvents.entries()) {
    if (now - timestamp > PROCESSED_EVENT_TTL_MS) {
      processedEvents.delete(key);
    }
  }
  for (const [key, timestamp] of recentIncomingTexts.entries()) {
    if (now - timestamp > RECENT_TEXT_TTL_MS) {
      recentIncomingTexts.delete(key);
    }
  }
  for (const [key, value] of recentReplies.entries()) {
    if (now - value.timestamp > RECENT_REPLY_TTL_MS) {
      recentReplies.delete(key);
    }
  }
  if (processedEvents.size > MAX_PROCESSED_EVENTS) {
    const overflow = processedEvents.size - MAX_PROCESSED_EVENTS;
    const oldest = Array.from(processedEvents.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, overflow);
    for (const [key] of oldest) {
      processedEvents.delete(key);
    }
  }
  for (const [key, timestamp] of processingEvents.entries()) {
    if (now - timestamp > EVENT_PROCESSING_TTL_MS) {
      processingEvents.delete(key);
    }
  }
  if (recentIncomingTexts.size > MAX_RECENT_INCOMING_TEXTS) {
    const overflow = recentIncomingTexts.size - MAX_RECENT_INCOMING_TEXTS;
    const oldest = Array.from(recentIncomingTexts.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, overflow);
    for (const [key] of oldest) {
      recentIncomingTexts.delete(key);
    }
  }
  if (recentReplies.size > MAX_RECENT_REPLIES) {
    const overflow = recentReplies.size - MAX_RECENT_REPLIES;
    const oldest = Array.from(recentReplies.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, overflow);
    for (const [key] of oldest) {
      recentReplies.delete(key);
    }
  }
}
export function buildEventKey(
  platform: Platform,
  senderId: string,
  event: { message?: { mid?: string; text?: string } },
) {
  const mid = event.message?.mid?.trim();
  if (mid) return `${platform}:mid:${mid}`;
  const normalizedText = (event.message?.text || "").trim().toLowerCase();
  return `${platform}:fallback:${senderId}:${hashIdentifier(normalizedText)}`;
}
function processedEventRedisKey(key: string) {
  return `webhook:processed_event:${key}`;
}
function processingEventRedisKey(key: string) {
  return `webhook:processing_event:${key}`;
}
function recentReplyRedisKey(sessionId: string) {
  return `webhook:recent_reply:${sessionId}`;
}
function conversationLockRedisKey(conversationKey: string) {
  return `webhook:conversation_lock:${conversationKey}`;
}
function conversationPendingRedisKey(conversationKey: string) {
  return `webhook:conversation_pending:${conversationKey}`;
}
export function markEventProcessed(key: string) {
  pruneProcessedEvents();
  if (processedEvents.has(key)) return false;
  processedEvents.set(key, Date.now());
  return true;
}
export async function claimEventForProcessingConsistent(key: string): Promise<EventClaim> {
  if (env.redisReplayEnabled) {
    const redisClaim = await withRedis("webhook.event_claim", async (redis) => {
      const completed = await redis.exists(processedEventRedisKey(key));
      if (completed > 0) {
        return { state: "already_completed" as EventClaimState };
      }
      const claimToken = `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
      const acquired = await redis.set(
        processingEventRedisKey(key),
        claimToken,
        "PX",
        EVENT_PROCESSING_TTL_MS,
        "NX",
      );
      if (acquired !== "OK") {
        return { state: "in_progress" as EventClaimState };
      }
      return {
        state: "acquired" as EventClaimState,
        token: claimToken,
      };
    });
    if (!redisClaim) {
      recordCounter("webhook.redis_fallback_total", 1, {
        operation: "event_claim",
      });
      recordConsistencyDegraded("replay", "event_claim");
      throw new RetryableWebhookError("redis_replay_unavailable:event_claim");
    }
    if (redisClaim.state !== "acquired") {
      return {
        state: redisClaim.state,
        complete: async () => {},
        release: async () => {},
      };
    }
    const token = redisClaim.token;
    if (!token) {
      throw new RetryableWebhookError("redis_replay_unavailable:event_claim_token");
    }
    return {
      state: "acquired",
      complete: async () => {
        const completed = await withRedis("webhook.event_complete", async (redis) => {
          const pipeline = redis.pipeline();
          pipeline.set(
            processedEventRedisKey(key),
            String(Date.now()),
            "PX",
            PROCESSED_EVENT_TTL_MS,
          );
          pipeline.eval(
            REDIS_CONVERSATION_UNLOCK_LUA,
            1,
            processingEventRedisKey(key),
            token,
          );
          await pipeline.exec();
          return true;
        });
        if (!completed) {
          recordCounter("webhook.redis_fallback_total", 1, {
            operation: "event_complete",
          });
          recordConsistencyDegraded("replay", "event_complete");
          throw new RetryableWebhookError("redis_replay_unavailable:event_complete");
        }
      },
      release: async () => {
        const released = await withRedis("webhook.event_release", async (redis) => {
          const result = await redis.eval(
            REDIS_CONVERSATION_UNLOCK_LUA,
            1,
            processingEventRedisKey(key),
            token,
          );
          return Number(result) >= 0;
        });
        if (!released) {
          recordCounter("webhook.redis_fallback_total", 1, {
            operation: "event_release",
          });
          recordConsistencyDegraded("replay", "event_release");
          throw new RetryableWebhookError("redis_replay_unavailable:event_release");
        }
      },
    };
  }
  pruneProcessedEvents();
  if (processedEvents.has(key)) {
    return {
      state: "already_completed",
      complete: async () => {},
      release: async () => {},
    };
  }
  const existing = processingEvents.get(key);
  if (typeof existing === "number" && Date.now() - existing <= EVENT_PROCESSING_TTL_MS) {
    return {
      state: "in_progress",
      complete: async () => {},
      release: async () => {},
    };
  }
  processingEvents.set(key, Date.now());
  return {
    state: "acquired",
    complete: async () => {
      processingEvents.delete(key);
      markEventProcessed(key);
    },
    release: async () => {
      processingEvents.delete(key);
    },
  };
}
export async function runEventWithClaim(
  key: string,
  tags: { platform: string; eventType: "dm" | "feed" },
  task: () => Promise<void>,
) {
  const claim = await claimEventForProcessingConsistent(key);
  if (claim.state === "already_completed") {
    recordCounter("webhook.duplicate_event_skipped_total", 1, {
      platform: tags.platform,
      event_type: tags.eventType,
      reason: "already_completed",
    });
    return;
  }
  if (claim.state === "in_progress") {
    recordCounter("webhook.duplicate_event_skipped_total", 1, {
      platform: tags.platform,
      event_type: tags.eventType,
      reason: "in_progress",
    });
    return;
  }
  try {
    await task();
    await claim.complete();
    recordCounter("webhook.event_completed_total", 1, {
      platform: tags.platform,
      event_type: tags.eventType,
    });
  } catch (error) {
    try {
      await claim.release();
    } catch (releaseError) {
      throw asRetryableWebhookError(releaseError, "event_claim_release_failed");
    }
    throw asRetryableWebhookError(error, "event_processing_failed");
  }
}
function normalizeText(text: string) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
export function markRecentIncomingText(
  platform: Platform,
  senderId: string,
  text: string,
) {
  pruneProcessedEvents();
  const key = `${platform}:${senderId}:${hashIdentifier(normalizeText(text))}`;
  if (recentIncomingTexts.has(key)) return false;
  recentIncomingTexts.set(key, Date.now());
  return true;
}
export function updateConcurrencyGauges() {
  setGauge("webhook.active_conversations", activeConversations.size);
  setGauge("webhook.pending_conversations", pendingConversations.size);
  setGauge("webhook.pending_messages", pendingConversationMessageCount);
}
function findOldestPendingEnvelope() {
  let oldestConversationKey: string | null = null;
  let oldestEnvelope: PendingEnvelope | null = null;
  for (const [conversationKey, queue] of pendingConversations.entries()) {
    const first = queue[0];
    if (!first) continue;
    if (!oldestEnvelope || first.sequence < oldestEnvelope.sequence) {
      oldestEnvelope = first;
      oldestConversationKey = conversationKey;
    }
  }
  return { oldestConversationKey, oldestEnvelope };
}
function evictOldestPendingEnvelope(reason: "overflow_global" | "overflow_conversation") {
  const { oldestConversationKey, oldestEnvelope } = findOldestPendingEnvelope();
  if (!oldestConversationKey || !oldestEnvelope) return false;
  const queue = pendingConversations.get(oldestConversationKey);
  if (!queue?.length) return false;
  queue.shift();
  pendingConversationMessageCount = Math.max(0, pendingConversationMessageCount - 1);
  if (!queue.length) pendingConversations.delete(oldestConversationKey);
  recordCounter("webhook.pending_evicted_total", 1, { reason });
  logWarn("webhook.pending_evicted", {
    reason,
    conversationKeyHash: hashIdentifier(oldestConversationKey),
    maxPendingConversations: MAX_PENDING_CONVERSATIONS,
    maxPendingPerConversation: MAX_PENDING_PER_CONVERSATION,
  });
  return true;
}
function enqueuePendingConversation(
  conversationKey: string,
  payload: PendingConversationPayload,
) {
  while (pendingConversationMessageCount >= MAX_PENDING_CONVERSATIONS) {
    if (!evictOldestPendingEnvelope("overflow_global")) break;
  }
  const queue = pendingConversations.get(conversationKey) || [];
  queue.push({
    payload,
    enqueuedAt: Date.now(),
    sequence: ++pendingSequence,
  });
  pendingConversations.set(conversationKey, queue);
  pendingConversationMessageCount += 1;
  while (queue.length > MAX_PENDING_PER_CONVERSATION) {
    const dropped = queue.shift();
    if (dropped) {
      pendingConversationMessageCount = Math.max(0, pendingConversationMessageCount - 1);
      recordCounter("webhook.pending_evicted_total", 1, {
        reason: "overflow_conversation",
      });
      logWarn("webhook.pending_evicted", {
        reason: "overflow_conversation",
        conversationKeyHash: hashIdentifier(conversationKey),
        maxPendingPerConversation: MAX_PENDING_PER_CONVERSATION,
      });
    }
  }
  recordCounter("webhook.pending_enqueued_total", 1, {
    mode: queue.length > 1 ? "append" : "new",
  });
  updateConcurrencyGauges();
}
export async function hasConversationLockConsistent(conversationKey: string) {
  if (activeConversations.has(conversationKey)) return true;
  if (env.redisConversationEnabled) {
    const redisBusy = await withRedis("webhook.conversation_lock_exists", async (redis) => {
      const exists = await redis.exists(conversationLockRedisKey(conversationKey));
      return exists > 0;
    });
    if (typeof redisBusy === "boolean") return redisBusy;
    recordCounter("webhook.redis_fallback_total", 1, {
      operation: "conversation_lock_exists",
    });
    recordConsistencyDegraded("conversation", "conversation_lock_exists");
    throw new RetryableWebhookError(
      "redis_conversation_unavailable:conversation_lock_exists",
    );
  }
  return activeConversations.has(conversationKey);
}
export async function acquireConversationLockConsistent(conversationKey: string) {
  if (!env.redisConversationEnabled) return null;
  const lockToken = `${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  const acquired = await withRedis("webhook.conversation_lock_acquire", async (redis) => {
    const result = await redis.set(
      conversationLockRedisKey(conversationKey),
      lockToken,
      "PX",
      env.redisLockTtlMs,
      "NX",
    );
    return result === "OK";
  });
  if (acquired === true) return lockToken;
  if (acquired === false) return "";
  recordCounter("webhook.redis_fallback_total", 1, {
    operation: "conversation_lock_acquire",
  });
  recordConsistencyDegraded("conversation", "conversation_lock_acquire");
  throw new RetryableWebhookError(
    "redis_conversation_unavailable:conversation_lock_acquire",
  );
}
export async function releaseConversationLockConsistent(
  conversationKey: string,
  lockToken: string | null,
) {
  if (!lockToken || !env.redisConversationEnabled) return;
  const released = await withRedis("webhook.conversation_lock_release", async (redis) => {
    const result = await redis.eval(
      REDIS_CONVERSATION_UNLOCK_LUA,
      1,
      conversationLockRedisKey(conversationKey),
      lockToken,
    );
    return Number(result) > 0;
  });
  if (released === null) {
    recordCounter("webhook.redis_fallback_total", 1, {
      operation: "conversation_lock_release",
    });
    recordConsistencyDegraded("conversation", "conversation_lock_release");
  }
}
export async function refreshConversationLockConsistent(
  conversationKey: string,
  lockToken: string | null,
) {
  if (!lockToken || !env.redisConversationEnabled) return true;
  const refreshed = await withRedis("webhook.conversation_lock_refresh", async (redis) => {
    const result = await redis.eval(
      REDIS_CONVERSATION_REFRESH_LUA,
      1,
      conversationLockRedisKey(conversationKey),
      lockToken,
      String(env.redisLockTtlMs),
    );
    return Number(result) > 0;
  });
  if (refreshed !== null) return refreshed;
  recordCounter("webhook.redis_fallback_total", 1, {
    operation: "conversation_lock_refresh",
  });
  recordConsistencyDegraded("conversation", "conversation_lock_refresh");
  throw new RetryableWebhookError(
    "redis_conversation_unavailable:conversation_lock_refresh",
  );
}
export async function withConversationLockHeartbeat<T>(
  conversationKey: string,
  lockToken: string | null,
  task: (ensureLockHealthy: () => Promise<void>) => Promise<T>,
): Promise<T> {
  if (!lockToken || !env.redisConversationEnabled) {
    return task(async () => {});
  }
  const intervalMs = Math.max(1_000, Math.floor(env.redisLockTtlMs / 3));
  let stopped = false;
  let lockLost = false;
  let heartbeatError: unknown = null;
  let heartbeatInFlight: Promise<void> | null = null;
  const heartbeat = async () => {
    if (stopped || heartbeatInFlight || lockLost || heartbeatError) return;
    heartbeatInFlight = (async () => {
      try {
        const healthy = await refreshConversationLockConsistent(
          conversationKey,
          lockToken,
        );
        if (!healthy) {
          lockLost = true;
        }
      } catch (error) {
        heartbeatError = error;
      }
    })().finally(() => {
      heartbeatInFlight = null;
    });
    await heartbeatInFlight;
  };
  const ensureLockHealthy = async () => {
    if (heartbeatError) {
      throw asRetryableWebhookError(
        heartbeatError,
        "conversation_lock_refresh_failed",
      );
    }
    if (lockLost) {
      throw new RetryableWebhookError("conversation_lock_lost");
    }
  };
  const interval = setInterval(() => {
    void heartbeat();
  }, intervalMs);
  if (typeof (interval as NodeJS.Timeout).unref === "function") {
    (interval as NodeJS.Timeout).unref();
  }
  try {
    const result = await task(ensureLockHealthy);
    await heartbeat();
    await ensureLockHealthy();
    return result;
  } finally {
    stopped = true;
    clearInterval(interval);
    if (heartbeatInFlight) {
      await heartbeatInFlight;
    }
  }
}
export async function enqueuePendingConversationConsistent(
  conversationKey: string,
  payload: PendingConversationPayload,
) {
  if (env.redisConversationEnabled) {
    const redisQueued = await withRedis("webhook.pending_enqueue", async (redis) => {
      const key = conversationPendingRedisKey(conversationKey);
      await redis.rpush(key, JSON.stringify(payload));
      await redis.ltrim(key, -MAX_PENDING_PER_CONVERSATION, -1);
      await redis.pexpire(key, env.redisLockTtlMs * 4);
      return true;
    });
    if (redisQueued) {
      recordCounter("webhook.pending_enqueued_total", 1, {
        mode: "append",
        backend: "redis",
      });
      return;
    }
    recordCounter("webhook.redis_fallback_total", 1, {
      operation: "pending_enqueue",
    });
    recordConsistencyDegraded("conversation", "pending_enqueue");
    throw new RetryableWebhookError("redis_conversation_unavailable:pending_enqueue");
  }
  enqueuePendingConversation(conversationKey, payload);
}
export async function drainPendingConversationConsistent(
  conversationKey: string,
): Promise<PendingConversationPayload | null> {
  if (env.redisConversationEnabled) {
    const redisPayload = await withRedis("webhook.pending_drain", async (redis) => {
      const key = conversationPendingRedisKey(conversationKey);
      const raw = await redis.lpop(key);
      if (!raw) return { found: false } as const;
      return {
        found: true,
        payload: JSON.parse(raw) as PendingConversationPayload,
      } as const;
    });
    if (redisPayload) {
      if (redisPayload.found) {
        recordCounter("webhook.pending_drained_total", 1, { backend: "redis" });
        return redisPayload.payload;
      }
      return null;
    }
    recordCounter("webhook.redis_fallback_total", 1, {
      operation: "pending_drain",
    });
    recordConsistencyDegraded("conversation", "pending_drain");
    throw new RetryableWebhookError("redis_conversation_unavailable:pending_drain");
  }
  const queue = pendingConversations.get(conversationKey) || [];
  const envelope = queue.shift() || null;
  if (envelope) {
    pendingConversationMessageCount = Math.max(0, pendingConversationMessageCount - 1);
    if (!queue.length) pendingConversations.delete(conversationKey);
    recordCounter("webhook.pending_drained_total", 1, { backend: "memory" });
    updateConcurrencyGauges();
  }
  return envelope?.payload || null;
}
export async function getLastReplyConsistent(sessionId: string) {
  if (env.redisConversationEnabled) {
    const redisReply = await withRedis("webhook.last_reply_get", async (redis) => {
      const raw = await redis.get(recentReplyRedisKey(sessionId));
      if (!raw) return { found: false } as const;
      const parsed = JSON.parse(raw) as { text: string; timestamp: number };
      if (
        typeof parsed?.text !== "string" ||
        typeof parsed?.timestamp !== "number"
      ) {
        return { found: false } as const;
      }
      return { found: true, payload: parsed } as const;
    });
    if (redisReply) {
      return redisReply.found ? redisReply.payload : null;
    }
    recordCounter("webhook.redis_fallback_total", 1, {
      operation: "last_reply_get",
    });
    recordConsistencyDegraded("conversation", "last_reply_get");
    throw new RetryableWebhookError("redis_conversation_unavailable:last_reply_get");
  }
  return recentReplies.get(sessionId) || null;
}
export async function setLastReplyConsistent(sessionId: string, text: string) {
  const payload = { text, timestamp: Date.now() };
  if (env.redisConversationEnabled) {
    const redisSaved = await withRedis("webhook.last_reply_set", async (redis) => {
      await redis.set(
        recentReplyRedisKey(sessionId),
        JSON.stringify(payload),
        "PX",
        RECENT_REPLY_TTL_MS,
      );
      return true;
    });
    if (redisSaved) return;
    recordCounter("webhook.redis_fallback_total", 1, {
      operation: "last_reply_set",
    });
    recordConsistencyDegraded("conversation", "last_reply_set");
    throw new RetryableWebhookError("redis_conversation_unavailable:last_reply_set");
  }
  recentReplies.set(sessionId, payload);
}
export function addActiveConversation(conversationKey: string) {
  activeConversations.add(conversationKey);
}
export function deleteActiveConversation(conversationKey: string) {
  activeConversations.delete(conversationKey);
}
export function getActiveConversationCount() {
  return activeConversations.size;
}
export function getPendingConversationCount() {
  return pendingConversations.size;
}
export function getWebhookRuntimeDiagnostics() {
  return {
    processedEvents: processedEvents.size,
    processingEvents: processingEvents.size,
    recentIncomingTexts: recentIncomingTexts.size,
    recentReplies: recentReplies.size,
    activeConversations: activeConversations.size,
    pendingConversations: pendingConversations.size,
    pendingMessages: pendingConversationMessageCount,
    maxPendingConversations: MAX_PENDING_CONVERSATIONS,
    maxPendingPerConversation: MAX_PENDING_PER_CONVERSATION,
    redisReplayEnabled: env.redisReplayEnabled,
    redisConversationEnabled: env.redisConversationEnabled,
  };
}
export function resetWebhookStateForTests() {
  processedEvents.clear();
  processingEvents.clear();
  activeConversations.clear();
  recentIncomingTexts.clear();
  recentReplies.clear();
  pendingConversations.clear();
  pendingConversationMessageCount = 0;
  pendingSequence = 0;
}
