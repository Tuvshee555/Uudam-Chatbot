import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../../lib/env";
import { pickFirst } from "../../../../lib/adminAuth";
import { chargeFailedAdminAuth } from "../../../../lib/adminAccess";
import { adminSessionCookie, createAdminSessionToken } from "../../../../lib/adminSession";
import {
  GOOGLE_STATE_COOKIE,
  checkGoogleIdToken,
  clearedGoogleStateCookie,
  exchangeGoogleCode,
  googleRedirectUri,
  statesMatch,
  type GoogleSignInError,
} from "../../../../lib/adminGoogleAuth";
import { logInfo, logWarn } from "../../../../lib/observability";

/**
 * Google returns here with ?code&state. A listed, verified account gets the admin session
 * cookie and lands on /admin; anything else lands on /admin?login_error=<reason>.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const env = getEnv();
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }

  const fail = async (error: GoogleSignInError) => {
    res.setHeader("Set-Cookie", clearedGoogleStateCookie());
    if (error === "google_email_not_allowed" || error === "google_token_invalid") {
      if (!(await chargeFailedAdminAuth(req, res, "api.admin.google.callback"))) return;
    }
    res.redirect(303, `/admin?login_error=${error}`);
  };

  if (!env.googleSignInEnabled) return fail("google_not_configured");
  const state = pickFirst(req.query.state as string | string[] | undefined);
  if (!statesMatch(req.cookies?.[GOOGLE_STATE_COOKIE] || "", state)) return fail("google_state_mismatch");
  const code = pickFirst(req.query.code as string | string[] | undefined);
  if (!code) return fail("google_cancelled");

  const idToken = await exchangeGoogleCode(code, env.googleClientId!, env.googleClientSecret!, googleRedirectUri(req));
  if (!idToken) return fail("google_exchange_failed");
  const checked = checkGoogleIdToken(idToken, env.googleClientId!, env.adminGoogleEmails);
  if (!checked.ok) {
    logWarn("admin.google_sign_in_refused", { error: checked.error });
    return fail(checked.error);
  }

  logInfo("admin.google_sign_in", { email: checked.email });
  const session = createAdminSessionToken(env.adminSecret);
  res.setHeader("Set-Cookie", [adminSessionCookie(session.token, session.expiresAt), clearedGoogleStateCookie()]);
  return res.redirect(303, "/admin");
}
