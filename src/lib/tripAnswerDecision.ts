import type { TripAnswerPlan } from "./tripAnswerPlan";
import { presentAssistantReply } from "./chatbotReplyPolicy";
import { EMPTY_REPLY_FALLBACK, enforceWebsiteForPayment, isReferReply, sanitizeAssistantReply } from "./reply";

export type TripAnswerDecision = {
  outcome: "answered" | "clarify" | "handoff";
  reply: string;
  plan: TripAnswerPlan;
  missingFacts: string[];
};

/** Nothing of the plan's text survived presentation: the cleaner's stand-in line, not an answer. */
const isEmptyStandIn = (reply: string) => reply.trim() === EMPTY_REPLY_FALLBACK;

/** Both channels consume field coverage, rather than guessing an outcome from prose. */
export function decideTripAnswer(
  plan: TripAnswerPlan,
  presentation: { userText: string; hasPriorReply?: boolean; phoneAlreadyRequested?: boolean },
): TripAnswerDecision {
  const missingFacts = [...plan.missingFacts];
  if (plan.selection.tripId !== plan.tripId) missingFacts.push("selection.trip");
  if (plan.status === "answered") {
    const missing = new Set([...plan.missingTopics, ...plan.request.topics.filter(topic => !plan.answeredTopics.includes(topic))]);
    for (const topic of missing) missingFacts.push(`topic.${topic}`);
  }
  if (plan.status === "handoff" || missingFacts.length || !plan.reply.trim() || isReferReply(plan.reply)) {
    return { outcome: "handoff", reply: "REFER", plan, missingFacts: [...new Set(missingFacts)] };
  }
  const reply = presentAssistantReply({ ...presentation, reply: enforceWebsiteForPayment(sanitizeAssistantReply(plan.reply)) });
  // A plan with no section for the turn ("3 том хүн" stating a party, a bare "Үнэ" the plan wrote
  // nothing for) came back as the cleaner's "Энэ мэдээлэл одоогоор тодорхойгүй байна. Хүний ажилтантай
  // холбож өгье." and was SENT, with no lead. No data is silence and a staff lead (owner's rule).
  if (!reply.trim() || isReferReply(reply) || isEmptyStandIn(plan.reply) || isEmptyStandIn(reply)) {
    return { outcome: "handoff", reply: "REFER", plan, missingFacts: ["reply.empty"] };
  }
  return { outcome: plan.status, reply, plan, missingFacts: [] };
}
