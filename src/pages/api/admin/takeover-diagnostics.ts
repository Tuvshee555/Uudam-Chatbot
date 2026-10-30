import type { NextApiRequest, NextApiResponse } from "next";
import { requireAdminAccess } from "../../../lib/adminAccess";
import { getEnv } from "../../../lib/env";
import { queryNeon } from "../../../lib/neonDb";

export const config = { maxDuration: 120 };

type ThreadMessage = { id?: string; from?: { id?: string }; created_time?: string; message?: string; tags?: { data?: Array<{ name?: string }> } };

/**
 * Read-only evidence for staff-takeover detection (what Meta really sends): the page token's
 * permissions, which webhook fields the app is subscribed to, the Graph API version Meta
 * applies, and — for recent real customers — the tag patterns of messages the Page sent,
 * split into those matching a reply the bot stored and those that do not (a person or a Meta
 * automation). Counts and tag names only: no message text, no customer or message ids.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (!await requireAdminAccess(req, res, "api.admin.takeover_diagnostics")) return;
  if (req.method !== "GET") return res.status(405).end();
  const env = getEnv();
  const pages = env.facebookPages.length ? env.facebookPages : env.tokenPage ? [{ pageId: env.facebookPageId, token: env.tokenPage }] : [];

  // One customer's thread as the webhook classifies it now: who sent each message, when, and
  // what the bot concludes. Times, tags, origins and lengths only — no text, no ids.
  if (typeof req.query.sender_id === "string" && req.query.sender_id.trim()) {
    const senderId = req.query.sender_id.trim();
    const { fetchThreadMessages, takeoverContext, classifyThread, latestStaffReply } = await import("../../../lib/staffTakeover");
    for (const page of pages) {
      const lookup = await fetchThreadMessages({ token: page.token, senderId, timeoutMs: 8000 });
      if (lookup.status !== "ok" || !lookup.messages.length) continue;
      const context = await takeoverContext({ messages: lookup.messages, pageId: page.pageId, senderId });
      const timeline = classifyThread(lookup.messages, context).map(({ message, origin }) => ({
        at: message.created_time,
        from: origin === "customer" ? "customer" : "page",
        ...(origin === "customer" ? {} : { tags: (message.tags?.data ?? []).map((tag) => tag.name ?? "").filter((name) => name.startsWith("source:")), origin }),
        textLength: String(message.message ?? "").length,
      }));
      const state = (await queryNeon<Record<string, unknown>>(
        `SELECT s.paused, s.pause_reason, s.paused_at, s.expires_at, s.last_staff_reply_at,
                l.lead_status, l.assigned_to <> '' AS assigned, l.seen_at, l.notify_status
           FROM travel_senders s LEFT JOIN LATERAL (SELECT * FROM travel_leads WHERE sender_id = s.sender_id ORDER BY id DESC LIMIT 1) l ON TRUE
          WHERE s.sender_id = $1`, [senderId],
      ))?.rows[0] ?? null;
      return res.status(200).json({ ok: true, page: `…${page.pageId.slice(-4)}`, threadComplete: context.threadComplete,
        recordingSince: context.recordingSince ? new Date(context.recordingSince).toISOString() : null,
        verdict: latestStaffReply({ messages: lookup.messages, ...context }), timeline, state });
    }
    return res.status(404).json({ ok: false, error: "thread_not_found" });
  }
  const graph = async (path: string, token: string) => {
    const separator = path.includes("?") ? "&" : "?";
    const response = await fetch(`https://graph.facebook.com/${path}${separator}access_token=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(8000) }).catch(() => null);
    const body = response ? await response.json().catch(() => ({})) : {};
    return { status: response?.status ?? 0, version: response?.headers.get("facebook-api-version") ?? null, body: body as Record<string, unknown> };
  };

  const pageReports = [];
  for (const page of pages) {
    const debug = await graph(`debug_token?input_token=${encodeURIComponent(page.token)}`, page.token);
    const data = (debug.body.data ?? {}) as { is_valid?: boolean; type?: string; scopes?: string[]; expires_at?: number; data_access_expires_at?: number };
    const subscribed = await graph(`${page.pageId}/subscribed_apps`, page.token);
    const apps = ((subscribed.body.data ?? []) as Array<{ name?: string; subscribed_fields?: string[] }>)
      .map((app) => ({ name: app.name ?? "", fields: app.subscribed_fields ?? [] }));
    const unversioned = await graph("me?fields=id", page.token);
    const pinned = await graph("v19.0/me?fields=id", page.token);
    pageReports.push({
      page: `…${page.pageId.slice(-4)}`,
      token: { valid: data.is_valid ?? null, type: data.type ?? null, scopes: data.scopes ?? [], expiresAt: data.expires_at || null,
        dataAccessExpiresAt: data.data_access_expires_at || null, debugStatus: debug.status },
      subscribedApps: apps, subscribedStatus: subscribed.status,
      graphVersion: { appDefault: unversioned.version, whenV19Requested: pinned.version },
    });
  }

  const limit = Math.min(60, Math.max(1, Number(req.query.senders) || 40));
  const senders = (await queryNeon<{ sender_id: string }>(
    `SELECT sender_id FROM travel_senders WHERE platform = 'facebook' AND sender_id NOT LIKE 'demo:%'
       AND last_seen > NOW() - INTERVAL '14 days' ORDER BY last_seen DESC LIMIT $1`, [limit],
  ))?.rows ?? [];
  const signatures = new Map<string, { total: number; matchedBot: number; unmatched: number; unmatchedSoonAfterCustomer: number; unmatchedRepeatedText: number }>();
  const texts = new Map<string, number>();
  const unmatchedRecords: Array<{ signature: string; soon: boolean; text: string }> = [];
  // Unmatched source:web page messages, broken down (counts only).
  const web = { beforeStoredHistory: 0, gapUnder5s: 0, gap5to20s: 0, gap20to120s: 0, gapOver120s: 0, noCustomerBefore: 0,
    firstPageMessageInThread: 0, len0: 0, lenUnder60: 0, len60to200: 0, lenOver200: 0, withinOneMinuteOfStaffMobile: 0 };
  let assistantRowsWithoutThreadMatch = 0, assistantRowsInThreadWindow = 0;
  let threadsRead = 0, threadFailures = 0;
  const idPrefixes = new Set<string>();
  const token = pages[0]?.token;
  const pageId = pages[0]?.pageId;
  for (const { sender_id } of token ? senders : []) {
    const thread = await graph(`me/conversations?platform=messenger&user_id=${encodeURIComponent(sender_id)}&fields=messages.limit(25){id,from,created_time,message,tags}`, token!);
    const messages = ((thread.body.data as Array<{ messages?: { data?: ThreadMessage[] } }> | undefined)?.[0]?.messages?.data) ?? null;
    if (thread.status !== 200 || !messages) { threadFailures += 1; continue; }
    threadsRead += 1;
    const assistantRows = (await queryNeon<{ at: string; text: string }>(
      "SELECT created_at AS at, text FROM travel_conversations WHERE sender_id=$1 AND role='assistant' AND created_at > NOW() - INTERVAL '120 days'",
      [sender_id],
    ))?.rows ?? [];
    const ordered = [...messages].sort((a, b) => Date.parse(a.created_time ?? "") - Date.parse(b.created_time ?? ""));
    const oldestStored = assistantRows.length ? Math.min(...assistantRows.map((row) => Date.parse(row.at))) : Infinity;
    const threadStart = Date.parse(ordered[0]?.created_time ?? "");
    for (const row of assistantRows) {
      const at = Date.parse(row.at);
      if (at < threadStart) continue;
      assistantRowsInThreadWindow += 1;
      if (!ordered.some((m) => m.from?.id === pageId && Math.abs(Date.parse(m.created_time ?? "") - at) < 120_000)) assistantRowsWithoutThreadMatch += 1;
    }
    let pageMessagesSeen = 0;
    ordered.forEach((message, index) => {
      if (message.id) idPrefixes.add(message.id.slice(0, 2));
      if (message.from?.id !== pageId) return;
      pageMessagesSeen += 1;
      const at = Date.parse(message.created_time ?? "");
      const signature = (message.tags?.data ?? []).map((tag) => tag.name ?? "").sort().join(",") || "(none)";
      const entry = signatures.get(signature) ?? { total: 0, matchedBot: 0, unmatched: 0, unmatchedSoonAfterCustomer: 0, unmatchedRepeatedText: 0 };
      entry.total += 1;
      const text = String(message.message ?? "").trim();
      const matched = assistantRows.some((row) => Math.abs(Date.parse(row.at) - at) < 120_000
        && (text === "" || row.text.trim().slice(0, 40) === text.slice(0, 40) || row.text.includes(text.slice(0, 30))));
      if (matched) entry.matchedBot += 1;
      else {
        entry.unmatched += 1;
        const previous = ordered.slice(0, index).reverse().find((candidate) => candidate.from?.id !== pageId);
        const soon = Boolean(previous && at - Date.parse(previous.created_time ?? "") < 15_000);
        if (soon) entry.unmatchedSoonAfterCustomer += 1;
        if (signature === "inbox,read,sent,source:web") {
          const gap = previous ? at - Date.parse(previous.created_time ?? "") : null;
          if (at < oldestStored) web.beforeStoredHistory += 1;
          if (gap === null) web.noCustomerBefore += 1;
          else if (gap < 5_000) web.gapUnder5s += 1;
          else if (gap < 20_000) web.gap5to20s += 1;
          else if (gap < 120_000) web.gap20to120s += 1;
          else web.gapOver120s += 1;
          if (pageMessagesSeen === 1) web.firstPageMessageInThread += 1;
          const length = text.length;
          if (length === 0) web.len0 += 1; else if (length < 60) web.lenUnder60 += 1; else if (length <= 200) web.len60to200 += 1; else web.lenOver200 += 1;
          if (ordered.some((m) => m.from?.id === pageId && (m.tags?.data ?? []).some((tag) => tag.name === "source:mobile")
            && Math.abs(Date.parse(m.created_time ?? "") - at) < 60_000)) web.withinOneMinuteOfStaffMobile += 1;
        }
        texts.set(text, (texts.get(text) ?? 0) + 1);
        unmatchedRecords.push({ signature, soon, text });
      }
      signatures.set(signature, entry);
    });
  }
  for (const record of unmatchedRecords) if (record.text && (texts.get(record.text) ?? 0) >= 3) signatures.get(record.signature)!.unmatchedRepeatedText += 1;

  return res.status(200).json({
    ok: true,
    pages: pageReports,
    threads: { sendersChecked: senders.length, threadsRead, threadFailures, messageIdPrefixes: [...idPrefixes] },
    pageMessageSignatures: Object.fromEntries([...signatures.entries()].sort((a, b) => b[1].total - a[1].total)),
    unmatchedWebBreakdown: web,
    storedBotReplies: { inThreadWindow: assistantRowsInThreadWindow, withoutAnyPageMessageNearby: assistantRowsWithoutThreadMatch },
  });
}
