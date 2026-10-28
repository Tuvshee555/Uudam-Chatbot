import type { NextApiRequest, NextApiResponse } from "next";
import { askOpenAI } from "../../lib/openaiProvider";
import { askOpenAIChatParts } from "../../lib/openaiFallback";
import { matchFlow, findTriggeredFlow, getFlowState, setFlowState, clearFlowState, newRuntimeState, runFlowFrom, resumeFlowWithInput, type FlowRule, type FlowDoc, type FlowEffects, type FlowRuntimeState, type RunOutcome, } from "../../lib/flowEngine";
import { BOT_MESSAGE_METADATA, replyToComment, sendImageMessage, sendQuickReplies } from "../../lib/messenger";
import { sendQuickReplies as sendIgQuickReplies } from "../../lib/instagram";
import { rateLimitAsync } from "../../lib/rateLimit";
import { getClarificationState, setClarificationState } from "../../lib/clarificationState";
import { getTripSelection, setTripSelection } from "../../lib/tripSelectionState";
import { tripsNamedIn, ungroundedTripInReply } from "../../lib/tripGrounding";
import { isLikelyCatalogMaintenanceText } from "../../lib/customerTextClassification";
import { readBusinessData } from "../../lib/businessData";
import { appendMessage, buildPromptParts, getHistory, hasAskedForPhone } from "../../lib/conversation";
import { buildContextualUserText, isLikelyContextDependentText } from "../../lib/contextualText";
import {
  isBareNumber,
  firstFacebookMessageGreetingPolicy,
  isGetStartedPostback,
  isGetStartedText,
  isKnownGreetingPhrase,
  isThanksOnly,
  isWithinGetStartedQuietWindow,
  MID_CONVERSATION_GREETING_REPLY,
  THANKS_REPLY,
} from "../../lib/greetingPhrases";
import { optionChosenByNumber } from "../../lib/selectionAnswer";
import { routeFastPathText, type FastPathRoute } from "../../lib/fastPathRouting";
import { tripUnderstandingEnabled, understandTripMessage } from "../../lib/tripUnderstanding";
import { understandingModel } from "../../lib/tripUnderstandingModel";
import { buildTripAnswerRuntime } from "../../lib/tripAnswerRuntime";
import { decideTripAnswer, type TripAnswerDecision } from "../../lib/tripAnswerDecision";
import { verifyTripReply } from "../../lib/tripReplyVerification";
import { presentAssistantReply } from "../../lib/chatbotReplyPolicy";
import { conversationalAgentEnabled, runConversationalAgent, type AgentTurn } from "../../lib/conversationalAgent";
import { recordPrimaryReplyDelivery, recordReplyPresentation } from "../../lib/chatbotReplyTelemetry";
import { getReplyMediaPolicy, limitReplyPhotos, recordReplyMediaDelivery } from "../../lib/replyMediaPolicy";
import type { TripSelection } from "../../lib/tripRequest";
import type { TravelTrip } from "../../lib/travelTypes";
import { stripTripNamesForIntent } from "../../lib/customerTurn";
import { buildCatalogListingReply } from "../../lib/catalogListing";
import { fixMojibake } from "../../lib/encoding";
import { scheduleDriveAutoSync } from "../../lib/googleDriveSync";
import { getCustomerMemoryText, scheduleCustomerMemoryUpdate } from "../../lib/conversationMemory";
import { ensureTravelSchema } from "../../lib/travelSchema";
import { analyzeBeforeReply, buildTripIndexLines, shouldAnalyzeBeforeReply } from "../../lib/replyReasoning";
import { buildContactReply, contactSettingsOf, isAddressRequest, isPhoneRequest, isRepeatOfLastReply } from "../../lib/contactReplies";
import { fetchThreadMessages, latestStaffReplyAt, STAFF_TAKEOVER_MS } from "../../lib/staffTakeover";
import { BANK_ACCOUNT_REQUEST_REPLY, enforcePaymentNeverSelfConfirmed, enforceWebsiteForPayment, extractButtons, guardInventedBookingTerms, guardUnverifiedDates, guardUnverifiedPrices, hasBankAccountRequest, hasPaymentClaimIntent, isReferReply, PAYMENT_VERIFICATION_DEFERRAL_REPLY, reconcilePhotoAttachmentReply, rewriteRepeatedGenericClarifier, sanitizeAssistantReply, shouldSilenceNoDataReply, stripRepeatedGreeting, whichTripClarifyReply } from "../../lib/reply";
import { findWrongTripReference } from "../../lib/tripConsistency";
import { autoHandoffSender, isPaused, markGetStarted, pauseBookedCustomer, pauseBot, trackSender } from "../../lib/pause";
import { pickReferral, rememberAdReferral } from "../../lib/adReferral";
import { AUTO_PAUSE_RESET_DAYS, dbAppendAdminMessage, dbClaimGoodbye, dbGetRecentAdminMessages, dbPauseSender, getBotControl, getTravelBotSettings, isPagePaused, listTrips, } from "../../lib/travelOps";
import { hasDepartureDateAvailabilityIntent, requestsDateWindow } from "../../lib/travelDates";
import { AMBIGUOUS_REPLY_MARKER, appendLeadCaptureCta, buildAmbiguousPassengerTotalReply, buildAmbiguousTripReply, buildArchivedTripNotice, buildBudgetReply, buildClarificationButtons, buildCompareReply, buildDiscountReply, buildPriceObjectionReply, buildProgramOrStructuredReply, buildSeatsReply, buildSmartButtons, buildStandalonePriceLookupReply, buildBarePriceReply, isBarePriceMessage, buildStructuredTripReply, buildDateQuestionReply, buildGroupSizeReply, hasBudgetIntent, hasCompareIntent, hasDiscountIntent, hasSeatsIntent, hasStandalonePriceLookupIntent, hasProgramIntent, isGenericTripRequest, isStructuredTripQuestion, resolveTripFromUserMessage, sanitizeTripForCustomers, buildSoldOutPrecedenceReply, } from "../../lib/travelFastPaths";
import { buildHandoffReplyWithContact, claimSeasonSend, extractTripPhotosForReply, getActiveSeason, GREETING_BUTTONS, hasTripPhotoIntent, isFirstMessage, isGreetingButton, matchSeasonByText, resolveGoodbyeContactText, resolveGoodbyeEnabled, resolveGreetingConfig, resolveSeasons, sampleWelcomePhotos, } from "../../lib/welcomeFlow";
import { handlePhotoOnlyMode } from "../../lib/webhookPhotoOnly";
import {
  scheduleAttachmentDocumentPipeline,
  handleAttachmentOnlyMessage,
} from "../../lib/webhookAttachments";
import { notifyStaffOfLead } from "../../lib/staffAlerts";
import { ensureDurableLead } from "../../lib/durableLead";
import { logInboundMessage } from "../../lib/travelMessages";
import { getCollectState } from "../../lib/bookingCollect";
import { continueBookingCollect, isBareBookingRequest, startBookingCollect, type BookingCollectContext } from "../../lib/bookingCollectFlow";
import { getEnv } from "../../lib/env";
import { isMetaOutboundDisabled } from "../../lib/metaOutboundKillSwitch";
import { beginRequestTrace, classifyError, finishRequestTrace, hashIdentifier, logError, logInfo, logWarn, recordCounter, } from "../../lib/observability";
import { parseWebhookJson, PayloadTooLargeError, verifyMetaSignature, } from "../../lib/webhookSecurity";
import {
  type Platform,
  type PendingConversationPayload,
  type PendingConversationHead,
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
  peekPendingConversationConsistent,
  acknowledgePendingConversationConsistent,
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
import { rememberSenderName } from "../../lib/senderNames";
import { sendPlatformMessage, recordImageMessage, recordFileMessage, sendPhotoAlbum, sendTripMediaForReply, sendFacebookTypingIndicator, normalizeLowerText, isQuickInfoKeyword, isHandoffRequest, CONTACT_OPERATOR_LABEL, isBookingIntent, extractPhoneNumber, isPhoneOnlyMessage, isCommentTriggerMatch } from "../../lib/webhookMedia";
import { sendFbFileAttachment, sendFbFileByUrl } from "../../lib/fbAttachmentUpload";
import { buildTripWeatherReply, isWeatherTurn } from "../../lib/tripWeather";
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
  token?: string | null,
  trace?: { requestId: string; correlationId: string; source: string; deliveryKey?: string },
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
  const {
    msg_count: senderMsgCount,
    prev_msg_at: prevMsgAt,
    get_started_at: getStartedAt,
  } = await trackSender(senderId, platform);
  // "hi" typed right after tapping Get Started: Meta's automated response has
  // just greeted this customer, so the bot stays quiet instead of stacking a
  // second greeting. The message is still saved for the admin inbox, and the
  // next real question is answered normally.
  if (isKnownGreetingPhrase(text) && isWithinGetStartedQuietWindow(getStartedAt)) {
    try {
      await appendMessage(senderId, "user", text);
    } catch { /* non-critical */ }
    logInfo("webhook.greeting_after_get_started_skipped", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
    });
    return;
  }
  // Started now so the Meta round trip overlaps the pause lookups below.
  const staffThread = platform === "facebook" && token
    ? fetchThreadMessages({ token, senderId, timeoutMs: 4000 })
    : Promise.resolve(null);
  if (await isPagePaused(pageId)) {
    await appendMessage(senderId, "user", text);
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
    await appendMessage(senderId, "user", text);
    logInfo("webhook.sender_paused", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
    });
    return;
  }
  // Staff replies never reach this webhook as echoes, so read the thread: a
  // staff member who wrote here in the last 3 days owns the conversation.
  {
    const thread = await staffThread;
    const staffAt = thread ? latestStaffReplyAt({ messages: thread, pageId }) : null;
    if (staffAt) {
      await appendMessage(senderId, "user", text);
      const remainingMs = staffAt.getTime() + STAFF_TAKEOVER_MS - Date.now();
      await pauseBot(senderId, remainingMs, "operator_reply").catch(() => {});
      logInfo("webhook.staff_takeover_detected", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        pageId,
        senderHash: hashIdentifier(senderId),
        staffReplyAt: staffAt.toISOString(),
      });
      recordCounter("webhook.staff_takeover_detected_total", 1, { platform });
      return;
    }
  }
  await assertLockHealthy();
  // Read history and pre-routing identity evidence together.
  const replyStartedAt = Date.now();
  const [history, customerMemory, groundingPending, groundingSelection] = await Promise.all([
    getHistory(senderId),
    getCustomerMemoryText(senderId),
    getClarificationState(senderId),
    getTripSelection(senderId),
  ]);
  // "1" under a bulleted hotel / package / date question is that option, not a number with no list.
  text = optionChosenByNumber(history, text) ?? text;
  const contextualUserText = buildContextualUserText(history, text);  const sessionId = `${platform}:${pageId}:${senderId}`;
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
  const captureLead = async (
    input: Omit<Parameters<typeof ensureDurableLead>[0], "platform" | "senderId" | "customerMessage"> & { customerMessage?: string },
    source: string,
  ) => {
    const details = { platform, senderId, customerMessage: text, ...input };
    const result = await ensureDurableLead(details);
    if (result.created) {
      await notifyStaffOfLead(details, {
        requestId: trace?.requestId, correlationId: trace?.correlationId, source,
      });
    }
    return result;
  };
  let pauseAfterContactCapture = false;
  let factualScope: TravelTrip[] | null = null;
  // The exit check every reply passes (tripGrounding.ts): named trips must be supported by
  // trip this conversation points to — the customer's words, an open list, the selected trip, an
  // earlier turn. Freeze that evidence before routing: a newly selected model ID cannot
  // authorize its own answer. Unavailable grounding must remain retryable.
  let groundingTrips: TravelTrip[] | null = null;
  const getGroundingTrips = async (): Promise<TravelTrip[]> => {
    try {
      groundingTrips ||= (await listTrips({ limit: 5000 })).map(sanitizeTripForCustomers);
      return groundingTrips;
    } catch (cause) {
      const error = new RetryableWebhookError("grounding_unavailable");
      error.cause = cause;
      throw error;
    }
  };
  const findUngroundedTrip = async (reply: string, catalogTripIds?: string[]): Promise<TravelTrip | null> =>
    ungroundedTripInReply(reply, {
      customerText: text, history, pendingTripIds: groundingPending?.candidateTripIds || [],
      selectionTripId: groundingSelection?.tripId || null, catalogTripIds, trips: await getGroundingTrips(),
    });
  let currentSelection: TripSelection | null = null;
  const deliverFastPathReply = async (input: {
    reply: string;
    failTag: string;
    rememberSource: string;
    counter?: string;
    buttons?: string[];
    afterDeliver?: () => Promise<void>;
    decision?: TripAnswerDecision;
    catalogTripIds?: string[];
    /** Trips whose facts the reply states: the fact-check scope only, never grounding permission. */
    verifyTripIds?: string[];
    verifyConfiguredFacts?: boolean;
  }) => {
    const presented = input.decision?.reply ?? presentAssistantReply({ reply: input.reply, userText: text,
      hasPriorReply: history.some((message) => message.role === "assistant"),
      phoneAlreadyRequested: Boolean(extractPhoneNumber(text)) || hasAskedForPhone(history) || history.some((message) => message.role === "user" && Boolean(extractPhoneNumber(message.text))),
    });
    const scopeIds = input.catalogTripIds || input.verifyTripIds;
    const verificationScope = input.verifyConfiguredFacts ? await getGroundingTrips()
      : scopeIds ? (await getGroundingTrips()).filter(trip => scopeIds.includes(trip.id)) : factualScope;
    const reply = verificationScope && !input.decision
      ? verifyTripReply({ reply: presented, trips: verificationScope, selection: currentSelection })
      : presented;
    const missingData = input.decision ? input.decision.outcome === "handoff" : isReferReply(reply) || shouldSilenceNoDataReply(reply);
    const ungroundedTrip = missingData ? null : await findUngroundedTrip(reply, input.catalogTripIds);
    const noDataReply = missingData || Boolean(ungroundedTrip);
    if (reply !== presented) recordCounter("webhook.factual_reply_rejected_total", 1, { path: input.failTag });
    if (ungroundedTrip) {
      logInfo("webhook.ungrounded_trip_reply_suppressed", { requestId: trace?.requestId, correlationId: trace?.correlationId,
        platform, senderHash: hashIdentifier(senderId), failTag: input.failTag, tripId: ungroundedTrip.id });
      recordCounter("webhook.ungrounded_trip_reply_suppressed_total", 1, { path: input.failTag });
    }
    if (noDataReply) {
      logInfo("webhook.no_data_reply_suppressed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        failTag: input.failTag,
      });
      recordCounter("webhook.no_data_reply_suppressed_total", 1, { platform });
      await captureLead({
        kind: "handoff",
        context: `Бот мэдээлэлгүй fast-path хариуг зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй: ${input.failTag}${input.decision?.missingFacts.length ? ` [${input.decision.missingFacts.join(", ")}]` : ""}${ungroundedTrip ? ` (харилцаанд дурдагдаагүй аялал: ${ungroundedTrip.route_name})` : ""}`,
      }, "api.webhook.no_data_handoff");
      // The bot doesn't know the answer, so it says NOTHING to the customer (owner's
      // rule: an unknown answer is met with silence, never a "passed to a
      // consultant" notice). Staff got the lead + alert above, and the bot is
      // paused for this customer the same way an explicit "холбогдох" request does
      // — a human takes over instead of the bot risking another wrong or empty
      // reply on the next message.
      await autoHandoffSender(senderId);
      const noDataPauseMs =
        botSettings.handoff_pause_minutes > 0
          ? botSettings.handoff_pause_minutes * 60_000
          : undefined;
      await pauseBot(senderId, noDataPauseMs, "no_data_handoff");
      if (input.counter) recordCounter(input.counter, 1, { platform });
      return false;
    }
    recordReplyPresentation({ reply, userText: text, path: "webhook_code", latencyMs: Date.now() - replyStartedAt });
    await assertLockHealthy();
    let delivered: boolean;
    // Always include the operator button — customer can tap it any time,
    // even on a fast-path reply that didn't propose its own buttons.
    const quickButtons = input.buttons?.filter(Boolean).slice(0, 10) || [];
    const buttons = quickButtons.includes(CONTACT_OPERATOR_LABEL)
      ? quickButtons
      : [...quickButtons, CONTACT_OPERATOR_LABEL].slice(0, 11);
    if (token && buttons.length > 0) {
      try {
        if (platform === "facebook") {
          await sendQuickReplies(senderId, reply, buttons, token, {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            deliveryKey: trace?.deliveryKey,
            source: `api.webhook.${input.failTag}_buttons`,
          });
        } else {
          await sendIgQuickReplies(igUserId || "", senderId, reply, buttons, token, {
            requestId: trace?.requestId,
            correlationId: trace?.correlationId,
            deliveryKey: trace?.deliveryKey,
            source: `api.webhook.${input.failTag}_buttons`,
          });
        }
        recordCounter("webhook.fast_path_buttons_sent_total", 1, {
          platform,
          buttonCount: String(buttons.length),
        });
        delivered = true;
      } catch {
        delivered = await sendPlatformMessage(
          platform,
          senderId,
          reply,
          token,
          pageId,
          igUserId,
          trace,
          { allowFallback: false },
        );
      }
    } else {
      delivered = await sendPlatformMessage(
        platform,
        senderId,
        reply,
        token,
        pageId,
        igUserId,
        trace,
        { allowFallback: false },
      );
    }
    recordPrimaryReplyDelivery({ path: "webhook_code", accepted: delivered, latencyMs: Date.now() - replyStartedAt });
    if (!delivered) {
      throw new RetryableWebhookError(`delivery_failed:${input.failTag}`);
    }
    // Recorded BEFORE afterDeliver (which sends any PDF/photo and logs it via
    // recordFileMessage/recordImageMessage with blank text): this text is
    // what actually reaches Messenger first. Logging it after afterDeliver
    // used to put a blank placeholder row ahead of the real caption in
    // travel_conversations, which reads backwards in the admin inbox even
    // though customers received the messages in the right order.
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
    if (!noDataReply && input.afterDeliver) await input.afterDeliver();
    await rememberTurn(noDataReply ? `${input.rememberSource}_handoff` : input.rememberSource);
    if (pauseAfterContactCapture) await pauseBookedCustomer(senderId);
    if (input.counter) recordCounter(input.counter, 1, { platform });
    return true;
  };

  // Photo-only mode: send photos only when we have a real trip signal.
  // Stay silent on greetings, unrelated text, or unknown requests. Full
  // behavior lives in webhookPhotoOnly.ts (extracted for the 2,000-line cap).
  const botSettings = await getTravelBotSettings();
  const botControl = await getBotControl();
  // The model leads trip conversations (conversationalAgent.ts); the keyword
  // paths below it only answer when the model is unavailable.
  const agentOn = conversationalAgentEnabled(botSettings.extra as Record<string, unknown> | undefined);
  // Reengagement copy is editable text, so verify it through the same boundary
  // before answering the current question. A withheld message hands off once.
  const INACTIVITY_MS = 30 * 60 * 1000;
  if (platform === "facebook" && token && senderMsgCount > 1 && prevMsgAt
    && Date.now() - new Date(prevMsgAt).getTime() >= INACTIVITY_MS
    && resolveGoodbyeEnabled(botSettings.extra) && await dbClaimGoodbye(senderId)) {
    const delivered = await deliverFastPathReply({
      reply: resolveGoodbyeContactText(botSettings.extra), verifyConfiguredFacts: true,
      failTag: "inactivity_goodbye", rememberSource: "api.webhook.inactivity_goodbye",
    });
    if (!delivered) {
      await appendMessage(senderId, "user", text);
      return;
    }
    recordCounter("webhook.reengagement_contact_sent_total", 1, { platform });
  }
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
      deliverReply: async (reply, tag) => { await deliverFastPathReply({ reply, failTag: tag, rememberSource: `api.webhook.${tag}` }); },
    });
    return;
  }

  if (platform === "facebook") {
    await sendFacebookTypingIndicator(senderId, token, pageId, trace);
  }
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
  // Facebook can already send an admin-configured page greeting before the bot
  // sees the first DM. Consume our one-time welcome slot, but do not stack a
  // second greeting bubble on top of Facebook's. A bare first "hi" stays quiet;
  // a first message with an actual question continues below and gets answered.
  const greeting = resolveGreetingConfig(botSettings.extra);
  const firstGreetingPolicy = firstFacebookMessageGreetingPolicy(text);
  if (
    platform === "facebook" &&
    token &&
    greeting.enabled &&
    senderMsgCount === 1 &&
    firstGreetingPolicy.suppressBotWelcome &&
    (await isFirstMessage(senderId))
  ) {
    logInfo("webhook.first_message_welcome_suppressed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      answerCustomerMessage: firstGreetingPolicy.answerCustomerMessage,
    });
    recordCounter("webhook.first_message_welcome_suppressed_total", 1, {
      platform,
      answerCustomerMessage: String(firstGreetingPolicy.answerCustomerMessage),
    });
    if (!firstGreetingPolicy.answerCustomerMessage) {
      await appendMessage(senderId, "user", text).catch(() => {});
      return;
    }
  }

  // ── Mid-conversation bare greeting ─────────────────────────────────────────
  // A bare greeting after the first Facebook turn, or anywhere Instagram still
  // needs the bot to greet, gets a deterministic friendly reply instead of the
  // model. Without this it falls through to the model, which — when the
  // previous turn was a multi-trip clarification — re-emits that clarification's
  // price list on "hi" ~50% of the time (found 2026-07-22). A greeting asks
  // nothing and must never re-serve a stale trip. Any attachment riding along
  // with the text is still processed by scheduleAttachmentDocumentPipeline.
  // With the agent on it answers these itself: "ок" is an acknowledgement, and
  // a canned "Сайн байна уу!" in the middle of a chat reads like a robot.
  if (isKnownGreetingPhrase(text) && !agentOn) {
    await appendMessage(senderId, "user", text).catch(() => {});
    await deliverFastPathReply({
      reply: MID_CONVERSATION_GREETING_REPLY,
      failTag: "greeting_fast_path",
      rememberSource: "api.webhook.greeting_fast_path",
      counter: "webhook.greeting_fast_path_total",
    });
    return;
  }

  // ── Bare number ("5", "55") ────────────────────────────────────────────────
  // A number on its own answers a numbered list the customer was just shown, or a
  // booking question. Outside those it means nothing: the model read "5" as "5
  // million" and offered a budget search. Stay silent unless one is pending.
  // With the conversational agent on, the chat history gives the number its
  // meaning ("2" after "how many people?"), so it goes to the agent instead.
  if (isBareNumber(text) && !agentOn) {
    const [pendingClarification, pendingBooking] = await Promise.all([
      getClarificationState(senderId),
      getCollectState(senderId),
    ]);
    if (!pendingClarification && !(pendingBooking && pendingBooking.step !== "done")) {
      await appendMessage(senderId, "user", text).catch(() => {});
      logInfo("webhook.bare_number_silent", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
      });
      recordCounter("webhook.bare_number_silent_total", 1, { platform });
      // A number without an open numbered list or booking question contains no
      // usable customer evidence. Keep it away from the model (which previously
      // treated values such as "1" as a trip/menu choice), but do not silently
      // lose the customer: the owner's no-data rule requires a durable staff
      // handoff whenever the bot cannot answer.
      await deliverFastPathReply({
        reply: "REFER",
        failTag: "bare_number_without_context",
        rememberSource: "api.webhook.bare_number_without_context",
        counter: "webhook.bare_number_handoff_total",
      });
      return;
    }
  }

  // ── Emoji / punctuation only ("😊", "????") ────────────────────────────────
  // No words, nothing to look up. The model read a lone "😊" as interest in a trip
  // from the customer's memory and asked about it (2026-10-21). An emoji gets nothing;
  // question marks mean the customer is waiting, so staff get a lead (no reply).
  // With the agent on, "????" (a customer still waiting) gets a human answer.
  if (!/[\p{L}\p{N}]/u.test(text) && !(agentOn && /[?？]/.test(text))) {
    if (/[?？]/.test(text)) {
      await deliverFastPathReply({
        reply: "REFER",
        failTag: "punctuation_only",
        rememberSource: "api.webhook.punctuation_only",
        counter: "webhook.punctuation_only_total",
      });
    } else {
      await appendMessage(senderId, "user", text).catch(() => {});
      recordCounter("webhook.emoji_only_silent_total", 1, { platform });
    }
    return;
  }

  // ── Bare thank-you ─────────────────────────────────────────────────────────
  // "Баярлалаа" asks nothing. It used to borrow the previous turns' trips and
  // come back as a list of <city> trips. Answer it deterministically (also keeps
  // working when the model is down). Anything beyond thanks goes on as usual.
  if (isThanksOnly(text)) {
    await appendMessage(senderId, "user", text).catch(() => {});
    await deliverFastPathReply({
      reply: THANKS_REPLY,
      failTag: "thanks_fast_path",
      rememberSource: "api.webhook.thanks_fast_path",
      counter: "webhook.thanks_fast_path_total",
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
  // Booking collector (name + phone before handoff). Answers are validated in
  // bookingCollect.ts; a message that is not an answer drops the flow and is
  // answered normally below.
  const bookingCtx: BookingCollectContext = {
    platform,
    senderId,
    text,
    contextualUserText,
    send: (message, tag) => deliverFastPathReply({ reply: message, failTag: tag, rememberSource: `api.webhook.${tag}` }),
    sendRecordsHistory: true,
    trace,
  };
  if (botSettings.handoff_enabled && (await continueBookingCollect(bookingCtx))) return;
  let flowAiPromptOverride: string | undefined;
  let flowWithheld = false;
  const flowDocs: FlowDoc[] = Array.isArray(botSettings.extra?.flowDocs)
    ? (botSettings.extra.flowDocs as FlowDoc[])
    : [];
  function buildFlowEffects(): FlowEffects {
    return {
      sendText: async (msg: string) => {
        if (flowWithheld) return;
        flowWithheld = !(await deliverFastPathReply({ reply: msg, verifyConfiguredFacts: true,
          failTag: "flow_message", rememberSource: "api.webhook.flow_message" }));
      },
      sendImage: token && platform === "facebook"
        ? async (url: string) => {
            if (flowWithheld) return;
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
            if (flowWithheld) return;
            flowWithheld = !(await deliverFastPathReply({ reply: msg, buttons: labels, verifyConfiguredFacts: true,
              failTag: "flow_quick", rememberSource: "api.webhook.flow_quick" }));
          }
        : undefined,
      notifyOwner: async (msg: string) => {
        if (flowWithheld) return;
        await notifyStaffOfLead(
          { kind: "handoff", platform, customerMessage: msg },
          { requestId: trace?.requestId, correlationId: trace?.correlationId, source: "api.webhook.flow" },
        ).catch(() => {});
      },
      captureLead: async (state: FlowRuntimeState) => {
        if (flowWithheld) return;
        await ensureDurableLead({
          kind: "booking", platform, senderId,
          customerMessage: state.fields.message || text,
          contactPhone: state.fields.phone || "",
          context: JSON.stringify(state.fields),
        });
      },
    };
  }
  async function persistFlowOutcome(
    doc: FlowDoc,
    state: FlowRuntimeState,
    outcome: RunOutcome,
  ): Promise<{ handedToAi: boolean; systemPromptOverride?: string }> {
    if (flowWithheld) {
      await clearFlowState(senderId, platform);
      return { handedToAi: false };
    }
    if (outcome.status === "waiting_input") {
      await setFlowState(senderId, platform, state);
      return { handedToAi: false };
    }
    await clearFlowState(senderId, platform);
    if (outcome.status === "handoff_to_ai") {
      return { handedToAi: true, systemPromptOverride: outcome.systemPromptOverride };
    }
    if (pauseAfterContactCapture) await pauseBookedCustomer(senderId);
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
    await captureLead({ kind: "handoff" }, "api.webhook.handoff");
    await appendMessage(senderId, "user", text);
    const handoffConfirmation =
      botSettings.handoff_reply ||
      "Таны хүсэлтийг хүлээн авлаа. Манай ажилтан удахгүй тантай холбогдоно.";
    // One bubble: confirmation + consultant numbers (Facebook only, as before).
    const handoffMsg =
      platform === "facebook" && token
        ? buildHandoffReplyWithContact(handoffConfirmation, botSettings.extra)
        : handoffConfirmation;
    await deliverFastPathReply({ reply: handoffMsg, failTag: "handoff", rememberSource: "api.webhook.handoff" });
    await autoHandoffSender(senderId);
    const pauseMs = botSettings.handoff_pause_minutes > 0 ? botSettings.handoff_pause_minutes * 60_000 : undefined;
    await pauseBot(senderId, pauseMs, "handoff");
    recordCounter("webhook.handoff_requested_total", 1, { platform });
    logInfo("webhook.handoff_requested", {
      requestId: trace?.requestId, correlationId: trace?.correlationId, platform,
      senderHash: hashIdentifier(senderId), pauseMinutes: botSettings.handoff_pause_minutes,
    });
    return;
  }
  const contactReply = buildContactReply(text, contactSettingsOf(botSettings.extra));
  if (contactReply || isPhoneRequest(text) || isAddressRequest(text)) {
    await assertLockHealthy();
    // The phone/address button tapped again within two minutes: it was just answered.
    // Three taps sent the same numbers three times in one minute (2026-10-18).
    const previousReply = await getLastReplyConsistent(sessionId);
    if (contactReply && isRepeatOfLastReply(previousReply, contactReply)) {
      try { await appendMessage(senderId, "user", text); } catch { /* non-critical */ }
      return;
    }
    await appendMessage(senderId, "user", text);
    await deliverFastPathReply({ reply: contactReply || "REFER", failTag: "contact_reply", rememberSource: "api.webhook.contact_reply" });
    return;
  }
  if (
    botSettings.quick_info_reply &&
    isQuickInfoKeyword(text, botSettings.quick_info_keywords)
  ) {
    await appendMessage(senderId, "user", text);
    await deliverFastPathReply({ reply: botSettings.quick_info_reply, verifyConfiguredFacts: true,
      failTag: "quick_info_keyword", rememberSource: "api.webhook.quick_info" });
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
    const captured = await captureLead({
      kind: "booking", contactPhone: detectedPhone, context: "Чатад утасны дугаараа үлдээсэн.",
    }, "api.webhook.phone_capture");
    if (captured.created) recordCounter("webhook.phone_lead_captured_total", 1, { platform });
    if (isPhoneOnlyMessage(text)) {
      await appendMessage(senderId, "user", text);
      await deliverFastPathReply({
        reply: `Баярлалаа! Манай аяллын зөвлөх таны ${detectedPhone} дугаарт холбогдоно.`,
        failTag: "phone_capture_confirmation", rememberSource: "api.webhook.phone_capture_confirmation",
      });
      await pauseBookedCustomer(senderId);
      return;
    }
    pauseAfterContactCapture = true;
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
      await appendMessage(senderId, "user", text);
      await deliverFastPathReply({ reply: matchedRule.reply, buttons: matchedRule.buttons, verifyConfiguredFacts: true,
        failTag: "flow_rule", rememberSource: "api.webhook.flow_rule" });
      return;
    }
  }
  scheduleDriveAutoSync({ source: "api.webhook" });
  // The catalog is focused on the trips this message is about inside
  // buildPromptParts (aiTripContext.ts) — shared with the demo endpoint.
  const { systemPrompt: fileSystemPrompt, business, pinnedButtonLabels } = await readBusinessData();
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
  // With the agent on, only a bare "I want to book" starts the name/phone form;
  // a question that merely mentions booking ("20 хүн захиалвал болох уу") is answered.
  const customerWantsToBook =
    botSettings.handoff_enabled && isBookingIntent(text) && (!agentOn || isBareBookingRequest(text));
  if (customerWantsToBook && (await startBookingCollect(bookingCtx))) return;
  await appendMessage(senderId, "user", text);
  let cachedTrips: Awaited<ReturnType<typeof listTrips>> | null = null;
  const getTrips = async () => {
    if (cachedTrips) return cachedTrips;
    cachedTrips = (await listTrips({ limit: 5000 })).map(sanitizeTripForCustomers);
    return cachedTrips;
  };
  // Only fetched on the miss path (nothing in the active catalogue matched),
  // so a normal message never pays for this extra query.
  let cachedArchivedTrips: Awaited<ReturnType<typeof listTrips>> | null = null;
  const getArchivedTrips = async () => {
    if (cachedArchivedTrips) return cachedArchivedTrips;
    cachedArchivedTrips = await listTrips({ status: "archived", limit: 500 });
    return cachedArchivedTrips;
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
      history,
      trips: await getTrips(),
      understand: tripUnderstandingEnabled()
        ? async (pendingTripIds, selection) =>
            understandTripMessage({ text, history, trips: await getTrips(), pendingTripIds, selection, ask: understandingModel(trace) })
        : undefined,
    });
    currentSelection = routedCache.selection || null;
    factualScope = routedCache.chosenTripId
      ? (await getTrips()).filter((trip) => trip.id === routedCache?.chosenTripId)
      : routedCache.scopedClarify || routedCache.understanding?.trips || [];
    return routedCache;
  };
  const getFastPathText = async (): Promise<string> => (await getRouted()).matchText;
  // What is being ASKED: the customer's words with trip names removed. A tapped
  // "…шууд нислэгтэй аялал" button is a choice of trip, not a flight question.
  const intentText = stripTripNamesForIntent(text, await getTrips());
  const wantsDateAvailability =
    (hasDepartureDateAvailabilityIntent(intentText) && !hasProgramIntent(intentText))
    // "11/1-ээс 11/6 аяллын хөтөлбөр илгээнэ үү": a programme ask over a date window that
    // names no trip has no programme to send — list the trips leaving in that window (a
    // "which trip?" the customer can pick from) instead of silence (2026-10-16).
    || (hasProgramIntent(intentText) && requestsDateWindow(intentText)
      && resolveTripFromUserMessage(text, await getTrips(), { allowLooseFallback: false }).status === "not_found");

  // Staff/catalog maintenance notes are not customer questions. They often
  // contain dates, "суудал дүүрсэн", and duration numbers; answering those as
  // prices or availability is exactly how a "5 шөнө" row turns into a bogus
  // "5 сая" conversation. Save the inbound text for the inbox, alert staff,
  // and stay quiet to the customer.
  if (isLikelyCatalogMaintenanceText(text)) {
    await captureLead({
      kind: "handoff", contactPhone: detectedPhone || "",
      context: "Дотоод каталог/status тэмдэглэл шиг харагдсан тул бот автоматаар хариулаагүй.",
    }, "api.webhook.catalog_note_suppressed");
    logInfo("webhook.catalog_note_suppressed", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
    });
    recordCounter("webhook.catalog_note_suppressed_total", 1, { platform });
    await rememberTurn("api.webhook.catalog_note_suppressed");
    return;
  }

  // A payment/booking confirmation claim ("5 сая шилжүүлсэн") must be
  // acknowledged BEFORE any trip/date/price fast-path runs below — those are
  // blind text/number matchers and were hijacking real payment claims into an
  // unrelated trip reply (a bare number like "5" or "8" in "5 сая" / "8 сая"
  // matched a trip alias containing "5 өдөр" or August month availability,
  // so a customer saying they just paid got a random trip listing instead of
  // any acknowledgment).
  // A request for the bank account ("за дансаа") is the same buy signal:
  // staff send the account, the bot only says so.
  const asksBankAccount = hasBankAccountRequest(text);
  if (hasPaymentClaimIntent(text) || asksBankAccount) {
    // The deferral reply PROMISES the customer a consultant will check and
    // get back to them — that promise is only real if staff actually hear
    // about it. A payment claim is the strongest buy signal there is; without
    // this lead+alert, a paying customer would wait on a follow-up nobody
    // knew to make.
    await captureLead({
      kind: "handoff", contactPhone: detectedPhone || "",
      context: asksBankAccount
        ? "Хэрэглэгч төлбөрийн дансны мэдээлэл асуусан — зөвлөх албан ёсоор илгээнэ үү."
        : "Төлбөр шилжүүлсэн гэж мэдэгдсэн — зөвлөх шалгаж баталгаажуулна уу.",
    }, "api.webhook.payment_claim");
    await deliverFastPathReply({
      reply: asksBankAccount
        ? BANK_ACCOUNT_REQUEST_REPLY
        : enforceWebsiteForPayment(sanitizeAssistantReply(PAYMENT_VERIFICATION_DEFERRAL_REPLY)),
      failTag: "payment_claim_deferred",
      rememberSource: "api.webhook.payment_claim_deferred",
      counter: "webhook.payment_claim_deferred_total",
    });
    await pauseBookedCustomer(senderId).catch(() => {});
    return;
  }

  // ── Conversational agent ───────────────────────────────────────────────────
  // One short, human message with at most one question, written by the model
  // from the catalog and checked at the shared exit (deliverFastPathReply).
  // Null (model down / unusable output) falls through to the keyword paths.
  if (agentOn && typeof business?.knowledgeBase === "string") {
    const catalogTrips = (await getTrips()).filter((trip) =>
      trip.status === "active" && (trip.extra as Record<string, unknown> | undefined)?.customer_visible !== false);
    const focusTripNames = (() => {
      const names = catalogTrips.filter((trip) => trip.id === groundingSelection?.tripId).map((trip) => trip.route_name);
      const match = resolveTripFromUserMessage(contextualUserText, catalogTrips, { allowLooseFallback: false });
      if (match.status === "verified") names.push(match.trip.route_name);
      if (match.status === "ambiguous") names.push(...match.candidates.slice(0, 6).map((trip) => trip.route_name));
      return names;
    })();
    const factProblem = async (turn: AgentTurn): Promise<string | null> => {
      if (isReferReply(verifyTripReply({ reply: turn.reply, trips: turn.trips }))) {
        return "a price, date, duration or booking term in it is not written in the catalog for the trips listed in \"trips\" (or a fact was stated without listing its trip). State only exact catalog values for trips you list, or leave the detail out.";
      }
      if (shouldSilenceNoDataReply(turn.reply)) {
        return "it told the customer the information is unavailable. If the catalog cannot answer, set handoff to true; otherwise answer from the catalog.";
      }
      const ungrounded = await findUngroundedTrip(turn.reply);
      return ungrounded
        ? `it named the trip «${ungrounded.route_name}», which this customer has not asked about. Do not bring up specific trips they have not mentioned; ask what destination or kind of trip they want instead.`
        : null;
    };
    const turn = await runConversationalAgent({
      ask: async ({ system, user }) => (await askOpenAI(user, {
        requestId: trace?.requestId, correlationId: trace?.correlationId, source: "api.webhook.agent",
        systemInstruction: system, jsonMode: true, temperature: 0.4, maxOutputTokens: 700,
        openaiModel: process.env.OPENAI_REPLY_MODEL || "gpt-4o", preferOpenAI: true,
      })).text,
      knowledgeBase: business.knowledgeBase, trips: catalogTrips, history, userText: text,
      customerMemory, focusTripNames, phoneCollected, check: factProblem,
    });
    if (turn?.noReply) {
      recordCounter("webhook.agent_turn_total", 1, { platform, outcome: "no_reply" });
      await rememberTurn("api.webhook.conversational_agent_no_reply");
      return;
    }
    if (turn) {
      recordCounter("webhook.agent_turn_total", 1, { platform, outcome: turn.handoff ? "handoff" : "reply" });
      await deliverFastPathReply({
        reply: turn.handoff ? "REFER" : turn.reply,
        buttons: turn.buttons,
        verifyTripIds: turn.trips.map((trip) => trip.id),
        failTag: turn.handoff ? "conversational_agent_handoff" : "conversational_agent",
        rememberSource: "api.webhook.conversational_agent",
        afterDeliver: async () => {
          // Photos of the one trip being discussed, and nothing else: the reply
          // already carries any link, so no second text bubble.
          const photos = turn.trips.length === 1 ? turn.trips[0].photo_urls.slice(0, 6) : [];
          if (!turn.sendPhotos || platform !== "facebook" || !token || !photos.length) return;
          await sendPhotoAlbum(senderId, photos, token, trace);
        },
      });
      return;
    }
    logWarn("webhook.agent_unavailable", { requestId: trace?.requestId, correlationId: trace?.correlationId,
      platform, senderHash: hashIdentifier(senderId) });
    recordCounter("webhook.agent_unavailable_total", 1, { platform });
  }

  // Generic price objections must run before route matching. Otherwise a
  // plain complaint can match a trip note that happens to contain "unetei".
  {
    const objectionReply = buildPriceObjectionReply(text);
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

  if ((await getRouted()).unsupportedRequest) {
    await deliverFastPathReply({ reply: "REFER", failTag: "unsupported_request",
      rememberSource: "api.webhook.unsupported_request" });
    return;
  }

  // Compare questions intentionally mention multiple destinations/products.
  // Answer them as comparisons before scoped clarification narrows the message
  // to one destination family and asks the wrong follow-up.
  {
    const route = await getRouted();
    const plan = await buildTripAnswerRuntime({ text, trips: await getTrips(), route });
    if (plan) {
      const decision = decideTripAnswer(plan, { userText: text,
        hasPriorReply: history.some((message) => message.role === "assistant"),
        phoneAlreadyRequested,
      });
      const reply = decision.reply;
      currentSelection = plan.selection;
      if (decision.outcome !== "handoff") await setTripSelection(senderId, plan.selection);
      logInfo("webhook.trip_answer_decision", {
        requestId: trace?.requestId, correlationId: trace?.correlationId, platform,
        senderHash: hashIdentifier(senderId), outcome: decision.outcome, tripId: plan.tripId,
        evidenceSource: route.understanding?.evidence?.source || "deterministic",
        catalogFingerprint: hashIdentifier(JSON.stringify(factualScope || [])),
        requestedTopics: plan.request.topics, missingFacts: decision.missingFacts,
      });
      recordCounter("webhook.answer_plan_total", 1, { status: decision.outcome });
      if (plan.missingTopics.length) recordCounter("webhook.answer_plan_missing_topics_total", plan.missingTopics.length, {});
      await deliverFastPathReply({
        reply, decision, failTag: "answer_plan", rememberSource: "api.webhook.answer_plan",
        buttons: decision.outcome === "clarify" ? undefined : buildSmartButtons(reply, factualScope || []) || undefined,
        afterDeliver: async () => {
          if (platform !== "facebook" || !token) return;
          const mediaPolicy = getReplyMediaPolicy(intentText, reply);
          if (!mediaPolicy.allowed) return;
          if (plan.brochureUrl) {
            recordReplyMediaDelivery("pdf", "attempted");
            const sent = await sendFbFileByUrl(senderId, plan.brochureUrl, token);
            recordReplyMediaDelivery("pdf", sent ? "sent" : "failed");
            if (sent) await recordFileMessage(senderId, plan.brochureUrl);
          }
          await sendPhotoAlbum(senderId, limitReplyPhotos(plan.mediaUrls, mediaPolicy.photoLimit), token, trace);
        },
      });
      return;
    }
  }
  if (hasCompareIntent(intentText)) {
    const trips = await getTrips();
    const compareReply = buildCompareReply(await getFastPathText(), trips);
    if (compareReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(compareReply)),
          phoneAlreadyRequested,
        ),
        failTag: "compare_fast_path",
        catalogTripIds: tripsNamedIn(compareReply, trips).map(trip => trip.id),
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
    if (routed.scopedClarify && routed.scopedClarify.length > 0 && !wantsDateAvailability) {
      const totalReply = buildAmbiguousPassengerTotalReply(await getFastPathText(), routed.scopedClarify);
      const clarifyBody = routed.scopedClarifyNote
        ? totalReply
          ? `${routed.scopedClarifyNote}\n${totalReply}`
          : buildAmbiguousTripReply(
              routed.scopedClarify,
              routed.scopedClarifyNote,
              { askToChoose: !routed.informationalAlternatives, customerText: routed.requestText || text },
            )
        : totalReply || buildAmbiguousTripReply(routed.scopedClarify, undefined, { customerText: routed.requestText || text });
      await deliverFastPathReply({
        reply: enforceWebsiteForPayment(sanitizeAssistantReply(clarifyBody)),
        failTag: "scoped_clarify",
        catalogTripIds: routed.scopedClarify.map(trip => trip.id),
        rememberSource: "api.webhook.scoped_clarify",
        counter: "webhook.scoped_clarify_total",
        buttons: routed.informationalAlternatives
          ? undefined
          : buildClarificationButtons(routed.scopedClarify),
      });
      return;
    }
    if (routed.notInCatalog) {
      // A place no trip goes to is a question the bot cannot answer: silence and a staff
      // lead, never "Уучлаарай, «<газар>» чиглэлийн аялал манайд байхгүй" (owner's rule;
      // the place reading is a guess — ordinary words were read as destinations).
      await deliverFastPathReply({
        reply: "REFER",
        failTag: "not_in_catalog",
        rememberSource: "api.webhook.not_in_catalog",
        counter: "webhook.not_in_catalog_total",
      });
      return;
    }
  }
  // Weather: answered from the booking website's own report (same text as
  // the trip page). Before the structured-question gate on purpose — "<хот>
  // хүйтэн байна уу" reads as structured and would otherwise go silent.
  if (isWeatherTurn(intentText, history)) {
    const weather = await buildTripWeatherReply(await getFastPathText(), await getTrips(), undefined, (await getRouted()).chosenTripId, intentText);
    if (weather.kind === "clarify") await setClarificationState(senderId, weather.candidates.map((t) => t.id));
    await deliverFastPathReply({
      reply: sanitizeAssistantReply(weather.reply),
      failTag: "weather_fast_path",
      catalogTripIds: weather.kind === "clarify" ? weather.candidates.map(trip => trip.id) : undefined,
      rememberSource: "api.webhook.weather_fast_path",
      counter: "webhook.weather_fast_path_total",
      buttons: weather.kind === "clarify" ? buildClarificationButtons(weather.candidates) : undefined,
    });
    return;
  }
  // The customer named a trip that is sold out: say so (and offer the same
  // destination's open trips) instead of quoting a near-name sibling's price.
  {
    const soldOutReply = buildSoldOutPrecedenceReply(text, await getTrips());
    if (soldOutReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(soldOutReply)),
          phoneAlreadyRequested,
        ),
        failTag: "sold_out_named",
        catalogTripIds: tripsNamedIn(soldOutReply, await getTrips()).map(trip => trip.id),
        rememberSource: "api.webhook.sold_out_named",
        counter: "webhook.sold_out_named_total",
      });
      return;
    }
  }
  // A question about the catalog ("шууд нислэгтэй аялал байна уу", "бүх
  // аяллын хуваарь") when neither the message nor the context names a trip:
  // list it from the DB instead of a silent no-data handoff.
  {
    const listing = buildCatalogListingReply(intentText, await getTrips());
    if (listing && (
      listing.authoritative === true ||
      resolveTripFromUserMessage(await getFastPathText(), await getTrips(), { allowLooseFallback: false }).status === "not_found"
    )) {
      // The list is a "which trip?" question: a following "Хөтөлбөр үзэх"
      // must re-ask it, not take the first trip listed.
      if (listing.listed.length > 0) {
        await setClarificationState(senderId, listing.listed.map((trip) => trip.id));
      }
      factualScope = listing.listed;
      await deliverFastPathReply({
        reply: enforceWebsiteForPayment(sanitizeAssistantReply(listing.reply)),
        failTag: "catalog_listing",
        catalogTripIds: listing.listed.map(trip => trip.id),
        rememberSource: "api.webhook.catalog_listing",
        counter: "webhook.catalog_listing_total",
        buttons: buildClarificationButtons(listing.listed),
      });
      return;
    }
  }
  // Broad structured questions ("<хот> аялал хэд вэ?") should clarify from
  // the DB when several active trips match. Do not send these to the model and
  // risk a silent REFER.
  {
    const fastPathText = await getFastPathText();
    if (isStructuredTripQuestion(intentText)) {
      const archivedNotice = buildArchivedTripNotice(
        fastPathText,
        await getArchivedTrips(),
      );
      if (archivedNotice) {
        await deliverFastPathReply({
          reply: appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(archivedNotice.reply)),
            phoneAlreadyRequested,
          ),
          failTag: "archived_trip_notice",
          rememberSource: "api.webhook.archived_trip_notice",
          counter: "webhook.archived_trip_notice_total",
        });
        return;
      }
      const resolution = resolveTripFromUserMessage(fastPathText, await getTrips(), {
        allowLooseFallback: false,
      });
      if (
        resolution.status === "ambiguous" &&
        resolution.candidates.length > 1 &&
        !wantsDateAvailability
      ) {
        // The list about to be shown must be exactly what the NEXT turn's
        // numbered/named answer is checked against. Without this, two real
        // customers typed "2. <the option's own name, copied verbatim>" and
        // got silence: nothing had remembered the list had ever been offered
        // (found replaying 2026-10-08..11 chats).
        await setClarificationState(senderId, resolution.candidates.map((trip) => trip.id));
        const totalReply = buildAmbiguousPassengerTotalReply(fastPathText, resolution.candidates);
        await deliverFastPathReply({
          reply: enforceWebsiteForPayment(
            sanitizeAssistantReply(totalReply || buildAmbiguousTripReply(resolution.candidates, undefined, { customerText: text })),
          ),
          failTag: "structured_clarify",
          catalogTripIds: resolution.candidates.map(trip => trip.id),
          rememberSource: "api.webhook.structured_clarify",
          counter: "webhook.structured_clarify_total",
          buttons: buildClarificationButtons(resolution.candidates),
        });
        return;
      }
      if (
        resolution.status === "not_found" &&
        !hasDepartureDateAvailabilityIntent(intentText) &&
        !hasCompareIntent(intentText) &&
        !hasBudgetIntent(intentText) &&
        !hasDiscountIntent(intentText) &&
        !hasSeatsIntent(intentText)
      ) {
        // No destination named at all ("Үнэ", "Хөтөлбөр", "Хэд хоногийн аялал
        // хэдэн төг вээ"): ask which trip. Handing this to staff and pausing
        // the bot was the most common way a real customer got no answer.
        if (isGenericTripRequest(text)) {
          await deliverFastPathReply({
            reply: whichTripClarifyReply(text),
            failTag: "generic_trip_request",
            rememberSource: "api.webhook.generic_trip_request",
            counter: "webhook.generic_trip_request_total",
          });
          return;
        }
        await deliverFastPathReply({
          reply: "REFER",
          failTag: "structured_trip_not_found",
          rememberSource: "api.webhook.structured_trip_not_found",
          counter: "webhook.structured_trip_not_found_total",
        });
        return;
      }
    }
  }
  if (wantsDateAvailability) {
    const trips = await getTrips();
    const routed = await getRouted();
    const dateAvailabilityReply = routed.unavailableDateWithinScope ? "REFER"
      : buildDateQuestionReply(intentText, await getFastPathText(), routed.scopedClarify || trips);
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
      await deliverFastPathReply({
        reply: safeDateReply,
        failTag: "date_availability_reply",
        catalogTripIds: tripsNamedIn(dateAvailabilityReply, routed.scopedClarify || trips).map(trip => trip.id),
        rememberSource: "api.webhook.date_fast_path",
        buttons: buildSmartButtons(safeDateReply, trips) || undefined,
      });
      return;
    }
  }
  {
    const groupReply = buildGroupSizeReply(await getFastPathText(), await getTrips());
    if (groupReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(sanitizeAssistantReply(groupReply), phoneAlreadyRequested),
        failTag: "group_size",
        rememberSource: "api.webhook.group_size",
        counter: "webhook.group_size_total",
        buttons: buildSmartButtons(groupReply, await getTrips()) || undefined,
      });
      return;
    }
  }
  if (hasSeatsIntent(intentText)) {
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
        buttons: buildSmartButtons(seatsReply, trips) || undefined,
      });
      return;
    }
  }
  if (hasBudgetIntent(intentText)) {
    const trips = await getTrips();
    const budgetReply = buildBudgetReply(await getFastPathText(), trips);
    if (budgetReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(budgetReply)),
          phoneAlreadyRequested,
        ),
        failTag: "budget_fast_path",
        catalogTripIds: tripsNamedIn(budgetReply, trips).map(trip => trip.id),
        rememberSource: "api.webhook.budget_fast_path",
        counter: "webhook.budget_fast_path_total",
        buttons: buildSmartButtons(budgetReply, trips) || undefined,
      });
      return;
    }
  }
  if (hasDiscountIntent(intentText)) {
    const trips = await getTrips();
    const discountReply = buildDiscountReply(await getFastPathText(), trips);
    if (discountReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(discountReply)),
          phoneAlreadyRequested,
        ),
        failTag: "discount_fast_path",
        catalogTripIds: tripsNamedIn(discountReply, trips).map(trip => trip.id),
        rememberSource: "api.webhook.discount_fast_path",
        counter: "webhook.discount_fast_path_total",
        buttons: buildSmartButtons(discountReply, trips) || undefined,
      });
      return;
    }
  }
  // A message that is only a price, pasted from an advert ("4,990,000", "5.89 сая"):
  // answer with the trips that have exactly that price. No exact match changes
  // nothing — it carries on to the other paths rather than being handed to staff.
  if (isBarePriceMessage(text)) {
    const trips = await getTrips();
    const barePriceReply = buildBarePriceReply(text, trips);
    if (barePriceReply) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(barePriceReply)),
          phoneAlreadyRequested,
        ),
        failTag: "bare_price_fast_path",
        catalogTripIds: tripsNamedIn(barePriceReply, trips).map(trip => trip.id),
        rememberSource: "api.webhook.bare_price_fast_path",
        counter: "webhook.bare_price_fast_path_total",
        buttons: buildSmartButtons(barePriceReply, trips) || undefined,
      });
      return;
    }
  }
  // Fast path: standalone price lookup ("1,111,111 гэсэн аялал аль вэ?").
  // Deterministic on purpose: a customer quoting a price and asking which
  // trip it is must never get a DIFFERENT trip's price stated back as if it
  // matched. When no trip's price matches, hand off rather than let the
  // model improvise a nearby-priced trip.
  if (hasStandalonePriceLookupIntent(intentText)) {
    const trips = await getTrips();
    const priceLookupReply = buildStandalonePriceLookupReply(await getFastPathText(), trips);
    await deliverFastPathReply({
      reply: priceLookupReply
        ? appendLeadCaptureCta(
            enforceWebsiteForPayment(sanitizeAssistantReply(priceLookupReply)),
            phoneAlreadyRequested,
          )
        : "REFER",
      failTag: "price_lookup_fast_path",
      catalogTripIds: priceLookupReply ? tripsNamedIn(priceLookupReply, trips).map(trip => trip.id) : undefined,
      rememberSource: "api.webhook.price_lookup_fast_path",
      counter: "webhook.price_lookup_fast_path_total",
      buttons: priceLookupReply ? (buildSmartButtons(priceLookupReply, trips) || undefined) : undefined,
    });
    return;
  }
  {
    const trips = await getTrips();
    const programFastPathText = await getFastPathText();
    // buildProgramOrStructuredReply already falls back to the structured
    // (price/date/duration) answer whenever the program path's only answer
    // would be pure "no photos" silence — covers every compound "zurag + X"
    // phrasing, not just ones containing hasPriceIntent's specific keyword
    // set (a bare "хэд төгрөг" price ask used to still fall through here).
    const programReply = buildProgramOrStructuredReply(programFastPathText, trips);
    if (programReply) {
      // A "which of these tours did you mean?" reply carries no media on
      // purpose. Inferring from its text would pick one of the trip names it
      // lists and attach that tour's poster — asking which tour while already
      // sending one tour's prices as an image.
      const inferredMediaUrls = programReply.brochure
        ? []
        : programReply.mediaUrls.length > 0
        ? programReply.mediaUrls
        : programReply.reply.includes(AMBIGUOUS_REPLY_MARKER)
          ? []
          : extractTripPhotosForReply(programReply.reply, trips, { userText: programFastPathText });
      const safeProgramReply = appendLeadCaptureCta(
        enforceWebsiteForPayment(
          sanitizeAssistantReply(
            reconcilePhotoAttachmentReply(programReply.reply, inferredMediaUrls.length > 0),
          ),
        ),
        phoneAlreadyRequested,
      );
      const programResolution = programReply.reply.includes(AMBIGUOUS_REPLY_MARKER)
        ? resolveTripFromUserMessage(programFastPathText, trips, { allowLooseFallback: false })
        : null;
      // Same reasoning as structured_clarify/structured_trip_fast_path below:
      // whatever list is actually shown must be what the next numbered/named
      // answer is checked against.
      if (programResolution?.status === "ambiguous") {
        await setClarificationState(senderId, programResolution.candidates.map((trip) => trip.id));
      }
      const programButtons =
        programResolution?.status === "ambiguous"
          ? buildClarificationButtons(programResolution.candidates)
          : buildSmartButtons(safeProgramReply, trips) || undefined;
      await deliverFastPathReply({
        reply: safeProgramReply,
        failTag: "program_fast_path",
        catalogTripIds: programResolution?.status === "ambiguous" ? programResolution.candidates.map(trip => trip.id) : undefined,
        rememberSource: "api.webhook.program_fast_path",
        counter: "webhook.program_fast_path_total",
        buttons: programButtons,
        afterDeliver: async () => {
          if (platform !== "facebook" || !token) return;
          const mediaPolicy = getReplyMediaPolicy(programFastPathText, safeProgramReply);
          if (!mediaPolicy.allowed) return;
          // The reply literally says "PDF хөтөлбөрийг хавсаргалаа", so the
          // brochure the program builder already resolved must be the one
          // sent. This used to fall through to sendTripMediaForReply, which
          // re-derives the brochure from the reply TEXT — so a reply about
          // the wrong trip attached that wrong trip's PDF, or (when the text
          // matched nothing) promised a PDF and sent nothing at all.
          if (programReply.brochure) {
            try {
              const sent =
                programReply.brochure.type === "id"
                  ? await sendFbFileAttachment(senderId, programReply.brochure.value, token)
                  : await sendFbFileByUrl(senderId, programReply.brochure.value, token);
              if (sent) {
                await recordFileMessage(senderId, programReply.brochure.value);
                recordCounter("webhook.program_pdf_sent_total", 1, { platform });
              } else {
                logWarn("webhook.program_pdf_send_failed", {
                  requestId: trace?.requestId,
                  correlationId: trace?.correlationId,
                  platform,
                  senderHash: hashIdentifier(senderId),
                  sourceType: programReply.brochure.type,
                });
              }
            } catch (error) {
              logWarn("webhook.program_pdf_send_failed", {
                requestId: trace?.requestId,
                correlationId: trace?.correlationId,
                platform,
                senderHash: hashIdentifier(senderId),
                sourceType: programReply.brochure.type,
                classification: classifyError(error),
              });
            }
            return;
          }
          if (programReply.mediaUrls.length > 0) {
            await sendPhotoAlbum(senderId, limitReplyPhotos(programReply.mediaUrls, mediaPolicy.photoLimit), token, trace);
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
    // The active catalogue has nothing to say — check whether the customer
    // actually named a tour that expired (every departure date passed) rather
    // than one we've simply never heard of, so they get told why, not silence.
    const archivedNotice = buildArchivedTripNotice(
      programFastPathText,
      await getArchivedTrips(),
    );
    if (archivedNotice) {
      await deliverFastPathReply({
        reply: appendLeadCaptureCta(
          enforceWebsiteForPayment(sanitizeAssistantReply(archivedNotice.reply)),
          phoneAlreadyRequested,
        ),
        failTag: "archived_trip_notice",
        rememberSource: "api.webhook.archived_trip_notice",
        counter: "webhook.archived_trip_notice_total",
      });
      return;
    }
    const structuredTripReply = buildStructuredTripReply(await getFastPathText(), trips);
    if (structuredTripReply) {
      const safeStructuredReply = appendLeadCaptureCta(
        enforceWebsiteForPayment(sanitizeAssistantReply(structuredTripReply)),
        phoneAlreadyRequested,
      );
      const structuredResolution = structuredTripReply.includes(AMBIGUOUS_REPLY_MARKER)
        ? resolveTripFromUserMessage(await getFastPathText(), trips, {
            allowLooseFallback: false,
          })
        : null;
      // This is the list the customer actually sees — remember it so a
      // numbered or named answer on the next turn resolves against it, the
      // same fix as structured_clarify and program_fast_path above (found
      // replaying 2026-10-08..11 chats: two customers answered a list from
      // this exact block and got silence).
      if (structuredResolution?.status === "ambiguous") {
        await setClarificationState(senderId, structuredResolution.candidates.map((trip) => trip.id));
      }
      // A "which trip?" list is checked line by line against the trips it names.
      // Checking it against only the routed trip rejected every other line, and
      // a park name got silence because a second trip also visits that park.
      if (structuredTripReply.includes(AMBIGUOUS_REPLY_MARKER) && factualScope) {
        factualScope = [...new Set([...factualScope, ...trips.filter((trip) => structuredTripReply.includes(trip.route_name))])];
      }
      await deliverFastPathReply({
        reply: safeStructuredReply,
        failTag: "structured_trip_fast_path",
        rememberSource: "api.webhook.trip_fast_path",
        counter: "webhook.trip_fast_path_total",
        buttons: structuredTripReply.includes(AMBIGUOUS_REPLY_MARKER)
          ? structuredResolution?.status === "ambiguous"
            ? buildClarificationButtons(structuredResolution.candidates)
            : undefined
          : buildSmartButtons(safeStructuredReply, trips) || undefined,
        afterDeliver: async () => {
          if (hasTripPhotoIntent(intentText)) {
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
    const understood = (routedCache as FastPathRoute | null)?.understanding;
    if (understood) return understood.trips.slice(0, 4).map((trip) => trip.route_name);
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
  // "Mimic Myself" toggle: off by default, adds nothing to the prompt when
  // disabled — toneExamples stays undefined and buildPromptParts is a no-op
  // for this option, preserving today's behavior exactly.
  const mimicMyselfEnabled =
    (botSettings.extra as Record<string, unknown> | undefined)?.mimic_myself_enabled === true;
  const toneExamples = mimicMyselfEnabled
    ? await dbGetRecentAdminMessages(8).catch(() => [])
    : undefined;
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
    toneExamples,
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
    let fallbackError = "";
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
      if (!fallbackText) fallbackError = "retry returned no text";
    } catch (retryError) {
      // fall through to the apology below
      fallbackError = retryError instanceof Error ? retryError.message : String(retryError);
    }
    logWarn("webhook.ai_fallback_reply", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      classification: classifyError(error),
      message: error instanceof Error ? error.message : String(error),
      openaiFallbackUsed: Boolean(fallbackText),
      fallbackError: fallbackError || undefined,
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
  // a staff handoff, pause the bot for this customer (never let it keep
  // guessing on the next message), and tell the customer a human is taking
  // over — same acknowledgement whether the cause was missing data or an AI
  // outage.
  const guardCandidateTrips = factualScope || reasoningTrips.filter((trip) => relevantTripNames.includes(trip.route_name));
  aiReply = guardInventedBookingTerms(aiReply, promptParts.user, guardCandidateTrips);
  if ((isReferReply(aiReply) || shouldSilenceNoDataReply(aiReply)) && isGenericTripRequest(text)) {
    // "Aylaluud", "Medeelel avay": no destination named, so the model had
    // nothing to look up and said REFER. Ask which trip rather than paging staff.
    // The question needs no model, so it is asked during an AI outage too (on 10-05/06
    // an empty OpenAI balance silenced dozens of "Medeelel" / "Асуулт асуух" openers).
    await deliverFastPathReply({
      reply: whichTripClarifyReply(text),
      failTag: "generic_trip_request_ai",
      rememberSource: "api.webhook.generic_trip_request_ai",
      counter: "webhook.generic_trip_request_total",
    });
    return;
  }
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
    await captureLead({
      kind: "handoff", contactPhone: detectedPhone || "",
      context: aiOutage ? "AI түр саатсан тул зөвлөхөд шилжүүлэв." : "Бот мэдээлэлгүй асуулт тул зөвлөхөд шилжүүлэв.",
    }, "api.webhook.ai_refer");
    await autoHandoffSender(senderId);
    const referPauseMs =
      botSettings.handoff_pause_minutes > 0
        ? botSettings.handoff_pause_minutes * 60_000
        : undefined;
    await pauseBot(senderId, referPauseMs, aiOutage ? "ai_outage" : "no_data_handoff");
    // Owner's rule: whether the model failed or simply does not know, the
    // customer gets NO message. The bot is paused (above) and staff got the lead
    // alert; the customer's message is already in history for whoever picks it up.
    // Logged as a warning so a "the bot ignored me" complaint can be traced to
    // this in the error log instead of guessed at.
    logWarn(aiOutage ? "webhook.ai_outage_customer_silenced" : "webhook.ai_refer_customer_silenced", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
    });
    recordCounter(aiOutage ? "webhook.ai_outage_silenced_total" : "webhook.ai_refer_silenced_total", 1, { platform });
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
  // Price guard: every ₮ figure in the reply must be a real, quotable price on
  // one of the trips this turn actually resolved to. Catches a base fare
  // quoted for a departure priced differently, or any invented amount,
  // regardless of which path (AI or fast path) produced it.
  const guardedReply = guardUnverifiedDates(
    guardUnverifiedPrices(
      enforcePaymentNeverSelfConfirmed(text, enforceWebsiteForPayment(rewrittenReply)),
      guardCandidateTrips,
    ),
    guardCandidateTrips,
    text,
  );
  const safeReply = verifyTripReply({ reply: presentAssistantReply({ reply: guardedReply, userText: text,
    hasPriorReply: history.some((message) => message.role === "assistant"), phoneAlreadyRequested,
  }), trips: guardCandidateTrips, selection: currentSelection });
  // Wrong-trip guard: the customer clearly asked about trip A but the model
  // answered with a DIFFERENT destination's price. Route to the same silent
  // handoff as a no-data reply rather than send a confident wrong answer.
  const wrongTripLeak = findWrongTripReference({
    replyText: safeReply,
    relevantTripNames,
    catalog: reasoningTrips,
  });
  // The price/date/fact guards above can turn a reply into REFER after the
  // model's own REFER was already handled, so check the token again here: four
  // customers were sent the bare word "REFER" (2026-10-06..07).
  // A refusal the guards silence counts too: "Can you tell me more about your ad?" got
  // "Уучлаарай, энэ талаар мэдээлэл өгөх боломжгүй…" (2026-10-18) instead of "which trip?".
  if ((isReferReply(safeReply) || shouldSilenceNoDataReply(safeReply)) && isGenericTripRequest(text)) {
    await deliverFastPathReply({
      reply: whichTripClarifyReply(text),
      failTag: "generic_trip_request_guarded",
      rememberSource: "api.webhook.generic_trip_request_guarded",
      counter: "webhook.generic_trip_request_total",
    });
    return;
  }
  const aiUngroundedTrip = isReferReply(safeReply) || shouldSilenceNoDataReply(safeReply) ? null : await findUngroundedTrip(safeReply);
  if (isReferReply(safeReply) || shouldSilenceNoDataReply(safeReply) || wrongTripLeak || aiUngroundedTrip) {
    if (aiUngroundedTrip) {
      logInfo("webhook.ai_ungrounded_trip_reply_suppressed", { requestId: trace?.requestId, correlationId: trace?.correlationId,
        platform, senderHash: hashIdentifier(senderId), tripId: aiUngroundedTrip.id });
      recordCounter("webhook.ungrounded_trip_reply_suppressed_total", 1, { path: "ai" });
    }
    if (wrongTripLeak) {
      logInfo("webhook.ai_wrong_trip_reply_suppressed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
        askedTrips: wrongTripLeak.relevantTripNames.join(" | "),
        offendingTrip: wrongTripLeak.offendingTripName,
      });
      recordCounter("webhook.ai_wrong_trip_reply_suppressed_total", 1, { platform });
    } else {
      logInfo("webhook.ai_no_data_reply_suppressed", {
        requestId: trace?.requestId,
        correlationId: trace?.correlationId,
        platform,
        senderHash: hashIdentifier(senderId),
      });
      recordCounter("webhook.ai_no_data_reply_suppressed_total", 1, { platform });
    }
    await captureLead({
      kind: "handoff", contactPhone: detectedPhone || "",
      context: wrongTripLeak
        ? `AI өөр аяллын (${wrongTripLeak.offendingTripName}) хариу өгөх гэсэн тул хэрэглэгчид илгээлгүй зөвлөхөд шилжүүлэв.`
        : "AI мэдээлэлгүй өгүүлбэр бичсэн тул зөвлөхөд шилжүүлж, хэрэглэгчид хариу илгээсэнгүй.",
    }, "api.webhook.ai_no_data_handoff");
    await autoHandoffSender(senderId);
    const suppressedPauseMs =
      botSettings.handoff_pause_minutes > 0
        ? botSettings.handoff_pause_minutes * 60_000
        : undefined;
    await pauseBot(
      senderId,
      suppressedPauseMs,
      wrongTripLeak ? "wrong_trip_handoff" : "no_data_handoff",
    );
    // Silent: a reply the guards suppressed (no data / another trip's facts) is
    // never replaced by a notice to the customer. Lead + alert + pause are above.
    logWarn("webhook.ai_no_data_customer_silenced", {
      requestId: trace?.requestId,
      correlationId: trace?.correlationId,
      platform,
      senderHash: hashIdentifier(senderId),
      reason: wrongTripLeak ? "wrong_trip" : "no_data",
    });
    return;
  }
  recordReplyPresentation({ reply: safeReply, userText: text, path: "webhook_ai", latencyMs: Date.now() - replyStartedAt });
  let replyButtons: string[] = [...aiButtons];
  if (platform === "facebook") {
    try {
      // Reuse the catalog already loaded this request instead of re-querying the
      // whole trip table from the DB just to build buttons.
      const tripsForButtons = await getTrips();
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
  if (token && replyButtons.length > 0) {
    try {
      if (platform === "facebook") {
        await sendQuickReplies(senderId, safeReply, replyButtons, token, {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          deliveryKey: trace?.deliveryKey,
          source: "api.webhook.reply_buttons",
        });
      } else {
        await sendIgQuickReplies(igUserId || "", senderId, safeReply, replyButtons, token, {
          requestId: trace?.requestId,
          correlationId: trace?.correlationId,
          deliveryKey: trace?.deliveryKey,
          source: "api.webhook.reply_buttons",
        });
      }
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
  recordPrimaryReplyDelivery({ path: "webhook_ai", accepted: delivered, latencyMs: Date.now() - replyStartedAt });
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
  if (pauseAfterContactCapture) await pauseBookedCustomer(senderId);
}
async function processConversationWithPendingQueue(
  conversationKey: string,
  initial: PendingConversationPayload,
  lockToken: string | null,
  initialHead: PendingConversationHead | null = null,
  checkpoint?: { eventKey: string; complete: () => Promise<void> },
) {
  addActiveConversation(conversationKey);
  updateConcurrencyGauges();
  try {
    // The page access token is deliberately stripped before a payload is
    // persisted to the pending queue/Redis (never store a secret there), so a
    // drained message comes back with token: null. Re-derive it from pageId
    // the same way the initial handler does — it's a cheap in-memory lookup,
    // not the queued value.
    let current = { ...initial, token: initial.token ?? PAGE_TOKENS.get(initial.pageId) ?? FALLBACK_TOKEN };
    let head = initialHead;
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
        throw new RetryableWebhookError("conversation_lock_lost");
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
              deliveryKey: current.eventKey,
            },
            ensureLockHealthy,
          ),
      );
      if (head && !(await acknowledgePendingConversationConsistent(conversationKey, head))) {
        throw new RetryableWebhookError("pending_ack_mismatch");
      }
      if (checkpoint && current.eventKey === checkpoint.eventKey) await checkpoint.complete();
      const pending = await peekPendingConversationConsistent(conversationKey);
      if (!pending) break;
      current = { ...pending.payload, token: pending.payload.token ?? PAGE_TOKENS.get(pending.payload.pageId) ?? FALLBACK_TOKEN };
      head = pending;
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
      if (isMetaOutboundDisabled()) {
        logInfo("webhook.disabled", {
          requestId: trace.requestId,
          correlationId: trace.correlationId,
        });
        return res.status(200).json({ ok: true, botDisabled: true });
      }

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
                app_id?: number | string;
                mid?: string;
                text?: string;
                quick_reply?: { payload?: string };
                metadata?: string;
                attachments?: Array<{ type?: string; payload?: { url?: string } }>;
              };
              postback?: { title?: string; payload?: string };
              referral?: Record<string, unknown>;
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
                  const operatorPauseMs = AUTO_PAUSE_RESET_DAYS * 24 * 60 * 60 * 1000;
                  // Was previously `.catch(() => {})` — a failed pause write
                  // was invisible, and the bot would just keep answering a
                  // customer staff already took over with no error anywhere.
                  await dbPauseSender(customerId, operatorPauseMs, "operator_reply").catch(
                    (error) => {
                      logWarn("webhook.operator_echo_pause_failed", {
                        requestId: trace.requestId,
                        customerHash: hashIdentifier(customerId),
                        pageId,
                        classification: classifyError(error),
                        message: error instanceof Error ? error.message : String(error),
                      });
                    },
                  );
                  // "Mimic Myself" tone capture — captured unconditionally on every
                  // human operator reply, regardless of the toggle (only the PROMPT
                  // USE of these samples is gated by mimic_myself_enabled below).
                  // This keeps the sample pool warm before an admin ever opts in.
                  // Fire-and-forget: must never delay the webhook response.
                  const operatorText = String(event.message.text ?? "").trim();
                  if (operatorText.length >= 8) {
                    void dbAppendAdminMessage(customerId, operatorText).catch(() => {});
                  }
                  // Diagnostic: attachment types on operator echoes are logged
                  // so a report of "the bot kept answering after I sent a voice
                  // note from the Page" can be checked against what Meta
                  // actually sent, instead of guessing. Cheap — only runs on
                  // human-sent echoes, which are low-volume.
                  const echoAttachmentTypes = Array.isArray(event.message?.attachments)
                    ? event.message.attachments.map((a) => a?.type || "unknown")
                    : [];
                  // appId identifies WHO sent it (Page inbox / Business Suite /
                  // an automation / another app) — the field to check when a
                  // pause looks like it was triggered by something that is not
                  // a person typing.
                  logInfo("webhook.operator_echo_pause", {
                    requestId: trace.requestId,
                    customerHash: hashIdentifier(customerId),
                    pageId,
                    appId: event.message.app_id ?? null,
                    hasText: operatorText.length > 0,
                    attachmentTypes: echoAttachmentTypes,
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
              // A chat opened from a post's "Send message" button names the ad that
              // opened it; the trip it is about becomes the selected trip so a first
              // "1" or "vne" is not guessed. Never blocks or fails the reply.
              const adReferral = pickReferral(event);
              if (adReferral && senderId) {
                await rememberAdReferral({
                  senderId, platform: payload.object === "instagram" ? "instagram" : "facebook", referral: adReferral,
                  trips: await listTrips({ limit: 5000 }).catch(() => []), pageToken: PAGE_TOKENS.get(pageId) ?? FALLBACK_TOKEN,
                });
              }
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
              // A tapped quick reply: the payload is our full label; the text is
              // Messenger's 20-character title ("1. <name cut off>...").
              const quickReplyPayload =
                typeof event?.message?.quick_reply?.payload === "string"
                  ? event.message.quick_reply.payload.trim()
                  : "";
              const messageText =
                quickReplyPayload ||
                (typeof event?.message?.text === "string" ? event.message.text.trim() : "");
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
              // Staff see the customer's name, also for photo- or voice-only senders.
              if (platform === "facebook") rememberSenderName(senderId, pageId);
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
              // Get Started tap: Meta's own automated response already greets
              // the customer, so the bot says nothing and waits for a real
              // message. Only the tap time is recorded (not counted as a
              // message) so the first real message still gets the welcome flow
              // and a "hi" typed right after is not greeted a second time.
              if ((!messageText && isGetStartedPostback(event?.postback)) || isGetStartedText(messageText)) {
                await runEventWithClaim(
                  eventKey,
                  { platform, eventType: "dm" },
                  async () => {
                    try {
                      await markGetStarted(senderId, platform);
                    } catch (error) {
                      logWarn("webhook.get_started_mark_failed", {
                        requestId: trace.requestId,
                        correlationId: trace.correlationId,
                        platform,
                        senderHash: hashIdentifier(senderId),
                        classification: classifyError(error),
                      });
                    }
                    logInfo("webhook.get_started_silent", {
                      requestId: trace.requestId,
                      correlationId: trace.correlationId,
                      platform,
                      senderHash: hashIdentifier(senderId),
                    });
                  },
                );
                continue;
              }
              await runEventWithClaim(
                eventKey,
                { platform, eventType: "dm" },
                async (completeEvent) => {
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
                    eventKey,
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
                  let transferredLock = false;
                  try {
                    const pendingBefore = await peekPendingConversationConsistent(
                      conversationKey,
                    );
                    if (pendingBefore) {
                      await enqueuePendingConversationConsistent(conversationKey, payloadForConversation);
                      initialPayload = pendingBefore.payload;
                    }
                    transferredLock = true;
                    await processConversationWithPendingQueue(
                      conversationKey, initialPayload, lockToken, pendingBefore,
                      { eventKey, complete: completeEvent },
                    );
                  } finally {
                    if (!transferredLock) await releaseConversationLockConsistent(conversationKey, lockToken);
                  }
                },
                async () => {
                  const conversationKey = `${platform}:${pageId}:${senderId}`;
                  const lockToken = await acquireConversationLockConsistent(conversationKey);
                  if (lockToken === "") return;
                  let transferredLock = false;
                  try {
                    const pending = await peekPendingConversationConsistent(conversationKey);
                    if (!pending) return;
                    transferredLock = true;
                    await processConversationWithPendingQueue(conversationKey, pending.payload, lockToken, pending);
                  } finally {
                    if (!transferredLock) await releaseConversationLockConsistent(conversationKey, lockToken);
                  }
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
