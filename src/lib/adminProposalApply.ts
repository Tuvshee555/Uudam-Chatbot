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

/**
 * How long Save waits for the server. The route may run 180 s (maxDuration in
 * /api/admin/ai-change): a proposal over many trips saves one trip after another, each waiting
 * for the website sync, so a 45 s client limit reported "failed" while the save went on.
 * Waiting past the route's own limit means an answer, or a certainty that it has stopped.
 */
export const APPLY_WAIT_MS = 200_000;

export const UNKNOWN_SAVE_TEXT =
  "Сервер хариу өгсөнгүй — өөрчлөлт хадгалагдсан эсэх тодорхойгүй. «Хадгалах»-ыг дахин дарвал хадгалагдсан эсэхийг шалгаад, хадгалагдаагүй бол хадгална.";
export const UNKNOWN_DIRECT_SAVE_TEXT =
  "Сервер хариу өгсөнгүй — өөрчлөлт хадгалагдсан эсэх тодорхойгүй. Давхар хадгалахгүйн тулд «Аяллууд» хэсгээс шалгаад, шаардлагатай бол зааврыг дахин илгээнэ үү.";
export const EXPIRED_SAVE_TEXT =
  "Энэ санал 24 цагаас хуучирсан тул хадгалахгүй — аяллын мэдээлэл тэр хооронд өөрчлөгдсөн байж магадгүй. Зааврыг дахин илгээнэ үү.";

export type ApplyOutcome =
  /** Saved; `text` is the server's per-trip lines (Mongolian). */
  | { kind: "saved"; text: string }
  /** Nothing saved: the proposal stays open to correct and save again. */
  | { kind: "retry"; text: string }
  /** The stored proposal is older than a day (409 proposal_expired): ask again. */
  | { kind: "expired"; text: string }
  /** No answer (network, gateway timeout): it may or may not have been saved. */
  | { kind: "unknown"; text: string }
  | { kind: "failed"; text: string };

/**
 * What one save answer means. `status` is null when no answer arrived at all. A repeated save
 * of a stored request that went through answers "Request already applied." — that is a success.
 */
export function applyOutcome(status: number | null, json: unknown, options: { stored?: boolean } = {}): ApplyOutcome {
  const body = (json && typeof json === "object" ? json : {}) as Row;
  const stored = options.stored !== false;
  if (status === null || status === 502 || status === 504) {
    return { kind: "unknown", text: stored ? UNKNOWN_SAVE_TEXT : UNKNOWN_DIRECT_SAVE_TEXT };
  }
  if (status === 409 && body.error === "proposal_expired") {
    return { kind: "expired", text: typeof body.message === "string" && body.message.trim() ? body.message : EXPIRED_SAVE_TEXT };
  }
  if (status >= 200 && status < 300 && body.ok !== false) {
    if (body.message === "Request already applied.") return { kind: "saved", text: "Өмнө нь хадгалагдсан байна." };
    const results = Array.isArray(body.results) ? body.results.map(String).filter(Boolean) : [];
    return { kind: "saved", text: results.join(" • ") || "Хадгалагдлаа." };
  }
  if (applyCanRetry(status, body)) return { kind: "retry", text: applyFailureText(body) };
  return { kind: "failed", text: applyFailureText(body) };
}
