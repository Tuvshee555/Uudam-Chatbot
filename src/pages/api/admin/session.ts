import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../lib/env";
import { safeSecretCompare } from "../../../lib/adminAuth";
import { chargeFailedAdminAuth, hasAdminAccess } from "../../../lib/adminAccess";
import {
  adminSessionCookie,
  clearedAdminSessionCookie,
  createAdminSessionToken,
  isSameOriginWrite,
  readAdminSessionCookie,
  shouldRenewAdminSession,
  verifyAdminSessionToken,
} from "../../../lib/adminSession";
import { beginRequestTrace, finishRequestTrace } from "../../../lib/observability";

/**
 * Admin panel sign-in.
 *   GET    → { authorized, open_access, google_sign_in, expires_at } (renews a session in use for a day)
 *   POST   { secret } → sets the session cookie; 401 on a wrong secret, 429 when throttled
 *   DELETE → signs this browser out
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const env = getEnv();
  res.setHeader("Cache-Control", "no-store");
  const trace = beginRequestTrace({
    route: "api.admin.session",
    method: req.method,
    url: req.url,
    headers: req.headers,
    setHeader: (name, value) => res.setHeader(name, value),
  });
  try {
    if (req.method === "GET") {
      const token = readAdminSessionCookie(req);
      const expiresAt = token ? verifyAdminSessionToken(env.adminSecret, token) : null;
      if (expiresAt != null && shouldRenewAdminSession(expiresAt)) {
        const renewed = createAdminSessionToken(env.adminSecret);
        res.setHeader("Set-Cookie", adminSessionCookie(renewed.token, renewed.expiresAt));
        return res.status(200).json({
          ok: true,
          authorized: true,
          open_access: env.adminOpenAccess,
          google_sign_in: env.googleSignInEnabled,
          expires_at: renewed.expiresAt,
        });
      }
      return res.status(200).json({
        ok: true,
        authorized: hasAdminAccess(req),
        open_access: env.adminOpenAccess,
        google_sign_in: env.googleSignInEnabled,
        expires_at: expiresAt,
      });
    }

    if (req.method === "POST") {
      if (!isSameOriginWrite(req)) return res.status(403).json({ error: "cross_site_request" });
      const secret = typeof req.body?.secret === "string" ? req.body.secret.trim() : "";
      if (!safeSecretCompare(env.adminSecret, secret)) {
        if (await chargeFailedAdminAuth(req, res, "api.admin.session")) {
          res.status(401).json({ error: "wrong_secret" });
        }
        return;
      }
      const session = createAdminSessionToken(env.adminSecret);
      res.setHeader("Set-Cookie", adminSessionCookie(session.token, session.expiresAt));
      return res.status(200).json({ ok: true, authorized: true, expires_at: session.expiresAt });
    }

    if (req.method === "DELETE") {
      res.setHeader("Set-Cookie", clearedAdminSessionCookie());
      return res.status(200).json({ ok: true, authorized: false });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).end();
  } finally {
    finishRequestTrace(trace, res.statusCode || 500);
  }
}
