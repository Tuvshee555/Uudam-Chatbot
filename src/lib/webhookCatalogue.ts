/**
 * The corporate catalogue inside a Messenger turn (webhook.ts calls handleCatalogueTurn; the rest of
 * the feature lives in src/lib/catalogue/). Same pattern as webhookMedia.ts / webhookPhotoOnly.ts:
 * webhook.ts keeps a few lines, this file owns the behaviour.
 *
 * What a turn can be:
 *   - a catalogue request ("байгууллагын аяллуудаа харуул", "каталог явуул", "all tours")
 *       -> ONE PDF + ONE short text (send.ts), or a staff lead when it cannot go
 *   - a trip-code reply ("A01, 25 хүн, 1-р сар")
 *       -> the trip is selected, a structured staff lead is written, ONE acknowledgement
 *   - a group quotation ("30 хүнтэй байгууллагын аялалд үнийн санал")
 *       -> a staff lead and ONE text asking what staff need; the PDF is not the end of the sale
 *   - anything else -> false: the existing flow answers
 *
 * Owner's rules kept here: a specific-trip question is never hijacked (named trip, or a trip
 * already under discussion); unknown data means silence + a staff lead; nothing here books,
 * quotes or promises; every customer-facing word leaves through deliverFastPathReply.
 */
import { appendMessage } from "./conversation";
import { classifyError, hashIdentifier, logError, logInfo, logWarn, recordCounter } from "./observability";
import { noteInbound } from "./inboundTrace";
import { latestCustomerLead, recordLeadFollowup } from "./travelLeadsDb";
import { ensureDurableLead } from "./durableLead";
import { isRetryableWebhookError } from "./webhookDedup";
import { isStaffTakeoverSendBlocked } from "./takeoverGuard";
import { resolveTripFromUserMessage } from "./travelFastPathsSearch";
import { setTripSelection } from "./tripSelectionState";
import { extractPhoneNumber } from "./webhookMedia";
import { analyzeCatalogueText, detectCatalogueIntent, isBareResendRequest, isSoftCatalogueRequest } from "./catalogue/intent";
import { extractGroupSize, extractMonth, parseAllTripCodes, parseTripCodeRequest, readTripCode, type TripCodeReading } from "./catalogue/tripCodeRequest";
import { CATALOGUE_BLOCK_REASON_TEXT, catalogueEditionOfCaption, catalogueLeadContext, groupQuoteLeadContext, groupQuoteText, tripCodeAckText, tripCodeLeadContext } from "./catalogue/messages";
import { REPEAT_ANSWERED_REASON, deliverCatalogue, planCatalogueDelivery, resolveSendDeps, type SendDeps } from "./catalogue/send";
import type { CatalogueDeliveryStatus } from "./catalogue/types";
import type { TravelTrip } from "./travelTypes";

type Reply = {
  reply: string; failTag: string; rememberSource: string; counter?: string; catalogTripIds?: string[]; afterDeliver?: () => Promise<void>;
};

export type CatalogueTurnContext = {
  platform: "facebook" | "instagram";
  senderId: string;
  pageId: string;
  /** The page (or Instagram) token this reply is sent with. */
  token: string | null | undefined;
  text: string;
  trace?: { requestId: string; correlationId: string; source: string; deliveryKey?: string };
  history: ReadonlyArray<{ role: string; text: string }>;
  /** A trip is selected or on offer in this conversation (webhook.ts: selection / clarification state). */
  hasTripContext: boolean;
  /** The trips a customer may be told about (hidden ones left out, customer-safe). */
  getTrips: () => Promise<TravelTrip[]>;
  /** webhook.ts deliverFastPathReply: grounding, no-data silence, delivery, history. false = withheld. */
  deliver: (input: Reply) => Promise<boolean>;
  /** webhook.ts captureLead: a durable staff lead (one open lead per kind; see recordLead). */
  captureLead: (input: { kind: "handoff"; context: string; contactPhone?: string }) => Promise<{ created: boolean }>;
  now?: () => Date;
};

export type CatalogueWebDeps = {
  /** Trip id behind a catalogue code, or null. */
  resolveTripCode: (code: string) => Promise<string | null>;
  send: Partial<SendDeps>;
};

let testDeps: Partial<CatalogueWebDeps> | null = null;
/** Journeys swap the store and Meta for fakes here; pass null to restore the real ones. */
export function setCatalogueWebDepsForTests(deps: Partial<CatalogueWebDeps> | null) {
  testDeps = deps;
}
function webDeps(): CatalogueWebDeps {
  return {
    resolveTripCode: async (code) => (await import("./catalogue/store")).resolveTripCode(code),
    send: {},
    ...(testDeps || {}),
  };
}

/**
 * The staff lead for this turn: a new lead, or a line on the customer's open one (never lost, never
 * doubled). A phone number typed in the same message is kept: this runs before the flow's own phone capture.
 */
async function recordLead(ctx: Pick<CatalogueTurnContext, "captureLead" | "senderId" | "text">, context: string): Promise<void> {
  const phone = extractPhoneNumber(ctx.text);
  const written = phone ? `${context}
Утас: ${phone}` : context;
  const result = await ctx.captureLead({ kind: "handoff", context: written, ...(phone ? { contactPhone: phone } : {}) });
  if (result.created) return;
  const open = await latestCustomerLead(ctx.senderId).catch(() => null);
  if (open) await recordLeadFollowup(open.id, written).catch(() => false);
}

/** The edition the bot sent last in this conversation, found by its own caption. */
function lastCatalogueEdition(history: CatalogueTurnContext["history"]): "quick" | "complete" | null {
  for (let index = history.length - 1; index >= Math.max(0, history.length - 30); index -= 1) {
    const message = history[index];
    if (message.role !== "assistant") continue;
    const edition = catalogueEditionOfCaption(message.text);
    if (edition) return edition;
  }
  return null;
}

/** True when the customer names a trip: the existing trip flow answers that, not the catalogue. */
async function namesASpecificTrip(ctx: CatalogueTurnContext): Promise<boolean> {
  try {
    const resolved = resolveTripFromUserMessage(ctx.text, await ctx.getTrips(), { allowLooseFallback: false });
    return resolved.status !== "not_found";
  } catch {
    return false;
  }
}

function logTurn(ctx: CatalogueTurnContext, event: string, fields: Record<string, unknown> = {}) {
  logInfo(event, { requestId: ctx.trace?.requestId, correlationId: ctx.trace?.correlationId, platform: ctx.platform, senderHash: hashIdentifier(ctx.senderId), ...fields });
}

const SILENT_STATUSES: ReadonlySet<CatalogueDeliveryStatus> = new Set([
  "duplicate_suppressed", "blocked_staff_owned", "blocked_paused", "blocked_window", "blocked_killswitch", "no_published_version", "failed", "dry_run",
]);

/**
 * One customer turn. Returns true when the catalogue feature handled it (the caller returns), false
 * when the message is none of its business (the existing flow answers).
 */
export async function handleCatalogueTurn(ctx: CatalogueTurnContext): Promise<boolean> {
  const text = ctx.text.trim();
  if (!text) return false;

  // A code reply, or a two-digit code inside a short sentence: handleCodeReply decides once it knows
  // the code. A question about a coded trip, or a code the store does not know, stays with the flow.
  const reading = readTripCode(text, { loose: true });
  if (reading && (await handleCodeReply(ctx, reading))) return true;

  let intent = detectCatalogueIntent(text);
  if (intent.kind === "none" && isBareResendRequest(text)) {
    const edition = lastCatalogueEdition(ctx.history);
    if (edition) intent = { kind: "catalogue", edition, resend: true, matched: "resend" };
  }
  if (intent.kind === "none") return false;

  // A specific-trip question keeps the existing flow: a named trip, or a trip already under discussion
  // ("брошюр явуул" after a trip card asks for THAT trip's brochure) unless the customer says company or
  // lists "all" of them as the thing they want ("бүх аяллаа"). A loose "all" ("энэ аялалд бүх зүйл
  // багтсан уу") and a company word next to "энэ"/"this" ("энэ аялал байгууллагад тохирох уу") are questions
  // about the trip under discussion.
  const signals = analyzeCatalogueText(text);
  if (intent.matched !== "resend") {
    const asksForTheOffer = (signals.corporate || signals.allListing) && !signals.demonstrative;
    if (ctx.hasTripContext && !asksForTheOffer) return false;
    if (await namesASpecificTrip(ctx)) return false;
  }
  if (intent.kind === "group_quote") return handleGroupQuote(ctx);

  const deps = resolveSendDeps(webDeps().send);
  const now = (ctx.now ? ctx.now() : new Date());
  const request = {
    senderId: ctx.senderId, pageId: ctx.pageId, pageToken: ctx.token || "", edition: intent.edition, explicitResend: intent.resend,
    lastInboundAt: now, trace: ctx.trace, platform: ctx.platform, dedupeKey: ctx.trace?.deliveryKey ?? null, customerText: text, deps: webDeps().send,
  };
  // A vague ask ("бүх аяллаа") the catalogue cannot serve right now is still answered by the trip flow.
  if (isSoftCatalogueRequest(text)) {
    const plan = await planCatalogueDelivery(request, deps).catch(() => null);
    if (!plan?.ready) {
      logTurn(ctx, "catalogue.soft_request_not_served", { reason: plan ? plan.reason : "plan_failed", status: plan ? plan.status : null });
      return false;
    }
  }

  await appendMessage(ctx.senderId, "user", text).catch(() => {});
  try {
    const outcome = await deliverCatalogue({
      ...request,
      sendText: ({ reply, failTag, afterDeliver }) => ctx.deliver({ reply, failTag, rememberSource: `api.webhook.${failTag}`, counter: `webhook.${failTag}_total`, afterDeliver }),
      captureLead: ({ context }) => recordLead(ctx, context),
    });
    // A repeat request answered with a pointer to the file already sent is not silence.
    if (SILENT_STATUSES.has(outcome.status) && outcome.reason !== REPEAT_ANSWERED_REASON) noteInbound((trace) => { trace.silent = `catalogue_${outcome.status}`; });
    logTurn(ctx, "catalogue.turn", { status: outcome.status, edition: intent.edition, explicitResend: intent.resend, matched: intent.matched, reason: outcome.reason });
    return true;
  } catch (error) {
    // A retry or a staff takeover is the webhook's to handle; anything else must not strand the customer.
    if (isRetryableWebhookError(error) || isStaffTakeoverSendBlocked(error)) throw error;
    logError("catalogue.turn_failed", { requestId: ctx.trace?.requestId, platform: ctx.platform, senderHash: hashIdentifier(ctx.senderId), classification: classifyError(error) });
    await recordLead(ctx, catalogueLeadContext({
      edition: intent.edition, reason: CATALOGUE_BLOCK_REASON_TEXT.failed, customerText: text, detail: "Системийн алдаа гарсан тул бот каталог илгээгээгүй.",
    }));
    noteInbound((trace) => { trace.silent = "catalogue_error"; });
    return true;
  }
}

/**
 * "A01, 25 хүн, 1-р сар": select the trip, write a structured lead, acknowledge once. Returns false
 * when the message is not ours after all:
 *   - it asks about the coded trip ("A01 хөтөлбөр юу вэ"): the trip is selected and the flow answers;
 *   - the code is unknown and was only found inside a sentence ("hotel C1 5 hun", "миний утас B21"):
 *     nothing about it says this was a catalogue reply, so nothing is consumed and no lead is written.
 */
async function handleCodeReply(ctx: CatalogueTurnContext, request: TripCodeReading): Promise<boolean> {
  let tripId: string | null = null;
  let lookupFailed = false;
  try {
    tripId = await webDeps().resolveTripCode(request.code);
  } catch (error) {
    lookupFailed = true;
    logError("catalogue.code_lookup_failed", { requestId: ctx.trace?.requestId, platform: ctx.platform, classification: classifyError(error) });
  }
  const trip = tripId ? (await ctx.getTrips()).find((candidate) => candidate.id === tripId && candidate.status === "active") ?? null : null;

  if (request.question && !request.stated) {
    // The customer asks something about a catalogue trip. Quoting is a person's job and the quotation
    // acknowledgement would not answer them: keep the conversation pointed at the trip and let the flow answer.
    if (trip) {
      await setTripSelection(ctx.senderId, { tripId: trip.id, date: null, hotel: null, package: null, passengers: [] }).catch(() => {});
      logTurn(ctx, "catalogue.code_question", { code: request.code, tripId: trip.id });
    }
    return false;
  }
  // An unknown code is consumed (silence + a staff lead naming it) only when it is clearly the point of
  // the message: it opens it, or the word "код" is there. Elsewhere in a sentence it may be anything.
  if (!trip && (request.loose || !(request.leading || request.codeWord))) return false;

  await appendMessage(ctx.senderId, "user", ctx.text).catch(() => {});
  const extraCodes = parseAllTripCodes(ctx.text, { loose: true }).filter((code) => code !== request.code);
  const note = [
    extraCodes.length ? `Бусад код: ${extraCodes.join(", ")}` : "",
    !trip ? (lookupFailed ? "Кодыг шалгаж чадсангүй (системийн алдаа)." : tripId ? "Код байгаа ч аялал одоо идэвхгүй эсвэл нуугдсан." : "Каталогид ийм код байхгүй.") : "",
  ].filter(Boolean).join("\n") || null;
  const base = { code: request.code, tripTitle: trip?.route_name ?? null, tripId, groupSize: request.groupSize, month: request.month, note, customerText: ctx.text };
  await recordLead(ctx, tripCodeLeadContext(base));
  recordCounter("catalogue.code_reply_total", 1, { platform: ctx.platform, result: trip ? "matched" : lookupFailed ? "lookup_failed" : tripId ? "inactive" : "unknown" });
  if (!trip) {
    // No data, no answer: the owner's rule. Staff have the lead above.
    noteInbound((trace) => { trace.silent = "catalogue_code_unknown"; });
    logTurn(ctx, "catalogue.code_unresolved", { code: request.code, lookupFailed, known: Boolean(tripId) });
    return true;
  }
  await setTripSelection(ctx.senderId, { tripId: trip.id, date: null, hotel: null, package: null, passengers: [] });
  await ctx.deliver({
    reply: tripCodeAckText({ code: request.code, title: trip.route_name, groupSize: request.groupSize, month: request.month }),
    failTag: "catalogue_code_request", rememberSource: "api.webhook.catalogue_code_request", counter: "webhook.catalogue_code_request_total", catalogTripIds: [trip.id],
  });
  logTurn(ctx, "catalogue.code_request", { code: request.code, tripId: trip.id, groupSize: request.groupSize, month: request.month });
  return true;
}

/** A quotation for a group or company: staff prepare it; the bot collects what they need. */
async function handleGroupQuote(ctx: CatalogueTurnContext): Promise<boolean> {
  await appendMessage(ctx.senderId, "user", ctx.text).catch(() => {});
  const groupSize = extractGroupSize(ctx.text);
  const month = extractMonth(ctx.text);
  await recordLead(ctx, groupQuoteLeadContext({ groupSize, month, customerText: ctx.text }));
  await ctx.deliver({
    reply: groupQuoteText({ groupSize, month }),
    failTag: "catalogue_group_quote", rememberSource: "api.webhook.catalogue_group_quote", counter: "webhook.catalogue_group_quote_total",
  });
  logTurn(ctx, "catalogue.group_quote", { groupSize, month });
  return true;
}

/**
 * The words on a staff lead when the conversation is owned by a person: webhook.ts's paused / taken
 * over branches already write the customer's message on their lead; this names what it asked for.
 * undefined = not a catalogue message (the default label stays).
 */
export function catalogueFollowupLabel(text: string): string | undefined {
  if (parseTripCodeRequest(text)) return "Каталогийн кодоор хариулсан — ажилтан хариулж байхад";
  const intent = detectCatalogueIntent(text);
  if (intent.kind === "catalogue") return "Байгууллагын каталог хүссэн — ажилтан хариулж байхад бот илгээгээгүй";
  if (intent.kind === "group_quote") return "Бүлгийн үнийн санал хүссэн — ажилтан хариулж байхад";
  return undefined;
}

/**
 * A catalogue request that reached the bot while the page is paused or photo-only mode is on:
 * nothing is sent, but staff must see it (a lead), never a dropped message. Returns true when the
 * message was a catalogue request.
 */
export async function noteBlockedCatalogueRequest(input: {
  platform: string; senderId: string; text: string; reason: "page_paused" | "photo_only";
}): Promise<boolean> {
  const intent = detectCatalogueIntent(input.text);
  const code = parseTripCodeRequest(input.text);
  if (intent.kind === "none" && !code) return false;
  const edition = intent.kind === "catalogue" ? intent.edition : "quick";
  const context = catalogueLeadContext({
    edition, reason: `${CATALOGUE_BLOCK_REASON_TEXT.blocked_paused} (${input.reason})`, customerText: input.text,
    detail: code ? `Каталогийн код: ${code.code}${code.groupSize ? `, ${code.groupSize} хүн` : ""}${code.month ? `, ${code.month}-р сар` : ""}` : null,
  });
  try {
    const created = await ensureDurableLead({ kind: "handoff", platform: input.platform, senderId: input.senderId, customerMessage: input.text, context, contactPhone: extractPhoneNumber(input.text) });
    if (!created.created) {
      const open = await latestCustomerLead(input.senderId).catch(() => null);
      if (open) await recordLeadFollowup(open.id, context).catch(() => false);
    }
  } catch (error) {
    logWarn("catalogue.blocked_request_lead_failed", { platform: input.platform, senderHash: hashIdentifier(input.senderId), classification: classifyError(error) });
    return true;
  }
  logInfo("catalogue.request_while_blocked", { platform: input.platform, senderHash: hashIdentifier(input.senderId), reason: input.reason });
  recordCounter("catalogue.request_blocked_total", 1, { reason: input.reason });
  return true;
}
