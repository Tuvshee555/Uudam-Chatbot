import type { TripAnswerPlan } from "./tripAnswerPlan";
import { presentAssistantReply } from "./chatbotReplyPolicy";
import { enforceWebsiteForPayment, isReferReply, sanitizeAssistantReply } from "./reply";

export type TripAnswerDecision = {
  outcome: "answered" | "clarify" | "handoff";
  reply: string;
  plan: TripAnswerPlan;
  missingFacts: string[];
};

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
  if (!reply.trim() || isReferReply(reply)) {
    return { outcome: "handoff", reply: "REFER", plan, missingFacts: ["reply.empty"] };
  }
  return { outcome: plan.status, reply, plan, missingFacts: [] };
}
