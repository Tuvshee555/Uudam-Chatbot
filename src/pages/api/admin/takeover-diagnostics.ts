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
      "SELECT created_at AS at, text FROM travel_conversations WHERE sender_id=$1 AND role='assistant' AND created_at > NOW() - INTERVAL '30 days'",
      [sender_id],
    ))?.rows ?? [];
    const ordered = [...messages].sort((a, b) => Date.parse(a.created_time ?? "") - Date.parse(b.created_time ?? ""));
    ordered.forEach((message, index) => {
      if (message.id) idPrefixes.add(message.id.slice(0, 2));
      if (message.from?.id !== pageId) return;
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
  });
}
