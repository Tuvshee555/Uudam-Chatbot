/**
 * The assistant conversation as the admin page keeps it. These extend the base chat
 * messages in src/lib/adminTypes.ts with what the agent-era route returns (how a reply was
 * made, the open question's context, a stored request a question belongs to) without
 * changing the shared types other tabs read.
 */
import type { AdminMsg, AIProposal, AskMsg, NoteMsg, ProposalMsg, ProposalQuestionOption } from "@/lib/adminTypes";

/** Who built a reply: the agent, the code-side brain, the bulk model path, or the file reader. */
export type ReplySource = "agent" | "brain" | "model" | "file";

/** How a reply was made, shown as one small line under it. */
export type ReplyMeta = {
  source?: ReplySource;
  /** The brain alone answered because the model was unavailable («энгийн горим»). */
  simple?: boolean;
  /** The agent's tool calls in order (search_trips, get_trip, read_web_page, …). */
  steps?: string[];
};

/** The open question a typed answer belongs to: the route sends it with the ask and gets it back. */
export type AnswerToRef = { id?: string; question: string; instruction?: string };

export type AssistantAdminMsg = AdminMsg & {
  /** Photos sent with the instruction, already on our Cloudinary (shown as thumbnails). */
  imageUrls?: string[];
};

export type AssistantAskMsg = AskMsg & {
  answerTo?: AnswerToRef;
  /**
   * The stored proposal this question belongs to (a proposal with no actions yet): the answer
   * goes back as a clarification on that request, not as a new instruction.
   */
  requestId?: number | null;
  meta?: ReplyMeta;
};

export type AssistantNoteMsg = NoteMsg & { meta?: ReplyMeta };

export type AssistantProposalMsg = ProposalMsg & {
  meta?: ReplyMeta;
  /** The stored request was older than a day; saving was refused (409 proposal_expired). */
  expired?: boolean;
  /**
   * Epoch ms until which Save stays off: the server may still be saving an earlier attempt. Set
   * before the save request goes out and cleared by any definite answer, so a save still running
   * when the page reloads keeps Save off on the restored card too (it is stored with the thread).
   */
  saveLockedUntil?: number;
  /**
   * The last save got no answer: it may or may not have been saved. `saveError` (or `resultText`
   * on an unsaved proposal, which is never saved again) holds the plain explanation. Shown as
   * "unknown", never as «Хадгалагдсангүй» — that word is for a refusal that left nothing saved.
   */
  saveUnknown?: boolean;
};

export type AssistantChatMessage = AssistantAdminMsg | AssistantAskMsg | AssistantNoteMsg | AssistantProposalMsg;

/** The ask as /api/admin/ai-change returns it. */
export type AssistantAskPayload = {
  id?: string;
  text: string;
  options?: ProposalQuestionOption[];
  allow_custom?: boolean;
  custom_placeholder?: string;
  answer_to?: AnswerToRef;
};

/** Every field the assistant route may answer with (instruction, clarification, quick action). */
export type AssistantResponse = {
  ok?: boolean;
  proposal?: AIProposal;
  ask?: AssistantAskPayload;
  note?: string;
  request_id?: number | null;
  source?: ReplySource;
  steps?: string[];
  requires_confirmation?: boolean;
  error?: string;
  message?: string;
  results?: string[];
  retry_after_ms?: number;
  reset?: number;
  max_chars?: number;
};

/** An image the agent receives with the instruction (hosted by the page first). */
export type AssistantAttachment = { url: string; kind: "image" };
