import type { NextApiRequest, NextApiResponse } from "next";
import { askGemini } from "../../lib/gemini";
import { matchFlow, findTriggeredFlow, getFlowState, setFlowState, clearFlowState, newRuntimeState, runFlowFrom, resumeFlowWithInput, type FlowRule, type FlowDoc, type FlowEffects, type FlowRuntimeState, type RunOutcome, } from "../../lib/flowEngine";
import { replyToComment, sendImageCarousel, sendImageMessage, sendQuickReplies, sendTextMessage, sendTypingOn } from "../../lib/messenger";
import { sendTextMessage as sendIgTextMessage } from "../../lib/instagram";
import { rateLimitAsync } from "../../lib/rateLimit";
import { readBusinessData } from "../../lib/businessData";
import { appendMessage, buildPrompt, getHistory } from "../../lib/conversation";
import { fixMojibake } from "../../lib/encoding";
import { maybeAutoSyncDriveFolder } from "../../lib/googleDriveSync";
import { enforceWebsiteForPayment, extractButtons, isDuplicateReply, rewriteRepeatedGenericClarifier, sanitizeAssistantReply, stripRepeatedGreeting } from "../../lib/reply";
import { isPaused, pauseBot, storeSenderName, trackSender } from "../../lib/pause";
import { createLead, getTravelBotSettings, hasRecentOpenLead, isPagePaused, listTrips, } from "../../lib/travelOps";
import { buildDepartureDateAvailabilityReply, hasDepartureDateAvailabilityIntent, } from "../../lib/travelDates";
import { buildCompareReply, buildDiscountReply, buildSeatsReply, buildSmartButtons, buildStructuredTripReply, buildTripProgramReply, hasCompareIntent, hasDiscountIntent, hasSeatsIntent, hasProgramIntent, } from "../../lib/travelFastPaths";
import { extractTripBrochureAttachmentId, extractTripPhotosForReply, getActiveSeason, isFirstMessage, matchSeasonByText, resolveGreetingConfig, resolveSeasons, sampleWelcomePhotos, } from "../../lib/welcomeFlow";
import { sendFbFileAttachment, sendFbFileByUrl } from "../../lib/fbAttachmentUpload";
import { notifyStaffOfLead } from "../../lib/staffAlerts";
import { logInboundMessage } from "../../lib/travelMessages";
import { advanceCollectState, buildCompletionMessage, buildLeadContext, clearCollectState, getCollectState, isInCollectFlow, promptForStep, setCollectState, startCollectState, } from "../../lib/bookingCollect";
import { getEnv } from "../../lib/env";
import { withRedis } from "../../lib/redisState";
import { beginRequestTrace, classifyError, finishRequestTrace, hashIdentifier, logError, logInfo, logWarn, recordCounter, setGauge, } from "../../lib/observability";
import { parseWebhookJson, PayloadTooLargeError, readRawBodyLimited, verifyMetaSignature, } from "../../lib/webhookSecurity";
const env = getEnv();
const VERIFY_TOKEN = env.verifyToken;
const PAGE_TOKENS = new Map(env.facebookPages.map((p) => [p.pageId, p.token]));
const FALLBACK_TOKEN = env.tokenPage;
const META_APP_SECRET = env.metaAppSecret;
const FALLBACK_SEND_ERROR_MESSAGE = "Уучлаарай, мессеж илгээхэд алдаа гарлаа.";
type Platform = "facebook" | "instagram";
type PendingConversationPayload = {
  platform: Platform;
  senderId: string;
  text: string;
  pageId: string;
  igUserId?: string | null;
  token?: string;
  trace?: { requestId: string; correlationId: string };
};
type PendingEnvelope = {
  payload: PendingConversationPayload;
  enqueuedAt: number;
  sequence: number;
};
type EventClaimState = "acquired" | "already_completed" | "in_progress";
type EventClaim = {
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
const MAX_PENDING_CONVERSATIONS = env.webhookMaxPendingConversations;
const MAX_PENDING_PER_CONVERSATION = 20;
const MAX_INCOMING_TEXT_CHARS = 2_000;
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
class RetryableWebhookError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableWebhookError";
  }
}
function isRetryableWebhookError(error: unknown) {
  return error instanceof RetryableWebhookError;
}
function asRetryableWebhookError(error: unknown, reason: string) {
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
export const config = {
  api: {
    bodyParser: false,
  },
};
function verifyToken(token: unknown) {
  if (!VERIFY_TOKEN || typeof token !== "string") return false;
  return token === VERIFY_TOKEN;
}
async function readRawBody(req: NextApiRequest): Promise<Buffer> {
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
async function claimEventForProcessingConsistent(key: string): Promise<EventClaim> {
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
async function runEventWithClaim(
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
function updateConcurrencyGauges() {
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
async function hasConversationLockConsistent(conversationKey: string) {
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
async function acquireConversationLockConsistent(conversationKey: string) {
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
async function releaseConversationLockConsistent(
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
async function refreshConversationLockConsistent(
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
async function withConversationLockHeartbeat<T>(
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
async function enqueuePendingConversationConsistent(
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
async function drainPendingConversationConsistent(
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
async function getLastReplyConsistent(sessionId: string) {
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
async function setLastReplyConsistent(sessionId: string, text: string) {
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
async function sendPlatformMessage(
  platform: Platform,
  senderId: string,
  text: string,
  token: string | undefined,
  pageId: string,
  igUserId?: string | null,
  trace?: { requestId: string; correlationId: string; source: string },
  options?: { allowFallback?: boolean },
) {
  const allowFallback = options?.allowFallback ?? true;
  if (!token) {
    logError("webhook.send.missing_token", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
    });
    return false;
  }
  try {
    if (platform === "facebook") {
      await sendTextMessage(senderId, text, token, trace);
    } else {
      await sendIgTextMessage(igUserId || "", senderId, text, token, trace);
    }
    recordCounter("webhook.send.success_total", 1, { platform });
    return true;
  } catch (error) {
    recordCounter("webhook.send.failed_total", 1, { platform });
    logError("webhook.send.primary_failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
      bodySnippet:
        error && typeof error === "object" && "bodySnippet" in error
          ? String((error as { bodySnippet?: unknown }).bodySnippet || "")
          : undefined,
    });
    if (!allowFallback || text === FALLBACK_SEND_ERROR_MESSAGE) {
      return false;
    }
    try {
      if (platform === "facebook") {
        await sendTextMessage(senderId, FALLBACK_SEND_ERROR_MESSAGE, token, trace);
      } else {
        await sendIgTextMessage(
          igUserId || "",
          senderId,
          FALLBACK_SEND_ERROR_MESSAGE,
          token,
          trace,
        );
      }
      recordCounter("webhook.send.fallback_success_total", 1, { platform });
    } catch (fallbackError) {
      logError("webhook.send.fallback_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        pageId,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(fallbackError),
        message:
          fallbackError instanceof Error
            ? fallbackError.message
            : String(fallbackError),
        bodySnippet:
          fallbackError &&
          typeof fallbackError === "object" &&
          "bodySnippet" in fallbackError
            ? String(
                (fallbackError as { bodySnippet?: unknown }).bodySnippet || "",
              )
            : undefined,
      });
    }
    return false;
  }
}
async function sendPhotoAlbum(
  senderId: string,
  photoUrls: string[],
  token: string | undefined,
  trace?: { requestId: string; correlationId: string },
): Promise<void> {
  if (!token || photoUrls.length === 0) return;
  const traceOpts = {
    requestId: trace?.requestId,
    correlationId: trace?.correlationId,
    source: "api.webhook.album",
  };
  try {
    await sendImageCarousel(
      senderId,
      photoUrls.map((url) => ({ imageUrl: url })),
      token,
      traceOpts,
    );
  } catch {
    for (const url of photoUrls) {
      try {
        await sendImageMessage(senderId, url, token, traceOpts);
      } catch {
      }
    }
  }
}
async function fetchAndStoreFbName(senderId: string, token: string): Promise<void> {
  try {
    const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(senderId)}?fields=name&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return;
    const data = (await res.json()) as { name?: string };
    if (typeof data.name === "string" && data.name.trim()) {
      await storeSenderName(senderId, data.name.trim());
    }
  } catch {
    // non-critical, ignore
  }
}
async function sendFacebookTypingIndicator(
  recipientId: string,
  token: string | undefined,
  pageId: string,
  trace?: { requestId: string; correlationId: string; source: string },
) {
  if (!token) {
    logWarn("webhook.typing.missing_token", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform: "facebook",
      pageId,
      recipientHash: hashIdentifier(recipientId),
    });
    return;
  }
  try {
    await sendTypingOn(recipientId, token, trace);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (msg.includes("2018048")) return;
    logWarn("webhook.typing.failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      pageId,
      recipientHash: hashIdentifier(recipientId),
      classification: classifyError(error),
      message: msg,
      bodySnippet:
        error && typeof error === "object" && "bodySnippet" in error
          ? String((error as { bodySnippet?: unknown }).bodySnippet || "")
          : undefined,
    });
  }
}
function normalizeLowerText(value: string): string {
  return value.trim().toLowerCase();
}
function isQuickInfoKeyword(text: string, keywords: string[]): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  for (const keyword of keywords) {
    if (normalizeLowerText(keyword) === normalized) return true;
  }
  return false;
}
function isHandoffRequest(text: string, keywords: string[]): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  for (const keyword of keywords) {
    const token = normalizeLowerText(keyword);
    if (token && normalized.includes(token)) return true;
  }
  return false;
}
const BOOKING_INTENT_KEYWORDS = [
  "захиал",
  "бүртгүүл",
  "суудал ав",
  "тийз ав",
  "book",
  "booking",
];
function isBookingIntent(text: string): boolean {
  const normalized = normalizeLowerText(text);
  if (!normalized) return false;
  return BOOKING_INTENT_KEYWORDS.some((keyword) => normalized.includes(keyword));
}
function extractPhoneNumber(text: string): string {
  const compact = text.replace(/[\s\-()]/g, "");
  const match = compact.match(/(?<!\d)[5-9]\d{7}(?!\d)/);
  return match ? match[0] : "";
}
function isCommentTriggerMatch(commentText: string, patterns: string[]): boolean {
  const normalized = normalizeLowerText(commentText);
  if (!normalized) return false;
  for (const pattern of patterns) {
    const token = normalizeLowerText(pattern);
    if (!token) continue;
    if (token.startsWith("/") && token.endsWith("/") && token.length > 2) {
      try {
        const regex = new RegExp(token.slice(1, -1), "i");
        if (regex.test(commentText)) return true;
      } catch {
      }
      continue;
    }
    if (normalized.includes(token)) return true;
  }
  return false;
}
async function handleMessage(
  platform: Platform,
  senderId: string,
  text: string,
  pageId: string,
  igUserId?: string | null,
  token?: string,
  trace?: { requestId: string; correlationId: string; source: string },
  ensureLockHealthy?: () => Promise<void> | void,
) {
  const assertLockHealthy = async () => {
    if (ensureLockHealthy) await ensureLockHealthy();
  };
  const limit = await rateLimitAsync(
    `${platform === "facebook" ? "fb" : "ig"}:${senderId}`,
    20,
    10 * 60 * 1000,
  );
  if (!limit.allowed) {
    recordCounter("abuse.webhook_sender_rate_limited_total", 1, { platform });
    const waitMsg = "Түр хүлээнэ үү, дараа оролдоно уу.";
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      waitMsg,
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError("delivery_failed:rate_limited");
    }
    return;
  }
  if (text.length > MAX_INCOMING_TEXT_CHARS) {
    recordCounter("abuse.webhook_text_too_long_total", 1, { platform });
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      "Асуултаа арай богино бичээд дахин илгээнэ үү.",
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError("delivery_failed:text_too_long");
    }
    return;
  }
  await trackSender(senderId);
  if (platform === "facebook" && token && !hasProgramIntent(text)) {
    void fetchAndStoreFbName(senderId, token);
  }
  if (await isPagePaused(pageId)) {
    logInfo("webhook.page_pause_active", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      pageId,
      senderHash: hashIdentifier(senderId),
    });
    return;
  }
  if (await isPaused(senderId)) {
    logInfo("webhook.sender_paused", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
    });
    return;
  }
  if (platform === "facebook") {
    await sendFacebookTypingIndicator(senderId, token, pageId, trace);
  }
  const botSettings = await getTravelBotSettings();
  void logInboundMessage({ platform, senderId, text });
  const greeting = resolveGreetingConfig(botSettings.extra);
  if (
    platform === "facebook" &&
    token &&
    greeting.enabled &&
    (await isFirstMessage(senderId, platform))
  ) {
    try {
      const welcomeText =
        greeting.text ||
        botSettings.quick_info_reply ||
        "Уудам Трэвел-д тавтай морилно уу! Бид танд хамгийн шилдэг аялалыг санал болгоно. Доорх аялалуудаас сонирхсоноо асуугаарай.";
      if (welcomeText.trim()) {
        await sendTextMessage(senderId, welcomeText, token, {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          source: "api.webhook.welcome",
        });
      }
      let defaultAlbum: string[] = [];
      if (greeting.defaultPhotoUrls.length > 0) {
        defaultAlbum = greeting.defaultPhotoUrls.slice(0, 10);
      } else if (greeting.usePhotoUrls && greeting.photoUrls.length > 0) {
        defaultAlbum = greeting.photoUrls.slice(0, 10);
      } else if (!greeting.usePhotoUrls) {
        const allTrips = await listTrips({ limit: 5000 });
        defaultAlbum = sampleWelcomePhotos(allTrips);
      }
      await sendPhotoAlbum(senderId, defaultAlbum, token, trace);
      const activeSeason = getActiveSeason(resolveSeasons(botSettings.extra));
      if (activeSeason && activeSeason.photoUrls.length > 0) {
        await sendPhotoAlbum(senderId, activeSeason.photoUrls.slice(0, 10), token, trace);
      }
      recordCounter("webhook.welcome_sent_total", 1, {
        platform,
        photoCount: String(defaultAlbum.length),
        seasonPhotoCount: String(activeSeason?.photoUrls.length || 0),
      });
    } catch (error) {
      logWarn("webhook.welcome_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
  }
  if (platform === "facebook" && token) {
    const matchedSeason = matchSeasonByText(text, resolveSeasons(botSettings.extra));
    if (matchedSeason) {
      const dedupeKey = `season_sent:${platform}:${senderId}:${matchedSeason.id}`;
      const shouldSend = await withRedis("webhook.season_dedupe", async (r) => {
        const set = await r.set(dedupeKey, "1", "EX", 600, "NX");
        return set === "OK";
      });
      if (shouldSend !== false) {
        await sendPhotoAlbum(senderId, matchedSeason.photoUrls.slice(0, 10), token, trace);
        recordCounter("webhook.season_album_sent_total", 1, {
          platform,
          season: matchedSeason.name,
        });
      }
    }
  }
  if (botSettings.handoff_enabled) {
    const collectState = await getCollectState(senderId);
    if (collectState && collectState.step !== "done") {
      const nextState = advanceCollectState(collectState, text);
      if (nextState.step === "done") {
        await clearCollectState(senderId);
        const pauseMs =
          botSettings.handoff_pause_minutes > 0
            ? botSettings.handoff_pause_minutes * 60_000
            : undefined;
        await pauseBot(senderId, pauseMs, "handoff");
        try {
          await createLead({
            kind: "booking",
            platform,
            senderId,
            customerMessage: nextState.originalMessage,
            contactPhone: nextState.phone,
            context: buildLeadContext(nextState),
          });
          await notifyStaffOfLead(
            {
              kind: "booking",
              platform,
              customerMessage: `${nextState.name} | ${nextState.phone} | ${nextState.trip}`,
              contactPhone: nextState.phone,
            },
            {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook",
            },
          );
          recordCounter("webhook.booking_collect_completed_total", 1, { platform });
        } catch (error) {
          logWarn("webhook.booking_collect_lead_failed", {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            platform,
            senderHash: hashIdentifier(senderId),
            classification: classifyError(error),
          });
        }
        const completionMsg = buildCompletionMessage(nextState);
        await assertLockHealthy();
        const delivered = await sendPlatformMessage(
          platform,
          senderId,
          completionMsg,
          token,
          pageId,
          igUserId,
          trace,
          { allowFallback: false },
        );
        if (!delivered) {
          throw new RetryableWebhookError("delivery_failed:booking_collect_done");
        }
        return;
      } else {
        await setCollectState(senderId, nextState);
        const question = promptForStep(nextState.step);
        await assertLockHealthy();
        const delivered = await sendPlatformMessage(
          platform,
          senderId,
          question,
          token,
          pageId,
          igUserId,
          trace,
          { allowFallback: false },
        );
        if (!delivered) {
          throw new RetryableWebhookError("delivery_failed:booking_collect_step");
        }
        return;
      }
    }
  }
  let flowAiPromptOverride: string | undefined;
  const flowDocs: FlowDoc[] = Array.isArray(botSettings.extra?.flowDocs)
    ? (botSettings.extra.flowDocs as FlowDoc[])
    : [];
  const flowSessionId = `${platform}:${pageId}:${senderId}`;
  function buildFlowEffects(): FlowEffects {
    return {
      sendText: async (msg: string) => {
        await assertLockHealthy();
        const ok = await sendPlatformMessage(
          platform, senderId, msg, token, pageId, igUserId, trace, { allowFallback: false },
        );
        if (!ok) throw new RetryableWebhookError("delivery_failed:flow_message");
        await appendMessage(flowSessionId, "assistant", msg).catch(() => {});
      },
      sendImage: token && platform === "facebook"
        ? async (url: string) => {
            await sendImageMessage(senderId, url, token, {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook.flow_image",
            });
          }
        : undefined,
      sendQuickReplies: token && platform === "facebook"
        ? async (msg: string, labels: string[]) => {
            await sendQuickReplies(senderId, msg, labels, token, {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook.flow_quick",
            });
            await appendMessage(flowSessionId, "assistant", msg).catch(() => {});
          }
        : undefined,
      notifyOwner: async (msg: string) => {
        await notifyStaffOfLead(
          { kind: "handoff", platform, customerMessage: msg },
          { requestId: trace?.requestId, correlationId: trace?.correlationId, source: "api.webhook.flow" },
        ).catch(() => {});
      },
      captureLead: async (state: FlowRuntimeState) => {
        await createLead({
          kind: "booking",
          platform,
          senderId,
          customerMessage: state.fields.message || text,
          contactPhone: state.fields.phone || "",
          context: JSON.stringify(state.fields),
        }).catch(() => {});
      },
    };
  }
  async function persistFlowOutcome(
    doc: FlowDoc,
    state: FlowRuntimeState,
    outcome: RunOutcome,
  ): Promise<{ handedToAi: boolean; systemPromptOverride?: string }> {
    if (outcome.status === "waiting_input") {
      await setFlowState(senderId, platform, state);
      return { handedToAi: false };
    }
    await clearFlowState(senderId, platform);
    if (outcome.status === "handoff_to_ai") {
      return { handedToAi: true, systemPromptOverride: outcome.systemPromptOverride };
    }
    return { handedToAi: false };
  }
  if (flowDocs.length > 0) {
    const activeState = await getFlowState(senderId, platform);
    if (activeState) {
      const doc = flowDocs.find((d) => d.id === activeState.flowId && d.enabled);
      if (doc) {
        recordCounter("webhook.flow_graph_resumed_total", 1, { platform });
        await appendMessage(flowSessionId, "user", text).catch(() => {});
        const outcome = await resumeFlowWithInput(doc, activeState, text, buildFlowEffects());
        const { handedToAi } = await persistFlowOutcome(doc, activeState, outcome);
        if (!handedToAi) return;
      } else {
        await clearFlowState(senderId, platform);
      }
    }
  }
  if (
    botSettings.handoff_enabled &&
    isHandoffRequest(text, botSettings.handoff_keywords)
  ) {
    const pauseMs =
      botSettings.handoff_pause_minutes > 0
        ? botSettings.handoff_pause_minutes * 60_000
        : undefined;
    await pauseBot(senderId, pauseMs, "handoff");
    recordCounter("webhook.handoff_requested_total", 1, { platform });
    logInfo("webhook.handoff_requested", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      pauseMinutes: botSettings.handoff_pause_minutes,
    });
    try {
      await createLead({
        kind: "handoff",
        platform,
        senderId,
        customerMessage: text,
      });
      await notifyStaffOfLead(
        { kind: "handoff", platform, customerMessage: text },
        {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          source: "api.webhook",
        },
      );
    } catch (error) {
      logWarn("webhook.handoff_lead_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    const handoffMsg =
      botSettings.handoff_reply ||
      "Таны хүсэлтийг хүлээн авлаа. Манай ажилтан удахгүй тантай холбогдоно.";
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      handoffMsg,
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError("delivery_failed:handoff");
    }
    return;
  }
  if (
    botSettings.quick_info_reply &&
    isQuickInfoKeyword(text, botSettings.quick_info_keywords)
  ) {
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      botSettings.quick_info_reply,
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError("delivery_failed:quick_info_keyword");
    }
    return;
  }
  const sessionId = `${platform}:${pageId}:${senderId}`;
  if (flowDocs.length > 0) {
    const triggered = findTriggeredFlow(text, flowDocs);
    if (triggered) {
      recordCounter("webhook.flow_graph_triggered_total", 1, { platform });
      await appendMessage(sessionId, "user", text).catch(() => {});
      const state = newRuntimeState(triggered.doc.id, triggered.startNodeId);
      const outcome = await runFlowFrom(
        triggered.doc,
        triggered.startNodeId,
        state,
        buildFlowEffects(),
      );
      const { handedToAi, systemPromptOverride } = await persistFlowOutcome(
        triggered.doc,
        state,
        outcome,
      );
      if (!handedToAi) return;
      flowAiPromptOverride = systemPromptOverride;
    }
  }
  const flowRules = Array.isArray(botSettings.extra?.flows)
    ? (botSettings.extra.flows as FlowRule[])
    : [];
  if (flowRules.length > 0) {
    const matchedRule = matchFlow(text, flowRules);
    if (matchedRule) {
      recordCounter("webhook.flow_rule_matched_total", 1, { platform });
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        matchedRule.reply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:flow_rule");
      }
      try {
        await appendMessage(sessionId, "user", text);
        await appendMessage(sessionId, "assistant", matchedRule.reply);
        await setLastReplyConsistent(sessionId, matchedRule.reply);
      } catch {
      }
      return;
    }
  }
  void maybeAutoSyncDriveFolder({ source: "api.webhook" });
  const { systemPrompt: fileSystemPrompt, business, pinnedButtonLabels } = await readBusinessData();
  await assertLockHealthy();
  const history = await getHistory(sessionId);
  const lastReply = await getLastReplyConsistent(sessionId);
  const customerWantsToBook =
    botSettings.handoff_enabled && isBookingIntent(text);
  if (customerWantsToBook && !(await hasRecentOpenLead(senderId, "booking"))) {
    const newState = startCollectState(text);
    await setCollectState(senderId, newState);
    const firstQuestion = promptForStep(newState.step);
    await appendMessage(sessionId, "user", text);
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      firstQuestion,
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError("delivery_failed:booking_collect_start");
    }
    recordCounter("webhook.booking_collect_started_total", 1, { platform });
    return;
  }
  await appendMessage(sessionId, "user", text);
  async function recordFreshBookingLead() {
  }
  let cachedTrips: Awaited<ReturnType<typeof listTrips>> | null = null;
  const getTrips = async () => {
    if (cachedTrips) return cachedTrips;
    cachedTrips = await listTrips({ limit: 5000 });
    return cachedTrips;
  };
  if (hasDepartureDateAvailabilityIntent(text)) {
    const trips = await getTrips();
    const dateAvailabilityReply = buildDepartureDateAvailabilityReply({
      userText: text,
      trips,
    });
    if (dateAvailabilityReply) {
      const bookingNudge = customerWantsToBook
        ? " Захиалгаа баталгаажуулах бол нэр, утасны дугаараа үлдээгээрэй."
        : "";
      const safeDateReply = enforceWebsiteForPayment(
        sanitizeAssistantReply(fixMojibake(`${dateAvailabilityReply}${bookingNudge}`)),
      );
      if (lastReply && isDuplicateReply(lastReply.text, safeDateReply)) {
        recordCounter("webhook.duplicate_reply_avoided_total", 1, { platform });
        await assertLockHealthy();
        const delivered = await sendPlatformMessage(
          platform,
          senderId,
          "Уучлаарай, яг одоо хариулт боловсруулахад алдаа гарлаа. Хэдэн минутын дараа дахин асууна уу.",
          token,
          pageId,
          igUserId,
          trace,
          { allowFallback: false },
        );
        if (!delivered) {
          throw new RetryableWebhookError("delivery_failed:duplicate_reply_notice");
        }
        await recordFreshBookingLead();
        return;
      }
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        safeDateReply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:date_availability_reply");
      }
      try {
        await appendMessage(sessionId, "assistant", safeDateReply);
        await setLastReplyConsistent(sessionId, safeDateReply);
      } catch (error) {
        logWarn("webhook.reply_state_persist_failed", {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          platform,
          senderHash: hashIdentifier(senderId),
          classification: classifyError(error),
        });
      }
      await recordFreshBookingLead();
      return;
    }
  }
  if (hasSeatsIntent(text)) {
    const trips = await getTrips();
    const seatsReply = buildSeatsReply(text, trips);
    if (seatsReply) {
      const safeSeatsReply = enforceWebsiteForPayment(sanitizeAssistantReply(seatsReply));
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        safeSeatsReply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:seats_fast_path");
      }
      try {
        await appendMessage(sessionId, "assistant", safeSeatsReply);
        await setLastReplyConsistent(sessionId, safeSeatsReply);
      } catch {
      }
      recordCounter("webhook.seats_fast_path_total", 1, { platform });
      return;
    }
  }
  if (hasDiscountIntent(text)) {
    const trips = await getTrips();
    const discountReply = buildDiscountReply(text, trips);
    if (discountReply) {
      const safeDiscountReply = enforceWebsiteForPayment(sanitizeAssistantReply(discountReply));
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        safeDiscountReply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:discount_fast_path");
      }
      try {
        await appendMessage(sessionId, "assistant", safeDiscountReply);
        await setLastReplyConsistent(sessionId, safeDiscountReply);
      } catch {
      }
      recordCounter("webhook.discount_fast_path_total", 1, { platform });
      return;
    }
  }
  if (hasCompareIntent(text)) {
    const trips = await getTrips();
    const compareReply = buildCompareReply(text, trips);
    if (compareReply) {
      const safeCompareReply = enforceWebsiteForPayment(sanitizeAssistantReply(compareReply));
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        safeCompareReply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:compare_fast_path");
      }
      try {
        await appendMessage(sessionId, "assistant", safeCompareReply);
        await setLastReplyConsistent(sessionId, safeCompareReply);
      } catch {
      }
      recordCounter("webhook.compare_fast_path_total", 1, { platform });
      return;
    }
  }
  {
    const trips = await getTrips();
    const programReply = buildTripProgramReply(text, trips);
    if (programReply) {
      const safeProgramReply = enforceWebsiteForPayment(
        sanitizeAssistantReply(programReply.reply),
      );
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        safeProgramReply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:program_fast_path");
      }
      if (platform === "facebook" && token) {
        if (programReply.brochure) {
          // Fire-and-forget to a separate endpoint so the webhook can return 200
          // to Meta immediately. The Drive download + FB upload can take 15-30s
          // which exceeds Vercel's function timeout if done inline here.
          const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL || "localhost:3000"}`;
          const body = programReply.brochure.type === "id"
            ? { recipientId: senderId, brochureId: programReply.brochure.value, pageToken: token }
            : { recipientId: senderId, brochureUrl: programReply.brochure.value, pageToken: token };
          fetch(`${baseUrl}/api/send-brochure`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-internal-token": env.verifyToken,
            },
            body: JSON.stringify(body),
          }).catch(() => {});
        } else {
          for (const url of programReply.mediaUrls) {
            try {
              await sendImageMessage(senderId, url, token, {
                requestId: trace?.requestId,
                correlationId: trace?.correlationId,
                source: "api.webhook.program_media",
              });
            } catch {
            }
          }
        }
      }
      try {
        await appendMessage(sessionId, "assistant", safeProgramReply);
        await setLastReplyConsistent(sessionId, safeProgramReply);
      } catch {
      }
      recordCounter("webhook.program_fast_path_total", 1, { platform });
      return;
    }
    const structuredTripReply = buildStructuredTripReply(text, trips);
    if (structuredTripReply) {
      const safeStructuredReply = enforceWebsiteForPayment(
        sanitizeAssistantReply(structuredTripReply),
      );
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform,
        senderId,
        safeStructuredReply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:structured_trip_fast_path");
      }
      try {
        await appendMessage(sessionId, "assistant", safeStructuredReply);
        await setLastReplyConsistent(sessionId, safeStructuredReply);
      } catch {
      }
      recordCounter("webhook.trip_fast_path_total", 1, { platform });
      return;
    }
  }
  const prompt = buildPrompt({
    systemPrompt: flowAiPromptOverride
      ? `${fileSystemPrompt}\n\n${flowAiPromptOverride}`
      : fileSystemPrompt,
    business: business || {},
    history,
    userText: text,
    pinnedButtonLabels,
  });
  let aiReply: string;
  try {
    const result = await askGemini(prompt, {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source: "api.webhook",
    });
    aiReply = result.text;
  } catch (error) {
    logWarn("webhook.ai_fallback_reply", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
    });
    aiReply = "Уучлаарай, систем түр алдаатай байна.";
  }
  const fixedReply = fixMojibake(aiReply);
  const { text: replyWithoutButtons, buttons: aiButtons } = extractButtons(fixedReply);
  const recentAssistantReplies = history
    .filter((message) => message.role === "assistant")
    .map((message) => message.text)
    .slice(-3);
  const rewrittenReply = rewriteRepeatedGenericClarifier({
    userText: text,
    replyText: stripRepeatedGreeting(
      sanitizeAssistantReply(replyWithoutButtons),
      history.some((message) => message.role === "assistant"),
    ),
    recentAssistantReplies,
  });
  const safeReply = enforceWebsiteForPayment(rewrittenReply);
  if (lastReply && isDuplicateReply(lastReply.text, safeReply)) {
    recordCounter("webhook.duplicate_reply_avoided_total", 1, { platform });
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      "Тэр мэдээллийг өмнө нь хуваалцсан. Өөр асуулт байвал асуугаарай!",
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError("delivery_failed:duplicate_reply_notice");
    }
    await recordFreshBookingLead();
    return;
  }
  let replyButtons: string[] = [...aiButtons];
  if (platform === "facebook") {
    try {
      const tripsForButtons = await listTrips({ limit: 5000 });
      const smartButtons = buildSmartButtons(safeReply, tripsForButtons);
      if (smartButtons) {
        for (const b of smartButtons) {
          if (!replyButtons.some((x) => x.toLowerCase() === b.toLowerCase())) {
            replyButtons.push(b);
          }
        }
      }
    } catch {
    }
  }
  replyButtons = replyButtons.slice(0, 3);
  await assertLockHealthy();
  let delivered: boolean;
  if (platform === "facebook" && token && replyButtons.length > 0) {
    try {
      await sendQuickReplies(senderId, safeReply, replyButtons, token, {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        source: "api.webhook.reply_buttons",
      });
      recordCounter("webhook.reply_buttons_sent_total", 1, {
        platform,
        buttonCount: String(replyButtons.length),
      });
      delivered = true;
    } catch {
      delivered = await sendPlatformMessage(
        platform, senderId, safeReply, token, pageId, igUserId, trace, { allowFallback: false },
      );
    }
  } else {
    delivered = await sendPlatformMessage(
      platform, senderId, safeReply, token, pageId, igUserId, trace, { allowFallback: false },
    );
  }
  if (!delivered) {
    throw new RetryableWebhookError("delivery_failed:assistant_reply");
  }
  try {
    await appendMessage(sessionId, "assistant", safeReply);
    await setLastReplyConsistent(sessionId, safeReply);
  } catch (error) {
    logWarn("webhook.reply_state_persist_failed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
    });
  }
  if (platform === "facebook" && token) {
    try {
      const tripsForPhotos = await listTrips({ limit: 5000 });
      const tripPhotos = extractTripPhotosForReply(safeReply, tripsForPhotos);
      for (const url of tripPhotos) {
        try {
          await sendImageMessage(senderId, url, token, {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.trip_photo",
          });
        } catch {
        }
      }
      if (tripPhotos.length > 0) {
        recordCounter("webhook.trip_photos_sent_total", 1, {
          platform,
          photoCount: String(tripPhotos.length),
        });
      }

      // Send PDF brochure if this trip has a stored attachment_id or a brochure_pdf_url.
      // Fire-and-forget via /api/send-brochure to avoid blocking the webhook response.
      const brochure = extractTripBrochureAttachmentId(safeReply, tripsForPhotos);
      if (brochure && token) {
        const baseUrl = process.env.BASE_URL || process.env.NEXT_PUBLIC_APP_URL || `https://${process.env.VERCEL_URL || "localhost:3000"}`;
        const body = brochure.type === "id"
          ? { recipientId: senderId, brochureId: brochure.value, pageToken: token }
          : { recipientId: senderId, brochureUrl: brochure.value, pageToken: token };
        fetch(`${baseUrl}/api/send-brochure`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-token": env.verifyToken,
          },
          body: JSON.stringify(body),
        }).catch(() => {});
        recordCounter("webhook.trip_brochure_sent_total", 1, { platform });
      }
    } catch {
    }
  }
  await recordFreshBookingLead();
}
async function processConversationWithPendingQueue(
  conversationKey: string,
  initial: PendingConversationPayload,
  lockToken: string | null,
) {
  activeConversations.add(conversationKey);
  updateConcurrencyGauges();
  try {
    let current = initial;
    while (current) {
      const lockHealthy = await refreshConversationLockConsistent(
        conversationKey,
        lockToken,
      );
      if (!lockHealthy) {
        recordCounter("webhook.conversation_lock_lost_total", 1);
        logWarn("webhook.conversation_lock_lost", {
          conversationKeyHash: hashIdentifier(conversationKey),
        });
        break;
      }
      await withConversationLockHeartbeat(
        conversationKey,
        lockToken,
        async (ensureLockHealthy) =>
          handleMessage(
            current.platform,
            current.senderId,
            current.text,
            current.pageId,
            current.igUserId,
            current.token,
            {
              requestId: current.trace?.requestId || "",
              correlationId: current.trace?.correlationId || "",
              source: "api.webhook",
            },
            ensureLockHealthy,
          ),
      );
      const pending = await drainPendingConversationConsistent(conversationKey);
      if (!pending) break;
      current = pending;
      updateConcurrencyGauges();
    }
  } finally {
    activeConversations.delete(conversationKey);
    await releaseConversationLockConsistent(conversationKey, lockToken);
    updateConcurrencyGauges();
  }
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
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const trace = beginRequestTrace({
    route: "api.webhook",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });
  try {
    if (req.method === "GET") {
      const mode = req.query["hub.mode"];
      const token = req.query["hub.verify_token"];
      const challenge = req.query["hub.challenge"];
      if (mode === "subscribe" && verifyToken(token))
        return res.status(200).send(challenge as string);
      recordCounter("abuse.webhook_verify_failed_total", 1);
      return res.status(403).send("Verification failed");
    }
    if (req.method === "POST") {
      try {
        let rawBody: Buffer;
        try {
          rawBody = await readRawBody(req);
        } catch (error) {
          if (error instanceof PayloadTooLargeError) {
            recordCounter("abuse.webhook_payload_too_large_total", 1);
            return res.status(413).json({ error: "payload_too_large" });
          }
          throw error;
        }
        const signatureHeader =
          req.headers["x-hub-signature-256"] || req.headers["x-hub-signature"];
        const signature = Array.isArray(signatureHeader)
          ? signatureHeader[0]
          : signatureHeader;
        if (!verifyMetaSignature(rawBody, signature, META_APP_SECRET)) {
          recordCounter("abuse.webhook_invalid_signature_total", 1);
          return res.status(401).json({ error: "invalid_signature" });
        }
        let body: unknown;
        try {
          body = parseWebhookJson(rawBody);
        } catch {
          recordCounter("abuse.webhook_invalid_json_total", 1);
          return res.status(400).json({ error: "invalid_json" });
        }
        const payload = body as {
          object?: string;
          entry?: Array<{
            id?: string;
            changes?: Array<{
              field?: string;
              value?: {
                item?: string;
                verb?: string;
                from?: { id?: string };
                message?: string;
                comment_id?: string;
              };
            }>;
            messaging?: Array<{
              sender?: { id?: string };
              message?: { is_echo?: boolean; mid?: string; text?: string };
            }>;
          }>;
        };
        logInfo("webhook.received", {
          requestId: trace.requestId,
          correlationId: trace.correlationId,
          object: payload?.object,
          entryCount: Array.isArray(payload?.entry) ? payload.entry.length : 0,
        });
        if (payload.object === "page" || payload.object === "instagram") {
          for (const entry of payload.entry || []) {
            const pageId =
              typeof entry?.id === "string" ? entry.id : String(entry?.id || "");
            const botSettings = await getTravelBotSettings();
            const feedChanges = Array.isArray(entry?.changes) ? entry.changes : [];
            for (const change of feedChanges) {
              if (change?.field !== "feed") continue;
              const val = change?.value;
              if (val?.item !== "comment") continue;
              if (val?.verb !== "add") continue;
              if (String(val?.from?.id) === pageId) continue;
              const commenterId = String(val?.from?.id || "").trim();
              const commentText = String(val?.message || "").trim();
              if (!commenterId || !commentText) continue;
              const isTriggered = isCommentTriggerMatch(
                commentText,
                botSettings.comment_trigger_patterns,
              );
              if (!isTriggered) continue;
              const commentId = String(val?.comment_id || "").trim();
              const feedKey = commentId
                ? `feed:${commentId}`
                : `feed:${commenterId}:${hashIdentifier(normalizeLowerText(commentText))}`;
              await runEventWithClaim(
                feedKey,
                { platform: "facebook", eventType: "feed" },
                async () => {
                  const token = PAGE_TOKENS.get(pageId);
                  if (!token) {
                    logWarn("webhook.unexpected_page", {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                      pageId,
                      eventType: "feed",
                    });
                    return;
                  }
                  logInfo("webhook.comment_trigger", {
                    requestId: trace.requestId,
                    correlationId: trace.correlationId,
                    commenterHash: hashIdentifier(commenterId),
                    commentId: commentId || null,
                  });
                  const publicReply = botSettings.comment_public_reply.trim();
                  const dmText = botSettings.comment_dm_reply.trim();
                  if (!dmText) {
                    logWarn("webhook.comment_dm_skipped_missing_settings", {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                      commenterHash: hashIdentifier(commenterId),
                      commentId: commentId || null,
                    });
                    return;
                  }
                  const dmDelivered = await sendPlatformMessage(
                    "facebook",
                    commenterId,
                    dmText,
                    token,
                    pageId,
                    undefined,
                    {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                      source: "api.webhook.comment_dm",
                    },
                    { allowFallback: false },
                  );
                  if (!dmDelivered) {
                    throw new RetryableWebhookError("delivery_failed:comment_dm");
                  }
                  if (commentId && publicReply) {
                    try {
                      await replyToComment(commentId, publicReply, token, {
                        requestId: trace.requestId,
                        correlationId: trace.correlationId,
                        source: "api.webhook.comment_reply",
                      });
                    } catch (error) {
                      logWarn("webhook.comment_reply_failed", {
                        requestId: trace.requestId,
                        correlationId: trace.correlationId,
                        commentId,
                        classification: classifyError(error),
                        message:
                          error instanceof Error ? error.message : String(error),
                      });
                    }
                  }
                },
              );
            }
            const messagingEvents = Array.isArray(entry?.messaging)
              ? entry.messaging
              : [];
            for (const event of messagingEvents) {
              if (!event?.sender?.id) continue;
              if (event?.message?.is_echo) continue;
              const senderId = String(event.sender.id).trim();
              const text =
                typeof event?.message?.text === "string"
                  ? event.message.text.trim()
                  : "";
              if (!senderId || !text) continue;
              if (payload.object === "page" && !PAGE_TOKENS.has(pageId)) {
                logWarn("webhook.unexpected_page", {
                  requestId: trace.requestId,
                  correlationId: trace.correlationId,
                  pageId,
                  knownPageIds: Array.from(PAGE_TOKENS.keys()),
                  senderHash: hashIdentifier(senderId),
                });
                continue;
              }
              const platform: Platform =
                payload.object === "instagram" ? "instagram" : "facebook";
              const token = PAGE_TOKENS.get(pageId) ?? FALLBACK_TOKEN;
              const eventKey = buildEventKey(platform, senderId, event);
              await runEventWithClaim(
                eventKey,
                { platform, eventType: "dm" },
                async () => {
                  if (!token) {
                    logError("webhook.missing_page_token", {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                      platform,
                      pageId,
                      senderHash: hashIdentifier(senderId),
                    });
                    throw new RetryableWebhookError("missing_page_token:dm");
                  }
                  const conversationKey = `${platform}:${pageId}:${senderId}`;
                  const payloadForConversation: PendingConversationPayload = {
                    platform,
                    senderId,
                    text,
                    pageId,
                    igUserId: platform === "instagram" ? pageId : undefined,
                    token,
                    trace: {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                    },
                  };
                  const busy = await hasConversationLockConsistent(conversationKey);
                  if (busy) {
                    await enqueuePendingConversationConsistent(
                      conversationKey,
                      payloadForConversation,
                    );
                    return;
                  }
                  const lockToken = await acquireConversationLockConsistent(
                    conversationKey,
                  );
                  if (lockToken === "") {
                    await enqueuePendingConversationConsistent(
                      conversationKey,
                      payloadForConversation,
                    );
                    return;
                  }
                  let initialPayload = payloadForConversation;
                  const pendingBefore = await drainPendingConversationConsistent(
                    conversationKey,
                  );
                  if (pendingBefore) {
                    await enqueuePendingConversationConsistent(
                      conversationKey,
                      payloadForConversation,
                    );
                    initialPayload = pendingBefore;
                  }
                  await processConversationWithPendingQueue(
                    conversationKey,
                    initialPayload,
                    lockToken,
                  );
                },
              );
            }
          }
        }
        return res.status(200).json({ ok: true });
      } catch (err) {
        if (isRetryableWebhookError(err)) {
          recordCounter("webhook.retryable_failure_total", 1, {
            reason: err.message.split(":")[0] || "unknown",
          });
          logWarn("webhook.retryable_error", {
            requestId: trace.requestId,
            correlationId: trace.correlationId,
            message: err.message,
          });
          res.setHeader("Retry-After", "5");
          return res.status(503).json({ error: "retryable_failure" });
        }
        logError("webhook.unhandled_error", {
          requestId: trace.requestId,
          correlationId: trace.correlationId,
          classification: classifyError(err),
          message: err instanceof Error ? err.message : String(err),
        });
        return res.status(500).json({ error: "internal_error" });
      }
    }
    return res.status(405).end();
  } finally {
    updateConcurrencyGauges();
    finishRequestTrace(trace, res.statusCode || 500, {
      activeConversationCount: activeConversations.size,
      pendingConversationCount: pendingConversations.size,
    });
  }
}
