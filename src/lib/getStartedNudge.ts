/**
 * One message to a customer who tapped «Get Started» and then wrote nothing (owner, 2026-11-14: "when someone
 * says get started the Facebook automatic thing answers and we lost it … my client wanted something like 'where
 * are you looking to travel? see our trips here, or leave your phone number if you have a question' and the
 * calendar link, when they don't text for 30 minutes after Get Started").
 *
 * Meta's own automated greeting still answers the tap (the bot stays silent then, webhook.ts); this is the one
 * message after it, from the same sweep as the follow-up (/api/cron/follow-up, every 5 minutes).
 *
 * Sent once per tap, only when ALL hold (each skip is logged with its reason, never with customer text):
 * - the tap is ≥ the delay old (extra.get_started_nudge_delay_minutes, default 30) and < 20 h old (Meta's 24 h
 *   window, which the tap opened);
 * - the customer wrote nothing since the tap except a bare greeting ("hi" right after the tap is not answered
 *   either), and the bot said nothing since;
 * - no pause, no consultant in the Messenger thread or in the stored history within 30 days (an existing
 *   customer gets no sales nudge), no open or assigned lead; the thread ends on the customer's tap / greeting or
 *   on Meta's automated greeting;
 * - not quiet hours (22:00–09:00 Ulaanbaatar: it waits, inside the window), Facebook only, not a demo sender;
 * - extra.get_started_nudge_enabled !== false and GET_STARTED_NUDGE is not "off".
 */
import { BOOKING_WEBSITE_URL } from "./bookingWebsite";
import { getEnv, pageTokenForRecipient } from "./env";
import { EXISTING_CUSTOMER_DAYS, FOLLOW_UP_WINDOW_MS, isQuietHour } from "./followUp";
import { isGetStartedText, isKnownGreetingPhrase } from "./greetingPhrases";
import { sendTextMessage } from "./messenger";
import { isMetaOutboundDisabled } from "./metaOutboundKillSwitch";
import { queryNeon } from "./neonDb";
import { hashIdentifier, logInfo, logWarn, recordCounter } from "./observability";
import { classifyThread, fetchThreadMessages, latestStaffReply, staffMessagesInThread, takeoverContext, takeoverRisk } from "./staffTakeover";
import { isStaffTakeoverSendBlocked } from "./takeoverGuard";
import { getBotControl, getTravelBotSettings, isPagePaused } from "./travelOps";
import { ensureTravelSchema } from "./travelSchema";
import { dbAppendMessage, dbGetConversationRows, dbHasRecentStaffMessage, dbPauseReason, type ConversationRow } from "./travelSessionDb";

export const GET_STARTED_NUDGE_DEFAULT_DELAY_MINUTES = 30;
/** The calendar of every departure on the website (uudamtravel.mn/departures). */
export const DEPARTURES_CALENDAR_URL = `${BOOKING_WEBSITE_URL}/departures`;
export const GET_STARTED_NUDGE_TEXT = [
  "Та хаашаа аялахаар сонирхож байна вэ? 😊",
  `Бүх аяллын гарах өдрийг календараас харж болно: ${DEPARTURES_CALENDAR_URL}`,
  "Асуух зүйл байвал утасны дугаараа үлдээгээрэй, манай аяллын зөвлөх тантай холбогдоно.",
].join("\n");
const SWEEP_LIMIT = 25;

export function getStartedNudgeDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(?:off|false|0|no)$/i.test(String(env.GET_STARTED_NUDGE ?? "").trim());
}

export function getStartedNudgeDelayMinutes(extra: Record<string, unknown> | null | undefined): number {
  const raw = Number(extra?.get_started_nudge_delay_minutes);
  return Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.max(5, Math.round(raw))) : GET_STARTED_NUDGE_DEFAULT_DELAY_MINUTES;
}

/** A customer message that is not a real message after the tap: the tap itself, or a bare greeting. */
const isTapOrGreeting = (text: string) => !text.trim() || isGetStartedText(text) || isKnownGreetingPhrase(text);

const at = (row: { created_at: string | Date }) => new Date(row.created_at).getTime();

/** Why the stored conversation rules the nudge out, or null when it may go. Pure. */
export function storedSkipReason(rows: ConversationRow[], tappedAt: number, now: number): string | null {
  if (now - tappedAt >= FOLLOW_UP_WINDOW_MS) return "window_closed";
  const since = rows.filter((row) => at(row) >= tappedAt - 1_000);
  if (since.some((row) => row.role === "user" && !isTapOrGreeting(row.text))) return "customer_wrote";
  if (since.some((row) => row.role === "assistant" && row.text.trim())) return "bot_spoke";
  if (rows.some((row) => row.role === "staff" && now - at(row) < EXISTING_CUSTOMER_DAYS * 86_400_000)) return "existing_customer";
  return null;
}

type Candidate = { sender_id: string; tapped_at: string | Date };

async function dueCandidates(now: Date, delayMs: number): Promise<Candidate[]> {
  const result = await queryNeon<Candidate>(
    `SELECT sender_id, get_started_at AS tapped_at FROM travel_senders
      WHERE get_started_at IS NOT NULL AND platform = 'facebook' AND sender_id NOT LIKE 'demo:%'
        AND get_started_at <= $1::timestamptz AND get_started_at > $2::timestamptz
        AND (get_started_nudge_at IS NULL OR get_started_nudge_at < get_started_at)
      ORDER BY get_started_at ASC LIMIT $3`,
    [new Date(now.getTime() - delayMs).toISOString(), new Date(now.getTime() - FOLLOW_UP_WINDOW_MS).toISOString(), SWEEP_LIMIT],
  );
  return result?.rows ?? [];
}

/** Atomic: marks this tap handled (sent or ruled out), once. A later tap makes the customer eligible again. */
async function claimTap(senderId: string, tappedAt: string, now: Date): Promise<boolean> {
  const result = await queryNeon<{ sender_id: string }>(
    `UPDATE travel_senders SET get_started_nudge_at = $3::timestamptz
      WHERE sender_id = $1 AND get_started_at = $2::timestamptz
        AND (get_started_nudge_at IS NULL OR get_started_nudge_at < get_started_at)
      RETURNING sender_id`,
    [senderId, tappedAt, now.toISOString()],
  );
  return Boolean(result?.rows.length);
}

type PageChoice = { token: string } | { skip: string; transient?: boolean };

/** The Messenger thread, read right before sending: nobody but the customer's tap and Meta's greeting since. */
async function threadAllowsNudge(senderId: string, tappedAt: number, now: Date): Promise<PageChoice> {
  const env = getEnv();
  const pages = env.facebookPages.length ? env.facebookPages : env.tokenPage ? [{ pageId: env.facebookPageId, token: env.tokenPage }] : [];
  let pausedPage = false;
  for (const page of pages) {
    if (await isPagePaused(page.pageId)) { pausedPage = true; continue; }
    const token = pageTokenForRecipient(page.pageId, senderId) ?? page.token;
    const lookup = await fetchThreadMessages({ token, senderId, timeoutMs: 5_000 });
    // Never read as "nobody wrote": an unsolicited message must not risk landing over a person.
    if (lookup.status !== "ok") return { skip: `thread_${lookup.reason}`, transient: true };
    if (!lookup.messages.length) continue;
    const context = await takeoverContext({ messages: lookup.messages, pageId: page.pageId, senderId });
    if (latestStaffReply({ messages: lookup.messages, now, ...context })) return { skip: "staff_in_thread" };
    if (staffMessagesInThread(lookup.messages, context).some((message) => now.getTime() - message.at.getTime() < EXISTING_CUSTOMER_DAYS * 86_400_000)) {
      return { skip: "existing_customer" };
    }
    const since = classifyThread(lookup.messages, context).filter((entry) => entry.at >= tappedAt - 60_000);
    if (since.some((entry) => entry.origin === "customer" && !isTapOrGreeting(String(entry.message.message ?? "")))) return { skip: "customer_wrote" };
    if (since.some((entry) => entry.origin !== "customer" && entry.origin !== "automation")) return { skip: "page_spoke" };
    return { token };
  }
  return pausedPage ? { skip: "page_paused", transient: true } : { skip: "thread_not_found" };
}

export type GetStartedNudgeResult = {
  ok: boolean;
  disabled?: string;
  deferred?: string;
  candidates: number;
  sent: number;
  /** Counts per reason; never sender ids or text (the workflow log is public). */
  skipped: Record<string, number>;
};

/** Sends every due nudge once. Safe to run concurrently (per-tap atomic claim). */
export async function runGetStartedNudgeSweep(options: { now?: Date } = {}): Promise<GetStartedNudgeResult> {
  const now = options.now ?? new Date();
  const result: GetStartedNudgeResult = { ok: true, candidates: 0, sent: 0, skipped: {} };
  if (getStartedNudgeDisabledByEnv()) return { ...result, disabled: "env" };
  if (isMetaOutboundDisabled()) return { ...result, disabled: "meta_outbound_off" };
  if (!await ensureTravelSchema()) return { ...result, ok: false, disabled: "db_unavailable" };
  const extra = ((await getTravelBotSettings())?.extra ?? {}) as Record<string, unknown>;
  if (extra.get_started_nudge_enabled === false) return { ...result, disabled: "settings" };
  const control = await getBotControl();
  if (control.bot_paused) return { ...result, disabled: "bot_paused" };
  if (control.photo_only) return { ...result, disabled: "photo_only" };
  if (isQuietHour(now)) return { ...result, deferred: "quiet_hours" };
  const candidates = await dueCandidates(now, getStartedNudgeDelayMinutes(extra) * 60_000);
  result.candidates = candidates.length;
  for (const candidate of candidates) {
    const outcome = await nudgeOne(candidate, now).catch((error) => {
      logWarn("get_started_nudge.failed", { senderHash: hashIdentifier(candidate.sender_id), message: error instanceof Error ? error.name : "unknown" });
      return "error";
    });
    if (outcome === "sent") result.sent += 1;
    else result.skipped[outcome] = (result.skipped[outcome] || 0) + 1;
  }
  return result;
}

async function nudgeOne(candidate: Candidate, now: Date): Promise<string> {
  const senderId = candidate.sender_id;
  const tappedAtIso = new Date(candidate.tapped_at).toISOString();
  const tappedAt = Date.parse(tappedAtIso);
  const senderHash = hashIdentifier(senderId);
  const skip = async (reason: string, transient = false) => {
    recordCounter("get_started_nudge.skipped_total", 1, { reason: reason.split(":")[0] });
    if (transient) {
      logInfo("get_started_nudge.deferred", { senderHash, reason });
    } else {
      // Ruled out for this tap: marked handled so the next sweeps do not look again.
      await claimTap(senderId, tappedAtIso, now).catch(() => false);
      logInfo("get_started_nudge.skipped", { senderHash, reason });
    }
    return reason;
  };
  const reason = storedSkipReason(await dbGetConversationRows(senderId), tappedAt, now.getTime());
  if (reason) return skip(reason);
  const pause = await dbPauseReason(senderId);
  if (pause) return skip(`paused:${pause}`);
  if (await dbHasRecentStaffMessage(senderId, EXISTING_CUSTOMER_DAYS)) return skip("existing_customer");
  const risk = await takeoverRisk(senderId);
  if (risk) return skip(risk);
  const page = await threadAllowsNudge(senderId, tappedAt, now);
  if ("skip" in page) return skip(page.skip, page.transient);
  if (!await claimTap(senderId, tappedAtIso, now)) return "claimed_elsewhere";
  // A consultant may have taken over, or the customer written, while the thread was read.
  const pauseNow = await dbPauseReason(senderId);
  if (pauseNow) return skip(`paused_before_send:${pauseNow}`);
  const raced = storedSkipReason(await dbGetConversationRows(senderId), tappedAt, now.getTime());
  if (raced) return skip(`before_send:${raced}`);
  try {
    // The bot's own send path: the bot metadata makes the send-time takeover guard apply.
    await sendTextMessage(senderId, GET_STARTED_NUDGE_TEXT, page.token, { source: "api.cron.get_started_nudge" });
  } catch (error) {
    if (isStaffTakeoverSendBlocked(error)) return skip(`takeover_blocked:${error.reason}`);
    logWarn("get_started_nudge.send_failed", { senderHash, message: error instanceof Error ? error.message.slice(0, 160) : "unknown" });
    return "send_failed";
  }
  await dbAppendMessage(senderId, "assistant", GET_STARTED_NUDGE_TEXT).catch(() => null);
  recordCounter("get_started_nudge.sent_total", 1);
  logInfo("get_started_nudge.sent", { senderHash, minutesAfterTap: Math.round((now.getTime() - tappedAt) / 60_000) });
  return "sent";
}
