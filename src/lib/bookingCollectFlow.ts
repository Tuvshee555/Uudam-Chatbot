/**
 * Webhook side of the booking collector (bookingCollect.ts holds the pure
 * rules): starting the flow on "Захиалах", validating each answer, and on
 * completion creating the lead, alerting staff and handing the chat to a
 * human. Extracted from webhook.ts, which is over the 2,000-line cap.
 */

import {
  BOOKING_ALREADY_RECEIVED_REPLY,
  advanceCollectState,
  buildCompletionMessage,
  buildLeadContext,
  clearCollectState,
  getCollectState,
  promptForStep,
  setCollectState,
  startCollectState,
} from "./bookingCollect";
import { appendMessage } from "./conversation";
import { classifyError, hashIdentifier, logWarn, recordCounter } from "./observability";
import { autoHandoffSender, pauseBot } from "./pause";
import { notifyStaffOfLead } from "./staffAlerts";
import { createLead, dbStoreSenderName, hasRecentOpenLead, listTrips } from "./travelOps";
import { resolveTripFromUserMessage, sanitizeTripForCustomers } from "./travelFastPaths";
import type { TravelTrip } from "./travelTypes";
import { extractPhoneNumber, isBookingIntent, normalizeLowerText } from "./webhookMedia";
import type { Platform } from "./webhookDedup";

export type BookingCollectContext = {
  platform: Platform;
  senderId: string;
  text: string;
  /** The conversation-aware text (previous reply + this message), used to pre-fill the trip. */
  contextualUserText: string;
  /** Pause applied once the booking is handed to staff; undefined = default. */
  pauseMs?: number;
  /** Delivers a message; must throw when delivery fails so Meta retries. */
  send: (message: string, tag: string) => Promise<void>;
  trace?: { requestId?: string; correlationId?: string };
};

async function loadTrips(): Promise<TravelTrip[]> {
  return (await listTrips({ limit: 5000 })).map(sanitizeTripForCustomers);
}

function verifiedTripName(text: string, trips: TravelTrip[]): string {
  if (!text.trim()) return "";
  const resolution = resolveTripFromUserMessage(text, trips, { allowLooseFallback: false });
  return resolution.status === "verified" ? resolution.trip.route_name : "";
}

// Words a bare "book it" message is made of ("Захиалах", "zahialga hiie",
// "захиалга өгмөөр байна") — nothing that names a trip or asks a question.
const BARE_BOOKING_WORD =
  /^(захиал\S*|zahial\S*|бүртгүүл\S*|burtguul\S*|book\S*|хий\S*|hii\S*|өг\S*|ug\S*|ав\S*|av\S*|aw\S*|байна|бна|bna|bnaa|уу|юу|вэ|би|bi|за|za|zaa|тэгье|tegye|хүсэж|husej|hvsej|байгаа|bga|юм|шүү|болох|bolom\S*|боломж\S*)$/;

export function isBareBookingRequest(text: string): boolean {
  const tokens = normalizeLowerText(text).split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((token) => BARE_BOOKING_WORD.test(token));
}

/**
 * "Захиалах" / "zahialga hiie": start collecting name + phone, pre-filling the
 * trip the customer was looking at. Returns true when a reply was sent.
 */
export async function startBookingCollect(ctx: BookingCollectContext): Promise<boolean> {
  if (!isBookingIntent(ctx.text)) return false;
  if (await hasRecentOpenLead(ctx.senderId, "booking")) {
    // Already with staff. A bare repeat gets a short confirmation instead of
    // being run through the trip matchers (it came back as a random <city>
    // list); anything more than that is answered normally.
    if (!isBareBookingRequest(ctx.text)) return false;
    await appendMessage(ctx.senderId, "user", ctx.text).catch(() => {});
    await ctx.send(BOOKING_ALREADY_RECEIVED_REPLY, "booking_already_received");
    await appendMessage(ctx.senderId, "assistant", BOOKING_ALREADY_RECEIVED_REPLY).catch(() => {});
    return true;
  }
  const trips = await loadTrips();
  const trip = verifiedTripName(ctx.text, trips) || verifiedTripName(ctx.contextualUserText, trips);
  const state = startCollectState(ctx.text, trip);
  await setCollectState(ctx.senderId, state);
  const prompt = promptForStep(state.step, state);
  await appendMessage(ctx.senderId, "user", ctx.text).catch(() => {});
  await ctx.send(prompt, "booking_collect_start");
  await appendMessage(ctx.senderId, "assistant", prompt).catch(() => {});
  recordCounter("webhook.booking_collect_started_total", 1, { platform: ctx.platform, tripKnown: String(Boolean(trip)) });
  return true;
}

/**
 * A booking flow is in progress: take this message as the next answer, or —
 * when it is not an answer (a new question, a button tap) — abandon the flow
 * and return false so the message is answered normally.
 */
export async function continueBookingCollect(ctx: BookingCollectContext): Promise<boolean> {
  const state = await getCollectState(ctx.senderId);
  if (!state || state.step === "done") return false;
  const trips = await loadTrips();
  const answer = state.step === "trip" ? verifiedTripName(ctx.text, trips) || ctx.text : ctx.text;
  const result = advanceCollectState(state, answer, extractPhoneNumber(ctx.text), {
    looksLikeTrip: (text) =>
      resolveTripFromUserMessage(text, trips, { allowLooseFallback: false }).status !== "not_found",
  });

  if (result.kind === "abandon") {
    await clearCollectState(ctx.senderId);
    recordCounter("webhook.booking_collect_abandoned_total", 1, { platform: ctx.platform, step: state.step });
    return false;
  }
  await appendMessage(ctx.senderId, "user", ctx.text).catch(() => {});
  if (result.kind === "ask") {
    await setCollectState(ctx.senderId, result.state);
    await ctx.send(result.prompt, "booking_collect_step");
    await appendMessage(ctx.senderId, "assistant", result.prompt).catch(() => {});
    return true;
  }

  const done = result.state;
  await clearCollectState(ctx.senderId);
  // The ONLY place a chat message becomes the stored customer name: a
  // validated answer to "нэрээ бичнэ үү".
  if (done.name.trim()) await dbStoreSenderName(ctx.senderId, done.name.trim()).catch(() => {});
  await autoHandoffSender(ctx.senderId);
  await pauseBot(ctx.senderId, ctx.pauseMs, "handoff");
  try {
    await createLead({
      kind: "booking",
      platform: ctx.platform,
      senderId: ctx.senderId,
      customerMessage: done.originalMessage,
      contactPhone: done.phone,
      context: buildLeadContext(done),
    });
    await notifyStaffOfLead(
      {
        kind: "booking",
        platform: ctx.platform,
        customerMessage: [done.name, done.phone, done.trip].filter(Boolean).join(" | "),
        contactPhone: done.phone,
      },
      { requestId: ctx.trace?.requestId, correlationId: ctx.trace?.correlationId, source: "api.webhook" },
    );
    recordCounter("webhook.booking_collect_completed_total", 1, { platform: ctx.platform });
  } catch (error) {
    logWarn("webhook.booking_collect_lead_failed", {
      requestId: ctx.trace?.requestId,
      correlationId: ctx.trace?.correlationId,
      platform: ctx.platform,
      senderHash: hashIdentifier(ctx.senderId),
      classification: classifyError(error),
    });
  }
  const completion = buildCompletionMessage(done);
  await ctx.send(completion, "booking_collect_done");
  await appendMessage(ctx.senderId, "assistant", completion).catch(() => {});
  return true;
}
