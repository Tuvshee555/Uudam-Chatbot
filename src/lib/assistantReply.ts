/**
 * One typed instruction in, one reply out. Since 2026-11-06 the admin assistant works like a
 * colleague: every typed instruction goes to the agent (src/lib/assistantAgent), which reads
 * the catalogue with tools, keeps every part of a multi-part message, reads pasted links,
 * and ends with a proposal, one question with buttons, or a plain answer.
 *
 * What stays in code, exactly as before:
 * - a tapped BRAIN option (its answer carries trip_id=… / [огноо: …]) goes back to the brain;
 * - small talk ("сайн уу", "за", "баярлалаа") is answered in code and costs nothing;
 * - a bulk paste (a price list) goes to the model whole, as one source;
 * - no database → one plain note; the day's AI budget spent or the model unreachable → the
 *   brain does the exact single edits it understands, and says so on the card;
 * - partner watch (src/lib/partnerWatch/assistant.ts): a pasted link a trip was already made from
 *   is asked about (check that trip's page now, or add it again as a new trip), and the tapped
 *   check reads the page and proposes the seat and fare changes — no model in either.
 * A partner page or a pasted program the agent hands back becomes the usual new-trip review
 * card through the file pipeline; the new trip keeps the page as extra.source_url. Every
 * proposal is stored and reviewed before anything is saved.
 */
import {
  parseIntent, stripAnswerTags, think, withTripTag, type AssistantAskPayload,
} from "./assistantBrain";
import { runAgent } from "./assistantAgent/agent";
import { defaultAgentDeps } from "./assistantAgent/deps";
import { identityLinks, resolveLinksInText, urlsInText } from "./assistantAgent/links";
import { openProposalRoute, unsavedTripLinkNote, type OpenProposal } from "./assistantAgent/openProposals";
import { isFileProposal, loadChangeRequest, saveRevisedProposal } from "./assistantAgent/requests";
import { hasBrainTokens } from "./assistantAgent/turn";
import type { AgentAttachment, AgentDeps, AgentOutcome, AnswerTo } from "./assistantAgent/types";
import { assistantContextText, type AssistantTurn } from "./assistantLog";
import { aiBudgetMessage, aiBudgetState } from "./aiUsage";
import { logError, logInfo, recordCounter } from "./observability";
import { duplicateLinkAsk, forcesNewTrip, partnerCheckReply, watchCheckTripId, withoutWatchTags, withSourceUrl } from "./partnerWatch/assistant";
import { partnerPageReader } from "./partnerWatch/run";
import { crossCheckProposal } from "./partnerWatch/crossCheck";
import { ensureTravelSchema, findTripMatches, listTrips } from "./travelDb";
import { generateAIProposal, generateAIProposalFromContentBatched, persistProposal, reviseAIRequest } from "./travelAI";
import { validateAIChangeProposal } from "./travelAIValidation";
import type { AIChangeProposal, AITripAction, TravelTrip } from "./travelTypes";

export type AssistantReply = (
  | { kind: "proposal"; proposal: AIChangeProposal; request_id: number | null; source: "brain" | "model" | "agent" | "file" }
  | { kind: "ask"; ask: AssistantAskPayload; source?: "brain" | "agent" }
  | { kind: "note"; text: string }
) & {
  /** The agent's tool calls in order (search_trips, get_trip, …), for the page's progress line and the logs. */
  steps?: string[];
};

export const DB_DOWN_NOTE = "Өгөгдлийн сан холбогдоогүй байна — одоогоор өөрчлөлт хадгалах, хэрэгжүүлэх боломжгүй. Хэдэн минутын дараа дахин оролдоно уу; үргэлжилбэл «Систем» хэсгийг шалгаарай.";

// A paste this big is a list, not an instruction: the model reads it whole (and in
// batches when it is a price list), the brain never reads one line of it as the command.
const BULK_CHARS = 1_500;
const BULK_LINES = 8;
const FREE_CHATTER = new Set(["empty", "greeting", "thanks", "ack", "no", "help"]);

export function looksLikeBulkText(instruction: string): boolean {
  return instruction.length >= BULK_CHARS || instruction.split(/\r?\n/).filter((line) => line.trim()).length >= BULK_LINES;
}

export type AssistantReplyOptions = {
  /** The conversation as text (the brain's form); built from `turns` when absent. */
  context?: string;
  turns?: AssistantTurn[];
  now?: Date;
  /** The open question a typed answer belongs to (the page echoes the ask's answer_to). */
  answerTo?: AnswerTo | null;
  /** Images the page already hosted, sent with the instruction. */
  attachments?: AgentAttachment[];
  /** New-trip cards open on the page and not saved yet (assistantAgent/openProposals.ts). */
  openProposals?: OpenProposal[];
  /** Tests: the agent's model and outside world. */
  agentDeps?: Partial<AgentDeps>;
};

type Trips = TravelTrip[];

async function readCatalogue(): Promise<Trips | null> {
  const ready = await ensureTravelSchema().catch(() => false);
  if (!ready) return null;
  try {
    return await listTrips({ limit: 250, includeArchived: true });
  } catch (error) {
    // A warm instance keeps "schema ensured" while the database goes away: the read fails here.
    logError("assistant.catalogue_unreadable", { message: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

async function modelReply(instruction: string, options: { context?: string; trips: Trips }): Promise<AssistantReply> {
  const budget = await aiBudgetState();
  if (budget.exceeded) {
    recordCounter("ai.budget_stop_total", 1, { route: "api.admin.ai_change" });
    return { kind: "note", text: aiBudgetMessage(budget) };
  }
  const generated = await generateAIProposal(instruction, { context: options.context, trips: options.trips });
  return { kind: "proposal", proposal: generated.proposal, request_id: generated.request_id, source: "model" };
}

/** The instruction a stored request or a log line keeps for a typed answer: the question's instruction and the answer. */
export function answeredInstruction(instruction: string, answerTo?: AnswerTo | null): string {
  const asked = String(answerTo?.instruction || "").trim();
  return asked ? `${asked}\n— хариулт: ${instruction}` : instruction;
}

/**
 * The brain's card checked the way save checks it (a partner trip's price, a day the website
 * does not have): each blocked part is dropped and said on the card; nothing left → a note. The
 * brain's own actions are kept as they are — the validator only decides.
 */
export function checkedBrainProposal(proposal: AIChangeProposal, trips: Trips, now?: Date): { proposal: AIChangeProposal } | { note: string } {
  const blocked: string[] = [];
  const actions = proposal.actions.filter((action) => {
    const report = validateAIChangeProposal({ ...proposal, conflicts: [], conflict_items: [], actions: [action] }, trips, { now });
    blocked.push(...report.blocking_conflicts);
    return report.blocking_conflicts.length === 0 && report.proposal.actions.length > 0;
  });
  const reasons = [...new Set(blocked)];
  if (!actions.length) return { note: reasons.join(" ") || "Өөрчлөх зүйл алга." };
  if (!reasons.length) return { proposal };
  const conflict_items = [...(proposal.conflict_items || []), ...reasons.map((text) => ({ text, severity: "warning" as const, type: "brain_refused" }))];
  return { proposal: { ...proposal, actions, conflict_items, conflicts: conflict_items.map((item) => item.text) } };
}

/**
 * The brain alone (no model): the day's budget is spent or the model cannot be reached. A typed
 * answer is read together with the question's instruction (B4); a pasted trip link names its
 * trip, and one that names none edits nothing (B1). Only an exact single edit is proposed, and
 * only what save would accept.
 */
async function brainFallback(instruction: string, trips: Trips, options: AssistantReplyOptions & { why: string; deps: AgentDeps }): Promise<AssistantReply> {
  let text = options.answerTo?.instruction ? `${stripAnswerTags(options.answerTo.instruction)} ${instruction}` : instruction;
  const links = identityLinks(await resolveLinksInText(text, trips, options.deps));
  if (links.length) {
    const ids = [...new Set(links.map((link) => link.trip_id).filter((id): id is string => Boolean(id)))];
    const trip = ids.length === 1 && links.every((link) => link.trip_id) ? trips.find((entry) => entry.id === ids[0]) : undefined;
    if (!trip) return { kind: "note", text: `${options.why}\n\nХолбоосоос аль аялал болохыг олж чадсангүй, тиймээс юу ч өөрчлөхгүй.` };
    text = withTripTag(text, trip);
  }
  const outcome = think({ text, trips, now: options.now, context: options.context });
  logInfo("assistant.brain", { outcome: outcome.kind, intent: outcome.intent.kind, fallback: true });
  if (outcome.kind === "proposal") {
    const checked = checkedBrainProposal(outcome.proposal, trips, options.now);
    if ("note" in checked) return { kind: "note", text: `${options.why}\n\n${checked.note}` };
    const proposal = checked.proposal;
    const line = `${options.why} Энгийн горимоор (нэг мессежид нэг өөрчлөлт) уншлаа — өөр хэсэг байсан бол тусад нь бичнэ үү.`;
    proposal.conflict_items = [...(proposal.conflict_items || []), { text: line, severity: "info", type: "ai_fallback" }];
    proposal.conflicts = proposal.conflict_items.map((item) => item.text);
    const request_id = await persistProposal(answeredInstruction(instruction, options.answerTo), proposal);
    return { kind: "proposal", proposal, request_id, source: "brain" };
  }
  if (outcome.kind === "ask") return { kind: "ask", ask: outcome.ask, source: "brain" };
  // A message with several kinds of change: the simple mode says why it reads one at a time.
  if (outcome.kind === "note") return { kind: "note", text: outcome.intent.kind === "several_changes" ? `${options.why}\n\n${outcome.text}` : outcome.text };
  return { kind: "note", text: options.why };
}

const EXISTING_TRIP_KEPT = "existing_trip_kept";
// The validator's English line for a cancel the reading proposed (it goes with the cancel).
const READER_CANCEL_LINE = /cancels a trip and should be reviewed/i;

/**
 * A partner page or a pasted program read for a NEW trip may only add trips (house rule 1;
 * page text is data, never an order). Whatever the reading would do to a trip already in the
 * catalogue — a patch, a cancel, a same-name update, a "which trip?" question that holds such
 * an edit — never reaches the card; it becomes one line: «X» бүртгэлд байна — шинэчлэх бол
 * тусад нь хэлнэ үү. Runs on the validated proposal, before it is stored.
 */
export function keepNewTripsOnly(proposal: AIChangeProposal, trips: TravelTrip[]): AIChangeProposal {
  const removed: string[] = [];
  const nameOf = (action: AITripAction): string =>
    String(trips.find((trip) => trip.id === action.trip_id)?.route_name || action.match?.route_name || action.fields?.route_name || "").trim();
  const actions = proposal.actions.filter((action) => {
    const creates = String(action.action || "").toLowerCase() === "upsert" && !action.trip_id
      && !(action.match && findTripMatches(trips, action.match.operator_name, action.match.route_name).length > 0);
    if (!creates) removed.push(nameOf(action));
    return creates;
  });
  const questions = (proposal.questions || []).filter((question) => {
    // A "which trip?" question carries an edit of an existing trip, waiting for the tap.
    const holdsEdit = String(question.id || "").startsWith("trip:");
    if (holdsEdit) removed.push(String(question.data?.route_name || "").trim());
    return !holdsEdit;
  });
  if (!removed.length) return proposal;
  const names = [...new Set(removed)];
  const lines = names.map((name) => (name
    ? `«${name}» бүртгэлд байна — шинэчлэх бол тусад нь хэлнэ үү.`
    : "Бүртгэлд байгаа аяллыг энэ эх сурвалжаар өөрчлөхгүй — шинэчлэх бол тусад нь хэлнэ үү."));
  // The validator's lines about the dropped edits go with them (a blocker there would stop the new trip's save).
  const aboutRemoved = (text: string, type?: string) => type !== "same_name_exists"
    && (READER_CANCEL_LINE.test(text) || names.some((name) => name && text.includes(name)));
  const conflictItems = [
    ...(proposal.conflict_items || []).filter((item) => !aboutRemoved(item.text, item.type)),
    ...lines.map((text) => ({ text, severity: "info" as const, type: EXISTING_TRIP_KEPT })),
  ];
  const created = actions.map((action) => String(action.fields?.route_name || "").trim()).filter(Boolean);
  const next: AIChangeProposal = {
    ...proposal,
    summary: created.length ? `Шинэ аялал: ${created.map((name) => `«${name}»`).join(", ")}.` : "Энэ эх сурвалжаас шинэ аялал гарсангүй.",
    actions,
    conflict_items: conflictItems,
    conflicts: [...(proposal.conflicts || []).filter((text) => !aboutRemoved(text)), ...lines],
  };
  if (questions.length) next.questions = questions;
  else delete next.questions;
  return next;
}

/** A partner page or a pasted program: the file pipeline's usual new-trip review card (new trips only). */
async function tripSourceReply(outcome: Extract<AgentOutcome, { kind: "trip_source" }>): Promise<AssistantReply> {
  const budget = await aiBudgetState();
  if (budget.exceeded) return { kind: "note", text: aiBudgetMessage(budget) };
  try {
    // A trip made from a page keeps that page, so the partner watch can check it again (partnerWatch/).
    const checkedAt = new Date().toISOString();
    const afterValidation = (proposal: AIChangeProposal, catalogue: TravelTrip[]) => crossCheckProposal(withSourceUrl(keepNewTripsOnly(proposal, catalogue), outcome.url, checkedAt), outcome.text);
    const result = await generateAIProposalFromContentBatched({ label: outcome.label, note: outcome.note, contentText: outcome.text, afterValidation });
    const kept = (result.proposal.conflict_items || []).filter((item) => item.type === EXISTING_TRIP_KEPT).map((item) => item.text);
    if (!result.proposal.actions.length && kept.length) {
      return { kind: "note", text: ["Энэ эх сурвалжаас шинэ аялал гарсангүй.", ...kept].join(" ") };
    }
    return { kind: "proposal", proposal: result.proposal, request_id: result.request_id, source: "file" };
  } catch (error) {
    logError("assistant.trip_source_failed", { message: error instanceof Error ? error.message : String(error) });
    return { kind: "note", text: "Хуудсыг шинэ аялал болгон уншиж чадсангүй. Текстийг нь хуулж оруулах эсвэл файлаар оруулна уу." };
  }
}

export async function generateAssistantReply(typed: string, options: AssistantReplyOptions = {}): Promise<AssistantReply> {
  const trips = await readCatalogue();
  if (!trips) return { kind: "note", text: DB_DOWN_NOTE };
  // A tapped «Хуваарь, суудлыг шинэчлэх»: the partner watch checks that trip's page now (no model).
  const checkTripId = watchCheckTripId(typed);
  if (checkTripId) {
    // The page is read with the agent's fetcher (the SSRF-safe safeFetch; a fixture in tests).
    const fetcher = options.agentDeps?.safeFetch;
    const checked = await partnerCheckReply(checkTripId, trips, { now: options.now, ...(fetcher ? { fetchPage: partnerPageReader(fetcher) } : {}) });
    return checked.kind === "proposal" ? { ...checked, source: "agent" } : checked;
  }
  const instruction = withoutWatchTags(typed);
  const context = options.context ?? assistantContextText(options.turns || []);
  const answering = Boolean(options.answerTo?.question);
  const attachments = options.attachments || [];
  if (!answering && !attachments.length && looksLikeBulkText(instruction)) {
    // Pages of text with not one number in them are neither a price list nor an instruction.
    if (!/\d/.test(instruction)) return { kind: "note", text: "Энэ урт текстэнд огноо, үнэ, тоо алга — юуг өөрчлөхийг нэг өгүүлбэрээр бичээрэй, эсвэл файлаа оруулаарай." };
    return modelReply(instruction, { context, trips });
  }
  // A tapped brain option: its tokens are read in code, exactly as before.
  if (hasBrainTokens(instruction)) {
    const outcome = think({ text: instruction, trips, now: options.now, context });
    if (outcome.kind === "proposal") {
      const checked = checkedBrainProposal(outcome.proposal, trips, options.now);
      if ("note" in checked) return { kind: "note", text: checked.note };
      const request_id = await persistProposal(instruction, checked.proposal);
      return { kind: "proposal", proposal: checked.proposal, request_id, source: "brain" };
    }
    if (outcome.kind === "ask") return { kind: "ask", ask: outcome.ask, source: "brain" };
    if (outcome.kind === "note") return { kind: "note", text: outcome.text };
  }
  // A link a trip was already made from is not read again as a new trip unless he says so (in code, before the model).
  if (!answering && !attachments.length && !forcesNewTrip(typed)) {
    const known = duplicateLinkAsk(instruction, trips, options.now);
    // Answered in code on purpose: marked as the brain, the page said «Энгийн горим — AI түр ажиллахгүй» under it.
    if (known) return { kind: "ask", ask: known, source: "agent", steps: ["resolve_link"] };
  }
  // Small talk is answered in code; it never costs a model call. A bare link is not small talk.
  if (!answering && !attachments.length && !urlsInText(instruction).length) {
    const intent = parseIntent(instruction, options.now);
    if (intent.kind === "chatter" && (FREE_CHATTER.has(intent.topic) || (intent.topic === "gibberish" && !/\d/.test(instruction)))) {
      const outcome = think({ text: instruction, trips, now: options.now, context });
      if (outcome.kind === "note") return { kind: "note", text: outcome.text };
    }
  }

  // A message about a trip still on an unsaved card changes that card, never a saved trip (2026-11-14).
  if (!answering && !attachments.length && options.openProposals?.length) {
    const opened = await openCardReply(instruction, options.openProposals, trips, options);
    if (opened) return opened;
  }

  const deps = { ...defaultAgentDeps(), ...(options.agentDeps || {}) } as AgentDeps;
  const run = await runAgent({ instruction, trips, turns: options.turns, answerTo: options.answerTo, attachments, today: options.now, deps });
  const outcome = run.outcome;
  if (outcome.kind === "note" && outcome.reason === "budget") {
    recordCounter("ai.budget_stop_total", 1, { route: "api.admin.ai_change" });
    return brainFallback(instruction, trips, { ...options, context, why: outcome.text, deps });
  }
  if (run.modelFailure && run.modelFailure !== "timeout" && outcome.kind === "note") {
    return brainFallback(instruction, trips, { ...options, context, why: outcome.text, deps });
  }
  const steps = run.tools;
  if (outcome.kind === "proposal") {
    const request_id = await persistProposal(answeredInstruction(instruction, options.answerTo), outcome.proposal);
    return { kind: "proposal", proposal: outcome.proposal, request_id, source: "agent", steps };
  }
  if (outcome.kind === "ask") return { kind: "ask", ask: outcome.ask, source: "agent", steps };
  if (outcome.kind === "trip_source") return { ...(await tripSourceReply(outcome)), steps };
  return { kind: "note", text: outcome.text, steps };
}

/**
 * The open card the message is about: its link is not there yet (a note), or the card is read
 * again with the message. Null — the card is gone, saved or out of date, or the message is about
 * something else — and the message goes to the agent as usual.
 */
async function openCardReply(instruction: string, open: OpenProposal[], trips: Trips, options: AssistantReplyOptions): Promise<AssistantReply | null> {
  const route = openProposalRoute(instruction, open, trips);
  if (!route) return null;
  const loaded = await loadChangeRequest(route.target.request_id);
  if (!loaded.ok || loaded.request.status !== "pending" || loaded.request.expired) return null;
  if (route.kind === "link") return { kind: "note", text: unsavedTripLinkNote(route.name), steps: ["open_card"] };
  const budget = await aiBudgetState();
  if (budget.exceeded) return { kind: "note", text: aiBudgetMessage(budget) };
  const revised = await reviseStoredProposal(route.target.request_id, instruction, options);
  logInfo("assistant.open_card", { request_id: route.target.request_id, ok: revised.ok });
  if (!revised.ok) return null;
  if (revised.note) return { kind: "note", text: revised.note, steps: ["open_card"] };
  return { kind: "proposal", proposal: revised.proposal, request_id: revised.request_id, source: "file", steps: ["open_card"] };
}

/* ---------------------------------------------------------------- */
/* Clarifying a stored proposal (the admin is still reviewing it)    */
/* ---------------------------------------------------------------- */

export type RevisionReply =
  | { ok: true; proposal: AIChangeProposal; request_id: number; requires_confirmation: boolean; note?: string }
  | { ok: false; message: string };

/**
 * A clarification on a stored proposal. A tapped trip choice and a file reading's own
 * questions (new trip: transport, price, photos) keep their reviser; every other answer goes
 * through the agent, and what it produces is validated, bound to real trips and
 * version-stamped like any agent proposal before it replaces the stored one (B9).
 */
export async function reviseStoredProposal(requestId: number, clarification: string, options: AssistantReplyOptions = {}): Promise<RevisionReply> {
  const loaded = await loadChangeRequest(requestId);
  if (!loaded.ok) return loaded;
  const { request } = loaded;
  if (request.status === "applied") return { ok: false, message: "Request is already applied." };
  if (request.expired) return { ok: false, message: "Энэ санал 24 цагаас хуучирсан. Зааврыг дахин илгээнэ үү." };
  if (hasBrainTokens(clarification) || isFileProposal(request.proposal)) {
    const revised = await reviseAIRequest(requestId, clarification);
    return revised.ok && revised.proposal
      ? { ok: true, proposal: revised.proposal, request_id: requestId, requires_confirmation: Boolean(revised.requires_confirmation) }
      : { ok: false, message: String((revised as { message?: unknown }).message || "Тодруулгыг хэрэгжүүлж чадсангүй.") };
  }
  const trips = await readCatalogue();
  if (!trips) return { ok: false, message: DB_DOWN_NOTE };
  const deps = { ...defaultAgentDeps(), ...(options.agentDeps || {}) } as AgentDeps;
  const run = await runAgent({
    instruction: clarification, trips, turns: options.turns, today: options.now, deps,
    revising: { requestId, instruction: request.instruction, proposal: request.proposal },
  });
  const outcome = run.outcome;
  if (outcome.kind === "proposal") {
    await saveRevisedProposal(requestId, outcome.proposal);
    return { ok: true, proposal: outcome.proposal, request_id: requestId, requires_confirmation: true };
  }
  if (outcome.kind === "ask") {
    // The question goes on the card as buttons; the card stays unsaved until it is answered.
    const proposal: AIChangeProposal = {
      ...request.proposal,
      needs_confirmation: true,
      questions: [{ id: "agent", prompt: outcome.ask.text, options: outcome.ask.options, allow_custom: true, custom_placeholder: outcome.ask.custom_placeholder }],
    };
    await saveRevisedProposal(requestId, proposal);
    return { ok: true, proposal, request_id: requestId, requires_confirmation: true };
  }
  if (outcome.kind === "note" && (outcome.reason === "budget" || run.modelFailure)) return { ok: false, message: outcome.text };
  const note = outcome.kind === "note" ? outcome.text : "Энэ тодруулгаар шинэ аялал нэмэхгүй — шинэ аяллыг тусад нь илгээнэ үү.";
  return { ok: true, proposal: request.proposal, request_id: requestId, requires_confirmation: true, note };
}
