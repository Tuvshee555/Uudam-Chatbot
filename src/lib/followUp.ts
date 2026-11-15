/**
 * The one follow-up question after a customer leaves the bot's answer on seen (owner, 2026-11-12:
 * "if the person just left you on seen, make a follow-up question after 10 min … it won't message
 * after they clicked 'connect to human', etc.").
 *
 * How it works:
 * - Every reply leaving the webhook's exit arms or disarms the sender (armFollowUp, replyQuestion.ts):
 *   a trip answer stores the next question for that moment's conversation state (nextQuestion.ts);
 *   anything else (contact numbers, a hand-off, an outage notice, a file acknowledgement …) clears it.
 *   The question is decided when the state is known, so the sweep never depends on Redis.
 * - The sweep (runFollowUpSweep; /api/cron/follow-up, GitHub Actions every 5 min) sends it once, when
 *   every rule below holds, re-checking the pause and the Messenger thread right before sending.
 *
 * Rules (each skip is logged with its reason, never with customer text):
 * - the bot's answer is the conversation's last message, ≥ delay minutes old (extra.follow_up_delay_minutes,
 *   default 30 since 2026-11-13), the customer's last message < 20 h old (Meta's 24 h window, with room), and no follow-up
 *   to this sender in the last 24 h;
 * - no pause of any kind (a consultant's reply, «Би хариулна», a hand-off after "connect to a person",
 *   the booking marker), no consultant in the Messenger thread or in the stored history within 30 days
 *   (an existing customer gets no sales nudge), no open or assigned lead (staff are already on it), and
 *   the page, the bot and photo-only mode are not paused;
 * - the customer's last message was a question the bot answered: not thanks/ok/bye, not a file or
 *   sticker, not a phone number, not a need the bot hands to staff;
 * - not a demo: or Instagram sender; quiet hours 22:00–09:00 Ulaanbaatar: wait until 09:00, inside the
 *   20 h window, else nothing;
 * - extra.follow_up_enabled !== false and FOLLOW_UP_ENABLED is not "off".
 */
import { getEnv, pageTokenForRecipient } from "./env";
import { classifyMessageNeed, isSocialMessage, type MessageNeed } from "./messageNeed";
import { sendQuickReplies, sendTextMessage } from "./messenger";
import { SMART_BUTTON_LABELS } from "./smartButtonLabels";
import { isMetaOutboundDisabled } from "./metaOutboundKillSwitch";
import { queryNeon } from "./neonDb";
import { hashIdentifier, logInfo, logWarn, recordCounter } from "./observability";
import type { NextQuestion } from "./nextQuestion";
import { isNextQuestionText, withoutNextQuestion } from "./nextQuestionText";
import { classifyThread, fetchThreadMessages, latestStaffReply, staffMessagesInThread, takeoverContext, takeoverRisk } from "./staffTakeover";
import { isStaffTakeoverSendBlocked } from "./takeoverGuard";
import { getBotControl, getTravelBotSettings, isPagePaused } from "./travelOps";
import { ensureTravelSchema } from "./travelSchema";
import { extractPhoneNumber } from "./webhookMedia";
import { dbAppendMessage, dbGetConversationRows, dbHasRecentStaffMessage, dbPauseReason, type ConversationRow } from "./travelSessionDb";

/** Owner, 2026-11-13: "when someone doesn't answer for 30 minutes" (was 10). */
export const FOLLOW_UP_DEFAULT_DELAY_MINUTES = 30;
/** The customer's last message must be newer than this (Meta allows 24 h). */
export const FOLLOW_UP_WINDOW_MS = 20 * 60 * 60 * 1000;
/** At most one follow-up per sender in this time. */
export const FOLLOW_UP_COOLDOWN_MS = 24 * 60 * 60 * 1000;
/** A consultant in the conversation within this time makes the customer an existing one. */
export const EXISTING_CUSTOMER_DAYS = 30;
const QUIET_FROM_HOUR = 22;
const QUIET_UNTIL_HOUR = 9;
const UB_OFFSET_HOURS = 8;
const SWEEP_LIMIT = 25;
/** Needs the bot hands to staff (needDispatch.ts): their typed lead is staff's to answer. */
const STAFF_NEEDS: ReadonlySet<MessageNeed> = new Set(["social", "business_group", "commercial_policy", "transport_only", "existing_booking", "complaint"]);
/** Bot messages that are not an answer the customer could be asked about (defence beside the arming). */
const NOT_AN_ANSWER = [
  /систем\s+түр\s+саат/iu, /^(?:📞\s*)?Манай\s+утасны\s+дугаар/imu, /^📍?\s*Манай\s+оффис/imu, /Файл\s+хүлээн\s+авлаа/iu,
  /Таны\s+хүсэлтийг\s+хүлээн\s+авлаа/iu, /зөвлөхөд\s+дамжууллаа/iu, /Дугаарыг\s+бүртгэлээ/iu, /утасны\s+дугаар\S*\s+(?:үлдээ|бич)/iu,
  /одоогоор\s+тодорхойгүй\s+байна\.\s+Хүний\s+ажилтан/iu, /Түр\s+хүлээнэ\s+үү/iu, /дансны\s+мэдээлл/iu, /^Зүгээр\s+ээ/iu,
];

export function followUpDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:off|false|0|no)$/i.test(String(env.FOLLOW_UP_ENABLED ?? "").trim());
}

export function followUpDelayMinutes(extra: Record<string, unknown> | null | undefined): number {
  const raw = Number(extra?.follow_up_delay_minutes);
  return Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.max(5, Math.round(raw))) : FOLLOW_UP_DEFAULT_DELAY_MINUTES;
}

/** 22:00–09:00 in Ulaanbaatar (UTC+8, no daylight saving). */
export function isQuietHour(now: Date): boolean {
  const hour = (now.getUTCHours() + UB_OFFSET_HOURS) % 24;
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

// ── Arming (written by every reply at the webhook's exit) ──────────────────────────────────────────

/**
 * Stamped with the database clock (the conversation rows' clock), to the millisecond: the claim
 * compares the stamp it read back, and a JavaScript Date holds no microseconds.
 */
export async function armFollowUp(senderId: string, followUp: NextQuestion | null): Promise<void> {
  if (!senderId || !await ensureTravelSchema()) return;
  if (followUp) {
    await queryNeon(`UPDATE travel_senders SET follow_up_slot = $2, follow_up_question = $3, follow_up_armed_at = date_trunc('milliseconds', NOW()) WHERE sender_id = $1`,
      [senderId, followUp.slot, followUp.text]);
  } else {
    await queryNeon(`UPDATE travel_senders SET follow_up_slot = '', follow_up_question = '' WHERE sender_id = $1 AND follow_up_slot <> ''`, [senderId]);
  }
}

type Candidate = { sender_id: string; slot: string; question: string; armed_at: string | Date };

async function dueCandidates(now: Date, delayMs: number): Promise<Candidate[]> {
  const result = await queryNeon<Candidate>(
    `SELECT sender_id, follow_up_slot AS slot, follow_up_question AS question, follow_up_armed_at AS armed_at FROM travel_senders
      WHERE follow_up_slot <> '' AND follow_up_question <> '' AND platform = 'facebook' AND sender_id NOT LIKE 'demo:%'
        AND follow_up_armed_at <= $1::timestamptz AND follow_up_armed_at > $2::timestamptz
        AND (follow_up_sent_at IS NULL OR follow_up_sent_at < $3::timestamptz)
      ORDER BY follow_up_armed_at ASC LIMIT $4`,
    [new Date(now.getTime() - delayMs).toISOString(), new Date(now.getTime() - FOLLOW_UP_WINDOW_MS).toISOString(),
      new Date(now.getTime() - FOLLOW_UP_COOLDOWN_MS).toISOString(), SWEEP_LIMIT],
  );
  return result?.rows ?? [];
}

/** Atomic: one sweep sends it, once, and only for the answer it was armed by. */
async function claimFollowUp(senderId: string, armedAt: string, now: Date): Promise<boolean> {
  const result = await queryNeon<{ sender_id: string }>(
    `UPDATE travel_senders SET follow_up_sent_at = $3::timestamptz, follow_up_slot = '', follow_up_question = ''
      WHERE sender_id = $1 AND follow_up_slot <> '' AND follow_up_armed_at = $2::timestamptz
        AND (follow_up_sent_at IS NULL OR follow_up_sent_at < $4::timestamptz)
      RETURNING sender_id`,
    [senderId, armedAt, now.toISOString(), new Date(now.getTime() - FOLLOW_UP_COOLDOWN_MS).toISOString()],
  );
  return Boolean(result?.rows.length);
}

/** This arm will never be sent (a rule says no): cleared so the next sweeps do not look at it again. */
async function disarm(senderId: string, armedAt: string): Promise<void> {
  await queryNeon(`UPDATE travel_senders SET follow_up_slot = '', follow_up_question = '' WHERE sender_id = $1 AND follow_up_armed_at = $2::timestamptz`,
    [senderId, armedAt]).catch(() => {});
}

// ── The rules over the stored conversation (pure) ──────────────────────────────────────────────────

const at = (row: { created_at: string | Date }) => new Date(row.created_at).getTime();

/** Why the stored conversation rules a follow-up out, or null when it may go. */
export function conversationSkipReason(rows: ConversationRow[], armedAt: number, now: number): string | null {
  const lastUser = rows.findLast((row) => row.role === "user");
  const lastAnswer = rows.findLast((row) => row.role === "assistant" && row.text.trim());
  if (!lastUser) return "no_customer_message";
  if (now - at(lastUser) >= FOLLOW_UP_WINDOW_MS) return "window_closed";
  if (!lastAnswer || at(lastUser) > at(lastAnswer) || at(lastUser) > armedAt) return "customer_wrote";
  if (rows.some((row) => row.role === "staff" && now - at(row) < EXISTING_CUSTOMER_DAYS * 86_400_000)) return "existing_customer";
  // The bot said something after the answer that armed this (it did not re-arm): that is the last word.
  if (at(lastAnswer) > armedAt + 5_000) return "bot_spoke_after";
  // Judged on the answer itself: the phone ask added after a trip answer (nextQuestion.ts phoneInvite) does not make
  // it a "leave your number" message.
  const body = withoutNextQuestion(lastAnswer.text);
  if (!body.trim() || isNextQuestionText(lastAnswer.text) || NOT_AN_ANSWER.some((pattern) => pattern.test(body))) return "bot_last_not_answer";
  const said = lastUser.text.trim();
  if (!said || /^\[Хэрэглэгч\s[^\]]*илгээсэн\]$/u.test(said)) return "customer_file";
  if (extractPhoneNumber(said)) return "customer_phone";
  if (isSocialMessage(said)) return "customer_social";
  const need = classifyMessageNeed(said, { lastBotReply: rows.slice(0, rows.indexOf(lastUser)).findLast((row) => row.role === "assistant")?.text ?? null });
  if (need && STAFF_NEEDS.has(need.need)) return `customer_need:${need.need}`;
  return null;
}

// ── The sweep ──────────────────────────────────────────────────────────────────────────────────────

export type FollowUpSweepResult = {
  ok: boolean;
  disabled?: string;
  deferred?: string;
  candidates: number;
  sent: number;
  /** Counts per reason; never sender ids or text (the workflow log is public). */
  skipped: Record<string, number>;
};

type PageChoice = { token: string } | { skip: string; transient?: boolean };

/** The page this customer's thread is on, read right before sending: no consultant, the bot spoke last. */
async function threadAllowsFollowUp(senderId: string, now: Date): Promise<PageChoice> {
  const env = getEnv();
  const pages = env.facebookPages.length ? env.facebookPages : env.tokenPage ? [{ pageId: env.facebookPageId, token: env.tokenPage }] : [];
  let pausedPage = false;
  for (const page of pages) {
    if (await isPagePaused(page.pageId)) { pausedPage = true; continue; }
    const token = pageTokenForRecipient(page.pageId, senderId) ?? page.token;
    const lookup = await fetchThreadMessages({ token, senderId, timeoutMs: 5_000 });
    // Never read as "no consultant": an unsolicited message must not risk landing over a person.
    if (lookup.status !== "ok") return { skip: `thread_${lookup.reason}`, transient: true };
    if (!lookup.messages.length) continue;
    const context = await takeoverContext({ messages: lookup.messages, pageId: page.pageId, senderId });
    if (latestStaffReply({ messages: lookup.messages, now, ...context })) return { skip: "staff_in_thread" };
    if (staffMessagesInThread(lookup.messages, context).some((message) => now.getTime() - message.at.getTime() < EXISTING_CUSTOMER_DAYS * 86_400_000)) {
      return { skip: "existing_customer" };
    }
    const last = classifyThread(lookup.messages, context).at(-1);
    if (!last) continue;
    if (last.origin === "customer") return { skip: "customer_wrote" };
    if (last.origin !== "bot") return { skip: "thread_not_bot_last" };
    return { token };
  }
  return pausedPage ? { skip: "page_paused", transient: true } : { skip: "thread_not_found" };
}

/** Sends every due follow-up once. Safe to run concurrently (per-sender atomic claim). */
export async function runFollowUpSweep(options: { now?: Date } = {}): Promise<FollowUpSweepResult> {
  const now = options.now ?? new Date();
  const result: FollowUpSweepResult = { ok: true, candidates: 0, sent: 0, skipped: {} };
  if (followUpDisabledByEnv()) return { ...result, disabled: "env" };
  if (isMetaOutboundDisabled()) return { ...result, disabled: "meta_outbound_off" };
  if (!await ensureTravelSchema()) return { ...result, ok: false, disabled: "db_unavailable" };
  const settings = await getTravelBotSettings();
  const extra = (settings?.extra ?? {}) as Record<string, unknown>;
  if (extra.follow_up_enabled === false) return { ...result, disabled: "settings" };
  const control = await getBotControl();
  if (control.bot_paused) return { ...result, disabled: "bot_paused" };
  if (control.photo_only) return { ...result, disabled: "photo_only" };
  if (isQuietHour(now)) return { ...result, deferred: "quiet_hours" };
  const candidates = await dueCandidates(now, followUpDelayMinutes(extra) * 60_000);
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    const outcome = await followUpOne(candidate, now).catch((error) => {
      logWarn("follow_up.failed", { senderHash: hashIdentifier(candidate.sender_id), message: error instanceof Error ? error.name : "unknown" });
      return "error";
    });
    if (outcome === "sent") result.sent += 1;
    else result.skipped[outcome] = (result.skipped[outcome] || 0) + 1;
  }
  return result;
}

async function followUpOne(candidate: Candidate, now: Date): Promise<string> {
  const senderId = candidate.sender_id;
  const armedAt = new Date(candidate.armed_at).toISOString();
  const senderHash = hashIdentifier(senderId);
  const skip = async (reason: string, transient = false) => {
    recordCounter("follow_up.skipped_total", 1, { reason: reason.split(":")[0] });
    if (transient) {
      logInfo("follow_up.deferred", { senderHash, reason });
    } else {
      await disarm(senderId, armedAt);
      logInfo("follow_up.skipped", { senderHash, reason, slot: candidate.slot });
    }
    return reason;
  };
  const reason = conversationSkipReason(await dbGetConversationRows(senderId), Date.parse(armedAt), now.getTime());
  if (reason) return skip(reason);
  const pause = await dbPauseReason(senderId);
  if (pause) return skip(`paused:${pause}`);
  if (await dbHasRecentStaffMessage(senderId, EXISTING_CUSTOMER_DAYS)) return skip("existing_customer");
  const risk = await takeoverRisk(senderId);
  if (risk) return skip(risk);
  const page = await threadAllowsFollowUp(senderId, now);
  if ("skip" in page) return skip(page.skip, page.transient);
  if (!await claimFollowUp(senderId, armedAt, now)) return "claimed_elsewhere";
  // A consultant may have taken over, or the customer written, while the thread was read.
  const pauseNow = await dbPauseReason(senderId);
  if (pauseNow) return skip(`paused_before_send:${pauseNow}`);
  const raced = conversationSkipReason(await dbGetConversationRows(senderId), Date.parse(armedAt), now.getTime());
  if (raced) return skip(`before_send:${raced}`);
  try {
    // The bot's own send path: the bot metadata makes the send-time takeover guard apply. The programme offer
    // carries the «Хөтөлбөр үзэх» button, which the webhook answers with the trip's programme.
    if (candidate.slot === "program") {
      await sendQuickReplies(senderId, candidate.question, [SMART_BUTTON_LABELS.PROGRAM], page.token, { source: "api.cron.follow_up" });
    } else {
      await sendTextMessage(senderId, candidate.question, page.token, { source: "api.cron.follow_up" });
    }
  } catch (error) {
    if (isStaffTakeoverSendBlocked(error)) return skip(`takeover_blocked:${error.reason}`);
    logWarn("follow_up.send_failed", { senderHash, message: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    return "send_failed";
  }
  await dbAppendMessage(senderId, "assistant", candidate.question).catch(() => null);
  recordCounter("follow_up.sent_total", 1, { slot: candidate.slot });
  logInfo("follow_up.sent", { senderHash, slot: candidate.slot, minutesAfterAnswer: Math.round((now.getTime() - Date.parse(armedAt)) / 60_000) });
  return "sent";
}
