/**
 * What the admin can do with one assistant proposal: answer its questions, save it,
 * undo the save. Moved out of pages/admin.tsx, which is over the 2,000-line cap.
 *
 * Save waits as long as the route may run (APPLY_WAIT_MS): a proposal over many trips saves
 * one trip after another, and the old 45 s limit said "failed" while the server kept saving.
 * Save is locked from the moment the request goes out until a definite answer, and the lock is
 * kept with the thread, so a reload mid-save cannot send the same proposal again. With no answer
 * at all the card says the outcome is unknown (never «Хадгалагдсангүй») and keeps Save off until
 * the server has certainly stopped; a second Save of a stored request then reports "already
 * saved" instead of saving twice.
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import { APPLY_WAIT_MS, applyOutcome, proposalApplyBody } from "@/lib/adminProposalApply";
import { buildProposalClarifications } from "@/lib/adminProposalUtils";
import { MAX_AI_INPUT_CHARS, apiErrorMessage, uid } from "@/lib/adminPageUtils";
import type { AIProposal, AIProposalResponse, ClarificationAnswer, ClarificationQuestion } from "@/lib/adminTypes";
import { isSaveLocked, replyToMessage, unlockSave } from "./assistantChatLogic";
import type { AssistantChatMessage, AssistantProposalMsg, AssistantResponse } from "./assistantChatTypes";

type Toast = { success: (message: string) => void; error: (message: string) => void };

export function useProposalActions({ fetchWithAdmin, readJsonSafe, toast, loadAll, setBusyKey, session, setChatMessages }: {
  fetchWithAdmin: (url: string, init?: RequestInit) => Promise<Response>;
  readJsonSafe: (response: Response) => Promise<Record<string, unknown>>;
  toast: Toast;
  loadAll: () => Promise<unknown>;
  setBusyKey: (key: string) => void;
  /** The assistant conversation this page is in. */
  session: RefObject<string>;
  setChatMessages: Dispatch<SetStateAction<AssistantChatMessage[]>>;
}) {
  function setProposalMessage(id: string, patch: Partial<AssistantProposalMsg>) {
    setChatMessages((prev) =>
      prev.map((message) =>
        message.id === id && message.role === "assistant" && message.kind === "proposal"
          ? { ...message, ...patch }
          : message,
      ),
    );
  }
  function appendMessage(message: AssistantChatMessage) {
    setChatMessages((prev) => [...prev, message]);
  }
  async function answerClarification(
    message: AssistantProposalMsg,
    question: ClarificationQuestion,
    answer: string,
    markAnsweredIds?: string[],
    extraAnswers?: ClarificationAnswer[],
  ) {
    const trimmed = answer.trim();
    if (!trimmed) return;
    setBusyKey(`clarify-${message.id}`);
    try {
      let proposal: AIProposal | undefined;
      let newRequestId: number | null = message.requestId;
      if (message.requestId != null) {
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: message.requestId,
            clarification: trimmed,
            session_id: session.current,
          }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        // The answer changed nothing on the card (the agent explained instead): say it plainly.
        if (typeof json?.note === "string" && json.note.trim()) {
          appendMessage({ id: uid(), role: "assistant", kind: "note", tone: "info", text: json.note });
        }
        proposal = json?.proposal as AIProposal | undefined;
      } else {
        const contextParts: string[] = [];
        if (message.sourceText) {
          contextParts.push(`Source text from uploaded files:\n${message.sourceText}`);
        }
        if (message.instruction) contextParts.push(message.instruction);
        if (message.clarificationAnswers.length > 0) {
          contextParts.push(
            "Previous clarification answers:\n" +
              message.clarificationAnswers
                .map((qa) => `${qa.prompt}: ${qa.answer}`)
                .join("\n"),
          );
        }
        contextParts.push(`${question.prompt}: ${trimmed}`);
        const instruction = contextParts.join("\n\n").slice(0, MAX_AI_INPUT_CHARS);
        const res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instruction, session_id: session.current }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        const data = json as AssistantResponse;
        // A new instruction may come back as a question or a note: shown in the thread as such.
        if (data.ask || (typeof data.note === "string" && data.note.trim())) {
          appendMessage(replyToMessage(data, { id: uid(), sent: instruction }));
          setProposalMessage(message.id, { status: "cancelled", resultText: undefined });
          return;
        }
        proposal = data.proposal;
        if (typeof data.request_id === "number") newRequestId = data.request_id;
      }
      if (!proposal || !Array.isArray(proposal.actions)) {
        throw new Error("AI засварласан санал буцааж чадсангүй.");
      }
      if (!proposal.photo_sources?.length && message.proposal.photo_sources?.length) {
        proposal.photo_sources = message.proposal.photo_sources;
      }
      const nextAnsweredIds = markAnsweredIds ?? [
        ...message.answeredClarificationIds,
        question.id,
      ];
      const nextAnswers = [
        ...message.clarificationAnswers,
        ...(extraAnswers ?? [
          {
            questionId: question.id,
            prompt: question.prompt,
            answer: trimmed,
          },
        ]),
      ];
      setProposalMessage(message.id, {
        proposal,
        requestId: newRequestId,
        clarifications: buildProposalClarifications(proposal, nextAnsweredIds, message.sourceNames ?? []),
        clarificationAnswers: nextAnswers,
        answeredClarificationIds: nextAnsweredIds,
        customReply: "",
        confirmChecked: false,
      });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Саналыг засаж чадсангүй.",
      );
    } finally {
      setBusyKey("");
    }
  }
  /** Lets Save back on when the lock set at `until` is over (a newer save's lock is left alone). */
  function unlockAt(id: string, until: number) {
    const wait = until - Date.now();
    if (wait <= 0) setChatMessages((prev) => unlockSave(prev, id, until));
    else setTimeout(() => setChatMessages((prev) => unlockSave(prev, id, until)), wait + 250);
  }
  async function applyProposal(message: AssistantProposalMsg) {
    if (isSaveLocked(message)) return;
    const startedAt = Date.now();
    const lockedUntil = startedAt + APPLY_WAIT_MS;
    const stored = message.requestId != null;
    setBusyKey(`apply-${message.id}`);
    // Locked before the request goes out and kept with the thread: if the page reloads while the
    // server is still saving, the restored card keeps Save off (restoreThread) instead of sending
    // the same proposal a second time.
    setProposalMessage(message.id, { savedAs: message.savedAs, saveError: undefined, saveUnknown: undefined, saveLockedUntil: lockedUntil });
    try {
      // Bounded past the route's own limit, so a stuck connection still ends with a clear
      // message instead of the "Save" button spinning forever.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), APPLY_WAIT_MS);
      let res: Response | null = null;
      try {
        res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proposalApplyBody(message, session.current)),
          signal: controller.signal,
        });
      } catch {
        res = null;
      } finally {
        clearTimeout(timeout);
      }
      const json = res ? await readJsonSafe(res) : {};
      const outcome = applyOutcome(res ? res.status : null, json, { stored });
      if (outcome.kind === "saved") {
        setProposalMessage(message.id, {
          status: "applied",
          saveLockedUntil: undefined,
          // What was saved is what the review showed, not the first reading.
          proposal: message.proposal,
          reviewed: message.reviewed,
          savedAs: message.savedAs,
          requestId: typeof json?.request_id === "number" ? (json.request_id as number) : message.requestId,
          resultText: outcome.text,
          savedLinks: outcome.links,
        });
        toast.success(message.savedAs === "draft" ? "Ноорог болгон хадгаллаа. Сайтад гараагүй." : "Өөрчлөлт хадгалагдлаа. Бот шинэ мэдээллээр хариулна.");
        await loadAll();
        return;
      }
      if (outcome.kind === "retry") {
        // Nothing was saved: the proposal stays open with what the admin corrected, to fix and save again.
        setProposalMessage(message.id, { saveError: outcome.text, saveLockedUntil: undefined });
        toast.error("Хадгалагдсангүй. Засаад дахин хадгална уу.");
        return;
      }
      if (outcome.kind === "expired") {
        setProposalMessage(message.id, { status: "error", expired: true, resultText: outcome.text, saveLockedUntil: undefined });
        toast.error("Санал хуучирсан байна.");
        return;
      }
      if (outcome.kind === "unknown") {
        if (!stored) {
          // An unsaved proposal has no request to ask about: saving it again could save it twice.
          setProposalMessage(message.id, { status: "error", saveUnknown: true, resultText: outcome.text, saveLockedUntil: undefined });
        } else {
          // Maybe saved, maybe not — never «Хадгалагдсангүй». The server may still be working on
          // this save until its own limit has passed; Save stays off until then.
          setProposalMessage(message.id, { saveUnknown: true, saveError: outcome.text });
          unlockAt(message.id, lockedUntil);
        }
        toast.error("Сервер хариу өгсөнгүй — хадгалагдсан эсэх тодорхойгүй.");
        return;
      }
      setProposalMessage(message.id, { status: "error", resultText: outcome.text, saveLockedUntil: undefined });
      toast.error("Хэрэгжүүлэхэд алдаа гарлаа.");
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        saveLockedUntil: undefined,
        resultText: err instanceof Error ? err.message : "Алдаа гарлаа.",
      });
      toast.error("Хэрэгжүүлэхэд алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }
  async function rollbackProposal(message: AssistantProposalMsg) {
    if (message.requestId == null) {
      toast.error("Буцаах хадгалсан хүсэлтийн дугаар олдсонгүй.");
      return;
    }
    if (
      !window.confirm(
        "Сүүлд хадгалсан AI өөрчлөлтийг буцаах уу? Энэ үйлдэл тухайн өөрчлөлтийн өмнөх аяллын мэдээллийг сэргээнэ.",
      )
    ) {
      return;
    }
    setBusyKey(`rollback-${message.id}`);
    try {
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: message.requestId,
          rollback: true,
          confirm: true,
          session_id: session.current,
        }),
      });
      const json = await readJsonSafe(res);
      if (!res.ok) {
        throw new Error(
          String(json?.message || json?.error || "Буцааж чадсангүй."),
        );
      }
      setProposalMessage(message.id, {
        status: "reverted",
        resultText: Array.isArray(json?.results)
          ? json.results.join(" • ")
          : String(json?.message || "Буцаагдлаа."),
      });
      toast.success("AI өөрчлөлтийг буцаалаа.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Буцаахад алдаа гарлаа.",
      });
      toast.error("Буцаахад алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }
  async function submitClarificationForm(
    message: AssistantProposalMsg,
    answers: Record<string, string>,
  ) {
    const combined = message.clarifications
      .map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        if (!answer) return "";
        const context = q.detail ? ` [Зөрчил: ${q.detail}]` : "";
        return `${q.prompt}${context} → ${answer}`;
      })
      .filter(Boolean)
      .join("\n");
    if (!combined.trim()) return;
    const allAnsweredIds = message.clarifications.map((q) => q.id);
    const newAnswers = message.clarifications
      .map((q) => {
        const answer = (answers[q.id] ?? "").trim();
        if (!answer) return null;
        return { questionId: q.id, prompt: q.prompt, answer };
      })
      .filter(Boolean) as ClarificationAnswer[];
    const firstQ = message.clarifications[0];
    if (!firstQ) return;
    await answerClarification(
      message,
      firstQ,
      combined,
      [...message.answeredClarificationIds, ...allAnsweredIds],
      newAnswers,
    );
  }
  return { setProposalMessage, applyProposal, rollbackProposal, submitClarificationForm };
}
