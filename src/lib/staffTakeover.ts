/**
 * Has a consultant replied to this customer, so the bot must stay out?
 *
 * Meta can tell the webhook through `message_echoes`, but the page tokens only hold
 * `pages_messaging` (no `pages_manage_metadata`), so the app cannot keep that subscription and
 * echoes stopped after 2026-08-01. The Conversations API is readable with the page token, so
 * the bot reads the thread before replying.
 *
 * Every Page message comes back "from" the Page — this bot, a consultant, Meta's automations
 * and inbox notices alike. Production threads (takeover diagnostics, 2026-10-30, 60 customers):
 * a consultant on the phone app is `source:mobile`; the bot, a consultant on a computer
 * (Business Suite) and Meta's automations are all `source:web`. So:
 * - the bot's own messages are known by the id Meta returned when it sent them
 *   (outboundMessages.ts), or by matching a reply the bot stored at that moment;
 * - `source:mobile` is a consultant;
 * - any other `source:web` Page message is a consultant on a computer, except Meta's
 *   automations and notices, which come within seconds of the customer's message, open the
 *   conversation before the customer's first message (the automated welcome greeting, live
 *   2026-10-30 22:37 UTC), or read as a notice;
 * - a `source:web` message from before the bot recorded its ids cannot be told apart and
 *   counts only as before (not a consultant).
 * A lookup that fails says so ("unverified"); it never reads as "no consultant".
 */
import { GRAPH_API_BASE } from "./metaGraph";

// The database is loaded on use, so the classification above stays importable on its own.
const db = () => import("./neonDb");

export type ThreadMessage = {
  id?: string;
  from?: { id?: string };
  message?: string;
  created_time?: string;
  tags?: { data?: Array<{ name?: string }> };
};

export type ThreadLookup =
  | { status: "ok"; messages: ThreadMessage[] }
  | { status: "unverified"; reason: "timeout" | "permission" | "api_error" | "incomplete" };

export type PageMessageOrigin = "bot" | "staff_mobile" | "staff_web" | "automation" | "legacy" | "other";

/** How long the bot stays quiet after the latest staff message. */
export const STAFF_TAKEOVER_MS = 3 * 24 * 60 * 60 * 1000;
/** Meta's instant replies, away messages and inbox notices follow the customer within seconds. */
export const AUTOMATION_WINDOW_MS = 20_000;
const META_NOTICE = /(?:replied to|responded to|clicked (?:on )?(?:your|an) ad|via an ad|from an ad|automated (?:welcome )?message|started (?:this|a) conversation)/i;

export type ClassifyContext = {
  pageId: string;
  /** The thread was read from its start (fewer messages than the lookup's limit). */
  threadComplete?: boolean;
  /** Ids the bot recorded when sending (outboundMessages.ts). */
  botMids?: Set<string>;
  /** When the bot began recording ids; null: unknown, every source:web message is legacy. */
  recordingSince?: number | null;
  /** Replies the bot stored for this customer, the fallback for an unrecorded id. */
  botReplies?: Array<{ at: number; text: string; attachments?: number }>;
};

/** Messages per thread lookup (fetchThreadMessages); a full page may not start at the beginning. */
export const THREAD_LOOKUP_LIMIT = 25;

const tagsOf = (message: ThreadMessage) => (message.tags?.data ?? []).map((tag) => tag.name ?? "");

function matchesStoredReply(message: ThreadMessage, at: number, replies: ClassifyContext["botReplies"]): boolean {
  const text = String(message.message ?? "").trim();
  // An image (no text) matches only a stored reply that carried one: a consultant's photo sent
  // right after a bot reply is not the bot.
  return (replies ?? []).some((reply) => Math.abs(reply.at - at) < 120_000
    && (text === "" ? (reply.attachments ?? 0) > 0 : reply.text.trim().startsWith(text.slice(0, 40)) || reply.text.includes(text.slice(0, 30))));
}

/**
 * Who sent one Page message; `previousCustomerAt` is the customer's last message before it, and
 * `opener` says it opens the conversation (only Meta's automations before it, in a thread read
 * from its start).
 */
export function classifyPageMessage(message: ThreadMessage, previousCustomerAt: number | null, context: ClassifyContext, opener = false): PageMessageOrigin {
  const at = Date.parse(message.created_time ?? "");
  const tags = tagsOf(message);
  if (message.id && context.botMids?.has(message.id)) return "bot";
  // The phone app is only ever a person; the bot sends from the web.
  if (tags.includes("source:mobile")) return "staff_mobile";
  if (!tags.includes("source:web")) return "other";
  if (matchesStoredReply(message, at, context.botReplies)) return "bot";
  const since = context.recordingSince ?? null;
  if (since === null || !(at >= since)) return "legacy";
  if (META_NOTICE.test(String(message.message ?? ""))) return "automation";
  // The conversation's opener, before the customer's first message: Meta's automated welcome
  // greeting, never a consultant replying.
  if (opener && previousCustomerAt === null) return "automation";
  if (previousCustomerAt !== null && at - previousCustomerAt >= 0 && at - previousCustomerAt < AUTOMATION_WINDOW_MS) return "automation";
  return "staff_web";
}

/** Latest consultant message in the thread within `windowMs`, and how it was recognised. */
export function latestStaffReply(input: {
  messages: ThreadMessage[];
  now?: Date;
  windowMs?: number;
} & ClassifyContext): { at: Date; origin: "staff_mobile" | "staff_web" } | null {
  const now = (input.now ?? new Date()).getTime();
  const windowMs = input.windowMs ?? STAFF_TAKEOVER_MS;
  let latest: { at: Date; origin: "staff_mobile" | "staff_web" } | null = null;
  for (const { at, origin } of classifyThread(input.messages, input)) {
    if (now - at > windowMs) continue;
    if ((origin === "staff_mobile" || origin === "staff_web") && (!latest || at > latest.at.getTime())) latest = { at: new Date(at), origin };
  }
  return latest;
}

/**
 * Every message of the thread in time order, each Page message with its origin. The opening run —
 * in a thread read from its start, before the customer's first message and before any Page message
 * that is not an automation — is Meta's automated greeting.
 */
export function classifyThread(messages: ThreadMessage[], context: ClassifyContext): Array<{ message: ThreadMessage; at: number; origin: PageMessageOrigin | "customer" }> {
  const ordered = [...messages].sort((a, b) => Date.parse(a.created_time ?? "") - Date.parse(b.created_time ?? ""));
  let previousCustomerAt: number | null = null;
  let opening = context.threadComplete ?? messages.length < THREAD_LOOKUP_LIMIT;
  const classified: Array<{ message: ThreadMessage; at: number; origin: PageMessageOrigin | "customer" }> = [];
  for (const message of ordered) {
    const at = Date.parse(message.created_time ?? "");
    if (Number.isNaN(at)) continue;
    if (message.from?.id !== context.pageId) {
      previousCustomerAt = at;
      opening = false;
      classified.push({ message, at, origin: "customer" });
      continue;
    }
    const origin = classifyPageMessage(message, previousCustomerAt, context, opening);
    if (origin !== "automation") opening = false;
    classified.push({ message, at, origin });
  }
  return classified;
}

/** Back-compatible: the latest consultant message time, or null. */
export function latestStaffReplyAt(input: { messages: ThreadMessage[]; now?: Date; windowMs?: number } & ClassifyContext): Date | null {
  return latestStaffReply(input)?.at ?? null;
}

const PERMISSION_CODES = new Set([10, 190, 200, 230, 294, 298, 299]);

/** Reads the thread from Meta; a failure is reported as such, never as an empty thread. */
export async function fetchThreadMessages(input: {
  token: string;
  senderId: string;
  timeoutMs: number;
}): Promise<ThreadLookup> {
  const url = `${GRAPH_API_BASE}/me/conversations?platform=messenger&user_id=${encodeURIComponent(input.senderId)}`
    + `&fields=messages.limit(${THREAD_LOOKUP_LIMIT}){id,from,message,created_time,tags}&access_token=${encodeURIComponent(input.token)}`;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(input.timeoutMs) });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { status: "unverified", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "api_error" };
  }
  const body = await response.json().catch(() => null) as { data?: Array<{ messages?: { data?: unknown } }>; error?: { code?: number } } | null;
  if (!response.ok) {
    const code = Number(body?.error?.code);
    return { status: "unverified", reason: response.status === 401 || response.status === 403 || PERMISSION_CODES.has(code) ? "permission" : "api_error" };
  }
  if (!body || !Array.isArray(body.data)) return { status: "unverified", reason: "incomplete" };
  if (body.data.length === 0) return { status: "ok", messages: [] };
  const messages = body.data[0]?.messages?.data;
  if (!Array.isArray(messages)) return { status: "unverified", reason: "incomplete" };
  return { status: "ok", messages: messages as ThreadMessage[] };
}

export type TakeoverCheck =
  | { status: "checked"; staff: { at: Date; origin: "staff_mobile" | "staff_web" } | null }
  | { status: "unverified"; reason: "timeout" | "permission" | "api_error" | "incomplete" };

/** What the classification needs besides the thread: the bot's recorded ids and stored replies. */
export async function takeoverContext(input: { messages: ThreadMessage[]; pageId: string; senderId: string }): Promise<ClassifyContext> {
  const pageMessages = input.messages.filter((message) => message.from?.id === input.pageId);
  const { knownOutboundMids, outboundRecordingSince } = await import("./outboundMessages");
  const { queryNeon } = await db();
  const [botMids, recordingSince, replies] = await Promise.all([
    knownOutboundMids(pageMessages.map((message) => message.id ?? "").filter(Boolean)).catch(() => new Set<string>()),
    outboundRecordingSince().catch(() => null),
    queryNeon<{ at: string; text: string; attachments: number }>(
      `SELECT created_at AS at, text, CASE WHEN jsonb_typeof(attachments) = 'array' THEN jsonb_array_length(attachments) ELSE 0 END AS attachments
         FROM travel_conversations
        WHERE sender_id=$1 AND role='assistant' AND created_at > NOW() - INTERVAL '4 days'`, [input.senderId],
    ).catch(() => null),
  ]);
  const botReplies = (replies?.rows ?? []).map((row) => ({ at: Date.parse(String(row.at)), text: String(row.text ?? ""), attachments: Number(row.attachments) || 0 }));
  return { pageId: input.pageId, botMids, recordingSince, botReplies, threadComplete: input.messages.length < THREAD_LOOKUP_LIMIT };
}

/** The thread, classified with the bot's recorded ids and stored replies. */
export async function detectStaffTakeover(input: { lookup: ThreadLookup; pageId: string; senderId: string; now?: Date }): Promise<TakeoverCheck> {
  if (input.lookup.status !== "ok") return input.lookup;
  if (!input.lookup.messages.some((message) => message.from?.id === input.pageId)) return { status: "checked", staff: null };
  const context = await takeoverContext({ messages: input.lookup.messages, pageId: input.pageId, senderId: input.senderId });
  return { status: "checked", staff: latestStaffReply({ messages: input.lookup.messages, now: input.now, ...context }) };
}

/** Records when a consultant last replied, so a later failed lookup still knows staff are involved. */
export async function markStaffReply(senderId: string, at: Date): Promise<void> {
  const { queryNeon } = await db();
  await queryNeon(
    `UPDATE travel_senders SET last_staff_reply_at = GREATEST(COALESCE(last_staff_reply_at, $2::timestamptz), $2::timestamptz)
      WHERE sender_id = $1`, [senderId, at.toISOString()],
  );
}

/**
 * When the thread cannot be read, is this a conversation the bot could talk over a consultant
 * in? A consultant replied in the last week, a lead is assigned to someone, or the customer has
 * an open booking or consultant request from the last three days. Null: answer as usual.
 */
export async function takeoverRisk(senderId: string): Promise<"recent_staff_reply" | "assigned_lead" | "open_lead" | null> {
  const { queryNeon, isNeonConfigured } = await db();
  // No database at all (local runs): nothing can mark a conversation as staff-owned.
  if (!isNeonConfigured()) return null;
  const result = await queryNeon<{ staff: boolean; assigned: boolean; open: boolean }>(
    `SELECT
       COALESCE((SELECT last_staff_reply_at > NOW() - INTERVAL '7 days' FROM travel_senders WHERE sender_id=$1), FALSE) AS staff,
       EXISTS (SELECT 1 FROM travel_leads WHERE sender_id=$1 AND assigned_to <> '' AND lead_status IN ('new_lead','contacted','no_answer')
                 AND COALESCE(last_activity_at, created_at) > NOW() - INTERVAL '14 days') AS assigned,
       EXISTS (SELECT 1 FROM travel_leads WHERE sender_id=$1 AND lead_status IN ('new_lead','contacted','no_answer')
                 AND COALESCE(last_activity_at, created_at) > NOW() - INTERVAL '3 days') AS open`,
    [senderId],
  ).catch(() => null);
  const row = result?.rows[0];
  // Holding a reply needs evidence that staff are involved. When even that cannot be read (the
  // database is failing too) there is none, and holding would only add silence to an outage.
  if (!row) {
    const { logError } = await import("./observability");
    logError("staff_takeover.risk_unreadable", { hint: "Thread and database both unavailable; the customer is answered as usual." });
    return null;
  }
  return row.staff ? "recent_staff_reply" : row.assigned ? "assigned_lead" : row.open ? "open_lead" : null;
}
