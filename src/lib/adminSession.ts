import crypto from "crypto";
import type { NextApiRequest } from "next";

/**
 * The admin panel's sign-in session: a signed, expiring token in an HttpOnly cookie,
 * issued only by "Sign in with Google" (api/admin/google/callback.ts). There is no
 * password: page scripts never see a credential, and nothing a person types opens the admin.
 *
 * Token v2 = "v2.<expiresAt>.<email, base64url>.<nonce>.<signature>". The email is the
 * Google account that signed in; it is re-checked against ADMIN_GOOGLE_EMAILS on every
 * request, so removing an address ends that person's access at once. v1 tokens (no email,
 * signed with the old ADMIN_SECRET) are refused.
 *
 * The signing key is ADMIN_SESSION_SECRET: a long random value nobody types. Rotating it
 * ends every session. A short or guessable key is refused outright (fail closed): no
 * session is issued or accepted until a strong one is set. The customer bot is unaffected.
 */
export const ADMIN_SESSION_COOKIE = "uudam_admin";
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A session used after this long is reissued, so active staff stay signed in (sliding week). */
const ADMIN_SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
const SESSION_KEY_LABEL = "uudam-admin-session:v2";
/** Signing keys and machine tokens shorter than this are refused. */
export const MIN_ADMIN_KEY_LENGTH = 32;

export type AdminSession = { email: string; expiresAt: number };

const COMMON_SECRETS = new Set([
  "admin", "administrator", "password", "passw0rd", "secret", "123456", "12345678", "123456789", "1234567890",
  "qwerty", "letmein", "changeme", "test", "admin123", "password123", "uudam", "uudamtravel", "travel", "root",
]);

/**
 * A key nobody should sign with: shorter than 32 characters, a common word, one short
 * chunk repeated ("admin" x 8), or fewer than 8 different characters.
 */
export function isWeakAdminKey(value: string | null | undefined): boolean {
  const key = String(value ?? "").trim();
  if (key.length < MIN_ADMIN_KEY_LENGTH) return true;
  if (COMMON_SECRETS.has(key.toLowerCase())) return true;
  if (/^([\s\S]{1,16})\1+$/.test(key)) return true;
  return new Set(key).size < 8;
}

/** ADMIN_API_TOKEN is usable: set, strong, and not the session signing key itself. */
export function isUsableAdminApiToken(token: string | null | undefined, sessionSecret: string): boolean {
  const value = String(token ?? "").trim();
  return Boolean(value) && !isWeakAdminKey(value) && value !== String(sessionSecret || "").trim();
}

/** The HMAC key for a purpose ("uudam-admin-session:v2", "customer-file-link:v1"); null when the secret is weak. */
export function deriveAdminKey(sessionSecret: string, label: string): Buffer | null {
  if (isWeakAdminKey(sessionSecret)) return null;
  return crypto.createHmac("sha256", sessionSecret.trim()).update(label).digest();
}

function sign(key: Buffer, payload: string): string {
  return crypto.createHmac("sha256", key).update(payload).digest("base64url");
}

function normalEmail(email: string): string {
  return String(email || "").trim().toLowerCase();
}

/** A session for one signed-in Google account; null when the key is weak or the email empty. */
export function createAdminSessionToken(
  sessionSecret: string,
  email: string,
  now = Date.now(),
): { token: string; expiresAt: number } | null {
  const key = deriveAdminKey(sessionSecret, SESSION_KEY_LABEL);
  const address = normalEmail(email);
  if (!key || !address.includes("@")) return null;
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const payload = `v2.${expiresAt}.${Buffer.from(address, "utf8").toString("base64url")}.${crypto.randomBytes(12).toString("base64url")}`;
  return { token: `${payload}.${sign(key, payload)}`, expiresAt };
}

/**
 * The session when the token is genuine, current, and its email is still on the
 * allow-list; null otherwise (a weak key, a v1 token or an empty allow-list included).
 */
export function verifyAdminSessionToken(
  sessionSecret: string,
  token: string,
  allowedEmails: readonly string[],
  now = Date.now(),
): AdminSession | null {
  if (!token) return null;
  const key = deriveAdminKey(sessionSecret, SESSION_KEY_LABEL);
  if (!key) return null;
  const parts = token.split(".");
  if (parts.length !== 5 || parts[0] !== "v2") return null;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ADMIN_SESSION_TTL_MS) return null;
  const expected = Buffer.from(sign(key, parts.slice(0, 4).join(".")));
  const actual = Buffer.from(parts[4]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  const email = normalEmail(Buffer.from(parts[2], "base64url").toString("utf8"));
  if (!email || !allowedEmails.some((allowed) => normalEmail(allowed) === email)) return null;
  return { email, expiresAt };
}

export function shouldRenewAdminSession(expiresAt: number, now = Date.now()): boolean {
  return expiresAt - now < ADMIN_SESSION_TTL_MS - ADMIN_SESSION_RENEW_AFTER_MS;
}

export function readAdminSessionCookie(req: Pick<NextApiRequest, "cookies" | "headers">): string {
  const parsed = req.cookies?.[ADMIN_SESSION_COOKIE];
  if (typeof parsed === "string") return parsed;
  const header = typeof req.headers?.cookie === "string" ? req.headers.cookie : "";
  for (const part of header.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === ADMIN_SESSION_COOKIE) return decodeURIComponent(value.join("="));
  }
  return "";
}

/**
 * A browser sends Origin on every POST/PATCH/DELETE. A cookie-authenticated write
 * from another site is refused even if a browser ever attached the cookie
 * (SameSite=Strict already keeps it off cross-site requests).
 */
export function isSameOriginWrite(req: Pick<NextApiRequest, "method" | "headers">): boolean {
  const method = (req.method || "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;
  const origin = typeof req.headers?.origin === "string" ? req.headers.origin : "";
  if (!origin) return true;
  const host = typeof req.headers?.["x-forwarded-host"] === "string" ? req.headers["x-forwarded-host"] : req.headers?.host;
  try {
    return new URL(origin).host === String(host || "").split(",")[0].trim();
  } catch {
    return false;
  }
}

function cookieAttributes(maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure}`;
}

export function adminSessionCookie(token: string, expiresAt: number, now = Date.now()): string {
  return `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(token)}; ${cookieAttributes(Math.max(0, Math.floor((expiresAt - now) / 1000)))}`;
}

export function clearedAdminSessionCookie(): string {
  return `${ADMIN_SESSION_COOKIE}=; ${cookieAttributes(0)}`;
}
