import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv, type ValidatedEnv } from "./env";
import { pickFirst, safeSecretCompare } from "./adminAuth";
import {
  isSameOriginWrite,
  isUsableAdminApiToken,
  isWeakAdminKey,
  readAdminSessionCookie,
  verifyAdminSessionToken,
  type AdminSession,
} from "./adminSession";
import { getClientKey, rateLimitAsync } from "./rateLimit";
import { recordCounter } from "./observability";

/**
 * Who may use the admin API. Exactly two ways in:
 *  1. a person: the session cookie "Sign in with Google" sets (adminSession.ts), for an
 *     address still on ADMIN_GOOGLE_EMAILS; writes only from this site;
 *  2. a script, read-only: `Authorization: Bearer <ADMIN_API_TOKEN>` on GET/HEAD. It never
 *     opens a write, whatever the route does.
 * There is no password, no x-admin-secret header, no ?secret= and no open-access switch.
 */

/** Sign-in can work: Google is configured and the session signing key is strong. */
export function adminSignInAvailable(env: ValidatedEnv = getEnv()): boolean {
  return env.googleSignInEnabled && !isWeakAdminKey(env.adminSessionSecret);
}

/** The machine token is usable: set, long and random, and not the session signing key itself. */
export function adminApiTokenUsable(env: ValidatedEnv = getEnv()): boolean {
  return isUsableAdminApiToken(env.adminApiToken, env.adminSessionSecret);
}

/** The signed-in Google account behind this request's session cookie, or null. */
export function readAdminSession(req: NextApiRequest): AdminSession | null {
  const token = readAdminSessionCookie(req);
  if (!token) return null;
  const env = getEnv();
  return verifyAdminSessionToken(env.adminSessionSecret, token, env.adminGoogleEmails);
}

/** The admin panel's signed-in browser: a current session cookie, writes only from this site. */
export function hasAdminSession(req: NextApiRequest): boolean {
  return readAdminSession(req) != null && isSameOriginWrite(req);
}

function bearerToken(req: NextApiRequest): string {
  const header = pickFirst(req.headers?.authorization as string | string[] | undefined);
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : "";
}

/** A script reading with ADMIN_API_TOKEN: GET/HEAD only, never a write. */
export function hasReadOnlyApiToken(req: NextApiRequest): boolean {
  const method = (req.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  const env = getEnv();
  if (!adminApiTokenUsable(env)) return false;
  return safeSecretCompare(env.adminApiToken || "", bearerToken(req));
}

export type AdminAccessOptions = {
  /** False for routes whose GET still changes something outside (subscribe-feed POSTs to Meta). */
  allowApiToken?: boolean;
};

export function hasAdminAccess(req: NextApiRequest, options: AdminAccessOptions = {}): boolean {
  if (hasAdminSession(req)) return true;
  return options.allowApiToken !== false && hasReadOnlyApiToken(req);
}

/** Charges one failed attempt to the caller's auth budget; false once the budget is spent. */
export async function chargeFailedAdminAuth(
  req: NextApiRequest,
  res: NextApiResponse,
  route: string,
): Promise<boolean> {
  const clientKey = getClientKey(req);
  const limit = await rateLimitAsync(
    `admin-auth:${clientKey}`,
    getEnv().adminAuthRateLimit,
    60 * 1000,
  );
  if (!limit.allowed) {
    recordCounter("abuse.admin_auth_blocked_total", 1, { route });
    res.status(429).json({ error: "too_many_attempts", reset: limit.reset });
    return false;
  }
  recordCounter("abuse.admin_auth_failed_total", 1, { route });
  return true;
}

/**
 * Routes whose GET still writes somewhere, so the read-only token never opens them:
 * website-sync's GET starts a background flush to the website database.
 * (subscribe-feed passes allowApiToken: false itself.)
 */
const GET_WITH_SIDE_EFFECTS = new Set(["api.admin.website-sync", "api.subscribe_feed"]);

export async function requireAdminAccess(
  req: NextApiRequest,
  res: NextApiResponse,
  route: string,
  options: AdminAccessOptions = {},
) {
  const allowApiToken = options.allowApiToken !== false && !GET_WITH_SIDE_EFFECTS.has(route);
  if (hasAdminAccess(req, { ...options, allowApiToken })) return true;
  if (await chargeFailedAdminAuth(req, res, route)) {
    res.status(401).json({ error: "unauthorized" });
  }
  return false;
}
