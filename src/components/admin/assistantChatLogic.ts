/**
 * The assistant tab's decisions that need no browser: where an attachment goes, what one
 * request carries, how a reply becomes a chat message, the progress line, the small "how it
 * was made" caption, and the thread kept in sessionStorage. Pure, so tests read them directly.
 */
import { buildProposalClarifications } from "@/lib/adminProposalUtils";
import type { AIProposal, AttachedFile } from "@/lib/adminTypes";
import type {
  AnswerToRef, AssistantAskMsg, AssistantAttachment, AssistantChatMessage, AssistantNoteMsg,
  AssistantProposalMsg, AssistantResponse, ReplyMeta,
} from "./assistantChatTypes";

/* ---------------------------------------------------------------- */
/* Attachments: the agent (photos) or the file → trip pipeline      */
/* ---------------------------------------------------------------- */

/** The most images one instruction hands the agent (the route keeps six). */
export const MAX_AGENT_IMAGES = 6;

// The agent sees an attachment only as a link: it can swap or remove a trip's photo with it, but
// cannot read a poster or a price list in it. So photos go to the agent only for an explicit photo
// edit; anything else, and anything unsure, goes to the file → trip reader, which reads the image.
// (No lookbehind: older Safari refuses it and the whole admin page would fail to load.)

// A photo named: "зураг", "зургийг", "зургаар", "зурган", "фото", "photo", "zurag", "zurgiig".
const PHOTO_WORD = /(?:зура?г|фото|photo|picture|image|zura?g)/iu;
// What to do with it: replace ("соль", "солих", "сольж", "soli", "replace") or remove ("хас",
// "хасах", "has", "remove"). Never "Солонгос": сол must be followed by и or ь.
const PHOTO_EDIT_VERB = /(?:сол[иь]|(?:^|[^\p{L}])soli|replace|swap|(?:^|[^\p{L}])хас|(?:^|[^\p{L}])has(?:ah|aad|na|j)?(?![\p{L}])|remove|delete)/iu;
// Which photo: the cover ("нүүр зураг"), a day's ("3-р өдрийн", "3 дахь өдөр", "3-r udriin",
// "day 3"), a position ("2-р зураг", "эхний зураг", "2nd photo").
const PHOTO_TARGET = new RegExp([
  "нүүр", "(?:^|[^\\p{L}])nuur", "cover",
  "\\d+\\s*-?\\s*(?:р|дугаар|дүгээр|дахь|дэх)\\s*(?:өдө?р|зура?г|фото)",
  "\\d+\\s*-?\\s*(?:r|dugaar|dahi|deh)\\s*(?:udu?r|odo?r|zura?g)",
  "(?:эхний|сүүлийн|сүүлчийн)\\s+(?:зура?г|фото)",
  "day\\s*\\d+", "\\d+(?:st|nd|rd|th)\\s+(?:day|photo|picture|image)", "(?:first|last)\\s+(?:photo|picture|image)",
].join("|"), "iu");
// Words for reading the attachment as a source: a new trip, prices, a list or table, a poster, a
// program, dates, "read". Any of these keeps the file reader, even with a photo word.
const READ_WORDS = new RegExp([
  "шинэ\\s+аял", "аял(?:ал|лыг|лаа)?\\s+(?:нэм|үүсг|оруул)", "үүсг", "үн[эи]", "прайс", "жагсаалт", "хүснэгт",
  "постер", "плакат", "хөтөлбөр", "огноо", "унш",
  "shine\\s+ay?al", "ay?al(?:al|liig)?\\s+(?:nem|uusg|oruul)", "uusg", "(?:^|[^a-z])un(?:e|ii|iig|eer)(?![a-z])",
  "jagsaalt", "husnegt", "hutulbur", "ognoo", "unsh",
  "\\b(?:prices?|list|table|poster|program(?:me)?|dates?|read|parse)\\b",
].join("|"), "iu");

/**
 * True only for an explicit photo edit: a photo named, with what to do or which photo
 * ("3-р өдрийн зургийг соль", "нүүр зураг солих", "2-р зургийг хас"), and nothing about reading
 * the attachment ("энэ зургаас шинэ аялал үүсгэ", "энэ зурган дээрх үнээр шинэчил" → false).
 */
export function isPhotoInstruction(text: string): boolean {
  const words = String(text || "");
  if (!PHOTO_WORD.test(words) || READ_WORDS.test(words)) return false;
  return PHOTO_EDIT_VERB.test(words) || PHOTO_TARGET.test(words);
}

export function isImageAttachment(file: Pick<AttachedFile, "name" | "mimeType">): boolean {
  const mime = String(file.mimeType || "").toLowerCase();
  return mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|heic|heif)$/i.test(String(file.name || "").trim());
}

export type AttachmentRoute =
  | { kind: "none" }
  /** Photos with an explicit photo edit: hosted first, then sent to the agent with the text. */
  | { kind: "agent_images"; images: AttachedFile[]; skipped: number }
  /** Documents, mixed files, or images with anything else (or nothing) said: the file → trip reader. */
  | { kind: "files" };

export function attachmentRoute(text: string, files: AttachedFile[]): AttachmentRoute {
  if (!files.length) return { kind: "none" };
  const allImages = files.every(isImageAttachment);
  if (allImages && String(text || "").trim() && isPhotoInstruction(text)) {
    return { kind: "agent_images", images: files.slice(0, MAX_AGENT_IMAGES), skipped: Math.max(0, files.length - MAX_AGENT_IMAGES) };
  }
  return { kind: "files" };
}

/* ---------------------------------------------------------------- */
/* One request                                                      */
/* ---------------------------------------------------------------- */

/** The body of one typed instruction, a typed answer (with its question) or a tapped option. */
/** An unsaved new-trip card in this chat: the server edits it (not a saved trip) when a message is about it. */
export type OpenProposalRef = { request_id: number; names: string[]; latest: boolean };

/**
 * The new-trip cards still open in the thread (not saved, cancelled or expired), newest first, at most
 * three. `latest`: that card is the assistant's last word. Until 2026-11-14 a message about a trip just
 * read («сүүлийн өдрийг нэм», «… линк») went to the saved catalogue and edited or linked another trip.
 */
export function openNewTripProposals(messages: AssistantChatMessage[]): OpenProposalRef[] {
  const lastAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const open: OpenProposalRef[] = [];
  for (let index = messages.length - 1; index >= 0 && open.length < 3; index--) {
    const message = messages[index];
    if (message.role !== "assistant" || message.kind !== "proposal" || message.status !== "pending" || message.expired || message.requestId == null) continue;
    const names = (message.proposal.actions || [])
      .filter((action) => String(action.action || "").toLowerCase() === "upsert" && !action.trip_id)
      .map((action) => String((action.fields as Record<string, unknown> | undefined)?.route_name || "").trim().slice(0, 200))
      .filter(Boolean);
    if (!names.length) continue;
    open.push({ request_id: message.requestId, names: names.slice(0, 3), latest: message === lastAssistant });
  }
  return open;
}

export function instructionBody(input: {
  instruction: string;
  sessionId: string;
  answerTo?: AnswerToRef | null;
  attachments?: AssistantAttachment[];
  openProposals?: OpenProposalRef[];
}): Record<string, unknown> {
  const attachments = (input.attachments || []).filter((item) => /^https:\/\//.test(item.url)).slice(0, MAX_AGENT_IMAGES);
  return {
    instruction: input.instruction,
    session_id: input.sessionId,
    ...(input.answerTo?.question ? { answer_to: input.answerTo } : {}),
    ...(attachments.length ? { attachments: attachments.map((item) => ({ url: item.url, kind: "image" as const })) } : {}),
    ...(input.openProposals?.length ? { open_proposals: input.openProposals } : {}),
  };
}

/** The question the composer answers: only while it is the assistant's latest word and unanswered. */
export function openAskOf(messages: AssistantChatMessage[]): AssistantAskMsg | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    return message.kind === "ask" && !message.answered ? message : null;
  }
  return null;
}

/** What a typed answer to `ask` sends back so the route reads it as the answer (B4). */
export function answerToOf(ask: AssistantAskMsg): AnswerToRef {
  return ask.answerTo?.question ? ask.answerTo : { question: ask.text };
}

// The tokens a tapped option carries back ("[сонгосон аялал: «…» id:…]", "[аялал: «…» trip_id=…]",
// "[огноо: …]", "(trip:2)"). They travel to the server as they are and are never shown.
const CHOICE_TAGS = /\s*\[(?:сонгосон аялал|аялал|огноо):[^\]]*\]|\s*\(trip:\d+\)|\s*trip_id=[A-Za-z0-9_.:-]+/gu;

/** Text for the screen: an answer or instruction without the tokens it carries. */
export function displayText(text: string): string {
  return String(text || "").replace(CHOICE_TAGS, "").replace(/[ \t]{2,}/g, " ").trim();
}

/* ---------------------------------------------------------------- */
/* Progress while the agent works                                   */
/* ---------------------------------------------------------------- */

/** `long`: a step of a 1–2 minute job, shown as a checklist with a clock instead of one rotating line. */
export type ProgressStage = { at: number; label: string; long?: boolean };

/**
 * "<link> нэм" / the «Шинэ аялал болгон дахин нэмэх» button: a partner page read as a new trip, 60–110 s
 * (page, the reader, the table cross-check, photos). One rotating line sat on «Өөрчлөлтийг бэлдэж байна…»
 * for a minute and looked frozen (2026-11-11).
 */
export function isTripFromLink(text: string): boolean {
  const value = String(text || "");
  if (/\[хамтрагч шалгах:/u.test(value)) return false;
  return /\[шинэ аялал\]/u.test(value) || (hasLink(value) && /нэм|nem|add|оруул|шинэ\s*аялал|аялал\s*болго/iu.test(value));
}

export const TRIP_FROM_LINK_STAGES: ProgressStage[] = [
  { at: 0, label: "Хуудсыг нээж байна", long: true },
  { at: 6, label: "Хуваарь, үнэ, огноо, хөтөлбөрийг уншиж байна", long: true },
  { at: 45, label: "Хуудасны хүснэгттэй тулгаж шалгаж байна", long: true },
  { at: 55, label: "Аялалд тохирох зураг сонгож байна", long: true },
];

const LINK = /(?:https?:\/\/|www\.)\S+|uudamtravel\.mn\/\S*/iu;

export function hasLink(text: string): boolean {
  return LINK.test(String(text || ""));
}

/** The usual order of the agent's work, with the second each step usually starts at. */
export function agentProgressStages(text: string): ProgressStage[] {
  if (isTripFromLink(text)) return TRIP_FROM_LINK_STAGES;
  return hasLink(text)
    ? [
      { at: 0, label: "Ойлгож байна…" },
      { at: 2, label: "Холбоосыг уншиж байна…" },
      { at: 8, label: "Аяллыг шалгаж байна…" },
      { at: 18, label: "Өөрчлөлтийг бэлдэж байна…" },
    ]
    : [
      { at: 0, label: "Ойлгож байна…" },
      { at: 2.5, label: "Аяллыг шалгаж байна…" },
      { at: 10, label: "Өөрчлөлтийг бэлдэж байна…" },
    ];
}

export function stageAt(stages: ProgressStage[], seconds: number): string {
  return stages.reduce((label, stage) => (seconds >= stage.at ? stage.label : label), stages[0]?.label || "Бодож байна…");
}

/* ---------------------------------------------------------------- */
/* How a reply was made                                             */
/* ---------------------------------------------------------------- */

const BRAIN_TOKENS = /trip_id=[A-Za-z0-9_.:-]+|\[огноо:[^\]]*\]/u;

/**
 * Where the reply came from. A typed instruction answered by the brain means the model was
 * unavailable (the budget is spent or the model is down): that is «энгийн горим». A tapped brain
 * option is answered by the brain on purpose and is not marked.
 */
export function replyMetaOf(data: AssistantResponse, sentInstruction: string): ReplyMeta | undefined {
  const source = data.source;
  const steps = Array.isArray(data.steps) ? data.steps.filter((step): step is string => typeof step === "string") : [];
  const fallbackNote = (data.proposal?.conflict_items || []).some((item) => item.type === "ai_fallback");
  const simple = fallbackNote || (source === "brain" && !BRAIN_TOKENS.test(sentInstruction));
  if (!source && !steps.length && !simple) return undefined;
  return { ...(source ? { source } : {}), ...(simple ? { simple: true } : {}), ...(steps.length ? { steps } : {}) };
}

const STEP_WORDS: Record<string, string> = {
  search_trips: "аялал хайсан",
  get_trip: "аяллыг шалгасан",
  resolve_link: "холбоос тодорхойлсон",
  read_web_page: "хуудас уншсан",
  host_image: "зураг байршуулсан",
  open_card: "нээлттэй картыг зассан",
};

/** One small line under a reply ("AI туслах · аялал хайсан · аяллыг шалгасан"), or null. */
export function replyCaption(meta?: ReplyMeta): string | null {
  if (!meta) return null;
  if (meta.simple) return "Энгийн горим — AI түр ажиллахгүй байгаа тул нэг мессежээс нэг өөрчлөлт уншлаа";
  const steps = [...new Set((meta.steps || []).map((step) => STEP_WORDS[step]).filter(Boolean))];
  if (meta.source === "agent") return ["AI туслах", ...steps].join(" · ");
  if (meta.source === "file") return ["AI туслах", ...steps, "шинэ аяллын уншлага"].join(" · ");
  if (meta.source === "model") return "AI туслах · жагсаалт уншсан";
  return null;
}

/* ---------------------------------------------------------------- */
/* A reply → a chat message                                         */
/* ---------------------------------------------------------------- */

const NOTHING_TO_CHANGE = "Өөрчлөх зүйл олдсонгүй. Илүү дэлгэрэнгүй зааварчилга эсвэл өөр файл оруулна уу.";

/**
 * A proposal with no actions: its first question becomes a question with buttons (B5) —
 * answered as a clarification on the stored request when there is one — otherwise its reason
 * is one plain line.
 */
export function zeroActionMessage(proposal: AIProposal, requestId: number | null, id: string, meta?: ReplyMeta): AssistantAskMsg | AssistantNoteMsg {
  const question = (proposal.questions || []).find((entry) => entry.prompt && (entry.options.length > 0 || entry.allow_custom));
  if (question) {
    return {
      id, role: "assistant", kind: "ask", text: question.prompt,
      options: question.options.map((option) => ({ label: option.label, answer: option.answer, ...(option.hint ? { hint: option.hint } : {}) })),
      allowCustom: question.allow_custom === true,
      customPlaceholder: question.custom_placeholder,
      requestId,
      answerTo: { ...(question.id ? { id: question.id } : {}), question: question.prompt },
      ...(meta ? { meta } : {}),
    };
  }
  const failed = (proposal.conflict_items || []).some((item) => item.severity === "blocker") || proposal.needs_confirmation;
  return {
    id, role: "assistant", kind: "note", tone: failed ? "error" : "info",
    text: proposal.conflicts?.[0] || proposal.important_reason || proposal.summary || NOTHING_TO_CHANGE,
    ...(meta ? { meta } : {}),
  };
}

export type ReplyContext = { id: string; sent: string; instruction?: string; sourceNames?: string[]; sourceText?: string };

/** The chat message for one answer of the route: a question, a note, or a proposal card. */
export function replyToMessage(data: AssistantResponse, ctx: ReplyContext): AssistantChatMessage {
  const meta = replyMetaOf(data, ctx.sent);
  const withMeta = meta ? { meta } : {};
  if (data.ask && typeof data.ask.text === "string") {
    return {
      id: ctx.id, role: "assistant", kind: "ask", text: data.ask.text,
      options: Array.isArray(data.ask.options) ? data.ask.options : [],
      allowCustom: data.ask.allow_custom === true,
      customPlaceholder: data.ask.custom_placeholder,
      ...(data.ask.answer_to?.question ? { answerTo: data.ask.answer_to } : {}),
      ...withMeta,
    };
  }
  if (typeof data.note === "string" && data.note.trim()) {
    return { id: ctx.id, role: "assistant", kind: "note", tone: "info", text: data.note, ...withMeta };
  }
  const proposal = data.proposal;
  if (!proposal || !Array.isArray(proposal.actions)) {
    throw new Error("AI хэрэгжих санал буцааж чадсангүй. Илүү тодорхой зааварчилгаар дахин оролдоно уу.");
  }
  const requestId = typeof data.request_id === "number" ? data.request_id : null;
  if (proposal.actions.length === 0) return zeroActionMessage(proposal, requestId, ctx.id, meta);
  return proposalMessage(proposal, requestId, ctx, meta);
}

export function proposalMessage(proposal: AIProposal, requestId: number | null, ctx: ReplyContext, meta?: ReplyMeta): AssistantProposalMsg {
  const sourceNames = ctx.sourceNames || [];
  return {
    id: ctx.id, role: "assistant", kind: "proposal", proposal, requestId,
    instruction: ctx.instruction ?? ctx.sent,
    sourceNames, sourceText: ctx.sourceText || "",
    status: "pending", confirmChecked: false,
    clarifications: buildProposalClarifications(proposal, [], sourceNames),
    clarificationAnswers: [], answeredClarificationIds: [], customReply: "",
    ...(meta ? { meta } : {}),
  };
}

/* ---------------------------------------------------------------- */
/* The thread across a reload (sessionStorage)                      */
/* ---------------------------------------------------------------- */

export const THREAD_KEY = "uudam.admin.assistant.thread.v1";
/** The server reads the last turns of the same session within six hours (assistantLog.ts). */
export const THREAD_TTL_MS = 6 * 3_600_000;
const MAX_STORED_MESSAGES = 60;
const MAX_STORED_CHARS = 1_500_000;

type StoredThread = { v: 1; sessionId: string; savedAt: number; messages: AssistantChatMessage[] };

/**
 * The thread as stored, or null when there is nothing worth keeping (only the greeting). A
 * proposal's save lock is kept: a save still running on the server when the page reloads must
 * keep Save off on the restored card (restoreThread).
 */
export function serializeThread(sessionId: string, messages: AssistantChatMessage[], now = Date.now()): string | null {
  if (!sessionId || messages.filter((message) => message.id !== "intro").length === 0) return null;
  let kept = messages.slice(-MAX_STORED_MESSAGES);
  let json = JSON.stringify({ v: 1, sessionId, savedAt: now, messages: kept } satisfies StoredThread);
  if (json.length > MAX_STORED_CHARS) {
    kept = kept.slice(-30).map((message) => (message.role === "assistant" && message.kind === "proposal" ? { ...message, sourceText: "" } : message));
    json = JSON.stringify({ v: 1, sessionId, savedAt: now, messages: kept } satisfies StoredThread);
  }
  return json.length > MAX_STORED_CHARS ? null : json;
}

function isMessage(value: unknown): value is AssistantChatMessage {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string") return false;
  if (row.role === "admin") return typeof row.text === "string";
  if (row.role !== "assistant") return false;
  if (row.kind === "note" || row.kind === "ask") return typeof row.text === "string";
  if (row.kind === "proposal") {
    const proposal = row.proposal as Record<string, unknown> | undefined;
    return Boolean(proposal && Array.isArray(proposal.actions) && Array.isArray(row.clarifications));
  }
  return false;
}

/** The card's line when the page reloaded while a stored proposal was saving: its answer is lost. */
export const RELOAD_DURING_SAVE_TEXT =
  "Хадгалж байх үед хуудас дахин ачаалагдсан — өөрчлөлт хадгалагдсан эсэх тодорхойгүй. «Хадгалах»-ыг дахин дарвал хадгалагдсан эсэхийг шалгаад, хадгалагдаагүй бол хадгална.";
/** The same for a proposal with no stored request: nothing can tell whether it was saved, so it is never saved again. */
export const RELOAD_DURING_DIRECT_SAVE_TEXT =
  "Хадгалж байх үед хуудас дахин ачаалагдсан — өөрчлөлт хадгалагдсан эсэх тодорхойгүй. Давхар хадгалахгүйн тулд «Аяллууд» хэсгээс шалгаад, шаардлагатай бол зааврыг дахин илгээнэ үү.";

/** True while Save must stay off: an earlier save of this proposal may still be running on the server. */
export function isSaveLocked(message: Pick<AssistantProposalMsg, "saveLockedUntil">, now = Date.now()): boolean {
  return typeof message.saveLockedUntil === "number" && message.saveLockedUntil > now;
}

/** Ends a save lock — only the one that was set (a newer save keeps its own). */
export function unlockSave(messages: AssistantChatMessage[], id: string, until: number): AssistantChatMessage[] {
  return messages.map((message) =>
    message.id === id && message.role === "assistant" && message.kind === "proposal" && message.saveLockedUntil === until
      ? { ...message, saveLockedUntil: undefined }
      : message,
  );
}

/**
 * A proposal as a reload finds it. A lock on a pending card with no answer recorded means the
 * page reloaded while its save was running: the answer will never arrive, so the outcome is
 * unknown. A stored request keeps Save off until the server has certainly stopped, then a second
 * Save asks the server ("Өмнө нь хадгалагдсан байна" when it went through). A proposal with no
 * stored request is never saved again (that could save it twice).
 */
function restoredProposal(message: AssistantProposalMsg, now: number): AssistantProposalMsg {
  const { saveLockedUntil, ...unlocked } = message;
  const lock = typeof saveLockedUntil === "number" && saveLockedUntil > now ? { saveLockedUntil } : {};
  if (saveLockedUntil === undefined) return message;
  if (message.status !== "pending") return unlocked;
  if (message.saveUnknown) return { ...unlocked, ...lock };
  if (message.requestId == null) {
    return { ...unlocked, status: "error", saveUnknown: true, saveError: undefined, resultText: RELOAD_DURING_DIRECT_SAVE_TEXT };
  }
  return { ...unlocked, ...lock, saveUnknown: true, saveError: RELOAD_DURING_SAVE_TEXT };
}

/** The stored thread when it is recent enough for the server to remember it too; null otherwise. */
export function restoreThread(raw: string | null | undefined, now = Date.now()): { sessionId: string; messages: AssistantChatMessage[] } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredThread>;
    if (parsed?.v !== 1 || typeof parsed.sessionId !== "string" || !parsed.sessionId) return null;
    if (typeof parsed.savedAt !== "number" || now - parsed.savedAt > THREAD_TTL_MS || parsed.savedAt > now + 60_000) return null;
    const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).filter(isMessage)
      .map((message) => (message.role === "assistant" && message.kind === "proposal" ? restoredProposal(message, now) : message));
    return messages.length ? { sessionId: parsed.sessionId, messages } : null;
  } catch {
    return null;
  }
}
