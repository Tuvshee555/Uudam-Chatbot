/**
 * What the admin page sends to save a proposal, and how it reads the answer.
 * Pure, so the rule that a reviewed proposal is the one that gets saved is
 * tested without a browser.
 */
import type { AIProposal, ProposalMsg } from "./adminTypes";
import { reviewedFields } from "./tripReview";

type Row = Record<string, unknown>;

export function isNewTripAction(action: { action?: string; trip_id?: string }): boolean {
  return String(action.action || "").toLowerCase() === "upsert" && !action.trip_id;
}

/**
 * The proposal as it will be saved after a review: every new trip takes the
 * fields the admin left on screen, as a draft or published; updates and
 * cancellations of existing trips are untouched.
 */
export function reviewedProposal(proposal: AIProposal, drafts: Record<number, Row>, mode: "draft" | "publish", now = new Date()): AIProposal {
  return {
    ...proposal,
    actions: proposal.actions.map((action, index) => (isNewTripAction(action)
      ? { ...action, fields: reviewedFields(drafts[index] ?? (action.fields as Row) ?? {}, mode, now) }
      : action)),
  };
}

/** The body of the save request. A reviewed proposal travels with its request id, so the stored first reading is not what gets saved. */
export function proposalApplyBody(message: ProposalMsg, sessionId: string): Row {
  if (message.requestId == null) {
    return { session_id: sessionId, apply: true, confirm: true, proposal_direct: message.proposal, instruction: message.instruction };
  }
  return {
    request_id: message.requestId, apply: true, confirm: true, session_id: sessionId,
    ...(message.reviewed ? { proposal_edit: message.proposal } : {}),
  };
}

/** Why a save was refused, in the words the server gave for each trip. */
export function applyFailureText(json: unknown): string {
  const body = (json && typeof json === "object" ? json : {}) as Row;
  const results = Array.isArray(body.results) ? body.results.map(String).filter(Boolean) : [];
  return results.join("\n") || String(body.message || body.error || "Хадгалж чадсангүй.");
}

/** True when the refusal left nothing saved and the proposal can be corrected and saved again. */
export function applyCanRetry(status: number, json: unknown): boolean {
  const body = (json && typeof json === "object" ? json : {}) as Row;
  return body.retry === true || status === 422 || status >= 500;
}
