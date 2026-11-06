import { ADMIN_SESSION_COOKIE, createAdminSessionToken } from "../../src/lib/adminSession";
import { TEST_ADMIN_API_TOKEN, TEST_ADMIN_EMAILS, TEST_ADMIN_SESSION_SECRET } from "./env";

/**
 * How a test signs in now that the admin is Google-only: the session cookie the Google
 * callback would set (any method), or the read-only machine token (GET/HEAD only).
 * Both use the invented values applyTestEnv() sets.
 */
export function adminSessionToken(email = TEST_ADMIN_EMAILS[0], secret = TEST_ADMIN_SESSION_SECRET): string {
  const session = createAdminSessionToken(secret, email);
  if (!session) throw new Error("test session key is weak");
  return session.token;
}

/** Request headers of a signed-in admin browser (cookie header; no Origin, like a same-site fetch). */
export function adminCookieHeaders(email = TEST_ADMIN_EMAILS[0]): Record<string, string> {
  return { cookie: `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(adminSessionToken(email))}` };
}

/** Request headers of a script reading with ADMIN_API_TOKEN. */
export function adminBearerHeaders(token = TEST_ADMIN_API_TOKEN): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}
