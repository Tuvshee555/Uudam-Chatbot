/* eslint-disable @typescript-eslint/no-explicit-any */
import type { NextApiRequest, NextApiResponse } from "next";
import { askOpenAI } from "../../lib/openaiProvider";
import { askOpenAIChatParts } from "../../lib/openaiFallback";
import {
  buildShardedRateLimitKey,
  getClientKey,
  rateLimitAsync,
} from "../../lib/rateLimit";
import { readBusinessData } from "../../lib/businessData";
import { appendMessage, buildPromptParts, getHistory, hasAskedForPhone, isReferReply } from "../../lib/conversation";
import { buildContextualUserText } from "../../lib/contextualText";
import { routeFastPathText, type FastPathRoute } from "../../lib/fastPathRouting";
import { getCustomerMemoryText, scheduleCustomerMemoryUpdate } from "../../lib/conversationMemory";
import { analyzeBeforeReply, buildTripIndexLines, shouldAnalyzeBeforeReply } from "../../lib/replyReasoning";
import { fixMojibake } from "../../lib/encoding";
import { scheduleDriveAutoSync } from "../../lib/googleDriveSync";
import { buildHandoffAcknowledgement, enforcePaymentNeverSelfConfirmed, enforceWebsiteForPayment, extractButtons, hasPaymentClaimIntent, isDuplicateReply, PAYMENT_VERIFICATION_DEFERRAL_REPLY, reconcilePhotoAttachmentReply, rewriteRepeatedGenericClarifier, sanitizeAssistantReply, shouldSilenceNoDataReply, stripRepeatedGreeting } from "../../lib/reply";
import { getTravelBotSettings, listTrips } from "../../lib/travelOps";
import { buildDepartureDateAvailabilityReply, hasDepartureDateAvailabilityIntent } from "../../lib/travelDates";
import { appendLeadCaptureCta, buildAmbiguousTripReply, buildBudgetReply, buildCompareReply, buildDiscountReply, buildSeatsReply, buildStructuredTripReply, buildTripProgramReply, hasBudgetIntent, hasCompareIntent, hasDiscountIntent, hasSeatsIntent, resolveTripFromUserMessage } from "../../lib/travelFastPaths";
import { extractTripPhotosForReply, hasTripPhotoIntent } from "../../lib/welcomeFlow";
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

type DemoMedia = {
  mediaUrls: string[];
  brochureUrl: string | null;
};

function normalizeConversationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!DEMO_CONVERSATION_ID_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function isLocalQaRequest(req: NextApiRequest): boolean {
  if (process.env.NODE_ENV === "production") return false;
  const marker = req.headers["x-uudam-demo-qa"];
  return marker === "1" || marker === "true";
}

function imageAttachments(urls: string[]) {
  return urls.map((url) => ({ type: "image" as const, url }));
}

function buildDemoMedia(input: {
  reply: string;
  userText: string;
  trips: Awaited<ReturnType<typeof listTrips>>;
  explicitMediaUrls?: string[];
  brochureUrl?: string | null;
}): DemoMedia {
  const explicit = input.explicitMediaUrls || [];
  const inferred = explicit.length > 0 || !hasTripPhotoIntent(input.userText)
    ? []
    : extractTripPhotosForReply(input.reply, input.trips, { userText: input.userText });
  const mediaUrls = Array.from(new Set([...explicit, ...inferred]))
    .filter((url) => typeof url === "string" && url.startsWith("https://"))
    .slice(0, 2);
  const brochureUrl = input.brochureUrl && input.brochureUrl.startsWith("https://")
    ? input.brochureUrl
    : null;
  return { mediaUrls, brochureUrl };
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
    const qaBypassRateLimit = isLocalQaRequest(req);

    if (!qaBypassRateLimit) {
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
    }

    try {
      scheduleDriveAutoSync({ source: "api.demo" });
      const { systemPrompt, business, pinnedButtonLabels } = await readBusinessData();
      const sessionId = `demo:${normalizedConversationId}`;
      const history = await getHistory(sessionId);
      const phoneAlreadyRequested = hasAskedForPhone(history);
      const customerMemory = await getCustomerMemoryText(sessionId);
      // Non-blocking memory merge — same as production Messenger.
      const rememberTurn = () =>
        scheduleCustomerMemoryUpdate({
          senderId: sessionId,
          requestId: trace.requestId,
          correlationId: trace.correlationId,
          source: "api.demo",
        });
      const returnHandoff = async (options: { aiOutage?: boolean } = {}) => {
        const reply = buildHandoffAcknowledgement(options);
        await appendMessage(sessionId, "assistant", reply);
        await rememberTurn();
        return res.status(200).json({
          reply,
          buttons: [],
          mediaUrls: [],
          brochureUrl: null,
          handoff: true,
        });
      };
      // Reference resolution + current-message-first routing, identical to the
      // production webhook — the demo used to skip this entirely, so QA runs
      // never exercised the exact matching path Messenger customers hit.
      const contextualUserText = buildContextualUserText(history, normalizedText);
      let cachedTrips: Awaited<ReturnType<typeof listTrips>> | null = null;
      const getTrips = async () => {
        if (cachedTrips) return cachedTrips;
        cachedTrips = await listTrips({ limit: 5000 });
        return cachedTrips;
      };
      let routedCache: FastPathRoute | null = null;
      const getRouted = async (): Promise<FastPathRoute> => {
        if (routedCache !== null) return routedCache;
        routedCache = await routeFastPathText({
          senderId: sessionId,
          text: normalizedText,
          contextualUserText,
          trips: await getTrips(),
        });
        return routedCache;
      };
      const getFastPathText = async (): Promise<string> => (await getRouted()).matchText;

      // A payment/booking confirmation claim ("5 сая шилжүүлсэн") must be
      // acknowledged BEFORE any trip/date/price fast-path runs — those are
      // blind text/number matchers and were hijacking payment claims into an
      // unrelated trip reply (a bare number like "5" or "8" in "5 сая" /
      // "8 сая" matched a trip alias or month availability instead).
      if (hasPaymentClaimIntent(normalizedText)) {
        const deferralReply = enforceWebsiteForPayment(
          sanitizeAssistantReply(PAYMENT_VERIFICATION_DEFERRAL_REPLY),
        );
        await appendMessage(sessionId, "user", normalizedText);
        await appendMessage(sessionId, "assistant", deferralReply);
        await rememberTurn();
        recordCounter("demo.payment_claim_deferred_total", 1, {});
        return res.status(200).json({ reply: deferralReply, buttons: [] });
      }

      // Answer fits several offered candidates — re-ask scoped to exactly
      // those (mirrors the production webhook).
      {
        const routed = await getRouted();
        if (routed.scopedClarify && routed.scopedClarify.length > 0) {
          const clarifyReply = enforceWebsiteForPayment(
            sanitizeAssistantReply(buildAmbiguousTripReply(routed.scopedClarify)),
          );
          await appendMessage(sessionId, "user", normalizedText);
          await appendMessage(sessionId, "assistant", clarifyReply);
          await rememberTurn();
          recordCounter("demo.scoped_clarify_total", 1, {});
          return res.status(200).json({ reply: clarifyReply, buttons: [] });
        }
      }

      // Fast path: departure date availability
      if (hasDepartureDateAvailabilityIntent(normalizedText)) {
        const trips = await getTrips();
        const dateReply = buildDepartureDateAvailabilityReply({ userText: await getFastPathText(), trips });
        if (dateReply) {
          const safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(fixMojibake(dateReply))),
            phoneAlreadyRequested,
          );
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply);
          await rememberTurn();
          recordCounter("demo.date_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: seats availability
      if (hasSeatsIntent(normalizedText)) {
        const trips = await getTrips();
        const seatsReply = buildSeatsReply(await getFastPathText(), trips);
        if (seatsReply) {
          const safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(seatsReply)),
            phoneAlreadyRequested,
          );
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply);
          await rememberTurn();
          recordCounter("demo.seats_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: cheapest / under-budget questions
      if (hasBudgetIntent(normalizedText)) {
        const trips = await getTrips();
        const budgetReply = buildBudgetReply(await getFastPathText(), trips);
        if (budgetReply) {
          const safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(budgetReply)),
            phoneAlreadyRequested,
          );
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply);
          await rememberTurn();
          recordCounter("demo.budget_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: discount query
      if (hasDiscountIntent(normalizedText)) {
        const trips = await getTrips();
        const discountReply = buildDiscountReply(await getFastPathText(), trips);
        if (discountReply) {
          const safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(discountReply)),
            phoneAlreadyRequested,
          );
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply);
          await rememberTurn();
          recordCounter("demo.discount_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: trip comparison
      if (hasCompareIntent(normalizedText)) {
        const trips = await getTrips();
        const compareReply = buildCompareReply(await getFastPathText(), trips);
        if (compareReply) {
          const safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(compareReply)),
            phoneAlreadyRequested,
          );
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply);
          await rememberTurn();
          recordCounter("demo.compare_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [] });
        }
      }

      // Fast path: structured trip query (price/duration/dates/flight for a specific trip)
      {
        const trips = await getTrips();
        const programReply = buildTripProgramReply(await getFastPathText(), trips);
        if (programReply) {
          const brochureLine = programReply.brochure?.type === "url"
            ? `\n\nPDF хөтөлбөр: ${programReply.brochure.value}`
            : "";
          const mediaLine = !programReply.brochure && programReply.mediaUrls.length > 0
            ? `\n\nХөтөлбөрийн зураг:\n${programReply.mediaUrls.join("\n")}`
            : "";
          let safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(
              sanitizeAssistantReply(`${programReply.reply}${brochureLine}${mediaLine}`),
            ),
            phoneAlreadyRequested,
          );
          const media = buildDemoMedia({
            reply: safeReply,
            userText: await getFastPathText(),
            trips,
            explicitMediaUrls: programReply.mediaUrls,
            brochureUrl: programReply.brochure?.type === "url" ? programReply.brochure.value : null,
          });
          safeReply = reconcilePhotoAttachmentReply(safeReply, media.mediaUrls.length > 0 || Boolean(media.brochureUrl));
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply, imageAttachments(media.mediaUrls));
          await rememberTurn();
          recordCounter("demo.program_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [], ...media });
        }
        const structuredReply = buildStructuredTripReply(await getFastPathText(), trips);
        if (structuredReply) {
          const safeReply = appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(structuredReply)),
            phoneAlreadyRequested,
          );
          const media = buildDemoMedia({
            reply: safeReply,
            userText: await getFastPathText(),
            trips,
          });
          await appendMessage(sessionId, "user", normalizedText);
          if (shouldSilenceNoDataReply(safeReply)) return returnHandoff();
          await appendMessage(sessionId, "assistant", safeReply, imageAttachments(media.mediaUrls));
          await rememberTurn();
          recordCounter("demo.structured_fast_path_total", 1, {});
          return res.status(200).json({ reply: safeReply, buttons: [], ...media });
        }
      }

      await appendMessage(sessionId, "user", normalizedText);

      // Pre-answer reasoning (mirrors production webhook): analyze intent,
      // references, and memory before the reply. Best-effort — null on failure.
      const reasoningTrips = await getTrips().catch(() => []);
      const reasoning = shouldAnalyzeBeforeReply(normalizedText)
        ? await analyzeBeforeReply({
            customerMemory,
            history,
            userText: normalizedText,
            tripIndexLines: buildTripIndexLines(reasoningTrips),
            requestId: trace.requestId,
            correlationId: trace.correlationId,
            source: "api.demo.reasoning",
          })
        : null;
      const relevantTripNames = (() => {
        if (reasoningTrips.length === 0) return [] as string[];
        const direct = resolveTripFromUserMessage(normalizedText, reasoningTrips, {
          allowLooseFallback: false,
        });
        if (direct.status === "verified") return [direct.trip.route_name];
        if (direct.status === "ambiguous") {
          return direct.candidates.slice(0, 4).map((trip) => trip.route_name);
        }
        if (contextualUserText !== normalizedText) {
          const contextual = resolveTripFromUserMessage(contextualUserText, reasoningTrips, {
            allowLooseFallback: false,
          });
          if (contextual.status === "verified") return [contextual.trip.route_name];
          if (contextual.status === "ambiguous") {
            return contextual.candidates.slice(0, 4).map((trip) => trip.route_name);
          }
        }
        return [] as string[];
      })();
      const previousAssistantMessages = history.filter((m) => m.role === "assistant");
      const previousAssistantReply = previousAssistantMessages.length > 0
        ? previousAssistantMessages[previousAssistantMessages.length - 1].text
        : undefined;
      const promptParts = buildPromptParts({
        systemPrompt,
        business: business || {},
        history,
        customerMemory,
        reasoning: reasoning || undefined,
        previousAssistantReply,
        relevantTripNames,
        userText: normalizedText,
        pinnedButtonLabels,
        phoneRequested: hasAskedForPhone(history),
      });
      // Mirrors the production webhook: OpenAI down/overloaded must not mean
      // the customer gets a bare error while a working second model sits
      // idle. Try OpenAI with the same prompt before giving up.
      let aiReplyText: string;
      try {
        // OpenAI is the primary model for customer replies (owner's call —
        // more reliable in practice).
        const result = await askOpenAI(promptParts.user, {
          requestId: trace.requestId,
          correlationId: trace.correlationId,
          source: "api.demo",
          systemInstruction: promptParts.system,
          openaiModel: process.env.OPENAI_REPLY_MODEL || "gpt-4o",
          preferOpenAI: true,
        });
        aiReplyText = result.text;
      } catch (error) {
        let fallbackText = "";
        try {
          const fallback = await askOpenAIChatParts([{ text: promptParts.user }], {
            source: "api.demo.reply_fallback",
            timeoutMs: 20_000,
            requestId: trace.requestId,
            correlationId: trace.correlationId,
            model: process.env.OPENAI_REPLY_MODEL || "gpt-4o",
            systemText: promptParts.system,
          });
          fallbackText = fallback?.text?.trim() || "";
        } catch {
          // fall through to REFER below
        }
        logError("demo.ai_fallback_reply", {
          requestId: trace.requestId,
          correlationId: trace.correlationId,
          classification: classifyError(error),
          openaiFallbackUsed: Boolean(fallbackText),
        });
        aiReplyText = fallbackText || "REFER";
      }
      const rawFixed = fixMojibake(aiReplyText);
      // REFER (or legacy SILENT) = the model has no data for this question.
      // Acknowledge the staff handoff instead of making the bot appear broken.
      if (isReferReply(rawFixed)) {
        recordCounter("demo.ai_refer_total", 1, {});
        return returnHandoff();
      }
      const { text: rawNoButtons, buttons } = extractButtons(rawFixed);
      const recentAssistantReplies = history
        .filter((message) => message.role === "assistant")
        .map((message) => message.text)
        .slice(-3);
      const reply = enforcePaymentNeverSelfConfirmed(
        normalizedText,
        enforceWebsiteForPayment(
          rewriteRepeatedGenericClarifier({
            userText: normalizedText,
            replyText: stripRepeatedGreeting(
              sanitizeAssistantReply(rawNoButtons),
              history.some((message) => message.role === "assistant"),
            ),
            recentAssistantReplies,
          }),
        ),
      );
      if (shouldSilenceNoDataReply(reply)) return returnHandoff();

      // Skip duplicate replies (same as Messenger behavior)
      const lastMessages = history.filter((m) => m.role === "assistant");
      const lastReplyText = lastMessages.length > 0 ? lastMessages[lastMessages.length - 1].text : null;
      if (lastReplyText && isDuplicateReply(lastReplyText, reply)) {
        recordCounter("demo.duplicate_reply_avoided_total", 1, {});
        const media = buildDemoMedia({
          reply,
          userText: normalizedText,
          trips: reasoningTrips,
        });
        await appendMessage(sessionId, "assistant", reply, imageAttachments(media.mediaUrls));
        await rememberTurn();
        return res.status(200).json({ reply, buttons, ...media });
      }

      const media = buildDemoMedia({
        reply,
        userText: normalizedText,
        trips: reasoningTrips,
      });
      await appendMessage(sessionId, "assistant", reply, imageAttachments(media.mediaUrls));
      await rememberTurn();

      logInfo("demo.reply_generated", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        clientHash,
        conversationIdSuffix: normalizedConversationId.slice(-8),
        promptLength: promptParts.system.length + promptParts.user.length,
        replyLength: reply.length,
        buttonCount: buttons.length,
      });

      return res.status(200).json({ reply, buttons, ...media });
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
