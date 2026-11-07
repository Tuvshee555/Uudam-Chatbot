import { GROUP_INQUIRY_HANDOFF_LINE, GROUP_INQUIRY_QUESTIONS, GROUP_INQUIRY_REPLY } from "./reply";
import type { NeedConstraints } from "./messageNeed";

/** The one detail worth asking next: head count, then destination, then month, then budget. */
export function nextGroupInquiryQuestion(constraints: NeedConstraints): string | null {
  if (!constraints.groupSize) return GROUP_INQUIRY_QUESTIONS.groupSize;
  if (!constraints.destinationWords?.length) return GROUP_INQUIRY_QUESTIONS.destination;
  if (!constraints.month && !constraints.period) return GROUP_INQUIRY_QUESTIONS.month;
  if (!constraints.budgetMentioned) return GROUP_INQUIRY_QUESTIONS.budget;
  return null;
}

/**
 * The reply to an organisation / group / bespoke-trip inquiry: the company's own published wording,
 * the "passed to the consultant" line, and exactly one question. Never a price, a discount or a call
 * time. The wording and the hand-off line tell the customer staff will prepare an offer, so they are
 * sent only after the staff lead really was saved; when saving failed the customer gets the question
 * alone (null when nothing is left to ask).
 */
export function buildGroupInquiryReply(input: { leadSaved: boolean; constraints: NeedConstraints }): string | null {
  const question = nextGroupInquiryQuestion(input.constraints);
  if (!input.leadSaved) return question;
  const body = `${GROUP_INQUIRY_REPLY} ${GROUP_INQUIRY_HANDOFF_LINE}`;
  return question ? `${body}\n\n${question}` : body;
}

/** True for a bot message that was a group inquiry reply: the customer's next short message answers it. */
export function isGroupInquiryReply(text: string | null | undefined): boolean {
  return Boolean(text) && String(text).includes(GROUP_INQUIRY_REPLY.slice(0, 60));
}
