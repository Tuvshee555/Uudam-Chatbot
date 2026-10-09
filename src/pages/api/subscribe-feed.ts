import type { NextApiRequest, NextApiResponse } from "next";
import { getClientKey, rateLimitAsync } from "../../lib/rateLimit";
import { getEnv } from "../../lib/env";
import { pickFirst, safeSecretCompare } from "../../lib/adminAuth";
import {
  beginRequestTrace,
  classifyError,
  finishRequestTrace,
  hashIdentifier,
  logError,
  recordCounter,
} from "../../lib/observability";

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
    const headerSecret = pickFirst(req.headers["x-admin-secret"]);
    const querySecret = env.allowAdminSecretQuery ? pickFirst(req.query.secret) : "";
    const providedSecret = headerSecret || querySecret;

    if (!safeSecretCompare(env.adminSecret, providedSecret)) {
      const limit = await rateLimitAsync(
        `admin-auth:${clientKey}`,
        env.adminAuthRateLimit,
        60 * 1000,
      );
      if (!limit.allowed) {
        recordCounter("abuse.admin_auth_blocked_total", 1, {
          route: "api.subscribe_feed",
        });
        return res.status(429).json({ error: "too_many_attempts", reset: limit.reset });
      }
      recordCounter("abuse.admin_auth_failed_total", 1, {
        route: "api.subscribe_feed",
      });
      return res.status(401).json({ error: "Unauthorized" });
    }

    // "message_echoes" (not "messaging_echoes", which Meta rejects and which
    // failed the whole request) is what tells the bot a staff member replied
    // from the Page inbox, so it can step aside. Every configured page needs it.
    const fields = "feed,messages,messaging_postbacks,message_reads,message_echoes";

    try {
      const results = [];
      for (const page of env.facebookPages) {
        // Plain fetch: Meta's error body (missing permission, bad field) is the
        // answer this admin call exists to show.
        const response = await fetch(`https://graph.facebook.com/v19.0/${page.pageId}/subscribed_apps`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscribed_fields: fields, access_token: page.token }),
          signal: AbortSignal.timeout(env.metaApiTimeoutMs),
        });
        const body = await response.json().catch(() => null);
        const current = await fetch(`https://graph.facebook.com/v19.0/${page.pageId}/subscribed_apps?access_token=${encodeURIComponent(page.token)}`, {
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
