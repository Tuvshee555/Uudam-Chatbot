/**
 * The assistant tab's conversation: what the admin sends, what comes back, and the thread kept
 * across a reload. Moved out of pages/admin.tsx (capped at 2,000 lines).
 *
 * - A typed instruction goes to /api/admin/ai-change; a typed answer while a question is open
 *   carries that question (answer_to), so it is read as the answer (B4).
 * - A tapped option sends its answer exactly as the server wrote it (the trip tag it carries is
 *   never shown). A question that belongs to a stored proposal is answered on that request.
 * - Photos sent with an explicit photo edit ("3-р өдрийн зургийг соль", "2-р зургийг хас") are
 *   hosted on our Cloudinary first and go to the agent as attachments; documents, and photos
 *   sent with anything else (a poster, a price list, «шинэ аялал») keep the file → trip reader.
 * - The session id and the visible thread live in sessionStorage, so a reload keeps both; a save
 *   still running at the reload keeps Save off on the restored card.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { extractGoogleDriveFileIds } from "@/lib/googleDriveLinks";
import { uploadAdminMedia } from "@/lib/adminMediaUpload";
import { MAX_AI_INPUT_CHARS, apiErrorMessage, mergeAIProposals, shortId, uid } from "@/lib/adminPageUtils";
import { hasPlannedLines } from "@/lib/adminProposalUtils";
import type { AIProposal, AIProposalResponse, AttachedFile, ProposalQuestionOption, TravelTrip } from "@/lib/adminTypes";
import {
  THREAD_KEY, agentProgressStages, answerToOf, attachmentRoute, displayText, instructionBody, openAskOf,
  proposalMessage, replyToMessage, restoreThread, serializeThread, unlockSave, zeroActionMessage, type ProgressStage,
} from "./assistantChatLogic";
import type { AssistantAskMsg, AssistantAttachment, AssistantChatMessage, AssistantProposalMsg, AssistantResponse } from "./assistantChatTypes";
import { MAX_AI_SOURCE_TEXT_CHARS, createFileParser } from "./assistantFileParse";
import { useProposalActions } from "./useProposalActions";

const SESSION_KEY = "uudam.admin.assistant.session";
const MAX_DETAIL_TRIPS = 6;

export const ASSISTANT_INTRO: AssistantChatMessage = {
  id: "intro",
  role: "assistant",
  kind: "note",
  tone: "info",
  text:
    "Сайн байна уу! Аяллын мэдээллээ энд шуурхай өөрчилнө. Хамт ажилладаг хүндээ хэлдэг шигээ бичээрэй (ж: «<Аяллын нэр> 12/27 дүүрсэн, 1/3-ны үнийг 100 мянгаар нэм»), зураг хавсаргаж «3-р өдрийн зургийг соль» гэж бичих, аяллын холбоос буулгах, эсвэл прайс жагсаалт (Excel, PDF, зураг) оруулж болно. Би өөрчлөлтийг санал болгоно — та хянаад хадгална, буцаах боломжтой.",
};

type Toast = { success: (message: string) => void; error: (message: string) => void };

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string | null) {
  try {
    const store = storage();
    if (!store) return;
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* a full or blocked storage only loses the thread on reload */
  }
}

export function useAssistantChat({ fetchWithAdmin, readJsonSafe, toast, loadAll, busyKey, setBusyKey, trips }: {
  fetchWithAdmin: (url: string, init?: RequestInit) => Promise<Response>;
  readJsonSafe: (response: Response) => Promise<Record<string, unknown>>;
  toast: Toast;
  loadAll: () => Promise<unknown>;
  busyKey: string;
  setBusyKey: (key: string) => void;
  /** The trips the page has loaded (list rows), used to tell which trips a card needs in full. */
  trips: TravelTrip[];
}) {
  const [messages, setMessages] = useState<AssistantChatMessage[]>([ASSISTANT_INTRO]);
  const [aiInput, setAiInput] = useState("");
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busyLabel, setBusyLabel] = useState("");
  const [busyProgress, setBusyProgress] = useState<number | null>(null);
  const [busyStages, setBusyStages] = useState<ProgressStage[] | null>(null);
  // Full trips for the cards that describe a program day or a day's photo (list rows hold neither).
  const [tripDetails, setTripDetails] = useState<Record<string, TravelTrip>>({});
  const session = useRef<string>(uid());
  const restored = useRef(false);
  const tripsRef = useRef(trips);
  const detailsRef = useRef(tripDetails);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { tripsRef.current = trips; }, [trips]);
  useEffect(() => { detailsRef.current = tripDetails; }, [tripDetails]);

  const pushMessage = useCallback((message: AssistantChatMessage) => setMessages((prev) => [...prev, message]), []);
  const patchMessage = useCallback((id: string, patch: Partial<AssistantChatMessage>) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? ({ ...message, ...patch } as AssistantChatMessage) : message)));
  }, []);

  /** Loads, read-only, the full trips a new proposal's card describes. */
  const loadTripDetails = useCallback(async (proposal: AIProposal) => {
    const listed = new Set(tripsRef.current.map((trip) => trip.id));
    const ids = [...new Set(proposal.actions
      .filter((action) => action.trip_id && (hasPlannedLines(action) || !listed.has(action.trip_id)))
      .map((action) => action.trip_id as string))]
      .filter((id) => !detailsRef.current[id])
      .slice(0, MAX_DETAIL_TRIPS);
    if (!ids.length) return;
    const loaded = await Promise.all(ids.map(async (id) => {
      try {
        const res = await fetchWithAdmin(`/api/admin/trips?id=${encodeURIComponent(id)}`);
        if (!res.ok) return null;
        const json = (await res.json().catch(() => null)) as { trip?: TravelTrip } | null;
        return json?.trip && json.trip.id === id ? json.trip : null;
      } catch {
        return null;
      }
    }));
    const found = loaded.filter((trip): trip is TravelTrip => Boolean(trip));
    if (found.length) setTripDetails((prev) => ({ ...prev, ...Object.fromEntries(found.map((trip) => [trip.id, trip])) }));
  }, [fetchWithAdmin]);

  // A reload keeps the conversation: the same session id (the server reads its recent turns)
  // and the visible thread, when it is recent enough for the server to remember it too.
  useEffect(() => {
    if (restored.current) return;
    const thread = restoreThread(readStored(THREAD_KEY));
    if (thread) {
      session.current = thread.sessionId;
      setMessages(thread.messages);
      for (const message of thread.messages) {
        if (message.role !== "assistant" || message.kind !== "proposal" || message.status !== "pending") continue;
        void loadTripDetails(message.proposal);
        // A save that was running when the page reloaded keeps Save off until the server has
        // certainly stopped (restoreThread marked its outcome unknown); then Save asks the server.
        const until = message.saveLockedUntil;
        if (typeof until === "number" && until > Date.now()) {
          window.setTimeout(() => setMessages((prev) => unlockSave(prev, message.id, until)), until - Date.now() + 250);
        }
      }
    } else {
      const stored = readStored(SESSION_KEY);
      if (stored) session.current = stored;
    }
    writeStored(SESSION_KEY, session.current);
    restored.current = true;
  }, [loadTripDetails]);
  useEffect(() => {
    if (!restored.current) return;
    const json = serializeThread(session.current, messages);
    if (json) writeStored(THREAD_KEY, json);
  }, [messages]);

  // A new message scrolls into view; a proposal is read from its top (a new trip's review is
  // long, and jumping to its last line hid the trip itself).
  const messageCount = useRef(0);
  useEffect(() => {
    const grew = messages.length > messageCount.current;
    messageCount.current = messages.length;
    if (!grew) return;
    const last = messages[messages.length - 1];
    const card = last && last.role === "assistant" && last.kind === "proposal" ? document.getElementById(`proposal-${last.id}`) : null;
    if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    else chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const fileParser = createFileParser({
    fetchWithAdmin, readJsonSafe, toastError: toast.error, setBusyLabel, setBusyProgress,
  });

  async function attachFiles(files: FileList | File[]) {
    const inputFiles = Array.from(files);
    if (inputFiles.length === 0) return;
    const nextFiles: AttachedFile[] = inputFiles.map((file) => ({
      id: `${file.name}:${file.size}:${file.lastModified}`,
      name: file.name,
      mimeType: file.type || "",
      sizeBytes: file.size,
      file,
    }));
    setAttachedFiles((prev) => {
      const existing = new Set(prev.map((file) => file.id));
      return [...prev, ...nextFiles.filter((file) => !existing.has(file.id))];
    });
  }
  function removeAttachedFile(fileId: string) {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== fileId));
  }

  /** Our Cloudinary copies of the photos (the agent stores only photos we host). */
  async function hostImages(files: AttachedFile[]): Promise<string[]> {
    const urls: string[] = [];
    for (const [index, file] of files.entries()) {
      setBusyLabel(files.length > 1 ? `Зургийг байршуулж байна… ${index + 1}/${files.length}` : "Зургийг байршуулж байна…");
      try {
        urls.push(await uploadAdminMedia(file.file, fetchWithAdmin));
      } catch (error) {
        toast.error(`«${file.name}»: ${error instanceof Error ? error.message : "байршуулж чадсангүй"}`);
      }
    }
    return urls;
  }

  async function postAssistant(body: Record<string, unknown>): Promise<AssistantResponse> {
    const res = await fetchWithAdmin("/api/admin/ai-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await readJsonSafe(res)) as AssistantResponse;
    // A clarification the agent could not use answers 409 with only a message.
    if (!res.ok) throw new Error(apiErrorMessage(data as AIProposalResponse, "AI санал үүсгэж чадсангүй."));
    return data;
  }

  function pushReply(data: AssistantResponse, sent: string) {
    const message = replyToMessage(data, { id: uid(), sent });
    pushMessage(message);
    if (message.role === "assistant" && message.kind === "proposal") void loadTripDetails(message.proposal);
  }

  /**
   * Sends what is in the composer — or a tapped option's answer (the thread shows its label).
   * `requestAsk` is the question that option belongs to when that question sits on a stored
   * proposal: the answer then goes to that request.
   */
  async function sendAssistant(override?: { instruction: string; shown: string; requestAsk?: AssistantAskMsg }) {
    const text = override ? override.instruction.trim() : aiInput.trim();
    const files = override ? [] : attachedFiles;
    const driveFileIds = override ? [] : extractGoogleDriveFileIds(text);
    if (!text && files.length === 0 && driveFileIds.length === 0) return;
    if (busyKey === "ai-send") return;
    if (text.length > MAX_AI_INPUT_CHARS) {
      toast.error(`AI заавар хэт урт байна. ${MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`);
      return;
    }
    const route = attachmentRoute(text, files);
    const fileFlow = route.kind === "files" || driveFileIds.length > 0;
    const ask = override ? override.requestAsk ?? null : fileFlow ? null : openAskOf(messages);
    const sourceNames = [
      ...files.map((file) => file.name),
      ...driveFileIds.map((fileId) => `Google Drive ${shortId(fileId)}`),
    ];
    const adminId = uid();
    pushMessage({ id: adminId, role: "admin", text: override ? override.shown : text || "Файл орууллаа", fileNames: sourceNames });
    if (!override) {
      setAiInput("");
      setAttachedFiles([]);
    }
    // A typed answer closes the question it answers (a tapped one was closed by the tap).
    if (ask && !override) patchMessage(ask.id, { answered: displayText(text).slice(0, 120) || "✓" });
    setBusyKey("ai-send");
    setBusyStages(null);
    setBusyProgress(fileFlow ? 3 : null);
    setBusyLabel(fileFlow
      ? (sourceNames.length > 1 ? `${sourceNames.length} файл уншиж байна…` : `«${sourceNames[0] || "Файл"}» уншиж байна…`)
      : "");
    try {
      if (fileFlow) {
        await readFiles(text, files, driveFileIds, sourceNames);
        return;
      }
      if (ask?.requestId != null) {
        // The question sits on a stored proposal: the answer revises that request.
        setBusyStages(agentProgressStages(text));
        const data = await postAssistant({ request_id: ask.requestId, clarification: text, session_id: session.current });
        pushReply(data, text);
        return;
      }
      let attachments: AssistantAttachment[] = [];
      if (route.kind === "agent_images") {
        const urls = await hostImages(route.images);
        if (!urls.length) throw new Error("Зургийг байршуулж чадсангүй, тиймээс зааврыг илгээсэнгүй. Дахин оролдоно уу.");
        if (route.skipped > 0) toast.error(`Нэг удаад ${route.images.length} хүртэл зураг илгээнэ — үлдсэн ${route.skipped}-г алгаслаа.`);
        patchMessage(adminId, { imageUrls: urls });
        attachments = urls.map((url) => ({ url, kind: "image" as const }));
      }
      setBusyLabel("");
      setBusyStages(agentProgressStages(text));
      const data = await postAssistant(instructionBody({
        instruction: text,
        sessionId: session.current,
        answerTo: ask && !override ? answerToOf(ask) : null,
        attachments,
      }));
      pushReply(data, text);
    } catch (err) {
      // The question stays open when its answer never arrived.
      if (ask) patchMessage(ask.id, { answered: undefined });
      pushMessage({
        id: uid(),
        role: "assistant",
        kind: "note",
        tone: "error",
        text: err instanceof TypeError
          ? "Сервер хариу өгөхөөс өмнө холболт тасарсан. Сүлжээгээ шалгаад дахин оролдоно уу."
          : err instanceof Error ? err.message : "Алдаа гарлаа.",
      });
    } finally {
      setBusyKey("");
      setBusyProgress(null);
      setBusyStages(null);
    }
  }

  /** The file → trip reader (documents, photos with no photo instruction, Google Drive links). */
  async function readFiles(text: string, files: AttachedFile[], driveFileIds: string[], sourceNames: string[]) {
    const parsedProposals: AIProposal[] = [];
    const parsedSourceNames: string[] = [];
    let requestId: number | null = null;
    let sourceText = "";
    if (files.length > 0) {
      const parsed = await fileParser.parseAttachedFiles(files, text);
      parsedProposals.push(parsed.proposal);
      parsedSourceNames.push(...files.map((file) => file.name));
      requestId = parsed.requestId;
      sourceText = parsed.sourceText;
    }
    if (driveFileIds.length > 0) {
      const parsedDrive = await fileParser.parseDriveFileIds(driveFileIds, text);
      parsedProposals.push(parsedDrive.proposal);
      parsedSourceNames.push(...driveFileIds.map((fileId) => `Google Drive ${shortId(fileId)}`));
      requestId = files.length === 0 ? parsedDrive.requestId : null;
      sourceText = sourceText ? `${sourceText}\n\n${parsedDrive.sourceText}`.slice(0, MAX_AI_SOURCE_TEXT_CHARS) : parsedDrive.sourceText;
    }
    const proposal = parsedProposals.length === 1 ? parsedProposals[0] : mergeAIProposals(parsedProposals, parsedSourceNames);
    setBusyLabel("Олдсон мэдээллийг нэгтгэж, шалгаж байна…");
    setBusyProgress(96);
    if (!proposal || !Array.isArray(proposal.actions)) {
      throw new Error("AI хэрэгжих санал буцааж чадсангүй. Илүү тодорхой зааварчилгаар дахин оролдоно уу.");
    }
    if (proposal.actions.length === 0) {
      pushMessage(zeroActionMessage(proposal, requestId, uid()));
      return;
    }
    const instruction = text ? `[File] ${sourceNames.join(", ")} - ${text}` : `[File] ${sourceNames.join(", ")}`;
    pushMessage(proposalMessage(proposal, requestId, { id: uid(), sent: text, instruction, sourceNames, sourceText }));
    setBusyProgress(100);
  }

  async function sendQuickAction(kind: "cancel" | "seats" | "food", trip: TravelTrip, value?: number | boolean) {
    if (busyKey === "ai-send") return;
    const label = kind === "cancel" ? "цуцлах" : kind === "seats" ? `үлдсэн суудал ${value}` : value ? "хоол багтсан" : "хоол багтаагүй";
    pushMessage({ id: uid(), role: "admin", text: `«${trip.route_name}» — ${label}` });
    setBusyKey("ai-send");
    setBusyProgress(null);
    setBusyStages(null);
    setBusyLabel("Санал бэлдэж байна…");
    try {
      const res = await fetchWithAdmin("/api/admin/ai-change", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quick: { kind, trip_id: trip.id, value }, session_id: session.current }),
      });
      const data = (await readJsonSafe(res)) as AIProposalResponse;
      if (!res.ok || !data.proposal) throw new Error(apiErrorMessage(data, "Санал үүсгэж чадсангүй."));
      const message = proposalMessage(data.proposal, typeof data.request_id === "number" ? data.request_id : null, {
        id: uid(), sent: "", instruction: `${trip.route_name} — ${label}`,
      });
      pushMessage({ ...message, clarifications: [] });
    } catch (err) {
      pushMessage({ id: uid(), role: "assistant", kind: "note", tone: "error", text: err instanceof Error ? err.message : "Алдаа гарлаа." });
    } finally {
      setBusyKey("");
    }
  }

  const proposalActions = useProposalActions({
    fetchWithAdmin, readJsonSafe, toast, loadAll, setBusyKey, session, setChatMessages: setMessages,
  });

  /** A tapped choice: the thread shows its label, the assistant gets its full answer as it is. */
  function chooseAskOption(message: AssistantAskMsg, option: ProposalQuestionOption) {
    if (busyKey === "ai-send") return;
    patchMessage(message.id, { answered: option.label });
    void sendAssistant({ instruction: option.answer, shown: option.label, ...(message.requestId != null ? { requestAsk: message } : {}) });
  }

  /** An expired proposal's instruction sent again for a fresh proposal on today's data. */
  function resendInstruction(message: AssistantProposalMsg) {
    if (!message.instruction.trim() || message.instruction.startsWith("[File]")) {
      setAiInput(displayText(message.instruction.replace(/^\[File\][^-]*-\s*/u, "")));
      inputRef.current?.focus();
      return;
    }
    void sendAssistant({ instruction: message.instruction, shown: displayText(message.instruction) });
  }

  /** A fresh conversation: a new session, the thread cleared here and forgotten on reload. */
  function newConversation() {
    if (busyKey === "ai-send") return;
    session.current = uid();
    writeStored(SESSION_KEY, session.current);
    writeStored(THREAD_KEY, null);
    setMessages([ASSISTANT_INTRO]);
    setTripDetails({});
    setAiInput("");
    setAttachedFiles([]);
  }

  return {
    messages, aiInput, setAiInput, attachedFiles, dragOver, setDragOver, busyLabel, busyProgress, busyStages, tripDetails,
    chatEndRef, inputRef, attachFiles, removeAttachedFile, sendAssistant, sendQuickAction, chooseAskOption,
    resendInstruction, newConversation, ...proposalActions,
  };
}
