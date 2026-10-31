import type { NextApiRequest, NextApiResponse } from "next";
import { getEnv } from "./env";
import { pickFirst, safeSecretCompare } from "./adminAuth";
import { isSameOriginWrite, readAdminSessionCookie, verifyAdminSessionToken } from "./adminSession";
import { getClientKey, rateLimitAsync } from "./rateLimit";
import { recordCounter } from "./observability";

const env = getEnv();

function extractProvidedSecret(req: NextApiRequest): string {
  const headerSecret = pickFirst(
    req.headers["x-admin-secret"] as string | string[] | undefined,
  );
  const querySecret = env.allowAdminSecretQuery
    ? pickFirst(req.query.secret as string | string[] | undefined)
    : "";
  return headerSecret || querySecret;
}

/** The admin panel's signed-in browser: a current session cookie, writes only from this site. */
export function hasAdminSession(req: NextApiRequest): boolean {
  const token = readAdminSessionCookie(req);
  if (!token || verifyAdminSessionToken(env.adminSecret, token) == null) return false;
  return isSameOriginWrite(req);
}

export function hasAdminAccess(req: NextApiRequest): boolean {
  if (env.adminOpenAccess) return true;
  // Scripts and integrations send the secret itself; the admin panel sends its session cookie.
  if (safeSecretCompare(env.adminSecret, extractProvidedSecret(req))) return true;
  return hasAdminSession(req);
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
    env.adminAuthRateLimit,
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

export async function requireAdminAccess(
  req: NextApiRequest,
  res: NextApiResponse,
  route: string,
) {
  if (hasAdminAccess(req)) return true;
  if (await chargeFailedAdminAuth(req, res, route)) {
    res.status(401).json({ error: "unauthorized" });
  }
  return false;
}
