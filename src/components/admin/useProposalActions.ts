/**
 * What the admin can do with one assistant proposal: answer its questions, save it,
 * undo the save. Moved out of pages/admin.tsx, which is over the 2,000-line cap.
 */
import type { Dispatch, RefObject, SetStateAction } from "react";
import { applyCanRetry, applyFailureText, proposalApplyBody } from "@/lib/adminProposalApply";
import { buildProposalClarifications } from "@/lib/adminProposalUtils";
import { MAX_AI_INPUT_CHARS, apiErrorMessage } from "@/lib/adminPageUtils";
import type { AIProposal, AIProposalResponse, ChatMessage, ClarificationAnswer, ClarificationQuestion, ProposalMsg } from "@/lib/adminTypes";

type Toast = { success: (message: string) => void; error: (message: string) => void };

export function useProposalActions({ fetchWithAdmin, readJsonSafe, toast, loadAll, setBusyKey, session, setChatMessages }: {
  fetchWithAdmin: (url: string, init?: RequestInit) => Promise<Response>;
  readJsonSafe: (response: Response) => Promise<Record<string, unknown>>;
  toast: Toast;
  loadAll: () => Promise<unknown>;
  setBusyKey: (key: string) => void;
  /** The assistant conversation this page is in. */
  session: RefObject<string>;
  setChatMessages: Dispatch<SetStateAction<ChatMessage[]>>;
}) {
  function setProposalMessage(id: string, patch: Partial<ProposalMsg>) {
    setChatMessages((prev) =>
      prev.map((message) =>
        message.id === id && "kind" in message && message.kind === "proposal"
          ? { ...message, ...patch }
          : message,
      ),
    );
  }
  async function answerClarification(
    message: ProposalMsg,
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
          body: JSON.stringify({ instruction }),
        });
        const json = await readJsonSafe(res);
        if (!res.ok) {
          throw new Error(
            apiErrorMessage(json as AIProposalResponse, "Саналыг засаж чадсангүй."),
          );
        }
        proposal = json?.proposal as AIProposal | undefined;
        if (typeof json?.request_id === "number") {
          newRequestId = json.request_id as number;
        }
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
  async function applyProposal(message: ProposalMsg) {
    setBusyKey(`apply-${message.id}`);
    setProposalMessage(message.id, { savedAs: message.savedAs, saveError: undefined });
    try {
      // Bounded so a stuck DB connection reads as a clear error the admin can
      // retry, instead of the "Save" button spinning forever with no signal.
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 45_000);
      let res: Response;
      try {
        res = await fetchWithAdmin("/api/admin/ai-change", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(proposalApplyBody(message, session.current)),
          signal: controller.signal,
        });
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          throw new Error("Хадгалахад удаж байна — сүлжээ/сервер удаан хариулж байна. Дахин оролдоно уу.");
        }
        throw err;
      } finally {
        clearTimeout(timeout);
      }
      const json = await readJsonSafe(res);
      if (!res.ok) {
        // Nothing was saved: the proposal stays open with what the admin corrected, to fix and save again.
        if (applyCanRetry(res.status, json)) {
          setProposalMessage(message.id, { saveError: applyFailureText(json) });
          toast.error("Хадгалагдсангүй. Засаад дахин хадгална уу.");
          return;
        }
        throw new Error(applyFailureText(json));
      }
      setProposalMessage(message.id, {
        status: "applied",
        // What was saved is what the review showed, not the first reading.
        proposal: message.proposal,
        reviewed: message.reviewed,
        savedAs: message.savedAs,
        requestId: typeof json?.request_id === "number" ? (json.request_id as number) : message.requestId,
        resultText: Array.isArray(json?.results) ? json.results.join(" • ") : String(json?.message || "Амжилттай."),
      });
      toast.success(message.savedAs === "draft" ? "Ноорог болгон хадгаллаа. Сайтад гараагүй." : "Өөрчлөлт хадгалагдлаа. Бот шинэ мэдээллээр хариулна.");
      await loadAll();
    } catch (err) {
      setProposalMessage(message.id, {
        status: "error",
        resultText: err instanceof Error ? err.message : "Алдаа гарлаа.",
      });
      toast.error("Хэрэгжүүлэхэд алдаа гарлаа.");
    } finally {
      setBusyKey("");
    }
  }
  async function rollbackProposal(message: ProposalMsg) {
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
    message: ProposalMsg,
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
