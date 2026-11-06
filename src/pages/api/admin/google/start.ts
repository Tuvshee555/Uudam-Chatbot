import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "../../../../lib/env";
import { adminSignInAvailable } from "../../../../lib/adminAccess";
import {
  buildGoogleAuthUrl,
  googleRedirectUri,
  googleStateCookie,
  newGoogleState,
} from "../../../../lib/adminGoogleAuth";

/** GET → sends the browser to Google's account chooser; Google returns it to ./callback. */
export default function handler(req: NextApiRequest, res: NextApiResponse) {
  const env = getEnv();
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).end();
  }
  // Off without Google setup, and also while ADMIN_SESSION_SECRET is weak (fail closed).
  if (!adminSignInAvailable(env)) {
    return res.redirect(303, "/admin?login_error=google_not_configured");
  }
  const state = newGoogleState();
  res.setHeader("Set-Cookie", googleStateCookie(state));
  return res.redirect(303, buildGoogleAuthUrl(env.googleClientId!, googleRedirectUri(req), state));
}
