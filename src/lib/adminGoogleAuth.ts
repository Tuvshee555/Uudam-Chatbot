import crypto from "crypto";
import type { NextApiRequest } from "next";

/**
 * "Sign in with Google" for the admin panel (OAuth 2.0 authorization-code flow, no library).
 * Google only proves who the person is; ADMIN_GOOGLE_EMAILS decides who gets in. A
 * listed account receives the same session cookie the admin secret gives.
 */
export const GOOGLE_STATE_COOKIE = "uudam_admin_oauth";
const GOOGLE_STATE_PATH = "/api/admin/google";
const GOOGLE_STATE_TTL_SECONDS = 10 * 60;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);

export type GoogleSignInError =
  | "google_not_configured"
  | "google_state_mismatch"
  | "google_cancelled"
  | "google_exchange_failed"
  | "google_token_invalid"
  | "google_email_unverified"
  | "google_email_not_allowed";

export function parseAllowedEmails(raw: string | null | undefined): string[] {
  return (raw || "")
    .split(/[,\s]+/)
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.includes("@"));
}

/** The callback address Google sends the browser back to; it must be listed in the Google console. */
export function googleRedirectUri(req: Pick<NextApiRequest, "headers">): string {
  const forwardedHost = typeof req.headers["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : "";
  const host = (forwardedHost || String(req.headers.host || "")).split(",")[0].trim();
  const forwardedProto = typeof req.headers["x-forwarded-proto"] === "string" ? req.headers["x-forwarded-proto"] : "";
  const proto = forwardedProto.split(",")[0].trim() || (/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https");
  return `${proto}://${host}${GOOGLE_STATE_PATH}/callback`;
}

export function newGoogleState(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function buildGoogleAuthUrl(clientId: string, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email",
    state,
    prompt: "select_account",
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

function stateCookieAttributes(maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  // Lax, not Strict: the callback is a top-level navigation coming back from accounts.google.com.
  return `Path=${GOOGLE_STATE_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

export function googleStateCookie(state: string): string {
  return `${GOOGLE_STATE_COOKIE}=${state}; ${stateCookieAttributes(GOOGLE_STATE_TTL_SECONDS)}`;
}

export function clearedGoogleStateCookie(): string {
  return `${GOOGLE_STATE_COOKIE}=; ${stateCookieAttributes(0)}`;
}

export function statesMatch(expected: string, actual: string): boolean {
  if (!expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

type IdTokenClaims = { iss?: unknown; aud?: unknown; exp?: unknown; email?: unknown; email_verified?: unknown };

function decodeIdToken(idToken: string): IdTokenClaims | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as IdTokenClaims;
  } catch {
    return null;
  }
}

/**
 * Checks the ID token Google returned on the server-to-server code exchange (TLS straight
 * from Google, so its signature need not be re-verified) and the allow-list.
 */
export function checkGoogleIdToken(
  idToken: string,
  clientId: string,
  allowedEmails: string[],
  now = Date.now(),
): { ok: true; email: string } | { ok: false; error: GoogleSignInError } {
  const claims = decodeIdToken(idToken);
  if (!claims) return { ok: false, error: "google_token_invalid" };
  if (typeof claims.iss !== "string" || !GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, error: "google_token_invalid" };
  if (claims.aud !== clientId) return { ok: false, error: "google_token_invalid" };
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return { ok: false, error: "google_token_invalid" };
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) return { ok: false, error: "google_token_invalid" };
  if (claims.email_verified !== true && claims.email_verified !== "true") return { ok: false, error: "google_email_unverified" };
  if (!allowedEmails.includes(email)) return { ok: false, error: "google_email_not_allowed" };
  return { ok: true, email };
}

export async function exchangeGoogleCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<string | null> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }).toString(),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) return null;
  const json = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  return typeof json?.id_token === "string" ? json.id_token : null;
}
