/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NextApiRequest, NextApiResponse } from "next";
import { askGemini } from "../../lib/gemini";
import {
  buildShardedRateLimitKey,
  getClientKey,
  rateLimitAsync,
} from "../../lib/rateLimit";
import { readBusinessData } from "../../lib/businessData";
import { appendMessage, buildPrompt, getHistory } from "../../lib/conversation";
import { fixMojibake } from "../../lib/encoding";
import { maybeAutoSyncDriveFolder } from "../../lib/googleDriveSync";
import { enforceWebsiteForPayment, extractButtons, isDuplicateReply, rewriteRepeatedGenericClarifier, sanitizeAssistantReply, stripRepeatedGreeting } from "../../lib/reply";
import { getTravelBotSettings, listTrips } from "../../lib/travelOps";
import { buildDepartureDateAvailabilityReply, hasDepartureDateAvailabilityIntent } from "../../lib/travelDates";
import { buildCompareReply, buildDiscountReply, buildSeatsReply, buildStructuredTripReply, buildTripProgramReply, hasCompareIntent, hasDiscountIntent, hasSeatsIntent } from "../../lib/travelFastPaths";
import { getEnv } from "../../lib/env";
import {
  beginRequestTrace,
  classifyError,
  finishRequestTrace,
  hashIdentifier,
  logError,
  logInfo,
  recordCounter,
} from "../../lib/observability";

const env = getEnv();
const DEMO_MAX_TEXT_CHARS = env.demoMaxTextChars;
const DEMO_GLOBAL_LIMIT = env.demoGlobalRateLimit;
const DEMO_CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]{16,80}$/;

function normalizeConversationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DEMO_CONVERSATION_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  const trace = beginRequestTrace({
    route: "api.demo",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  try {
    if (req.method === "GET") {
      const settings = await getTravelBotSettings();
      return res.status(200).json({ pinned_buttons: settings.chat_buttons });
    }

    if (req.method !== "POST") {
      return res.status(405).end();
    }

    const { text, conversationId } = req.body || {};
    if (typeof text !== "string") return res.status(400).json({ error: "missing text" });

    const normalizedText = text.trim();
    if (!normalizedText) return res.status(400).json({ error: "missing text" });
    if (normalizedText.length > DEMO_MAX_TEXT_CHARS) {
      return res.status(413).json({ error: "text_too_long", max: DEMO_MAX_TEXT_CHARS });
    }

    const clientKey = getClientKey(req);
    const clientHash = hashIdentifier(clientKey);
    const normalizedConversationId = normalizeConversationId(conversationId);
    if (!normalizedConversationId) {
      return res.status(400).json({ error: "invalid_conversation_id" });
    }

    const key = `demo:${clientKey}`;
    const limit = await rateLimitAsync(key, 30, 5 * 60 * 1000); // 30 requests per 5 minutes per IP
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.demo",
        scope: "client",
      });
      return res.status(429).json({
        error: "rate_limited",
        reset: limit.reset,
      });
    }

    const shardKey = buildShardedRateLimitKey("demo:global", clientKey, 32);
    const shardLimit = await rateLimitAsync(
      shardKey,
      DEMO_GLOBAL_LIMIT,
      60 * 1000,
    );
    if (!shardLimit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.demo",
        scope: "global_shard",
      });
      return res.status(429).json({
        error: "server_busy",
        reset: shardLimit.reset,
      });
    }

    const globalLimit = await rateLimitAsync(
      "demo:global:all",
      DEMO_GLOBAL_LIMIT * 32,
      60 * 1000,
    );
    if (!globalLimit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.demo",
        scope: "global_all",
      });
      return res.status(429).json({
        error: "server_busy",
        reset: globalLimit.reset,
      });
    }

    try {
      void maybeAutoSyncDriveFolder({ source: "api.demo" });
      const { systemPrompt, business, pinnedButtonLabels } = await readBusinessData();
      const sessionId = `demo:${normalizedConversationId}`;
      const history = await getHistory(sessionId);

      // Fast path: departure date availability
      if (hasDepartureDateAvailabilityIntent(normalizedText)) {
        const trips = await listTrips({ limit: 5000 });
        const dateReply = buildDepartureDateAvailabilityReply({ userText: normalizedText, trips });
        if (dateReply) {
          const safeReply = enforceWebsiteForPayment(sanitizeAssistantReply(fixMojibake(dateReply)));
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", safeReply);
          recordCounter("demo.date_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: seats availability
      if (hasSeatsIntent(normalizedText)) {
        const trips = await listTrips({ limit: 5000 });
        const seatsReply = buildSeatsReply(normalizedText, trips);
        if (seatsReply) {
          const safeReply = enforceWebsiteForPayment(sanitizeAssistantReply(seatsReply));
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", safeReply);
          recordCounter("demo.seats_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: discount query
      if (hasDiscountIntent(normalizedText)) {
        const trips = await listTrips({ limit: 5000 });
        const discountReply = buildDiscountReply(normalizedText, trips);
        if (discountReply) {
          const safeReply = enforceWebsiteForPayment(sanitizeAssistantReply(discountReply));
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", safeReply);
          recordCounter("demo.discount_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: trip comparison
      if (hasCompareIntent(normalizedText)) {
        const trips = await listTrips({ limit: 5000 });
        const compareReply = buildCompareReply(normalizedText, trips);
        if (compareReply) {
          const safeReply = enforceWebsiteForPayment(sanitizeAssistantReply(compareReply));
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", safeReply);
          recordCounter("demo.compare_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: structured trip query (price/duration/dates/flight for a specific trip)
      {
        const trips = await listTrips({ limit: 5000 });
        const programReply = buildTripProgramReply(normalizedText, trips);
        if (programReply) {
          const brochureLine = programReply.brochure?.type === "url"
            ? `\n\nPDF хөтөлбөр: ${programReply.brochure.value}`
            : "";
          const mediaLine = !programReply.brochure && programReply.mediaUrls.length > 0
            ? `\n\nХөтөлбөрийн зураг:\n${programReply.mediaUrls.join("\n")}`
            : "";
          const safeReply = enforceWebsiteForPayment(
            sanitizeAssistantReply(`${programReply.reply}${brochureLine}${mediaLine}`),
          );
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", safeReply);
          recordCounter("demo.program_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
        const structuredReply = buildStructuredTripReply(normalizedText, trips);
        if (structuredReply) {
          const safeReply = enforceWebsiteForPayment(sanitizeAssistantReply(structuredReply));
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", safeReply);
          recordCounter("demo.structured_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      await appendMessage(sessionId, "user", normalizedText);

      const prompt = buildPrompt({
        systemPrompt,
        business: business || {},
        history,
        userText: normalizedText,
        pinnedButtonLabels,
      });
      const result = await askGemini(prompt, {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        source: "api.demo",
      });
      const rawFixed = fixMojibake(result.text);
      const { text: rawNoButtons, buttons } = extractButtons(rawFixed);
      const recentAssistantReplies = history
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .slice(-3);
      const reply = enforceWebsiteForPayment(
        rewriteRepeatedGenericClarifier({
          userText: normalizedText,
          replyText: stripRepeatedGreeting(
            sanitizeAssistantReply(rawNoButtons),
            history.some((message) => message.role === "assistant"),
          ),
          recentAssistantReplies,
        }),
      );

      // Skip duplicate replies (same as Messenger behavior)
      const lastMessages = history.filter((m) => m.role === "assistant");
      const lastReplyText = lastMessages.length > 0 ? lastMessages[lastMessages.length - 1].text : null;
      if (lastReplyText && isDuplicateReply(lastReplyText, reply)) {
        recordCounter("demo.duplicate_reply_avoided_total", 1, {});
        await appendMessage(sessionId, "assistant", reply);
        return res.status(200).json({ reply, buttons });
      }

      await appendMessage(sessionId, "assistant", reply);

      logInfo("demo.reply_generated", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        clientHash,
        conversationIdSuffix: normalizedConversationId.slice(-8),
        promptLength: prompt.length,
        replyLength: reply.length,
        buttonCount: buttons.length,
      });

      return res.status(200).json({ reply, buttons });
    } catch (error: any) {
      const classification = classifyError(error);
      logError("demo.request_failed", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        classification,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(500).json({ error: "server_error" });
    }
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
