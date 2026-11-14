/**
 * The webhook's exit hook for the owner's 2026-11-12 request (nextQuestion.ts, followUp.ts): a trip
 * answer that would end without asking anything gets one next question after a blank line, and the
 * reply arms (or clears) the one follow-up sent if the customer then leaves it on seen.
 *
 * Only trip answers (by the exit's failTag) are touched. Never: contact numbers, an address, a phone
 * acknowledgement, a hand-off, the booking collector, payment, an outage notice, thanks, a file or
 * sticker acknowledgement, the catalogue PDF, the need gate's replies, sold-out / ended-trip notices
 * (they list their own options), a no-data silence (nothing is sent), and never a customer a
 * consultant owns or handled in the last 30 days (dbHasRecentStaffMessage, as dateMiss.ts), one
 * waiting for a consultant after booking, or one who just left a phone number.
 *
 * Nothing here can fail a turn: any error leaves the reply as it was and the follow-up unarmed.
 */
import { getClarificationState } from "./clarificationState";
import { getConstraintLedger } from "./constraintLedger";
import { armFollowUp } from "./followUp";
import { appendNextQuestion, nextQuestion, phoneInvite, replyAsksSomething, type NextQuestion } from "./nextQuestion";
import { recordCounter } from "./observability";
import { getTripSelection } from "./tripSelectionState";
import type { TravelTrip } from "./travelTypes";
import { extractPhoneNumber } from "./webhookMedia";

/** Trip answers: a question may be added, and the answer may be followed up. */
const TRIP_ANSWER_TAGS: ReadonlySet<string> = new Set([
  "answer_plan", "structured_trip_fast_path", "program_fast_path", "date_availability_reply", "date_not_scheduled",
  "catalog_listing", "scoped_clarify", "structured_clarify", "group_size", "seats_fast_path", "budget_fast_path",
  "discount_fast_path", "bare_price_fast_path", "price_lookup_fast_path", "compare_fast_path", "weather_fast_path",
  "weather_place",
]);
/**
 * Nothing is added, but the reply may be followed up: the bot's own "which trip?" questions, and the
 * model's free-text answer (its kind — a trip, a visa, an owner-entered barter term — is not known
 * from a tag, so its text is never extended; the follow-up's own rules still read the customer's need).
 */
const FOLLOW_ONLY_TAGS: ReadonlySet<string> = new Set(["generic_trip_request", "generic_trip_request_ai", "generic_trip_request_guarded", "model_reply"]);

export function nextQuestionDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:off|false|0|no)$/i.test(String(env.NEXT_QUESTION ?? "").trim());
}

/** Off switch for the phone ask alone (PHONE_INVITE=off). */
export function phoneInviteDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:off|false|0|no)$/i.test(String(env.PHONE_INVITE ?? "").trim());
}

export type ReplyQuestionInput = {
  senderId: string;
  platform: string;
  failTag: string;
  /** The answer as it would be sent (after every check). */
  reply: string;
  /** answer_plan only: the decision's outcome. */
  decisionOutcome?: "answered" | "clarify" | "handoff";
  customerText: string;
  history: Array<{ role: string; text: string }>;
  trips: () => Promise<TravelTrip[]>;
  /** A consultant wrote to this customer in the last 30 days (dbHasRecentStaffMessage). */
  isExistingCustomer: () => Promise<boolean>;
  /** The customer is waiting for a consultant (booking marker) or left a phone number this turn. */
  staffOwned?: boolean;
};

export type ReplyQuestionPlan = { reply: string; followUp: NextQuestion | null };

export async function planReplyQuestion(input: ReplyQuestionInput): Promise<ReplyQuestionPlan> {
  const unchanged = { reply: input.reply, followUp: null };
  const appendable = TRIP_ANSWER_TAGS.has(input.failTag) && (input.failTag !== "answer_plan" || input.decisionOutcome === "answered");
  const followable = appendable || FOLLOW_ONLY_TAGS.has(input.failTag) || (input.failTag === "answer_plan" && input.decisionOutcome === "clarify");
  if (!followable || input.staffOwned || nextQuestionDisabledByEnv()) return unchanged;
  try {
    // Fail closed: an unreadable history is not proof the customer is new.
    if (await input.isExistingCustomer().catch(() => true)) return unchanged;
    const [selection, pending, ledger, trips] = await Promise.all([
      getTripSelection(input.senderId), getClarificationState(input.senderId), getConstraintLedger(input.senderId), input.trips(),
    ]);
    const base = {
      history: input.history, customerText: input.customerText, selection, ledger, trips,
      pendingTripIds: pending?.candidateTripIds || [],
      phoneKnown: Boolean(extractPhoneNumber(input.customerText)) || input.history.some((message) => message.role === "user" && Boolean(extractPhoneNumber(message.text))),
      previousBotText: input.history.findLast((message) => message.role === "assistant")?.text ?? null,
    };
    let reply = input.reply;
    let appended: NextQuestion | null = null;
    if (appendable && !replyAsksSomething(reply)) {
      const question = nextQuestion({ ...base, purpose: "reply", reply });
      if (question) {
        reply = appendNextQuestion(reply, question);
        appended = question;
        recordCounter("reply_question.appended_total", 1, { slot: question.slot, path: input.failTag });
      }
    }
    // The phone (and the party, when unknown) is asked beside the answer's own question (owner, 2026-11-14).
    if (appendable && !phoneInviteDisabledByEnv()) {
      const invite = phoneInvite({ ...base, purpose: "reply", reply: input.reply }, appended);
      if (invite) {
        reply = appendNextQuestion(reply, invite);
        recordCounter("reply_question.phone_invite_total", 1, { path: input.failTag });
      }
    }
    // Facebook only: Instagram's send path has no takeover guard and no thread check.
    const followUp = input.platform === "facebook" && !input.senderId.startsWith("demo:")
      ? nextQuestion({ ...base, purpose: "follow_up", reply }) : null;
    return { reply, followUp };
  } catch {
    return unchanged;
  }
}

/** After the reply was delivered and stored: arm the follow-up, or clear an older one. Never throws. */
export async function settleFollowUp(senderId: string, plan: ReplyQuestionPlan | null): Promise<void> {
  await armFollowUp(senderId, plan?.followUp ?? null).catch(() => {});
}
