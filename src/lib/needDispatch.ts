/**
 * What the webhook does once the customer's NEED is known (messageNeed.ts), before any trip is
 * looked up. No model call is made here, so a billing outage cannot reach it.
 *
 *  social              thanks / praise: one warm line. A bare acknowledgement or farewell: silence, no lead.
 *  business_group      the corporate catalogue file (webhook catalogue step); otherwise a typed lead and silence.
 *  commercial_policy   a typed staff lead and silence (no data, no answer).
 *  transport_only      the same.
 *  existing_booking    the lead's real status when a booking lead exists, otherwise a typed lead and silence;
 *                      never the booking collector's phone ask.
 *  complaint           the existing hand-off branch (the webhook passes it in).
 *
 * Every customer-facing line leaves through the webhook's deliverFastPathReply; "silence" sends nothing.
 */
import type { TravelLead, TravelTrip } from "./travelTypes";
import { appendMessage } from "./conversation";
import { latestCustomerLead, recordLeadFollowup } from "./travelLeadsDb";
import { bookedStatusTurn, followupLeadLine } from "./bookedFollowup";
import { hashIdentifier, logInfo, recordCounter } from "./observability";
import { noteInbound } from "./inboundTrace";
import { PRAISE_REPLY, THANKS_REPLY } from "./greetingPhrases";
import { hasBankAccountRequest, hasPaymentClaimIntent } from "./reply";
import { buildGroupInquiryReply } from "./groupInquiry";
import { commercialSignalCovered, socialKindOfText, type MessageNeed, type MessageNeedResult, type NeedConstraints } from "./messageNeed";
import { getAliases } from "./travelFastPathsSearch";
import { GENERIC_ROUTE_WORDS, normText, phoneticLatinText } from "./travelTextNorm";

export const NEED_TAG = (need: MessageNeed | string) => `[need:${need}]`;

/**
 * NEED_MODEL: "observe" (default) only logs the need the understanding call proposed (webhook.need_observed),
 * "enforce" lets a validated model-sourced need act exactly like a rule need, "off" ignores it.
 */
export function needModelMode(): "off" | "observe" | "enforce" {
  const value = (process.env.NEED_MODEL || "observe").toLowerCase();
  return value === "off" || value === "enforce" ? value : "observe";
}

export type NeedSource = "rule" | "model";

export type NeedDispatchInput = {
  hit: MessageNeedResult;
  source: NeedSource;
  text: string;
  senderId: string;
  platform: string;
  lastBotReply: string | null;
  trace?: { requestId?: string; correlationId?: string };
  /** The webhook's deliverFastPathReply. */
  deliver: (input: { reply: string; failTag: string; rememberSource: string; counter?: string }) => Promise<boolean>;
  /** The webhook's captureLead (ensureDurableLead: throws when the lead cannot be persisted). */
  captureLead: (input: { kind: "handoff" | "booking"; context?: string }) => Promise<{ created: boolean; lead: TravelLead | null }>;
  /**
   * The existing hand-off branch (confirmation, pause), for a complaint. Absent when the page has hand-off
   * switched off: the complaint then becomes a typed staff lead and silence, never a trip answer.
   */
  handoff?: (context: string) => Promise<void>;
  /** Active catalogue, only read to recognise the destination words a customer typed. */
  trips: () => Promise<TravelTrip[]>;
  /** What the owner entered as offers, discount policies and FAQ (commercialFacts.ts): when it covers the asked term, the gate steps aside. */
  configuredFacts?: string;
};

const STATUS_QUESTION = /баталгаажс|баталгаажл|баталгаажуулс|юу\s+болсон|яасан|хаана\s+явна|төлөв|batalgaajs|yu\s+bolson/iu;

/** Destination words from the catalogue (aliases, destinations, name words) that the customer typed, as typed. */
export function catalogPlaceWordsIn(text: string, trips: TravelTrip[]): string[] {
  const known = new Set<string>();
  for (const trip of trips) {
    const destinations = Array.isArray(trip.extra?.destinations) ? trip.extra.destinations.filter((city): city is string => typeof city === "string") : [];
    for (const source of [...getAliases(trip), ...destinations, trip.route_name]) {
      for (const word of phoneticLatinText(source).split(" ")) {
        if (word.length >= 4 && !GENERIC_ROUTE_WORDS.has(word)) known.add(word);
      }
    }
  }
  const found: string[] = [];
  for (const word of normText(text).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/)) {
    const phonetic = phoneticLatinText(word);
    if (word.length >= 4 && known.has(phonetic) && !found.includes(word)) found.push(word);
  }
  return found.slice(0, 3);
}

/** The lead's first line: machine-readable class and constraints, then what the customer wrote. */
export function typedLeadContext(need: MessageNeed | string, constraints: NeedConstraints, text: string, source: NeedSource = "rule"): string {
  const lines = [`${NEED_TAG(need)}${source === "model" ? " (model)" : ""}`];
  if (constraints.groupSize) lines.push(`Хүний тоо: ${constraints.groupSize}`);
  if (constraints.destinationWords?.length) lines.push(`Чиглэл: ${constraints.destinationWords.join(", ")}`);
  if (constraints.month) lines.push(`Сар: ${constraints.month}`);
  if (constraints.period) lines.push(`Хугацаа: ${constraints.period}`);
  lines.push(`Хэрэглэгчийн бичсэн: ${text.replace(/\s+/g, " ").trim().slice(0, 600)}`);
  return lines.join("\n");
}

/**
 * Staff must hold this message: a new typed lead, or, when an open lead already exists, the message
 * added to it (it used to be dropped). Returns whether staff have a lead for this customer.
 * `captureLead` throws when nothing could be persisted; callers that must not lose the customer
 * (silence) let that propagate so Meta redelivers, the group inquiry catches it.
 */
async function holdForStaff(input: NeedDispatchInput, constraints: NeedConstraints, options: { catchFailure: boolean }): Promise<boolean> {
  const context = typedLeadContext(input.hit.need, constraints, input.text, input.source);
  let result: { created: boolean; lead: TravelLead | null };
  try {
    result = await input.captureLead({ kind: "handoff", context });
  } catch (error) {
    if (!options.catchFailure) throw error;
    return false;
  }
  if (result.created) return true;
  // An open lead exists: the new message goes onto it, and the lead goes back to unread.
  const open = await latestCustomerLead(input.senderId).catch(() => null);
  if (!open) return false;
  await recordLeadFollowup(open.id, followupLeadLine(input.text, undefined, `${NEED_TAG(input.hit.need)} Шинэ мессеж`)).catch(() => false);
  return true;
}

function silent(input: NeedDispatchInput, reason: string) {
  noteInbound((outcome) => { outcome.silent = reason; });
  recordCounter("webhook.need_silent_total", 1, { need: input.hit.need });
}

export async function dispatchNeed(input: NeedDispatchInput): Promise<boolean> {
  const { hit, text, senderId } = input;
  // A payment claim or a bank-account request has its own fixed reply, lead and pause (webhook.ts).
  if (hasPaymentClaimIntent(text) || hasBankAccountRequest(text)) return false;
  const base = { requestId: input.trace?.requestId, correlationId: input.trace?.correlationId, platform: input.platform, senderHash: hashIdentifier(senderId) };
  // "No data, no answer" applies only when there is no data: a barter / contract / instalment / discount term the owner
  // wrote in the admin is answered from it by the ordinary path (and the output guard checks the claim against it).
  if (hit.need === "commercial_policy" && input.configuredFacts && commercialSignalCovered(hit.signals, input.configuredFacts)) {
    logInfo("webhook.need_data_covers", { ...base, need: hit.need, signals: hit.signals });
    return false;
  }
  const classified = () => {
    logInfo("webhook.need_classified", { ...base, need: hit.need, source: input.source, signals: hit.signals, ...(hit.social ? { social: hit.social } : {}) });
    recordCounter("webhook.need_classified_total", 1, { need: hit.need, source: input.source });
  };

  if (hit.need === "complaint") {
    classified();
    if (input.handoff) {
      await input.handoff(typedLeadContext("complaint", hit.constraints, text, input.source));
      return true;
    }
    await appendMessage(senderId, "user", text).catch(() => {});
    await holdForStaff(input, hit.constraints, { catchFailure: false });
    silent(input, "need:complaint");
    return true;
  }

  if (hit.need === "social") {
    classified();
    await appendMessage(senderId, "user", text).catch(() => {});
    const kind = hit.social ?? socialKindOfText(text);
    if (kind === "thanks" || kind === "praise") {
      await input.deliver({ reply: kind === "thanks" ? THANKS_REPLY : PRAISE_REPLY, failTag: "need_social", rememberSource: "api.webhook.need_social", counter: "webhook.need_social_total" });
    } else {
      silent(input, `need:social_${kind}`);
    }
    return true;
  }

  if (hit.need === "business_group") {
    // The customer's answer to the question the bot just asked: it goes onto the open inquiry lead, nothing more is sent.
    if (hit.signals.includes("inquiry_answer")) {
      const open = await latestCustomerLead(senderId, 1).catch(() => null);
      if (!open || !open.context.startsWith(NEED_TAG("business_group"))) return false;
      classified();
      await appendMessage(senderId, "user", text).catch(() => {});
      await recordLeadFollowup(open.id, followupLeadLine(text, undefined, `${NEED_TAG("business_group")} Хариулт`)).catch(() => false);
      silent(input, "need:business_group_answer");
      return true;
    }
    classified();
    await appendMessage(senderId, "user", text).catch(() => {});
    const catalogWords = await input.trips().then((trips) => catalogPlaceWordsIn(text, trips)).catch(() => [] as string[]);
    const constraints: NeedConstraints = { ...hit.constraints, destinationWords: [...new Set([...(hit.constraints.destinationWords ?? []), ...catalogWords])].slice(0, 4) };
    if (!constraints.destinationWords?.length) delete constraints.destinationWords;
    // Owner decision 2026-11-11: a group ask is answered with the corporate catalogue file (webhook.ts runs the
    // catalogue step first, with groupNeed). One the catalogue does not take (a named trip, a trip under
    // discussion) is something the bot does not know: silence, and a typed lead carrying the group's details.
    await holdForStaff({ ...input, hit: { ...hit, constraints } }, constraints, { catchFailure: true });
    silent(input, "need:business_group");
    return true;
  }

  if (hit.need === "existing_booking") {
    classified();
    await appendMessage(senderId, "user", text).catch(() => {});
    const lead = await latestCustomerLead(senderId).catch(() => null);
    // A booking this bot took: the status is the lead's own (never a confirmation or a call time).
    if (lead?.kind === "booking" && (hit.signals.includes("status_question") || STATUS_QUESTION.test(text))) {
      const recorded = await recordLeadFollowup(lead.id, followupLeadLine(text, undefined, "Захиалгын төлөв асуусан")).catch(() => false);
      const reply = recorded ? bookedStatusTurn(lead, input.lastBotReply ?? undefined) : null;
      if (reply) {
        await input.deliver({ reply, failTag: "booked_followup", rememberSource: "api.webhook.booked_followup", counter: "webhook.booked_followup_total" });
      } else {
        silent(input, recorded ? "need:existing_booking_repeat" : "need:existing_booking_unrecorded");
      }
      return true;
    }
    await holdForStaff(input, hit.constraints, { catchFailure: false });
    silent(input, "need:existing_booking");
    return true;
  }

  // commercial_policy, transport_only: nothing in the data answers; staff do, the customer hears nothing.
  classified();
  await appendMessage(senderId, "user", text).catch(() => {});
  await holdForStaff(input, hit.constraints, { catchFailure: false });
  silent(input, `need:${hit.need}`);
  return true;
}
