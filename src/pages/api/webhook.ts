import type { NextApiRequest, NextApiResponse } from "next";
import { askOpenAI } from "../../lib/openaiProvider";
import { askOpenAIChatParts } from "../../lib/openaiFallback";
import { matchFlow, findTriggeredFlow, getFlowState, setFlowState, clearFlowState, newRuntimeState, runFlowFrom, resumeFlowWithInput, type FlowRule, type FlowDoc, type FlowEffects, type FlowRuntimeState, type RunOutcome, } from "../../lib/flowEngine";
import { BOT_MESSAGE_METADATA, replyToComment, sendImageMessage, sendQuickReplies, sendTextMessage } from "../../lib/messenger";
import { rateLimitAsync } from "../../lib/rateLimit";
import { readBusinessData } from "../../lib/businessData";
import { appendMessage, buildPromptParts, getHistory, hasAskedForPhone } from "../../lib/conversation";
import { buildContextualUserText, isLikelyContextDependentText } from "../../lib/contextualText";
import { isKnownGreetingPhrase, MID_CONVERSATION_GREETING_REPLY } from "../../lib/greetingPhrases";
import { routeFastPathText, type FastPathRoute } from "../../lib/fastPathRouting";
import { fixMojibake } from "../../lib/encoding";
import { scheduleDriveAutoSync } from "../../lib/googleDriveSync";
import { getCustomerMemoryText, scheduleCustomerMemoryUpdate } from "../../lib/conversationMemory";
import { ensureTravelSchema } from "../../lib/travelSchema";
import { analyzeBeforeReply, buildTripIndexLines, shouldAnalyzeBeforeReply } from "../../lib/replyReasoning";
import { buildHandoffAcknowledgement, enforcePaymentNeverSelfConfirmed, enforceWebsiteForPayment, extractButtons, hasPaymentClaimIntent, isDuplicateReply, isReferReply, PAYMENT_VERIFICATION_DEFERRAL_REPLY, reconcilePhotoAttachmentReply, rewriteRepeatedGenericClarifier, sanitizeAssistantReply, shouldSilenceNoDataReply, stripRepeatedGreeting } from "../../lib/reply";
import { autoHandoffSender, isPaused, pauseBot, trackSender } from "../../lib/pause";
import { createLead, dbClaimGoodbye, dbPauseSender, dbStoreSenderName, getBotControl, getTravelBotSettings, hasRecentOpenLead, isPagePaused, listTrips, } from "../../lib/travelOps";
import { buildDepartureDateAvailabilityReply, hasDepartureDateAvailabilityIntent, } from "../../lib/travelDates";
import { appendLeadCaptureCta, buildAmbiguousPassengerTotalReply, buildAmbiguousTripReply, buildBudgetReply, buildCompareReply, buildDiscountReply, buildPriceObjectionReply, buildSeatsReply, buildSmartButtons, buildStructuredTripReply, buildTripProgramReply, hasBudgetIntent, hasCompareIntent, hasDiscountIntent, hasSeatsIntent, hasProgramIntent, isStructuredTripQuestion, resolveTripFromUserMessage, } from "../../lib/travelFastPaths";
import { claimSeasonSend, extractTripPhotosForReply, getActiveSeason, GREETING_BUTTONS, hasTripPhotoIntent, isFirstMessage, isGenericOpener, isGreetingButton, matchSeasonByText, resolveGoodbyeContactText, resolveGoodbyeEnabled, resolveGreetingConfig, resolveSeasons, sampleWelcomePhotos, } from "../../lib/welcomeFlow";
import { handlePhotoOnlyMode } from "../../lib/webhookPhotoOnly";
import {
  scheduleAttachmentDocumentPipeline,
  handleAttachmentOnlyMessage,
} from "../../lib/webhookAttachments";
import { notifyStaffOfLead } from "../../lib/staffAlerts";
import { logInboundMessage } from "../../lib/travelMessages";
import { advanceCollectState, buildCompletionMessage, buildLeadContext, clearCollectState, getCollectState, promptForStep, setCollectState, startCollectState } from "../../lib/bookingCollect";
import { getEnv } from "../../lib/env";
import { beginRequestTrace, classifyError, finishRequestTrace, hashIdentifier, logError, logInfo, logWarn, recordCounter, } from "../../lib/observability";
import { parseWebhookJson, PayloadTooLargeError, verifyMetaSignature, } from "../../lib/webhookSecurity";
import {
  type Platform,
  type PendingConversationPayload,
  RetryableWebhookError,
  isRetryableWebhookError,
  verifyToken,
  readRawBody,
  buildEventKey,
  markEventProcessed,
  runEventWithClaim,
  markRecentIncomingText,
  updateConcurrencyGauges,
  hasConversationLockConsistent,
  acquireConversationLockConsistent,
  releaseConversationLockConsistent,
  refreshConversationLockConsistent,
  withConversationLockHeartbeat,
  enqueuePendingConversationConsistent,
  drainPendingConversationConsistent,
  getLastReplyConsistent,
  setLastReplyConsistent,
  addActiveConversation,
  deleteActiveConversation,
  getActiveConversationCount,
  getPendingConversationCount,
  MAX_INCOMING_TEXT_CHARS,
  getWebhookRuntimeDiagnostics as getWebhookRuntimeDiagnosticsInternal,
  resetWebhookStateForTests as resetWebhookStateForTestsInternal,
} from "../../lib/webhookDedup";
import { sendPlatformMessage, recordImageMessage, sendPhotoAlbum, sendTripMediaForReply, fetchAndStoreFbName, sendFacebookTypingIndicator, normalizeLowerText, isQuickInfoKeyword, isHandoffRequest, CONTACT_OPERATOR_LABEL, DUPLICATE_REPLY_NUDGE, isBookingIntent, extractPhoneNumber, isPhoneOnlyMessage, isCommentTriggerMatch } from "../../lib/webhookMedia";
const env = getEnv();
const PAGE_TOKENS = new Map(env.facebookPages.map((p) => [p.pageId, p.token]));
const FALLBACK_TOKEN = env.tokenPage;
const META_APP_SECRET = env.metaAppSecret;
export const config = {
  api: {
    bodyParser: false,
  },
  // The AI path is reasoning + answer (+ retries) — well past default function
  // limits. Without this, a mid-processing kill silently drops the reply.
  maxDuration: 60,
};
export { buildEventKey, markEventProcessed, markRecentIncomingText };
export function getWebhookRuntimeDiagnostics() {
  return getWebhookRuntimeDiagnosticsInternal();
}
export function resetWebhookStateForTests() {
  resetWebhookStateForTestsInternal();
}

// Implementation moved to contextualText.ts so the demo endpoint shares the
// exact same reference-resolution behavior (it previously diverged silently).
export { isLikelyContextDependentText, buildContextualUserText };

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
  // When a database IS configured but unavailable, fail closed: a 503 makes
  // Meta redeliver and the dedup/queue machinery retries cleanly. The old
  // fail-open behavior answered with zero history and zero memory — the bot
  // greeted mid-conversation customers like strangers and permanently lost
  // their message from history, with no error anywhere. (With no DB configured
  // at all — tests, local dev — the bot still runs stateless by design.)
  const dbReady = await ensureTravelSchema();
  if (!dbReady && env.neonDatabaseUrl) {
    throw new RetryableWebhookError("db_unavailable:context_load");
  }
  // 40 msgs / 10 min: an engaged customer asking many quick questions is a
  // GOOD outcome — the old 20 cap (1 per 30s) throttled real buyers.
  const limit = await rateLimitAsync(
    `${platform === "facebook" ? "fb" : "ig"}:${senderId}`,
    40,
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
  const { msg_count: senderMsgCount, prev_msg_at: prevMsgAt } = await trackSender(senderId, platform);
  if (platform === "facebook" && token && !hasProgramIntent(text)) {
    void fetchAndStoreFbName(senderId, token);
  }
  // Re-engagement contact info: a customer coming back after 30+ min of
  // silence gets the consultant contact message ONCE per 14 days (when the
  // goodbye toggle is on) — and then their message is ALWAYS answered.
  // The old behaviour (24h pause + early return) swallowed the returning
  // customer's actual question and muted the bot for a day, which killed
  // every conversation that naturally resumed hours later.
  const INACTIVITY_MS = 30 * 60 * 1000;
  if (
    platform === "facebook" &&
    token &&
    senderMsgCount > 1 &&
    prevMsgAt &&
    Date.now() - new Date(prevMsgAt).getTime() >= INACTIVITY_MS
  ) {
    const shouldSendGoodbye = await dbClaimGoodbye(senderId);
    if (shouldSendGoodbye) {
      try {
        const goodbyeSettings = await getTravelBotSettings();
        if (resolveGoodbyeEnabled(goodbyeSettings.extra)) {
          await sendTextMessage(senderId, resolveGoodbyeContactText(goodbyeSettings.extra), token, {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.inactivity_goodbye",
          });
          recordCounter("webhook.reengagement_contact_sent_total", 1, { platform });
        }
      } catch (error) {
        logWarn("webhook.inactivity_goodbye_failed", {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          platform,
          pageId,
          senderHash: hashIdentifier(senderId),
          classification: classifyError(error),
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // No pause, no return — processing continues so the message gets answered.
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
  await assertLockHealthy();
  const history = await getHistory(senderId);
  const customerMemory = await getCustomerMemoryText(senderId);
  const contextualUserText = buildContextualUserText(history, text);
  const sessionId = `${platform}:${pageId}:${senderId}`;
  // Non-blocking: the memory merge continues after the response via waitUntil.
  // It used to be awaited inline while holding the conversation lock, which
  // serialized a long model call behind every reply.
  const rememberTurn = (source: string) =>
    scheduleCustomerMemoryUpdate({
      senderId,
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source,
    });
  /**
   * Shared tail of every deterministic fast-path reply: deliver (retryable on
   * failure), optionally send follow-up media, persist history + last-reply
   * state, schedule the memory merge, bump the counter. The fast paths below
   * were six copy-pasted versions of this block.
   */
  const deliverFastPathReply = async (input: {
    reply: string;
    failTag: string;
    rememberSource: string;
    counter?: string;
    afterDeliver?: () => Promise<void>;
  }) => {
    const noDataReply = isReferReply(input.reply) || shouldSilenceNoDataReply(input.reply);
    const reply = input.reply;
    if (noDataReply) {
      logInfo("webhook.no_data_reply_suppressed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        failTag: input.failTag,
      });
      recordCounter("webhook.no_data_reply_suppressed_total", 1, { platform });
      try {
        if (!(await hasRecentOpenLead(senderId, "handoff"))) {
          await createLead({
            kind: "handoff",
            platform,
            senderId,
            customerMessage: text,
            context: `Бот мэдээлэлгүй fast-path хариуг зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй: ${input.failTag}`,
          });
          await notifyStaffOfLead(
            { kind: "handoff", platform, customerMessage: text },
            {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook.no_data_handoff",
            },
          );
        }
      } catch (error) {
        logWarn("webhook.no_data_handoff_lead_failed", {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          platform,
          senderHash: hashIdentifier(senderId),
          classification: classifyError(error),
        });
      }
      await rememberTurn(`${input.rememberSource}_silent_no_data`);
      if (input.counter) recordCounter(input.counter, 1, { platform });
      return;
    }
    await assertLockHealthy();
    const delivered = await sendPlatformMessage(
      platform,
      senderId,
      reply,
      token,
      pageId,
      igUserId,
      trace,
      { allowFallback: false },
    );
    if (!delivered) {
      throw new RetryableWebhookError(`delivery_failed:${input.failTag}`);
    }
    if (!noDataReply && input.afterDeliver) await input.afterDeliver();
    try {
      await appendMessage(senderId, "assistant", reply);
      await setLastReplyConsistent(sessionId, reply);
    } catch (error) {
      logWarn("webhook.reply_state_persist_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    await rememberTurn(noDataReply ? `${input.rememberSource}_handoff` : input.rememberSource);
    if (input.counter) recordCounter(input.counter, 1, { platform });
  };

  // Photo-only mode: send photos only when we have a real trip signal.
  // Stay silent on greetings, unrelated text, or unknown requests. Full
  // behavior lives in webhookPhotoOnly.ts (extracted for the 2,000-line cap).
  const botControl = await getBotControl();
  if (botControl.photo_only && platform === "facebook" && token) {
    await handlePhotoOnlyMode({
      platform,
      senderId,
      pageId,
      token,
      text,
      contextualUserText,
      trace,
      rememberTurn,
    });
    return;
  }

  if (platform === "facebook") {
    await sendFacebookTypingIndicator(senderId, token, pageId, trace);
  }
  const botSettings = await getTravelBotSettings();
  void logInboundMessage({ platform, senderId, text });

  // ── Greeting button tap handler ─────────────────────────────────────────────
  const seasonsEnabledForGreeting = (botSettings.extra as Record<string, unknown>)?.seasons_enabled !== false;
  const activeSeasonForGreeting = seasonsEnabledForGreeting ? getActiveSeason(resolveSeasons(botSettings.extra)) : null;
  const seasonButtonLabel = activeSeasonForGreeting ? `${activeSeasonForGreeting.name} аяллууд` : null;
  const isSeasonButton = seasonButtonLabel && text.trim() === seasonButtonLabel;
  const isAllTripsButton = text.trim() === GREETING_BUTTONS.ALL_TRIPS;
  const isSeeAllButton = text.trim() === GREETING_BUTTONS.SEE_ALL;

  if (platform === "facebook" && token && (isGreetingButton(text) || isSeasonButton)) {
    try {
      const allTrips = await listTrips({ limit: 5000 });
      if (isAllTripsButton || isSeeAllButton) {
        const greeting = resolveGreetingConfig(botSettings.extra);
        let album: string[] = [];
        if (greeting.defaultPhotoUrls.length > 0) album = greeting.defaultPhotoUrls.slice(0, 10);
        else if (greeting.usePhotoUrls && greeting.photoUrls.length > 0) album = greeting.photoUrls.slice(0, 10);
        else album = sampleWelcomePhotos(allTrips);
        await sendPhotoAlbum(senderId, album, token, trace);
      }
      if (isSeasonButton || isSeeAllButton) {
        if (activeSeasonForGreeting && activeSeasonForGreeting.photoUrls.length > 0) {
          await sendPhotoAlbum(senderId, activeSeasonForGreeting.photoUrls.slice(0, 10), token, trace);
        }
      }
      recordCounter("webhook.greeting_button_total", 1, { platform, button: text });
    } catch (error) {
      logWarn("webhook.greeting_button_failed", {
        requestId: trace?.requestId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    return;
  }

  // ── First-message greeting ──────────────────────────────────────────────────
  // Only fires when: Facebook, greeting enabled, first-ever message, AND the
  // message is a generic opener (hi, hello, etc.) — NOT when person already
  // asked about a specific trip.
  const greeting = resolveGreetingConfig(botSettings.extra);
  if (
    platform === "facebook" &&
    token &&
    greeting.enabled &&
    senderMsgCount === 1 &&
    isGenericOpener(text) &&
    (await isFirstMessage(senderId))
  ) {
    try {
      const welcomeText =
        greeting.text ||
        botSettings.quick_info_reply ||
        "Уудам Трэвел-д тавтай морилно уу! Доорх товчнуудаас сонирхсоноо сонгоорой 👇";
      const buttons = [
        GREETING_BUTTONS.ALL_TRIPS,
        ...(activeSeasonForGreeting ? [`${activeSeasonForGreeting.name} аяллууд`] : []),
        GREETING_BUTTONS.SEE_ALL,
      ];
      // Send text + quick-reply buttons in one message
      await sendQuickReplies(senderId, welcomeText, buttons, token, {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
      });
      recordCounter("webhook.welcome_sent_total", 1, { platform });
    } catch (error) {
      logWarn("webhook.welcome_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    // Generic opener — greeting sent, nothing else to do. Return.
    return;
  }

  // ── Mid-conversation bare greeting ─────────────────────────────────────────
  // The first-message welcome (with buttons) already returned above. A bare
  // greeting on any later turn (or a first turn where the welcome didn't fire —
  // Instagram, greeting disabled) gets a deterministic friendly reply instead
  // of the model. Without this it falls through to the model, which — when the
  // previous turn was a multi-trip clarification — re-emits that clarification's
  // price list on "hi" ~50% of the time (found 2026-07-22). A greeting asks
  // nothing and must never re-serve a stale trip. Any attachment riding along
  // with the text is still processed by scheduleAttachmentDocumentPipeline.
  if (isKnownGreetingPhrase(text)) {
    await deliverFastPathReply({
      reply: MID_CONVERSATION_GREETING_REPLY,
      failTag: "greeting_fast_path",
      rememberSource: "api.webhook.greeting_fast_path",
      counter: "webhook.greeting_fast_path_total",
    });
    return;
  }

  // ── Seasonal album on keyword match ────────────────────────────────────────
  const seasonsEnabledGlobal = (botSettings.extra as Record<string, unknown>)?.seasons_enabled !== false;
  if (platform === "facebook" && token && seasonsEnabledGlobal) {
    const matchedSeason = matchSeasonByText(text, resolveSeasons(botSettings.extra));
    if (matchedSeason && (await claimSeasonSend(senderId, matchedSeason.id))) {
      await sendPhotoAlbum(senderId, matchedSeason.photoUrls.slice(0, 10), token, trace);
      recordCounter("webhook.season_album_sent_total", 1, {
        platform,
        season: matchedSeason.name,
      });
    }
  }
  if (botSettings.handoff_enabled) {
    const collectState = await getCollectState(senderId);
    if (collectState && collectState.step !== "done") {
      const nextState = advanceCollectState(collectState, text);
      if (nextState.step === "done") {
        await clearCollectState(senderId);
        // The ONLY place a chat message becomes the stored customer name:
        // this is a direct answer to "нэрээ бичнэ үү". A generic heuristic
        // used to guess names from any short Cyrillic message and polluted
        // display_name with trip/keyword words ("Бээжин", "үнэ").
        if (nextState.name.trim()) {
          await dbStoreSenderName(senderId, nextState.name.trim()).catch(() => {});
        }
        // Use 14-day auto-handoff pause (resets automatically after 2 weeks)
        await autoHandoffSender(senderId);
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
  function buildFlowEffects(): FlowEffects {
    return {
      sendText: async (msg: string) => {
        await assertLockHealthy();
        const ok = await sendPlatformMessage(
          platform, senderId, msg, token, pageId, igUserId, trace, { allowFallback: false },
        );
        if (!ok) throw new RetryableWebhookError("delivery_failed:flow_message");
        await appendMessage(senderId, "assistant", msg).catch(() => {});
        await rememberTurn("api.webhook.flow_message");
      },
      sendImage: token && platform === "facebook"
        ? async (url: string) => {
            await sendImageMessage(senderId, url, token, {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook.flow_image",
            });
            await recordImageMessage(senderId, [url]);
          }
        : undefined,
      sendQuickReplies: token && platform === "facebook"
        ? async (msg: string, labels: string[]) => {
            await sendQuickReplies(senderId, msg, labels, token, {
              requestId: trace?.requestId,
              correlationId: trace?.correlationId,
              source: "api.webhook.flow_quick",
            });
            await appendMessage(senderId, "assistant", msg).catch(() => {});
            await rememberTurn("api.webhook.flow_quick");
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
        await appendMessage(senderId, "user", text).catch(() => {});
        const outcome = await resumeFlowWithInput(doc, activeState, text, buildFlowEffects());
        const { handedToAi } = await persistFlowOutcome(doc, activeState, outcome);
        if (!handedToAi) return;
      } else {
        await clearFlowState(senderId, platform);
      }
    }
  }
  if (
    text.trim() === CONTACT_OPERATOR_LABEL ||
    (botSettings.handoff_enabled && isHandoffRequest(text, botSettings.handoff_keywords))
  ) {
    // 14-day auto-reset so bot re-engages after 2 weeks if consultant hasn't followed up
    await autoHandoffSender(senderId);
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
    try {
      await appendMessage(senderId, "user", text);
      await appendMessage(senderId, "assistant", handoffMsg);
      await setLastReplyConsistent(sessionId, handoffMsg);
      await rememberTurn("api.webhook.handoff");
    } catch { /* non-critical */ }
    // Send contact numbers after handoff confirmation
    if (platform === "facebook" && token) {
      try {
        await sendTextMessage(senderId, resolveGoodbyeContactText(botSettings.extra), token, {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          source: "api.webhook.handoff_goodbye",
        });
      } catch (error) {
        logWarn("webhook.handoff_goodbye_failed", {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          platform,
          pageId,
          senderHash: hashIdentifier(senderId),
          classification: classifyError(error),
          message: error instanceof Error ? error.message : String(error),
        });
      }
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
    try {
      await appendMessage(senderId, "user", text);
      await appendMessage(senderId, "assistant", botSettings.quick_info_reply);
      await setLastReplyConsistent(sessionId, botSettings.quick_info_reply);
      await rememberTurn("api.webhook.quick_info");
    } catch { /* non-critical */ }
    return;
  }
  // ── Phone-number lead capture ───────────────────────────────────────────────
  // The AI's #1 rule asks the customer for a phone number; this is where the
  // answer is actually caught. Any message containing a Mongolian mobile
  // number creates a lead + staff alert (once per open lead). A phone-only
  // message gets a deterministic thank-you; a phone bundled with a question
  // falls through so the AI answers the question too.
  const detectedPhone = extractPhoneNumber(text);
  if (detectedPhone) {
    try {
      if (!(await hasRecentOpenLead(senderId, "booking"))) {
        await createLead({
          kind: "booking",
          platform,
          senderId,
          customerMessage: text,
          contactPhone: detectedPhone,
          context: "Чатад утасны дугаараа үлдээсэн.",
        });
        await notifyStaffOfLead(
          {
            kind: "booking",
            platform,
            customerMessage: text,
            contactPhone: detectedPhone,
          },
          {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.phone_capture",
          },
        );
        recordCounter("webhook.phone_lead_captured_total", 1, { platform });
      }
    } catch (error) {
      logWarn("webhook.phone_lead_capture_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    if (isPhoneOnlyMessage(text)) {
      try {
        await appendMessage(senderId, "user", text);
      } catch { /* non-critical */ }
      const confirmation =
        `Баярлалаа! 🙌 Манай аяллын зөвлөх таны ${detectedPhone} дугаарт удахгүй холбогдоно. ` +
        "Өөр асуух зүйл байвал чөлөөтэй бичээрэй 😊";
      await assertLockHealthy();
      const delivered = await sendPlatformMessage(
        platform, senderId, confirmation, token, pageId, igUserId, trace, { allowFallback: false },
      );
      if (!delivered) {
        throw new RetryableWebhookError("delivery_failed:phone_capture_confirmation");
      }
      try {
        await appendMessage(senderId, "assistant", confirmation);
        await setLastReplyConsistent(sessionId, confirmation);
        await rememberTurn("api.webhook.phone_capture_confirmation");
      } catch { /* non-critical */ }
      return;
    }
  }
  if (flowDocs.length > 0) {
    const triggered = findTriggeredFlow(text, flowDocs);
    if (triggered) {
      recordCounter("webhook.flow_graph_triggered_total", 1, { platform });
      await appendMessage(senderId, "user", text).catch(() => {});
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
        await appendMessage(senderId, "user", text);
        await appendMessage(senderId, "assistant", matchedRule.reply);
        await setLastReplyConsistent(sessionId, matchedRule.reply);
        await rememberTurn("api.webhook.flow_rule");
      } catch {
      }
      return;
    }
  }
  scheduleDriveAutoSync({ source: "api.webhook" });
  const { systemPrompt: fileSystemPrompt, business: rawBusiness, pinnedButtonLabels } = await readBusinessData();

  // Narrow knowledgeBase to the best-matching trip when user clearly names one.
  // This prevents the AI from confusing two trips that share keywords (e.g. two "Бээжин" trips).
  const business = (() => {
    if (!rawBusiness?.knowledgeBase || typeof rawBusiness.knowledgeBase !== "string") return rawBusiness;
    const norm = (s: string) => s.toLowerCase().replace(/[^\wа-яөүё\s]/gi, " ");
    const userNorm = norm(text);
    // Split knowledgeBase into per-trip blocks (each line starting with "- " is one trip module)
    const allLines = rawBusiness.knowledgeBase.split("\n");
    const tripLines = allLines.filter(l => l.startsWith("- "));
    if (tripLines.length < 2) return rawBusiness; // only 1 trip, no confusion possible

    // Score each trip line against user query using words ≥3 chars
    const scored = tripLines.map(line => {
      const words = norm(line).split(/\s+/).filter(w => w.length >= 3);
      const score = words.filter(w => userNorm.includes(w)).length;
      return { line, score };
    }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

    // If top match is clearly better than second (score gap ≥ 2), inject only that trip
    if (scored.length >= 1 && (scored.length === 1 || scored[0].score - (scored[1]?.score ?? 0) >= 2)) {
      const nonTripLines = allLines.filter(l => !l.startsWith("- "));
      const focusedKb = [...nonTripLines, scored[0].line].join("\n");
      logInfo("webhook.trip_focus_narrowed", {
        requestId: trace?.requestId,
        score: scored[0].score,
        gap: scored[0].score - (scored[1]?.score ?? 0),
      });
      return { ...rawBusiness, knowledgeBase: focusedKb };
    }
    return rawBusiness;
  })();
  await assertLockHealthy();
  const lastReply = await getLastReplyConsistent(sessionId);
  // Phone already given this conversation (current message or history). Every
  // fast-path answer appends the phone ask unless this is true, and the AI
  // prompt switches to "never ask again". Computed here (before the fast paths)
  // so the deterministic replies capture leads the same way the AI path does.
  const phoneCollected =
    Boolean(detectedPhone) ||
    history.some(
      (message) => message.role === "user" && extractPhoneNumber(message.text),
    );
  const phoneAlreadyRequested = phoneCollected || hasAskedForPhone(history);
  const customerWantsToBook =
    botSettings.handoff_enabled && isBookingIntent(text);
  if (customerWantsToBook && !(await hasRecentOpenLead(senderId, "booking"))) {
    const newState = startCollectState(text);
    await setCollectState(senderId, newState);
    const firstQuestion = promptForStep(newState.step);
    await appendMessage(senderId, "user", text);
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
  await appendMessage(senderId, "user", text);
  let cachedTrips: Awaited<ReturnType<typeof listTrips>> | null = null;
  const getTrips = async () => {
    if (cachedTrips) return cachedTrips;
    cachedTrips = await listTrips({ limit: 5000 });
    return cachedTrips;
  };
  // Stateful routing for the deterministic matchers: answers to a
  // clarification we just asked resolve against the OFFERED candidates first;
  // otherwise current-message-first priorities apply. See fastPathRouting.ts
  // for the live wrong-trip bug this prevents.
  let routedCache: FastPathRoute | null = null;
  const getRouted = async (): Promise<FastPathRoute> => {
    if (routedCache !== null) return routedCache;
    routedCache = await routeFastPathText({
      senderId,
      text,
      contextualUserText,
      trips: await getTrips(),
    });
    return routedCache;
  };
  const getFastPathText = async (): Promise<string> => (await getRouted()).matchText;

  // A payment/booking confirmation claim ("5 сая шилжүүлсэн") must be
  // acknowledged BEFORE any trip/date/price fast-path runs below — those are
  // blind text/number matchers and were hijacking real payment claims into an
  // unrelated trip reply (a bare number like "5" or "8" in "5 сая" / "8 сая"
  // matched a trip alias containing "5 өдөр" or August month availability,
  // so a customer saying they just paid got a random trip listing instead of
  // any acknowledgment).
  if (hasPaymentClaimIntent(text)) {
    // The deferral reply PROMISES the customer a consultant will check and
    // get back to them — that promise is only real if staff actually hear
    // about it. A payment claim is the strongest buy signal there is; without
    // this lead+alert, a paying customer would wait on a follow-up nobody
    // knew to make.
    try {
      if (!(await hasRecentOpenLead(senderId, "handoff"))) {
        await createLead({
          kind: "handoff",
          platform,
          senderId,
          customerMessage: text,
          contactPhone: detectedPhone || "",
          context: "Төлбөр шилжүүлсэн гэж мэдэгдсэн — зөвлөх шалгаж баталгаажуулна уу.",
        });
        await notifyStaffOfLead(
          { kind: "handoff", platform, customerMessage: text, contactPhone: detectedPhone || "" },
          {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.payment_claim",
          },
        );
      }
    } catch (error) {
      logWarn("webhook.payment_claim_lead_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    await deliverFastPathReply({
      reply: enforceWebsiteForPayment(sanitizeAssistantReply(PAYMENT_VERIFICATION_DEFERRAL_REPLY)),
      failTag: "payment_claim_deferred",
      rememberSource: "api.webhook.payment_claim_deferred",
      counter: "webhook.payment_claim_deferred_total",
    });
    return;
  }

  // Compare questions intentionally mention multiple destinations/products.
  // Answer them as comparisons before scoped clarification narrows the message
  // to one destination family and asks the wrong follow-up.
  if (hasCompareIntent(text)) {
    const trips = await getTrips();
    const compareReply = buildCompareReply(await getFastPathText(), trips);
    if (compareReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(compareReply)),
          phoneAlreadyRequested,
        ),
        failTag: "compare_fast_path",
        rememberSource: "api.webhook.compare_fast_path",
        counter: "webhook.compare_fast_path_total",
      });
      return;
    }
  }

  // The customer's answer fits SEVERAL of the trips we just offered ("шууд
  // нислэгтэй" when both options are direct flights) — re-ask scoped to
  // exactly those, like a human agent would. Letting a matcher rescore the
  // names would confidently pick one, which is a guess, not an answer.
  {
    const routed = await getRouted();
    if (routed.scopedClarify && routed.scopedClarify.length > 0) {
      const totalReply = buildAmbiguousPassengerTotalReply(await getFastPathText(), routed.scopedClarify);
      const clarifyBody = routed.scopedClarifyNote
        ? `${routed.scopedClarifyNote}\n${totalReply || buildAmbiguousTripReply(routed.scopedClarify)}`
        : totalReply || buildAmbiguousTripReply(routed.scopedClarify);
      await deliverFastPathReply({
        reply: enforceWebsiteForPayment(sanitizeAssistantReply(clarifyBody)),
        failTag: "scoped_clarify",
        rememberSource: "api.webhook.scoped_clarify",
        counter: "webhook.scoped_clarify_total",
      });
      return;
    }
  }
  // Broad structured questions ("Бээжин аялал хэд вэ?") should clarify from
  // the DB when several active trips match. Do not send these to the model and
  // risk a silent REFER.
  {
    const fastPathText = await getFastPathText();
    if (isStructuredTripQuestion(fastPathText)) {
      const resolution = resolveTripFromUserMessage(fastPathText, await getTrips(), {
        allowLooseFallback: false,
      });
      if (resolution.status === "ambiguous" && resolution.candidates.length > 1) {
        const totalReply = buildAmbiguousPassengerTotalReply(fastPathText, resolution.candidates);
        await deliverFastPathReply({
          reply: enforceWebsiteForPayment(
            sanitizeAssistantReply(totalReply || buildAmbiguousTripReply(resolution.candidates)),
          ),
          failTag: "structured_clarify",
          rememberSource: "api.webhook.structured_clarify",
          counter: "webhook.structured_clarify_total",
        });
        return;
      }
    }
  }
  if (hasDepartureDateAvailabilityIntent(text)) {
    const trips = await getTrips();
    const dateAvailabilityReply = buildDepartureDateAvailabilityReply({
      userText: await getFastPathText(),
      trips,
    });
    if (dateAvailabilityReply) {
      const bookingNudge = customerWantsToBook
        ? " Захиалгаа баталгаажуулах бол нэр, утасны дугаараа үлдээгээрэй."
        : "";
      const safeDateReply = appendLeadCaptureCta(
        enforceWebsiteForPayment(
          sanitizeAssistantReply(fixMojibake(`${dateAvailabilityReply}${bookingNudge}`)),
        ),
        phoneAlreadyRequested,
      );
      if (lastReply && isDuplicateReply(lastReply.text, safeDateReply)) {
        recordCounter("webhook.duplicate_reply_avoided_total", 1, { platform });
        // Neutral nudge — never a fake error and never "I already told you".
        // Persisted as the last reply so a third identical question is not
        // met with the exact same nudge again.
        await deliverFastPathReply({
          reply: DUPLICATE_REPLY_NUDGE,
          failTag: "duplicate_reply_notice",
          rememberSource: "api.webhook.date_duplicate_nudge",
        });
        return;
      }
      await deliverFastPathReply({
        reply: safeDateReply,
        failTag: "date_availability_reply",
        rememberSource: "api.webhook.date_fast_path",
      });
      return;
    }
  }
  if (hasSeatsIntent(text)) {
    const trips = await getTrips();
    const seatsReply = buildSeatsReply(await getFastPathText(), trips);
    if (seatsReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(seatsReply)),
          phoneAlreadyRequested,
        ),
        failTag: "seats_fast_path",
        rememberSource: "api.webhook.seats_fast_path",
        counter: "webhook.seats_fast_path_total",
      });
      return;
    }
  }
  {
    const objectionReply = buildPriceObjectionReply(await getFastPathText());
    if (objectionReply) {
      await deliverFastPathReply({
        reply: enforceWebsiteForPayment(sanitizeAssistantReply(objectionReply)),
        failTag: "price_objection_fast_path",
        rememberSource: "api.webhook.price_objection_fast_path",
        counter: "webhook.price_objection_fast_path_total",
      });
      return;
    }
  }
  if (hasBudgetIntent(text)) {
    const trips = await getTrips();
    const budgetReply = buildBudgetReply(await getFastPathText(), trips);
    if (budgetReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(budgetReply)),
          phoneAlreadyRequested,
        ),
        failTag: "budget_fast_path",
        rememberSource: "api.webhook.budget_fast_path",
        counter: "webhook.budget_fast_path_total",
      });
      return;
    }
  }
  if (hasDiscountIntent(text)) {
    const trips = await getTrips();
    const discountReply = buildDiscountReply(await getFastPathText(), trips);
    if (discountReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(discountReply)),
          phoneAlreadyRequested,
        ),
        failTag: "discount_fast_path",
        rememberSource: "api.webhook.discount_fast_path",
        counter: "webhook.discount_fast_path_total",
      });
      return;
    }
  }
  {
    const trips = await getTrips();
    const programFastPathText = await getFastPathText();
    const programReply = buildTripProgramReply(programFastPathText, trips);
    if (programReply) {
      const inferredMediaUrls = programReply.mediaUrls.length > 0
        ? programReply.mediaUrls
        : extractTripPhotosForReply(programReply.reply, trips, { userText: programFastPathText });
      const safeProgramReply = appendLeadCaptureCta(
        enforceWebsiteForPayment(
          sanitizeAssistantReply(
            reconcilePhotoAttachmentReply(programReply.reply, inferredMediaUrls.length > 0),
          ),
        ),
        phoneAlreadyRequested,
      );
      await deliverFastPathReply({
        reply: safeProgramReply,
        failTag: "program_fast_path",
        rememberSource: "api.webhook.program_fast_path",
        counter: "webhook.program_fast_path_total",
        afterDeliver: async () => {
          if (platform !== "facebook" || !token) return;
          if (programReply.mediaUrls.length > 0) {
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
            await recordImageMessage(senderId, programReply.mediaUrls);
          } else if (programReply.trip) {
            await sendTripMediaForReply(
              platform,
              senderId,
              safeProgramReply,
              programFastPathText,
              token,
              pageId,
              igUserId,
              trace ? { ...trace, source: "api.webhook.program_trip_media" } : undefined,
            );
          }
        },
      });
      return;
    }
    const structuredTripReply = buildStructuredTripReply(await getFastPathText(), trips);
    if (structuredTripReply) {
      const safeStructuredReply = appendLeadCaptureCta(
        enforceWebsiteForPayment(sanitizeAssistantReply(structuredTripReply)),
        phoneAlreadyRequested,
      );
      await deliverFastPathReply({
        reply: safeStructuredReply,
        failTag: "structured_trip_fast_path",
        rememberSource: "api.webhook.trip_fast_path",
        counter: "webhook.trip_fast_path_total",
        afterDeliver: async () => {
          if (hasTripPhotoIntent(text)) {
            await sendTripMediaForReply(
              platform,
              senderId,
              safeStructuredReply,
              await getFastPathText(),
              token,
              pageId,
              igUserId,
              trace,
            );
          }
        },
      });
      return;
    }
  }
  // Pre-answer reasoning: a small model call analyzes intent, vague references,
  // memory facts, and what's already been explained BEFORE the reply is written.
  // Best-effort — null on any failure and the reply proceeds exactly as before.
  const reasoningTrips = await getTrips().catch(() => []);
  const reasoning = shouldAnalyzeBeforeReply(text)
    ? await analyzeBeforeReply({
        customerMemory,
        history,
        userText: text,
        tripIndexLines: buildTripIndexLines(reasoningTrips),
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        source: "api.webhook.reasoning",
      })
    : null;
  // Deterministic relevance hint: the same matcher the fast paths trust points
  // the model at the most likely trip(s). A hint, not a filter — the full
  // Context stays in the prompt so the model can never be starved of the
  // right trip by a bad match.
  const relevantTripNames = (() => {
    const source = reasoningTrips.length > 0 ? reasoningTrips : [];
    if (source.length === 0) return [] as string[];
    const direct = resolveTripFromUserMessage(text, source, { allowLooseFallback: false });
    if (direct.status === "verified") return [direct.trip.route_name];
    if (direct.status === "ambiguous") {
      return direct.candidates.slice(0, 4).map((trip) => trip.route_name);
    }
    if (contextualUserText !== text) {
      const contextual = resolveTripFromUserMessage(contextualUserText, source, {
        allowLooseFallback: false,
      });
      if (contextual.status === "verified") return [contextual.trip.route_name];
      if (contextual.status === "ambiguous") {
        return contextual.candidates.slice(0, 4).map((trip) => trip.route_name);
      }
    }
    return [] as string[];
  })();
  const promptParts = buildPromptParts({
    systemPrompt: flowAiPromptOverride
      ? `${fileSystemPrompt}\n\n${flowAiPromptOverride}`
      : fileSystemPrompt,
    business: business || {},
    history,
    customerMemory,
    reasoning: reasoning || undefined,
    previousAssistantReply: lastReply?.text || undefined,
    relevantTripNames,
    userText: text,
    pinnedButtonLabels,
    phoneCollected,
    phoneRequested: phoneAlreadyRequested,
  });
  let aiReply: string;
  // True when OpenAI failed. Missing-data REFER stays silent customer-side,
  // while a real AI outage gets a visible temporary-issue handoff.
  let aiOutage = false;
  try {
    // OpenAI is the primary model for customer replies (owner's call — more
    // reliable in practice).
    const result = await askOpenAI(promptParts.user, {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      source: "api.webhook",
      systemInstruction: promptParts.system,
      openaiModel: process.env.OPENAI_REPLY_MODEL || "gpt-4o",
      preferOpenAI: true,
    });
    aiReply = result.text;
  } catch (error) {
    // OpenAI down/overloaded must not mean a customer gets a bare apology.
    // Retry the same prompt with the configured reply model before giving up.
    let fallbackText = "";
    try {
      const fallback = await askOpenAIChatParts([{ text: promptParts.user }], {
        source: "api.webhook.reply_fallback",
        timeoutMs: 20_000,
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        model: process.env.OPENAI_REPLY_MODEL || "gpt-4o",
        systemText: promptParts.system,
      });
      fallbackText = fallback?.text?.trim() || "";
    } catch {
      // fall through to the apology below
    }
    logWarn("webhook.ai_fallback_reply", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
      openaiFallbackUsed: Boolean(fallbackText),
    });
    if (fallbackText) {
      aiReply = fallbackText;
    } else {
      // Both models are down. Route to the REFER path so a lead is created and
      // staff are alerted — never a fake customer-facing answer.
      aiOutage = true;
      aiReply = "REFER";
    }
  }
  // Bot has no data for this question (REFER, or legacy SILENT). Create/alert
  // a staff handoff. For missing data, stay silent customer-side as requested;
  // for a real AI outage, send a visible temporary-issue acknowledgement.
  if (isReferReply(aiReply)) {
    logInfo("webhook.ai_refer", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      reason: aiOutage ? "ai_outage" : "no_data",
    });
    recordCounter("webhook.ai_refer_total", 1, {
      platform,
      reason: aiOutage ? "ai_outage" : "no_data",
    });
    try {
      if (!(await hasRecentOpenLead(senderId, "handoff"))) {
        await createLead({
          kind: "handoff",
          platform,
          senderId,
          customerMessage: text,
          contactPhone: detectedPhone || "",
          context: aiOutage
            ? "AI түр саатсан тул зөвлөхөд шилжүүлэв."
            : "Бот мэдээлэлгүй асуулт тул зөвлөхөд шилжүүлэв.",
        });
        await notifyStaffOfLead(
          { kind: "handoff", platform, customerMessage: text },
          {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.ai_refer",
          },
        );
      }
    } catch (error) {
      logWarn("webhook.ai_refer_lead_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    if (!aiOutage) {
      await rememberTurn("api.webhook.ai_refer_silent_no_data");
      return;
    }
    await deliverFastPathReply({
      reply: buildHandoffAcknowledgement({ aiOutage }),
      failTag: aiOutage ? "ai_outage_handoff" : "ai_refer_handoff",
      rememberSource: aiOutage ? "api.webhook.ai_outage_handoff" : "api.webhook.ai_refer_handoff",
    });
    return;
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
  const safeReply = enforcePaymentNeverSelfConfirmed(text, enforceWebsiteForPayment(rewrittenReply));
  if (shouldSilenceNoDataReply(safeReply)) {
    logInfo("webhook.ai_no_data_reply_suppressed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
    });
    recordCounter("webhook.ai_no_data_reply_suppressed_total", 1, { platform });
    try {
      if (!(await hasRecentOpenLead(senderId, "handoff"))) {
        await createLead({
          kind: "handoff",
          platform,
          senderId,
          customerMessage: text,
          contactPhone: detectedPhone || "",
          context: "AI мэдээлэлгүй өгүүлбэр бичсэн тул зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй.",
        });
        await notifyStaffOfLead(
          { kind: "handoff", platform, customerMessage: text, contactPhone: detectedPhone || "" },
          {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            source: "api.webhook.ai_no_data_handoff",
          },
        );
      }
    } catch (error) {
      logWarn("webhook.ai_no_data_handoff_lead_failed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        classification: classifyError(error),
      });
    }
    await rememberTurn("api.webhook.ai_no_data_silent");
    return;
  }
  if (lastReply && isDuplicateReply(lastReply.text, safeReply)) {
    recordCounter("webhook.duplicate_reply_avoided_total", 1, { platform });
    // The prompt forbids "Тэр мэдээллийг өмнө нь хуваалцсан" — the code must
    // not say it either. Neutral nudge instead, persisted as the last reply
    // so a third identical question is not answered with the same nudge.
    await deliverFastPathReply({
      reply: DUPLICATE_REPLY_NUDGE,
      failTag: "duplicate_reply_notice",
      rememberSource: "api.webhook.duplicate_nudge",
    });
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
  // Always include contact button as the last one — customer can tap any time
  replyButtons = replyButtons.slice(0, 10);
  if (!replyButtons.includes(CONTACT_OPERATOR_LABEL)) {
    replyButtons.push(CONTACT_OPERATOR_LABEL);
  }
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
    await appendMessage(senderId, "assistant", safeReply);
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
  await rememberTurn("api.webhook.reply");
  await sendTripMediaForReply(
    platform,
    senderId,
    safeReply,
    text,
    token,
    pageId,
    igUserId,
    trace,
  );
}
async function processConversationWithPendingQueue(
  conversationKey: string,
  initial: PendingConversationPayload,
  lockToken: string | null,
) {
  addActiveConversation(conversationKey);
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
    deleteActiveConversation(conversationKey);
    await releaseConversationLockConsistent(conversationKey, lockToken);
    updateConcurrencyGauges();
  }
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
              recipient?: { id?: string };
              message?: {
                is_echo?: boolean;
                mid?: string;
                text?: string;
                metadata?: string;
                attachments?: Array<{ type?: string; payload?: { url?: string } }>;
              };
              postback?: { title?: string; payload?: string };
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
              // Echo = operator/page sent a message to a customer.
              // Bot echoes carry our metadata; only pause for human/operator echoes.
              if (event?.message?.is_echo) {
                const customerId = String(event.recipient?.id ?? "").trim();
                const isBotEcho = event.message.metadata === BOT_MESSAGE_METADATA;
                if (customerId && !isBotEcho) {
                  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
                  await dbPauseSender(customerId, fourteenDaysMs, "operator_reply").catch(() => {});
                  logInfo("webhook.operator_echo_pause", {
                    requestId: trace.requestId,
                    customerHash: hashIdentifier(customerId),
                    pageId,
                  });
                } else if (customerId && isBotEcho) {
                  logInfo("webhook.bot_echo_skip", {
                    requestId: trace.requestId,
                    customerHash: hashIdentifier(customerId),
                    pageId,
                  });
                }
                continue;
              }
              const senderId = String(event.sender.id).trim();
              // Postback taps (Get Started button, persistent menu) carry no
              // message.text — they were silently dropped, so a brand-new
              // customer tapping Get Started got nothing. Treat the button
              // title (or payload) as the customer's message.
              const postbackText =
                typeof event?.postback?.title === "string" && event.postback.title.trim()
                  ? event.postback.title.trim()
                  : typeof event?.postback?.payload === "string"
                    ? event.postback.payload.trim()
                    : "";
              const messageText =
                typeof event?.message?.text === "string"
                  ? event.message.text.trim()
                  : "";
              const text = messageText || postbackText;
              const attachments = Array.isArray(event?.message?.attachments)
                ? event.message.attachments
                : [];
              if (!senderId) continue;
              if (!text && attachments.length === 0) continue;
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
              // Attachment-only message (image, voice note, sticker, share).
              // These used to be silently DROPPED — no reply, no history row;
              // a customer sending a trip-poster screenshot was just ignored.
              if (!text) {
                const attachmentKey = buildEventKey(platform, senderId, event);
                await runEventWithClaim(
                  attachmentKey,
                  { platform, eventType: "dm" },
                  async () => {
                    await handleAttachmentOnlyMessage({
                      platform,
                      senderId,
                      pageId,
                      token,
                      attachments,
                      trace: {
                        requestId: trace.requestId,
                        correlationId: trace.correlationId,
                      },
                    });
                  },
                );
                continue;
              }
              // Postbacks have no mid and no message.text — key them by the
              // derived text so two DIFFERENT button taps never dedup-collide.
              const eventKey = event?.message?.mid
                ? buildEventKey(platform, senderId, event)
                : buildEventKey(platform, senderId, { message: { text } });
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
                  // Images riding along with text are processed in the
                  // background — the text must be answered immediately, not
                  // after a multi-image vision pipeline finishes.
                  scheduleAttachmentDocumentPipeline({
                    platform,
                    senderId,
                    pageId,
                    token,
                    attachments,
                    trace: {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                    },
                  });
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
      activeConversationCount: getActiveConversationCount(),
      pendingConversationCount: getPendingConversationCount(),
    });
  }
}
