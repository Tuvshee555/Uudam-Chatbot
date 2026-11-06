import type { NextApiRequest, NextApiResponse } from "next";
import { getClientKey } from "../../lib/rateLimit";
import { getEnv } from "../../lib/env";
import { requireAdminAccess } from "../../lib/adminAccess";
import {
  beginRequestTrace,
  classifyError,
  finishRequestTrace,
  hashIdentifier,
  logError,
} from "../../lib/observability";
import { GRAPH_API_BASE } from "../../lib/metaGraph";

const env = getEnv();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const trace = beginRequestTrace({
    route: "api.subscribe_feed",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });

  const clientKey = getClientKey(req);

  try {
    // A signed-in admin only (Google session). Never the read-only ADMIN_API_TOKEN: even a
    // GET here re-subscribes the pages at Meta.
    if (!(await requireAdminAccess(req, res, "api.subscribe_feed", { allowApiToken: false }))) return;

    // "message_echoes" (not "messaging_echoes", which Meta rejects and which
    // failed the whole request) is what tells the bot a staff member replied
    // from the Page inbox, so it can step aside. Every configured page needs it.
    // messaging_referrals: a customer who already has a thread and taps an ad (or an m.me
    // link) arrives as a separate referral event; without it the bot never learns which ad,
    // and "Can you tell me more about your ad?" names no trip (Meta webhook docs).
    const fields = "feed,messages,messaging_postbacks,message_reads,message_echoes,messaging_referrals";

    try {
      const results = [];
      for (const page of env.facebookPages) {
        // Plain fetch: Meta's error body (missing permission, bad field) is the
        // answer this admin call exists to show.
        const response = await fetch(`${GRAPH_API_BASE}/${page.pageId}/subscribed_apps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscribed_fields: fields, access_token: page.token }),
          signal: AbortSignal.timeout(env.metaApiTimeoutMs),
        });
        const body = await response.json().catch(() => null);
        const current = await fetch(`${GRAPH_API_BASE}/${page.pageId}/subscribed_apps?access_token=${encodeURIComponent(page.token)}`, {
          signal: AbortSignal.timeout(env.metaApiTimeoutMs),
        }).then((r) => r.json()).catch(() => null);
        results.push({ pageId: page.pageId, status: response.status, response: body, subscribed: current });
      }
      return res.status(results.every((r) => r.status === 200) ? 200 : 502).json({ subscribed_fields: fields, results });
    } catch (error) {
      const classification = classifyError(error);
      logError("subscribe_feed.failed", {
        requestId: trace.requestId,
        correlationId: trace.correlationId,
        classification,
        message: error instanceof Error ? error.message : String(error),
      });
      return res.status(502).json({ error: "upstream_error", classification });
    }
  } finally {
    finishRequestTrace(trace, res.statusCode || 500, {
      clientHash: hashIdentifier(clientKey),
    });
  }
}
