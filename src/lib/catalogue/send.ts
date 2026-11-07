/**
 * Messenger delivery of the published catalogue: ONE file attachment and ONE short text.
 *
 *   plan     what may happen (kill switch, 24h window, staff-owned / paused, published version,
 *            freshness). Sends nothing, writes nothing.
 *   execute  claim the send (idempotent under webhook redelivery and double taps), find or upload the
 *            Meta attachment, then text -> file. Every outcome is logged machine-readably.
 *
 * Order matters: the attachment is uploaded to Meta BEFORE the caption goes out, so the caption
 * ("the file below") is only sent when the file is ready. If Meta then refuses the cached id the
 * bytes are uploaded once more; if the file still cannot go, ONE text with the public file link
 * follows. A customer is never told a file was sent when it was not, and never gets a second file.
 *
 * Everything outside the process (store, Meta, pause state, clock) is behind `SendDeps`, so the
 * journeys run the real webhook with fakes and no database or network. The webhook passes its own
 * `deliverFastPathReply` as `sendText`: every customer-facing word still leaves through
 * tripGrounding.ts, exactly like the trip brochure (webhook.ts).
 */
import { buildFbFileMessageBody, classifyFbFailure, sendFbFileAttachmentDetailed, uploadPdfBufferDetailed, type FbSendDetail, type FbUploadDetail } from "../fbAttachmentUpload";
import { BOOKING_WEBSITE_URL } from "../bookingWebsite";
import { isMetaOutboundDisabled } from "../metaOutboundKillSwitch";
import { BOT_MESSAGE_METADATA } from "../messenger";
import { hashIdentifier, logInfo, logWarn, recordCounter } from "../observability";
import { isStaffTakeoverSendBlocked } from "../takeoverGuard";
import { checkLiveDrift, evaluateFreshness, type FreshnessVerdict, type LiveDrift } from "./freshness";
import {
  CATALOGUE_BLOCK_REASON_TEXT, CATALOGUE_STAFF_WILL_SEND_TEXT, catalogueCaption, catalogueLeadContext, catalogueLinkFollowupText,
  catalogueLinkOnlyText, catalogueRepeatText, catalogueStaleText,
} from "./messages";
import { CATALOGUE_PUBLIC_FILE_PATH, type CatalogueDeliveryOutcome, type CatalogueDeliveryStatus, type CatalogueEdition, type CatalogueVersionMeta } from "./types";

/** Messenger lets a Page message a person for 24 hours after their last message; 5 minutes of margin. */
export const MESSAGING_WINDOW_MS = 24 * 3_600_000 - 5 * 60_000;
/** Meta's attachment upload limit is 25 MB; the catalogue is far smaller, but a bigger file is never attempted. */
export const META_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/**
 * A second request this soon after a send is a double tap or a redelivery of the same moment, not a
 * customer who asks again: it stays silent. Later, the customer is pointed at the file they already
 * have (never sent a second one). Same length as the store's explicit-resend burst guard.
 */
export const REPEAT_NOTICE_MIN_AGE_MS = 45_000;
/** outcome.reason when a repeat request was answered with ONE short pointer text. */
export const REPEAT_ANSWERED_REASON = "recent_send_answered";
/** outcome.reason when a repeat request could not be answered in the chat and staff were told instead. */
export const REPEAT_FOLLOWUP_REASON = "recent_send_followup";

export type SendTrace = { requestId?: string; correlationId?: string; source?: string; deliveryKey?: string };

/** What a claim returns. When it is refused, `priorStatus` / `priorAgeMs` describe the send that refused it. */
export type CatalogueClaimResult = { claimed: boolean; reason?: string; sendId: string; priorStatus?: string; priorAgeMs?: number };

export type CatalogueSendStore = {
  getPublished(edition: CatalogueEdition): Promise<CatalogueVersionMeta | null>;
  getVersionMeta(id: string): Promise<CatalogueVersionMeta | null>;
  getVersionPdf(id: string): Promise<{ bytes: Buffer; meta: CatalogueVersionMeta } | null>;
  claimSend(input: {
    senderId: string; edition: CatalogueEdition; versionId: string | null; explicitResend: boolean; windowMs?: number; dedupeKey?: string | null;
  }): Promise<CatalogueClaimResult>;
  finishSend(sendId: string, outcome: { status: CatalogueDeliveryStatus; metaMessageId?: string | null; reason?: string | null; retries?: number }): Promise<boolean>;
  getCachedFbAttachment(versionId: string, pageId: string): Promise<string | null>;
  cacheFbAttachment(versionId: string, pageId: string, attachmentId: string): Promise<void>;
  clearCachedFbAttachment?(versionId: string, pageId: string): Promise<void>;
};

export type GateVerdict = { status: "blocked_staff_owned" | "blocked_paused"; reason: string } | null;

export type SendDeps = {
  now: () => Date;
  store: CatalogueSendStore;
  /** Is this conversation owned by a person, or is the bot paused? null = the bot may send. */
  gate: (senderId: string, pageId: string) => Promise<GateVerdict>;
  /** Page-level stops only (page paused, photo-only mode): they hold even for a verified test recipient. */
  pageGate: (pageId: string) => Promise<GateVerdict>;
  killSwitch: () => boolean;
  /** Live-vs-published comparison; null when it could not be made. */
  checkDrift: (published: CatalogueVersionMeta, nowIso: string) => Promise<LiveDrift | null>;
  upload: (bytes: Buffer, fileName: string, pageToken: string) => Promise<FbUploadDetail>;
  sendFile: (recipientId: string, attachmentId: string, pageToken: string) => Promise<FbSendDetail>;
  /** Outside the webhook only (admin test): a plain Messenger text. */
  sendDirectText: (recipientId: string, text: string, pageToken: string, trace?: SendTrace) => Promise<boolean>;
  /** Throws when a person took the conversation over in the meantime (takeoverGuard.ts). */
  assertMaySend: (recipientId: string, trace?: SendTrace) => Promise<void>;
  recordFile: (senderId: string, url: string) => Promise<void>;
  recordOutbound: (messageId: string, recipientId: string) => Promise<void>;
  publicFileUrl: (token: string) => string;
  websiteUrl: () => string;
};

function normalizeBase(value: string | undefined): string {
  const raw = (value || "").trim();
  if (!raw) return "";
  return (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
}

/** The public, token-addressed file URL on this deployment ("" when no public host is configured). */
export function catalogueFileUrl(token: string, env: Partial<NodeJS.ProcessEnv> = process.env): string {
  const base = normalizeBase(env.CATALOGUE_PUBLIC_BASE_URL || env.NEXT_PUBLIC_SITE_URL || env.SITE_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL);
  return base && token ? `${base}${CATALOGUE_PUBLIC_FILE_PATH}/${encodeURIComponent(token)}` : "";
}

export function defaultSendDeps(): SendDeps {
  return {
    now: () => new Date(),
    store: {
      getPublished: async (edition) => (await import("./store")).getPublished(edition),
      getVersionMeta: async (id) => (await import("./store")).getVersionMeta(id),
      getVersionPdf: async (id) => (await import("./store")).getVersionPdf(id),
      claimSend: async (input) => (await import("./store")).claimSend(input),
      finishSend: async (sendId, outcome) => (await import("./store")).finishSend(sendId, outcome),
      getCachedFbAttachment: async (versionId, pageId) => (await import("./store")).getCachedFbAttachment(versionId, pageId),
      cacheFbAttachment: async (versionId, pageId, attachmentId) => (await import("./store")).cacheFbAttachment(versionId, pageId, attachmentId),
      clearCachedFbAttachment: async (versionId, pageId) => (await import("./store")).clearCachedFbAttachment(versionId, pageId),
    },
    gate: async (senderId, pageId) => {
      const [{ pauseReason }, { HUMAN_OWNER_REASONS }, ops] = await Promise.all([import("../pause"), import("../takeoverGuard"), import("../travelOps")]);
      const reason = await pauseReason(senderId).catch(() => null);
      if (reason && HUMAN_OWNER_REASONS.has(reason)) return { status: "blocked_staff_owned", reason };
      // The bot's own marker after a booking request does not silence it (webhook.ts waitingForConsultant).
      if (reason && reason !== "booked_customer") return { status: "blocked_paused", reason };
      if (await ops.isPagePaused(pageId).catch(() => false)) return { status: "blocked_paused", reason: "page_paused" };
      if ((await ops.getBotControl().catch(() => null))?.photo_only) return { status: "blocked_paused", reason: "photo_only" };
      return null;
    },
    pageGate: async (pageId) => {
      const ops = await import("../travelOps");
      if (await ops.isPagePaused(pageId).catch(() => false)) return { status: "blocked_paused", reason: "page_paused" };
      if ((await ops.getBotControl().catch(() => null))?.photo_only) return { status: "blocked_paused", reason: "photo_only" };
      return null;
    },
    killSwitch: () => isMetaOutboundDisabled(),
    checkDrift: (published, nowIso) => checkLiveDrift(published, nowIso),
    upload: uploadPdfBufferDetailed,
    sendFile: sendFbFileAttachmentDetailed,
    sendDirectText: async (recipientId, text, pageToken, trace) => {
      const { sendTextMessage } = await import("../messenger");
      await sendTextMessage(recipientId, text, pageToken, trace);
      return true;
    },
    assertMaySend: async (recipientId, trace) => (await import("../takeoverGuard")).assertBotMaySend(recipientId, trace),
    recordFile: async (senderId, url) => (await import("../webhookMedia")).recordFileMessage(senderId, url),
    recordOutbound: async (messageId, recipientId) => (await import("../outboundMessages")).recordOutboundMessage(messageId, recipientId),
    publicFileUrl: (token) => catalogueFileUrl(token),
    websiteUrl: () => BOOKING_WEBSITE_URL,
  };
}

let testOverrides: Partial<SendDeps> | null = null;
/** Journeys and unit tests swap the outside world here; pass null to restore the real one. */
export function setSendDepsForTests(overrides: Partial<SendDeps> | null) {
  testOverrides = overrides;
}
export function resolveSendDeps(overrides?: Partial<SendDeps>): SendDeps {
  return { ...defaultSendDeps(), ...(testOverrides || {}), ...(overrides || {}) };
}

// ── Inputs and plan ──────────────────────────────────────────────────────────────────────────────

/** How the customer-facing text is sent. The webhook passes deliverFastPathReply; false = the text was withheld. */
export type SendText = (input: { reply: string; failTag: string; afterDeliver?: () => Promise<void> }) => Promise<boolean>;
export type CaptureCatalogueLead = (input: { reason: string; status: CatalogueDeliveryStatus; context: string }) => Promise<void>;

export type DeliverCatalogueInput = {
  senderId: string;
  pageId: string;
  pageToken: string;
  edition: CatalogueEdition;
  explicitResend: boolean;
  /** When the customer last wrote. Messenger only lets the Page answer within 24 hours of it. */
  lastInboundAt: Date | string | number | null;
  trace?: SendTrace;
  dryRun?: boolean;
  platform?: "facebook" | "instagram";
  /** The inbound message / event key: the same message never owns two sends (store.claimSend). */
  dedupeKey?: string | null;
  /** Admin test: this exact version (a draft is fine) instead of the published one. */
  versionId?: string | null;
  /** Admin test to an allowlisted tester: no claim, no pause / window checks. The kill switch still applies. */
  testSend?: boolean;
  /**
   * A REAL test to a verified tester (testers.ts): the 24 h window is judged on the tester's last message and the
   * page-level stops apply. A sender-level pause on the tester's own conversation does not (testers.ts, "Decision").
   */
  testerGate?: { lastInboundAt: Date | string | number | null };
  sendText?: SendText;
  /** Staff lead for any outcome a person must see (not called on a clean send). */
  captureLead?: CaptureCatalogueLead;
  /** What the customer wrote, for the lead. */
  customerText?: string;
  deps?: Partial<SendDeps>;
};

export type DeliveryPlan =
  | { ready: true; version: CatalogueVersionMeta; freshness: FreshnessVerdict | null }
  | { ready: false; status: CatalogueDeliveryStatus; reason: string; version: CatalogueVersionMeta | null; freshness: FreshnessVerdict | null };

const notReady = (status: CatalogueDeliveryStatus, reason: string, version: CatalogueVersionMeta | null = null, freshness: FreshnessVerdict | null = null): DeliveryPlan =>
  ({ ready: false, status, reason, version, freshness });

function toMillis(value: DeliverCatalogueInput["lastInboundAt"]): number | null {
  if (value === null || value === undefined) return null;
  const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** What may happen now. Sends nothing and writes nothing. */
export async function planCatalogueDelivery(input: DeliverCatalogueInput, deps: SendDeps = resolveSendDeps(input.deps)): Promise<DeliveryPlan> {
  const now = deps.now();
  // A dry run sends nothing, so the kill switch does not hide what WOULD be sent.
  if (!input.dryRun && deps.killSwitch()) return notReady("blocked_killswitch", "meta_outbound_disabled");
  if (input.testSend) {
    if (input.testerGate && !input.dryRun) {
      const lastInbound = toMillis(input.testerGate.lastInboundAt);
      if (lastInbound === null) return notReady("blocked_window", "no_inbound_timestamp");
      if (now.getTime() - lastInbound > MESSAGING_WINDOW_MS) return notReady("blocked_window", "outside_24h_window");
      const pageStop = await deps.pageGate(input.pageId);
      if (pageStop) return notReady(pageStop.status, pageStop.reason);
    }
  } else {
    const lastInbound = toMillis(input.lastInboundAt);
    if (lastInbound === null) return notReady("blocked_window", "no_inbound_timestamp");
    if (now.getTime() - lastInbound > MESSAGING_WINDOW_MS) return notReady("blocked_window", "outside_24h_window");
    const gate = await deps.gate(input.senderId, input.pageId);
    if (gate) return notReady(gate.status, gate.reason);
  }
  const version = input.versionId ? await deps.store.getVersionMeta(input.versionId) : await deps.store.getPublished(input.edition);
  if (!version) return notReady("no_published_version", input.versionId ? "version_not_found" : "none_published");
  if (input.versionId) return { ready: true, version, freshness: null }; // a version staff chose to test
  const nowIso = now.toISOString();
  const verdict = evaluateFreshness({ published: version, nowIso, drift: await deps.checkDrift(version, nowIso) });
  if (verdict.stale) return notReady("stale_fallback", `stale:${verdict.code}`, version, verdict);
  return { ready: true, version, freshness: verdict };
}

// ── Execution ────────────────────────────────────────────────────────────────────────────────────

function logOutcome(input: DeliverCatalogueInput, outcome: CatalogueDeliveryOutcome, extra: Record<string, unknown> = {}) {
  const fields = {
    requestId: input.trace?.requestId, correlationId: input.trace?.correlationId,
    senderHash: hashIdentifier(input.senderId), pageId: input.pageId, edition: outcome.edition, status: outcome.status,
    versionId: outcome.versionId, reason: outcome.reason, metaMessageId: outcome.metaMessageId, fileAccepted: outcome.fileAccepted,
    explicitResend: input.explicitResend, testSend: Boolean(input.testSend), ...extra,
  };
  if (outcome.status === "sent" || outcome.status === "dry_run" || outcome.status === "duplicate_suppressed") logInfo("catalogue.delivery", fields);
  else logWarn("catalogue.delivery", fields);
  recordCounter("catalogue.delivery_total", 1, { status: outcome.status, edition: outcome.edition });
}

const outcomeOf = (input: DeliverCatalogueInput, status: CatalogueDeliveryStatus, parts: Partial<CatalogueDeliveryOutcome> = {}): CatalogueDeliveryOutcome => ({
  status, versionId: null, edition: input.edition, metaMessageId: null, reason: null, fileAccepted: false, ...parts,
});

/** The default text channel outside the webhook: send the text, then run what follows it. */
function directSendText(input: DeliverCatalogueInput, deps: SendDeps): SendText {
  return async ({ reply, afterDeliver }) => {
    if (!(await deps.sendDirectText(input.senderId, reply, input.pageToken, input.trace))) return false;
    if (afterDeliver) await afterDeliver();
    return true;
  };
}

/**
 * Deliver the catalogue to one conversation. Returns the outcome; throws only what the webhook must
 * see (a retryable delivery failure, a staff takeover mid-send), after the claim has been released.
 */
export async function deliverCatalogue(input: DeliverCatalogueInput): Promise<CatalogueDeliveryOutcome> {
  const deps = resolveSendDeps(input.deps);
  const plan = await planCatalogueDelivery(input, deps);
  const sendText = input.sendText ?? directSendText(input, deps);
  const lead = async (status: CatalogueDeliveryStatus, reason: string, version: CatalogueVersionMeta | null, detail?: string | null) => {
    if (!input.captureLead) return;
    await input.captureLead({
      status, reason,
      context: catalogueLeadContext({
        edition: input.edition, versionNo: version?.versionNo ?? null, customerText: input.customerText || "",
        reason: CATALOGUE_BLOCK_REASON_TEXT[status] || reason, detail: detail ?? null,
      }),
    });
  };
  // The send log row: claim then finish, so blocked and unpublished requests are counted too.
  const record = async (status: CatalogueDeliveryStatus, reason: string, version: CatalogueVersionMeta | null) => {
    if (input.testSend || input.dryRun) return;
    try {
      const claim = await deps.store.claimSend({ senderId: input.senderId, edition: input.edition, versionId: version?.id ?? null, explicitResend: true, dedupeKey: input.dedupeKey ?? input.trace?.deliveryKey ?? null });
      if (claim.claimed) await deps.store.finishSend(claim.sendId, { status, reason });
    } catch (error) {
      logWarn("catalogue.send_log_failed", { requestId: input.trace?.requestId, message: error instanceof Error ? error.name : "unknown" });
    }
  };

  /**
   * A claim was refused. A redelivery, a double tap seconds later or a send still in flight stays
   * silent. A customer who asks again minutes later must not meet silence: if the file (or its link)
   * already went to them they get ONE short text pointing at it, never a second file; otherwise a
   * staff line says they asked again.
   */
  const answerRepeat = async (claim: CatalogueClaimResult, version: CatalogueVersionMeta | null, withLink: boolean): Promise<CatalogueDeliveryOutcome> => {
    const versionId = version?.id ?? null;
    const suppressed = (reason: string) => outcomeOf(input, "duplicate_suppressed", { versionId, reason });
    const askedAgain = claim.reason === "recent_send" && (claim.priorAgeMs ?? 0) >= REPEAT_NOTICE_MIN_AGE_MS && !input.testSend;
    if (!askedAgain) {
      const outcome = suppressed(claim.reason ?? "duplicate");
      logOutcome(input, outcome);
      return outcome;
    }
    let reason = REPEAT_FOLLOWUP_REASON;
    if (claim.priorStatus === "sent" || claim.priorStatus === "sent_link_fallback") {
      const linkOnly = claim.priorStatus === "sent_link_fallback";
      const url = withLink && version ? deps.publicFileUrl(version.publicToken) : "";
      if (!(linkOnly && !url)) {
        const sent = await sendText({ reply: catalogueRepeatText({ url, linkOnly }), failTag: "catalogue_repeat" });
        if (sent) reason = REPEAT_ANSWERED_REASON;
      }
    }
    const outcome = suppressed(reason);
    logOutcome(input, outcome, { priorStatus: claim.priorStatus ?? null, priorAgeMs: claim.priorAgeMs ?? null });
    if (reason === REPEAT_FOLLOWUP_REASON) {
      await lead("duplicate_suppressed", reason, version, claim.priorStatus === "stale_fallback"
        ? "Өмнө нь каталог хуучирсан тул вэбсайтын холбоос явуулсан; хэрэглэгч дахин хүссэн."
        : "Хэрэглэгч каталогийг дахин хүссэн; бот хариулж чадсангүй.");
    }
    return outcome;
  };

  if (!plan.ready) {
    if ((plan.status === "stale_fallback" || plan.status === "no_published_version") && !input.dryRun) {
      // Never the stale file, and never silence when nothing is published (owner, launch 2026-11-07). The live site, once (the claim makes a double tap silent), and a person follows up.
      const claim = await deps.store.claimSend({ senderId: input.senderId, edition: input.edition, versionId: plan.version?.id ?? null, explicitResend: input.explicitResend, dedupeKey: input.dedupeKey ?? input.trace?.deliveryKey ?? null })
        .catch(() => null);
      if (claim && !claim.claimed) return answerRepeat(claim, plan.version, false);
      let sent = false;
      try {
        sent = await sendText({ reply: catalogueStaleText(deps.websiteUrl()), failTag: "catalogue_stale" });
      } catch (error) {
        if (claim) await deps.store.finishSend(claim.sendId, { status: "failed", reason: "stale_text_delivery_failed" }).catch(() => false);
        throw error;
      }
      const outcome = outcomeOf(input, plan.status, { versionId: plan.version?.id ?? null, reason: plan.reason });
      if (claim) await deps.store.finishSend(claim.sendId, { status: sent ? "stale_fallback" : "failed", reason: sent ? plan.reason : "stale_text_withheld" }).catch(() => false);
      logOutcome(input, outcome, { staleReasons: plan.freshness?.reasons.length ?? 0, ageDays: plan.freshness?.ageDays ?? null });
      await lead(plan.status === "no_published_version" ? "no_published_version" : "stale_fallback", plan.reason, plan.version, plan.freshness?.reasons.join("; ") || null);
      return outcome;
    }
    const outcome = outcomeOf(input, plan.status, { versionId: plan.version?.id ?? null, reason: plan.reason });
    await record(plan.status, plan.reason, plan.version);
    logOutcome(input, outcome);
    if (plan.status !== "duplicate_suppressed" && !input.dryRun) await lead(plan.status, plan.reason, plan.version);
    return outcome;
  }

  const version = plan.version;
  if (input.dryRun) {
    const outcome = outcomeOf(input, "dry_run", { versionId: version.id });
    logOutcome(input, outcome);
    return outcome;
  }

  // 1. Claim. The same inbound message, or the same person asking again inside the window, owns one send.
  let sendId: string | null = null;
  if (!input.testSend) {
    const claim = await deps.store.claimSend({ senderId: input.senderId, edition: input.edition, versionId: version.id, explicitResend: input.explicitResend, dedupeKey: input.dedupeKey ?? input.trace?.deliveryKey ?? null });
    if (!claim.claimed) return answerRepeat(claim, version, true);
    sendId = claim.sendId;
  }
  const finish = async (outcome: CatalogueDeliveryOutcome, retries: number, extra: Record<string, unknown> = {}) => {
    if (sendId) {
      await deps.store.finishSend(sendId, { status: outcome.status, metaMessageId: outcome.metaMessageId, reason: outcome.reason, retries })
        .catch((error) => logWarn("catalogue.finish_send_failed", { requestId: input.trace?.requestId, message: error instanceof Error ? error.name : "unknown" }));
    }
    logOutcome(input, outcome, { retries, versionNo: version.versionNo, sizeBytes: version.sizeBytes, ...extra });
    return outcome;
  };

  let retries = 0;
  try {
    const url = deps.publicFileUrl(version.publicToken);
    let attachmentId: string | null = null;
    let cached = false;
    let linkReason: string | null = input.platform === "instagram" ? "instagram_no_file" : null;

    const uploadAndCache = async (): Promise<string | null> => {
      const pdf = await deps.store.getVersionPdf(version.id);
      if (!pdf) { linkReason = "pdf_bytes_missing"; return null; }
      const uploaded = await deps.upload(pdf.bytes, version.fileName, input.pageToken);
      if (!uploaded.ok || !uploaded.attachmentId) {
        linkReason = `upload_failed:${classifyFbFailure(uploaded)}${uploaded.errorCode ? `:${uploaded.errorCode}` : ""}`;
        return null;
      }
      await deps.store.cacheFbAttachment(version.id, input.pageId, uploaded.attachmentId)
        .catch((error) => logWarn("catalogue.attachment_cache_failed", { requestId: input.trace?.requestId, message: error instanceof Error ? error.name : "unknown" }));
      return uploaded.attachmentId;
    };

    // 2. The Meta attachment, before anything reaches the customer.
    if (!linkReason) {
      if (version.sizeBytes > META_MAX_ATTACHMENT_BYTES) linkReason = "file_too_large_for_meta";
      else {
        attachmentId = await deps.store.getCachedFbAttachment(version.id, input.pageId).catch(() => null);
        cached = Boolean(attachmentId);
        if (!attachmentId) attachmentId = await uploadAndCache();
      }
    }

    // 3a. No file can go: ONE text with the public link (or nothing, if there is no link either).
    if (!attachmentId) {
      if (!url) {
        const outcome = outcomeOf(input, "failed", { versionId: version.id, reason: `${linkReason || "no_file"}+no_public_url` });
        await finish(outcome, retries);
        await lead("failed", outcome.reason || "no_file", version);
        return outcome;
      }
      const sent = await sendText({ reply: catalogueLinkOnlyText(input.edition, url), failTag: "catalogue_link" });
      const outcome = sent
        ? outcomeOf(input, "sent_link_fallback", { versionId: version.id, reason: linkReason })
        : outcomeOf(input, "failed", { versionId: version.id, reason: "link_text_withheld" });
      await finish(outcome, retries);
      await lead(outcome.status, outcome.reason || "link_only", version, sent ? "Файл биш, холбоос явуулсан." : null);
      return outcome;
    }

    // 3b. Caption, then the file in its afterDeliver (the same shape as the trip brochure send).
    let fileResult: FbSendDetail | null = null;
    let fileFailure: string | null = null;
    const sendTheFile = async () => {
      // A person who took over meanwhile wins. Not for a verified tester: that conversation is staff's own account (testers.ts).
      if (!input.testerGate) await deps.assertMaySend(input.senderId, input.trace);
      let result = await deps.sendFile(input.senderId, attachmentId!, input.pageToken);
      let failure = result.ok ? null : classifyFbFailure(result);
      if (!result.ok && failure === "attachment_rejected") {
        // The cached id is no longer accepted (re-uploaded app, expired attachment): upload the bytes once more.
        retries += 1;
        await deps.store.clearCachedFbAttachment?.(version.id, input.pageId).catch(() => {});
        const fresh = await uploadAndCache();
        if (fresh) {
          attachmentId = fresh;
          cached = false;
          result = await deps.sendFile(input.senderId, fresh, input.pageToken);
          failure = result.ok ? null : classifyFbFailure(result);
        }
      } else if (!result.ok && failure === "transient") {
        retries += 1;
        result = await deps.sendFile(input.senderId, attachmentId!, input.pageToken);
        failure = result.ok ? null : classifyFbFailure(result);
      }
      fileResult = result;
      fileFailure = result.ok ? null : `file_send_failed:${failure}${result.errorCode ? `:${result.errorCode}` : ""}${result.status ? `:http${result.status}` : ""}`;
      if (result.ok) {
        if (result.messageId) await deps.recordOutbound(result.messageId, result.recipientId || input.senderId).catch(() => {});
        await deps.recordFile(input.senderId, url || version.fileName).catch(() => {});
      }
    };

    const captionSent = await sendText({ reply: catalogueCaption(input.edition), failTag: "catalogue_pdf", afterDeliver: sendTheFile });
    const accepted = fileResult as FbSendDetail | null;
    if (!captionSent) {
      const outcome = outcomeOf(input, "failed", { versionId: version.id, reason: "caption_withheld" });
      await finish(outcome, retries);
      await lead("failed", "caption_withheld", version);
      return outcome;
    }
    if (accepted?.ok) {
      const outcome = outcomeOf(input, "sent", { versionId: version.id, metaMessageId: accepted.messageId, fileAccepted: true });
      return await finish(outcome, retries, { cachedAttachment: cached });
    }
    // The caption is out but Meta would not take the file: the link, once, in its place.
    const reason = fileFailure || "file_not_sent";
    const sentLink = url ? await sendText({ reply: catalogueLinkFollowupText(url), failTag: "catalogue_link_followup" }) : false;
    if (!url) await sendText({ reply: CATALOGUE_STAFF_WILL_SEND_TEXT, failTag: "catalogue_staff_will_send" });
    const outcome = sentLink
      ? outcomeOf(input, "sent_link_fallback", { versionId: version.id, reason })
      : outcomeOf(input, "failed", { versionId: version.id, reason: url ? `${reason}+link_withheld` : `${reason}+no_public_url` });
    await finish(outcome, retries, { cachedAttachment: cached });
    await lead(outcome.status, reason, version, sentLink ? "Файлыг Meta хүлээн аваагүй тул холбоос явуулсан." : "Каталогийг хэрэглэгчид гараар илгээнэ үү.");
    return outcome;
  } catch (error) {
    // The claim must not outlive a send that never happened: a redelivery retries instead of being suppressed.
    const takeover = isStaffTakeoverSendBlocked(error);
    const status: CatalogueDeliveryStatus = takeover ? "blocked_staff_owned" : "failed";
    const reason = takeover ? `staff_takeover_mid_send:${error.reason}` : `exception:${error instanceof Error ? error.name : "unknown"}`;
    await finish(outcomeOf(input, status, { versionId: version.id, reason }), retries);
    throw error;
  }
}

// ── Admin test send ──────────────────────────────────────────────────────────────────────────────

export type CatalogueTestPayload = {
  /** Exactly what goes to Meta, in order: one text, then one file attachment. */
  messages: Array<{ kind: "text" | "file"; body: Record<string, unknown> }>;
  textMessages: 1;
  fileAttachments: 1;
  fileName: string;
  sizeBytes: number;
  versionNo: number;
  edition: CatalogueEdition;
  /** "cached_attachment_id": a reusable id already exists. "upload_on_send": the bytes are uploaded first. */
  attachmentSource: "cached_attachment_id" | "upload_on_send";
  publicUrl: string;
  /** What the customer would get instead of the file if Meta refused it. */
  fallbackText: string;
};

export type CatalogueTestInput = {
  recipientPsid: string;
  edition: CatalogueEdition;
  /** Default true: nothing is sent, the payload is returned. */
  dryRun?: boolean;
  /** Test this exact version (a draft awaiting review) instead of the published one. */
  versionId?: string | null;
  pageId?: string;
  env?: Partial<NodeJS.ProcessEnv>;
  deps?: Partial<SendDeps>;
  /** A verified tester (testers.ts) instead of a PSID: the raw id is looked up here and never leaves the server. */
  testerId?: string | null;
  /** Tests only: replaces the tester lookup. */
  testerLookup?: (id: string) => Promise<import("./testers").TesterLookup>;
};

/**
 * A CatalogueDeliveryOutcome (what the admin route reads: status, reason, fileAccepted, metaMessageId)
 * plus the exact payload and the verdict on the recipient.
 */
export type CatalogueTestResult = CatalogueDeliveryOutcome & {
  ok: boolean;
  dryRun: boolean;
  /** The recipient is a verified tester, or is listed in CATALOGUE_TEST_RECIPIENT_PSIDS. */
  allowlisted: boolean;
  recipientMasked: string;
  payload: CatalogueTestPayload | null;
  /** Machine-readable code when not ok. */
  error: string | null;
};

export function testRecipientAllowlist(env: Partial<NodeJS.ProcessEnv> = process.env): string[] {
  return String(env.CATALOGUE_TEST_RECIPIENT_PSIDS || "").split(/[\s,;]+/).map((value) => value.trim()).filter(Boolean);
}

const maskPsid = (psid: string) => (psid.length <= 4 ? "****" : `${"*".repeat(Math.min(8, psid.length - 4))}${psid.slice(-4)}`);

export async function buildDeliveryPayload(input: { recipientId: string; version: CatalogueVersionMeta; pageId: string; deps: SendDeps }): Promise<CatalogueTestPayload> {
  const { recipientId, version, pageId, deps } = input;
  const cachedId = await deps.store.getCachedFbAttachment(version.id, pageId).catch(() => null);
  const url = deps.publicFileUrl(version.publicToken);
  return {
    messages: [
      { kind: "text", body: { messaging_type: "RESPONSE", recipient: { id: recipientId }, message: { text: catalogueCaption(version.edition), metadata: BOT_MESSAGE_METADATA } } },
      { kind: "file", body: buildFbFileMessageBody(recipientId, { attachmentId: cachedId || "<attachment_id after upload>" }) },
    ],
    textMessages: 1, fileAttachments: 1,
    fileName: version.fileName, sizeBytes: version.sizeBytes, versionNo: version.versionNo, edition: version.edition,
    attachmentSource: cachedId ? "cached_attachment_id" : "upload_on_send",
    publicUrl: url,
    fallbackText: url ? catalogueLinkOnlyText(version.edition, url) : "",
  };
}

/**
 * The admin's "send a test": ONLY to a PSID in CATALOGUE_TEST_RECIPIENT_PSIDS, dry-run by default.
 * A dry run needs no allowlisted recipient and sends nothing; it returns the exact payload so the
 * admin can show "one file attachment". A real test goes through the same code as a customer send.
 */
export async function sendCatalogueTest(input: CatalogueTestInput): Promise<CatalogueTestResult> {
  const env = input.env || process.env;
  const dryRun = input.dryRun !== false;
  const deps = resolveSendDeps(input.deps);
  const none = (status: CatalogueDeliveryStatus, reason: string) => outcomeOf({ edition: input.edition } as DeliverCatalogueInput, status, { reason });

  // A verified tester is looked up by id; its raw PSID is used only to address the send and is never returned.
  let tester: import("./testers").TesterSendTarget | null = null;
  if (input.testerId) {
    const testers = await import("./testers");
    const lookup = await (input.testerLookup ?? testers.getTesterForSend)(input.testerId);
    if (lookup.status !== "ok") {
      const reason = lookup.status === "revoked" ? "tester_revoked" : "tester_not_found";
      return { ...none("failed", reason), ok: false, dryRun, allowlisted: false, recipientMasked: "", payload: null, error: reason };
    }
    tester = lookup.target;
  }
  const recipient = tester ? (dryRun ? "" : tester.psid) : String(input.recipientPsid || "").trim();
  const allowlisted = tester ? true : recipient !== "" && testRecipientAllowlist(env).includes(recipient);
  const result = (ok: boolean, outcome: CatalogueDeliveryOutcome, payload: CatalogueTestPayload | null, error: string | null): CatalogueTestResult =>
    ({ ...outcome, ok, dryRun, allowlisted, recipientMasked: tester ? tester.masked : recipient ? maskPsid(recipient) : "", payload, error });
  if (!dryRun && !allowlisted) {
    const reason = recipient ? "recipient_not_allowlisted" : "recipient_required";
    return result(false, none("failed", reason), null, reason);
  }

  const { getEnv, pageTokenForRecipient } = await import("../env");
  const facebookPages = getEnv().facebookPages;
  const pageId = tester?.pageId || input.pageId || facebookPages[0]?.pageId || "";
  const pageToken = (pageId && recipient && pageTokenForRecipient(pageId, recipient)) || facebookPages.find((page) => page.pageId === pageId)?.token || "";
  if (!dryRun && (!pageId || !pageToken)) return result(false, none("failed", "page_token_missing"), null, "page_token_missing");

  const request: DeliverCatalogueInput = {
    senderId: recipient || "dry-run", pageId, pageToken, edition: input.edition, explicitResend: true, lastInboundAt: null,
    dryRun, testSend: true, versionId: input.versionId ?? null, deps: input.deps,
    ...(tester ? { testerGate: { lastInboundAt: tester.lastInboundAt } } : {}),
  };
  const plan = await planCatalogueDelivery(request, deps);
  if (!plan.ready) {
    return result(false, outcomeOf(request, plan.status, { versionId: plan.version?.id ?? null, reason: plan.reason }), null, plan.status);
  }
  const payload = await buildDeliveryPayload({ recipientId: recipient || "<test recipient>", version: plan.version, pageId, deps });
  if (dryRun) {
    const outcome = outcomeOf(request, "dry_run", { versionId: plan.version.id });
    logOutcome(request, outcome);
    return result(true, outcome, payload, null);
  }
  const outcome = await deliverCatalogue({ ...request, versionId: plan.version.id });
  const delivered = outcome.status === "sent" || outcome.status === "sent_link_fallback";
  return result(delivered, outcome, payload, delivered ? null : outcome.reason || outcome.status);
}

export { catalogueCaption } from "./messages";
export { evaluateFreshness } from "./freshness";
