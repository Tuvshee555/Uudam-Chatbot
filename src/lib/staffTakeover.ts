/**
 * Has a staff member replied to this customer from the Page inbox?
 *
 * Meta is meant to tell the webhook through `message_echoes`, but that
 * subscription has never been on for this app (the page tokens lack
 * pages_manage_metadata), so the bot kept answering over staff: one customer
 * got the trip card three times between a staff member's own messages
 * (2026-10-06). The Conversations API IS readable with the page token, so the
 * bot looks at the thread itself before replying.
 *
 * Every Page-sent message comes back "from" the Page — staff, this bot, Meta's
 * welcome/instant replies and inbox notices alike. Only staff typing in the
 * Pages / Business Suite app carries `source:mobile`; the rest are
 * `source:web`. Checked against every thread of 2026-10-05..09: staff wrote in
 * 64 of 69, always `source:mobile`, while `source:web` page messages were the
 * bot or Meta's automations ("Hi …! Please let us know how we can help…").
 */

export type ThreadMessage = {
  from?: { id?: string };
  message?: string;
  created_time?: string;
  tags?: { data?: Array<{ name?: string }> };
};

/** How long the bot stays quiet after the latest staff message. */
export const STAFF_TAKEOVER_MS = 3 * 24 * 60 * 60 * 1000;

/** Latest staff message in the thread within `windowMs`, or null. */
export function latestStaffReplyAt(input: {
  messages: ThreadMessage[];
  pageId: string;
  now?: Date;
  windowMs?: number;
}): Date | null {
  const now = (input.now ?? new Date()).getTime();
  const windowMs = input.windowMs ?? STAFF_TAKEOVER_MS;
  let latest = 0;
  for (const message of input.messages) {
    if (message.from?.id !== input.pageId) continue;
    const at = Date.parse(message.created_time ?? "");
    if (Number.isNaN(at) || now - at > windowMs) continue;
    const fromStaffApp = (message.tags?.data ?? []).some((tag) => tag.name === "source:mobile");
    if (fromStaffApp && at > latest) latest = at;
  }
  return latest ? new Date(latest) : null;
}

/** Reads the thread from Meta; null on any failure so the bot still answers. */
export async function fetchThreadMessages(input: {
  token: string;
  senderId: string;
  timeoutMs: number;
}): Promise<ThreadMessage[] | null> {
  const url = `https://graph.facebook.com/v19.0/me/conversations?platform=messenger&user_id=${encodeURIComponent(input.senderId)}`
    + `&fields=messages.limit(25){from,message,created_time,tags}&access_token=${encodeURIComponent(input.token)}`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(input.timeoutMs) });
    if (!response.ok) return null;
    const body = await response.json() as { data?: Array<{ messages?: { data?: ThreadMessage[] } }> };
    return body.data?.[0]?.messages?.data ?? [];
  } catch {
    return null;
  }
}
