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
import { MAX_AI_INPUT_CHARS, apiErrorMessage, buildImageUploadUnit, fileToDataUrl, mergeAIProposals, shortId, uid } from "@/lib/adminPageUtils";
import { hasPlannedLines } from "@/lib/adminProposalUtils";
import type { AIProposal, AIProposalResponse, AttachedFile, ProposalQuestionOption, TravelTrip } from "@/lib/adminTypes";
import {
  MAX_AGENT_FILES, THREAD_KEY, agentProgressStages, answerToOf, attachmentRoute, dialogAnswer, displayText, instructionBody, isImageAttachment, openAskOf,
  openNewTripProposals, proposalMessage, replyToMessage, restoreThread, serializeThread, unlockSave, wantsSavedTripCheck, zeroActionMessage,
  type DialogPicks, type ProgressStage,
} from "./assistantChatLogic";
import type { AssistantAskMsg, AssistantAttachment, AssistantChatMessage, AssistantProposalMsg, AssistantResponse } from "./assistantChatTypes";
import { MAX_AI_SOURCE_TEXT_CHARS, createFileParser } from "./assistantFileParse";
import { useProposalActions } from "./useProposalActions";

const SESSION_KEY = "uudam.admin.assistant.session";
// One file per request to /api/admin/file-text; its base64 stays under Vercel's 4.5 MB body cap.
const DOCUMENT_MAX_BYTES = 3_000_000;
// A turn that compares files with saved trips runs longer than a typed edit (up to about two minutes).
const DOCUMENT_STAGES = [
  { at: 0, label: "Файлыг ойлгож байна…" },
  { at: 4, label: "Хадгалсан аяллыг шалгаж байна…" },
  { at: 14, label: "Файлыг аялалтай харьцуулж байна…" },
  { at: 40, label: "Өөрчлөлтийг бэлдэж байна… (урт жагсаалт бол 1–2 минут)" },
];
const MAX_DETAIL_TRIPS = 6;

export const ASSISTANT_INTRO: AssistantChatMessage = {
  id: "intro",
  role: "assistant",
  kind: "note",
  tone: "info",
  text:
    "Сайн байна уу! Аяллын мэдээллээ энд шуурхай өөрчилнө. Хамт ажилладаг хүндээ хэлдэг шигээ бичээрэй (ж: «<Аяллын нэр> 12/27 дүүрсэн, 1/3-ны үнийг 100 мянгаар нэм»), зураг хавсаргаж «3-р өдрийн зургийг соль» гэж бичих, аяллын холбоос буулгах, эсвэл прайс жагсаалт (Excel, PDF, зураг) оруулж болно. Хадгалсан аяллаа файлаар шинэчлэх бол файлаа хавсаргаад «<Аяллын нэр> аяллын хөтөлбөрийг энэ файлаар шинэчил», «энэ жагсаалтыг <Аяллын нэр> аялалд нэмэлт мэдээлэл болгож нэм», «<Аяллын нэр> аяллыг сэргээ» гэж бичнэ (Word .doc/.docx, Excel, PDF, зураг). Би өөрчлөлтийг санал болгоно — та хянаад хадгална, буцаах боломжтой.",
};

type Toast = { success: (message: string) => void; error: (message: string) => void };
/** One attached file as text (/api/admin/file-text); `similar` counts the saved trips it looks like. */
type FileText = { id: string; name: string; text: string; similar: number };

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
  // The files' text of the last message about saved trips: an answer to the assistant's question
  // about them (typed or tapped) carries it again, so the question never loses the file.
  const askDocuments = useRef<Array<{ name: string; text: string }> | null>(null);
  // The files themselves, kept while that conversation runs: one the assistant calls a whole new
  // trip is handed to the new-trip reader as the file it is.
  const askFiles = useRef<AttachedFile[] | null>(null);
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

  /**
   * The files of a message about saved trips, each read as text by the server (Word, Excel, PDF, a
   * price photo). A file that cannot be read is named in a toast and left out; the rest still go.
   */
  async function readDocuments(files: AttachedFile[], options: { known?: Map<string, FileText>; quiet?: boolean; match?: boolean } = {}): Promise<FileText[]> {
    const documents: FileText[] = [];
    for (const [index, file] of files.entries()) {
      const known = options.known?.get(file.id);
      if (known) { documents.push(known); continue; }
      setBusyLabel(files.length > 1 ? `«${file.name}» уншиж байна… ${index + 1}/${files.length}` : `«${file.name}» уншиж байна…`);
      try {
        // A photo is shrunk to fit one request; a document must fit as it is.
        const image = isImageAttachment(file);
        if (!image && file.file.size > DOCUMENT_MAX_BYTES) throw new Error(`файл ${(file.file.size / 1_048_576).toFixed(1)} MB — 3 MB-аас бага байх ёстой (PDF эсвэл .docx болгож жижигрүүлнэ үү)`);
        const dataUrl = image ? (await buildImageUploadUnit(file.file, DOCUMENT_MAX_BYTES)).dataUrl : await fileToDataUrl(file.file);
        const res = await fetchWithAdmin("/api/admin/file-text", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.mimeType, dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1), ...(options.match ? { match: true } : {}) }),
        });
        const data = (await readJsonSafe(res)) as { ok?: boolean; message?: string; document?: { name?: string; text?: string }; similar?: unknown[] };
        if (!res.ok || !data.document?.text) throw new Error(data.message || "уншиж чадсангүй");
        documents.push({ id: file.id, name: data.document.name || file.name, text: data.document.text, similar: Array.isArray(data.similar) ? data.similar.length : 0 });
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : "уншиж чадсангүй";
        if (!options.quiet) toast.error(reason.includes(file.name) ? reason : `«${file.name}»: ${reason}`);
      }
    }
    return documents;
  }

  /**
   * Files the assistant called whole new trips: each set goes to the new-trip reader as the
   * original files (a poster is read as a picture), with the admin's own decisions as the note.
   */
  async function runHandoffs(handoffs: AssistantResponse["handoffs"]) {
    const kept = askFiles.current || [];
    for (const handoff of handoffs || []) {
      const names = new Set((handoff.files || []).map((name) => name.trim()));
      const files = kept.filter((file) => names.has(file.name.trim()));
      if (!files.length) {
        pushMessage({ id: uid(), role: "assistant", kind: "note", tone: "error", text: `Шинэ аялал болгох файл (${[...names].join(", ")}) энэ хуудсанд үлдээгүй байна. Файлаа дахин хавсаргаад «шинэ аялал болгон нэм» гэж илгээнэ үү.` });
        continue;
      }
      const sourceNames = files.map((file) => file.name);
      setBusyStages(null);
      setBusyProgress(3);
      setBusyLabel(sourceNames.length > 1 ? `${sourceNames.length} файлыг шинэ аялал болгон уншиж байна…` : `«${sourceNames[0]}»-г шинэ аялал болгон уншиж байна…`);
      await readFiles(handoff.note || "", files, [], sourceNames);
    }
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
    // A revised reading of an open card replaces it: only the newest copy can be saved.
    if (message.role === "assistant" && message.kind === "proposal" && message.requestId != null) {
      const requestId = message.requestId;
      setMessages((prev) => prev.map((old) => (
        old.role === "assistant" && old.kind === "proposal" && old.requestId === requestId && old.status === "pending"
          ? { ...old, status: "cancelled", resultText: "Энэ саналыг доорх шинэчилсэн хувилбар орлосон." }
          : old
      )));
    }
    pushMessage(message);
    if (message.role === "assistant" && message.kind === "proposal") void loadTripDetails(message.proposal);
  }

  /**
   * Sends what is in the composer — or a tapped option's answer (the thread shows its label).
   * `requestAsk` is the question that option belongs to when that question sits on a stored
   * proposal: the answer then goes to that request.
   */
  async function sendAssistant(override?: { instruction: string; shown: string; requestAsk?: AssistantAskMsg; answers?: AssistantAskMsg; dialogAnswers?: string[] }) {
    const text = override ? override.instruction.trim() : aiInput.trim();
    const files = override ? [] : attachedFiles;
    const driveFileIds = override ? [] : extractGoogleDriveFileIds(text);
    if (!text && files.length === 0 && driveFileIds.length === 0) return;
    if (busyKey === "ai-send") return;
    if (text.length > MAX_AI_INPUT_CHARS) {
      toast.error(`AI заавар хэт урт байна. ${MAX_AI_INPUT_CHARS} тэмдэгтээс богино бичнэ үү.`);
      return;
    }
    const firstRoute = attachmentRoute(text, files);
    const mayReadFiles = firstRoute.kind === "files" || driveFileIds.length > 0;
    // A message with files is a new instruction, never the answer to a question on a stored card.
    const ask = override ? override.requestAsk ?? null : mayReadFiles || firstRoute.kind === "agent_files" ? null : openAskOf(messages);
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
    setBusyProgress(mayReadFiles ? 3 : null);
    setBusyLabel(mayReadFiles
      ? (sourceNames.length > 1 ? `${sourceNames.length} файл уншиж байна…` : `«${sourceNames[0] || "Файл"}» уншиж байна…`)
      : "");
    try {
      let route = firstRoute;
      const known = new Map<string, FileText>();
      // One document and no "new trip" said: is it a trip the catalogue already has? Then the
      // assistant takes stock first and asks «шинэчлэх үү, шинээр нэмэх үү?»; otherwise the reader,
      // as before. Until 2026-11-21 the file of a live trip quietly became a second trip.
      if (route.kind === "files" && driveFileIds.length === 0 && wantsSavedTripCheck(text, files)) {
        setBusyLabel("Энэ аялал бүртгэлд байгаа эсэхийг шалгаж байна…");
        for (const document of await readDocuments(files.filter((file) => !isImageAttachment(file)), { quiet: true, match: true })) known.set(document.id, document);
        if ([...known.values()].some((document) => document.similar > 0)) {
          route = { kind: "agent_files", files: files.slice(0, MAX_AGENT_FILES), skipped: Math.max(0, files.length - MAX_AGENT_FILES), reason: "check" };
        }
      }
      if (route.kind === "files" || driveFileIds.length > 0) {
        setBusyProgress(3);
        setBusyLabel(sourceNames.length > 1 ? `${sourceNames.length} файл уншиж байна…` : `«${sourceNames[0] || "Файл"}» уншиж байна…`);
        await readFiles(text, files, driveFileIds, sourceNames);
        return;
      }
      setBusyProgress(null);
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
      let documents: Array<{ name: string; text: string }> = [];
      let intake = false;
      if (route.kind === "agent_files") {
        const read = await readDocuments(route.files, { known, quiet: route.reason !== "words" });
        // A set the assistant cannot read whole as text (a scanned PDF, a zip) keeps the reader.
        if (route.reason !== "words" && read.length < route.files.length) {
          setBusyProgress(3);
          await readFiles(text, files, driveFileIds, sourceNames);
          return;
        }
        if (!read.length) throw new Error("Файлаас уншигдах зүйл гарсангүй, тиймээс зааврыг илгээсэнгүй. Файлаа шалгаад дахин оролдоно уу.");
        if (route.skipped > 0) toast.error(`Нэг удаад ${route.files.length} хүртэл файл илгээнэ — үлдсэн ${route.skipped}-г алгаслаа.`);
        documents = read.map((document) => ({ name: document.name, text: document.text }));
        askDocuments.current = documents;
        askFiles.current = route.files;
        intake = route.reason !== "words";
      } else if (askDocuments.current && (override?.answers || (ask && !override))) {
        documents = askDocuments.current;
      } else {
        askDocuments.current = null;
        askFiles.current = null;
      }
      setBusyLabel("");
      setBusyStages(documents.length ? DOCUMENT_STAGES : agentProgressStages(text));
      const answered = override?.answers ?? (ask && !override ? ask : null);
      const data = await postAssistant(instructionBody({
        // Files with no words: the assistant works out what they are and asks.
        instruction: text || `Файл орууллаа: ${sourceNames.join(", ")}`,
        sessionId: session.current,
        documents,
        intake,
        // A tapped option travels with the question and its first instruction, like a typed answer: on
        // 2026-11-14 a tapped «хүүхэд ор эзлэхгүй» was read alone and the adult price and «the other
        // departures like 12/4» from the first message were lost. A dialog's answers go one by one too.
        answerTo: answered ? { ...answerToOf(answered), ...(override?.dialogAnswers?.length ? { answers: override.dialogAnswers } : {}) } : null,
        attachments,
        // A typed message may be about a new trip read but not saved yet: the server edits that card.
        openProposals: ask ? [] : openNewTripProposals(messages),
      }));
      pushReply(data, text);
      // Files that are whole new trips: each becomes its own review card, read from the original file.
      if (data.handoffs?.length) await runHandoffs(data.handoffs);
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
    void sendAssistant({ instruction: option.answer, shown: option.label, ...(message.requestId != null ? { requestAsk: message } : { answers: message }) });
  }

  /** A dialog of several questions, answered in one go: every answer travels numbered, in the questions' order. */
  function submitAskDialog(message: AssistantAskMsg, picks: DialogPicks) {
    if (busyKey === "ai-send") return;
    const answer = dialogAnswer(message, picks);
    if (!answer) return;
    patchMessage(message.id, { answered: "✓", dialogAnswers: answer.summary });
    void sendAssistant({ instruction: answer.instruction, shown: answer.shown, answers: message, dialogAnswers: answer.answers });
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
    askDocuments.current = null;
    askFiles.current = null;
  }

  return {
    messages, aiInput, setAiInput, attachedFiles, dragOver, setDragOver, busyLabel, busyProgress, busyStages, tripDetails,
    chatEndRef, inputRef, attachFiles, removeAttachedFile, sendAssistant, sendQuickAction, chooseAskOption, submitAskDialog,
    resendInstruction, newConversation, ...proposalActions,
  };
}
