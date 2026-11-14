import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getClientKey, rateLimitAsync } from "../../../lib/rateLimit";
import {
  applyAIProposalDirect,
  applyAIRequest,
  getAIProposalFailureResponse,
  rollbackAIRequest,
} from "../../../lib/travelOps";
import { answeredInstruction, generateAssistantReply, reviseStoredProposal } from "../../../lib/assistantReply";
import { logAssistantEvent, recentAssistantTurns } from "../../../lib/assistantLog";
import { EXPIRED_PROPOSAL_MESSAGE, expireStaleProposals, loadChangeRequest } from "../../../lib/assistantAgent/requests";
import { parseOpenProposals } from "../../../lib/assistantAgent/openProposals";
import type { AgentAttachment, AnswerTo } from "../../../lib/assistantAgent/types";
import { createQuickProposal, type QuickActionRequest } from "../../../lib/assistantQuickActions";
import {
  beginRequestTrace,
  finishRequestTrace,
  logError,
  recordCounter,
} from "../../../lib/observability";

export const config = {
  // Large pasted lists fan out into several batched AI calls; give the function
  // enough headroom to finish them (matches the file-parse endpoint and stays
  // above the 150s batch budget in generateAIProposalFromContentBatched).
  maxDuration: 180,
};

const ADMIN_AI_CHANGE_RATE_LIMIT = 30;
const ADMIN_AI_CHANGE_RATE_WINDOW_MS = 10 * 60 * 1000;
// Large pasted price lists are auto-split into batches in generateAIProposal,
// so allow a very generous instruction size here. The cap exists only to stop
// an absurd multi-MB paste from exhausting memory. Clarifications stay short.
const MAX_AI_CHANGE_INSTRUCTION_CHARS = 500_000;
const MAX_AI_CHANGE_CLARIFICATION_CHARS = 4_000;
const MAX_ATTACHMENTS = 6;

/** `attachments: [{url, kind:"image"}]`: images the page already hosted; anything else is dropped. */
function parseAttachments(value: unknown): AgentAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const url = item && typeof item === "object" ? (item as { url?: unknown }).url : undefined;
    const kind = item && typeof item === "object" ? (item as { kind?: unknown }).kind : undefined;
    return typeof url === "string" && /^https:\/\/\S+$/.test(url.trim()) && url.length <= 2_048 && (kind === undefined || kind === "image")
      ? [{ url: url.trim(), kind: "image" as const }] : [];
  }).slice(0, MAX_ATTACHMENTS);
}

/** `answer_to: {id?, question, instruction?}`: the open question a typed answer belongs to (echoed from the ask). */
function parseAnswerTo(value: unknown): AnswerTo | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { id?: unknown; question?: unknown; instruction?: unknown };
  const question = typeof raw.question === "string" ? raw.question.trim().slice(0, 2_000) : "";
  if (!question) return null;
  return {
    question,
    ...(typeof raw.id === "string" && raw.id.trim() ? { id: raw.id.trim().slice(0, 64) } : {}),
    ...(typeof raw.instruction === "string" && raw.instruction.trim() ? { instruction: raw.instruction.trim().slice(0, 6_000) } : {}),
  };
}

/** The card's action lines (each starts with «trip name»), for the conversation log. */
function proposalLines(proposal: { actions?: Array<{ summary?: unknown }> }): string[] {
  return (proposal.actions || []).map((action) => (typeof action.summary === "string" ? action.summary : "")).filter(Boolean).slice(0, 6);
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  let trace: ReturnType<typeof beginRequestTrace> | null = null;

  try {
    trace = beginRequestTrace({
      route: "api.admin.ai_change",
      method: req.method,
      url: req.url,
      headers: req.headers,
      setHeader: (name, value) => res.setHeader(name, value),
    });
    const allowed = await requireAdminAccess(req, res, "api.admin.ai_change");
    if (!allowed) return;

    if (req.method !== "POST") return res.status(405).end();

    const clientKey = getClientKey(req);
    const limit = await rateLimitAsync(
      `admin-ai:ai-change:${clientKey}`,
      ADMIN_AI_CHANGE_RATE_LIMIT,
      ADMIN_AI_CHANGE_RATE_WINDOW_MS,
    );
    if (!limit.allowed) {
      recordCounter("abuse.rate_limited_total", 1, {
        route: "api.admin.ai_change",
        scope: "admin_ai",
      });
      return res.status(429).json({
        error: "rate_limited",
        reset: limit.reset,
        retry_after_ms: Math.max(0, limit.reset - Date.now()),
      });
    }

    const { instruction, request_id, apply, rollback, confirm, clarification, proposal_direct, proposal_edit, quick, session_id } =
      req.body || {};
    const answerTo = parseAnswerTo(req.body?.answer_to);
    const attachments = parseAttachments(req.body?.attachments);
    const resultText = (result: { results?: unknown; message?: unknown }) =>
      Array.isArray(result.results) ? result.results.join(" • ") : String(result.message || "");

    if (typeof request_id === "number" && rollback === true) {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to roll back stored AI change.",
        });
      }
      const rolledBack = await rollbackAIRequest(request_id);
      await logAssistantEvent({ sessionId: session_id, requestId: request_id, role: "assistant", kind: "rolled_back", text: resultText(rolledBack) || "Буцаасан." });
      return res.status(rolledBack.ok ? 200 : 409).json(rolledBack);
    }

    // Apply a proposal that was never persisted to DB (request_id was null).
    if (apply === true && proposal_direct && typeof instruction === "string") {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to apply proposal.",
        });
      }
      const applied = await applyAIProposalDirect(proposal_direct, instruction.trim());
      await logAssistantEvent({ sessionId: session_id, role: "assistant", kind: "applied", text: resultText(applied) || "Хэрэгжүүлсэн." });
      return res.status(applied.ok ? 200 : 409).json(applied);
    }

    if (typeof request_id === "number" && apply === true) {
      if (confirm !== true) {
        return res.status(400).json({
          error: "confirmation_required",
          message: "Set confirm=true to apply stored AI proposal.",
        });
      }
      // A proposal nobody saved within a day was built on data that may have moved (B12).
      const stored = await loadChangeRequest(request_id).catch(() => null);
      if (stored?.ok && stored.request.expired) {
        return res.status(409).json({ ok: false, error: "proposal_expired", message: EXPIRED_PROPOSAL_MESSAGE, results: [EXPIRED_PROPOSAL_MESSAGE] });
      }
      // The proposal as the admin left it on the review page: that, not the stored first reading, is saved.
      const reviewed = proposal_edit && typeof proposal_edit === "object" && Array.isArray(proposal_edit.actions) ? proposal_edit : undefined;
      const applied = await applyAIRequest(request_id, reviewed);
      await logAssistantEvent({ sessionId: session_id, requestId: request_id, role: "assistant", kind: "applied", text: resultText(applied) || "Хэрэгжүүлсэн." });
      return res.status(applied.ok ? 200 : 409).json(applied);
    }

    if (
      typeof request_id === "number" &&
      typeof clarification === "string" &&
      clarification.trim()
    ) {
      const trimmedClarification = clarification.trim();
      if (trimmedClarification.length > MAX_AI_CHANGE_CLARIFICATION_CHARS) {
        return res.status(413).json({
          error: "clarification_too_long",
          max_chars: MAX_AI_CHANGE_CLARIFICATION_CHARS,
        });
      }
      const turns = await recentAssistantTurns(session_id);
      await logAssistantEvent({ sessionId: session_id, requestId: request_id, role: "admin", kind: "clarification", text: trimmedClarification });
      const revised = await reviseStoredProposal(request_id, trimmedClarification, { turns });
      if (revised.ok) {
        await logAssistantEvent({ sessionId: session_id, requestId: request_id, role: "assistant", kind: revised.note ? "note" : "proposal",
          text: revised.note || [revised.proposal.summary, ...proposalLines(revised.proposal)].join(" — ") });
      }
      return res.status(revised.ok ? 200 : 409).json(revised);
    }

    if (quick && typeof quick === "object") {
      const created = await createQuickProposal(quick as QuickActionRequest);
      if (!created.ok) return res.status(400).json({ ok: false, error: "quick_action_invalid", message: created.message });
      await logAssistantEvent({ sessionId: session_id, requestId: created.request_id, role: "admin", kind: "quick_action", text: created.proposal.summary });
      return res.status(200).json({ ok: true, proposal: created.proposal, request_id: created.request_id, requires_confirmation: true });
    }

    if (typeof instruction !== "string" || !instruction.trim()) {
      return res.status(400).json({ error: "instruction is required" });
    }

    const trimmedInstruction = instruction.trim();
    if (trimmedInstruction.length > MAX_AI_CHANGE_INSTRUCTION_CHARS) {
      return res.status(413).json({
        error: "instruction_too_long",
        max_chars: MAX_AI_CHANGE_INSTRUCTION_CHARS,
      });
    }

    void expireStaleProposals();
    const turns = await recentAssistantTurns(session_id);
    await logAssistantEvent({ sessionId: session_id, role: "admin", kind: answerTo ? "clarification" : "instruction",
      text: [answerTo ? `(хариулт: ${answerTo.question.slice(0, 200)})` : "", trimmedInstruction, attachments.length ? `[${attachments.length} зураг]` : ""].filter(Boolean).join(" ") });
    const openProposals = parseOpenProposals(req.body?.open_proposals);
    const reply = await generateAssistantReply(trimmedInstruction, { turns, answerTo, attachments, openProposals });
    if (reply.kind === "ask") {
      // One question with real choices (which trip, which day, which amount); nothing is saved yet.
      // answer_to is what the page sends back with a TYPED answer, so it is read as the answer.
      const ask = { ...reply.ask, answer_to: { id: reply.ask.id, question: reply.ask.text, instruction: answeredInstruction(trimmedInstruction, answerTo).slice(0, 6_000) } };
      await logAssistantEvent({ sessionId: session_id, role: "assistant", kind: "ask",
        text: [reply.ask.text, ...reply.ask.options.slice(0, 8).map((option) => `• ${option.label}`)].join("\n") });
      return res.status(200).json({ ok: true, ask, source: reply.source || "brain", steps: reply.steps });
    }
    if (reply.kind === "note") {
      await logAssistantEvent({ sessionId: session_id, role: "assistant", kind: "note", text: reply.text });
      return res.status(200).json({ ok: true, note: reply.text, steps: reply.steps });
    }
    const proposal = { proposal: reply.proposal, request_id: reply.request_id, source: reply.source, steps: reply.steps };
    await logAssistantEvent({
      sessionId: session_id,
      requestId: proposal.request_id,
      role: "assistant",
      kind: "proposal",
      // The action lines name each trip in «», so "энэ аялал" in the next message finds it.
      text: [proposal.proposal.summary, ...proposalLines(proposal.proposal), proposal.proposal.conflicts?.[0]].filter(Boolean).join(" — "),
    });
    const failure = getAIProposalFailureResponse(proposal.proposal);
    if (failure) {
      return res.status(failure.statusCode).json({
        ok: false,
        error: failure.error,
        message: failure.message,
        retry_after_ms: failure.retry_after_ms,
        proposal: proposal.proposal,
        request_id: proposal.request_id,
      });
    }
    return res.status(200).json({
      ok: true,
      ...proposal,
      requires_confirmation: Boolean(proposal.proposal.needs_confirmation),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "unexpected error";
    logError("api.admin.ai_change.unhandled", { error: message });
    return res.status(500).json({
      ok: false,
      error: "ai_change_failed",
      message,
    });
  } finally {
    if (trace) finishRequestTrace(trace, res.statusCode || 500);
  }
}
