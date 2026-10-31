import crypto from "crypto";
import type { NextApiRequest } from "next";

/**
 * The admin panel's sign-in session: a signed, expiring token in an HttpOnly
 * cookie. Staff type the admin secret once; the browser keeps only this token,
 * which page scripts cannot read (the secret used to sit in localStorage, open
 * to any injected script, with no server-side expiry and no way to sign out).
 *
 * The signing key is derived from ADMIN_SECRET, so rotating the secret ends
 * every session at once. Scripts keep sending the x-admin-secret header.
 */
export const ADMIN_SESSION_COOKIE = "uudam_admin";
export const ADMIN_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A session used after this long is reissued, so active staff stay signed in (sliding week). */
const ADMIN_SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;

function signingKey(adminSecret: string): Buffer {
  return crypto.createHmac("sha256", adminSecret).update("uudam-admin-session:v1").digest();
}

function sign(adminSecret: string, payload: string): string {
  return crypto.createHmac("sha256", signingKey(adminSecret)).update(payload).digest("base64url");
}

export function createAdminSessionToken(adminSecret: string, now = Date.now()): { token: string; expiresAt: number } {
  const expiresAt = now + ADMIN_SESSION_TTL_MS;
  const payload = `v1.${expiresAt}.${crypto.randomBytes(12).toString("base64url")}`;
  return { token: `${payload}.${sign(adminSecret, payload)}`, expiresAt };
}

/** The token's expiry when it is genuine and current; null otherwise. */
export function verifyAdminSessionToken(adminSecret: string, token: string, now = Date.now()): number | null {
  if (!adminSecret || !token) return null;
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const expiresAt = Number(parts[1]);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ADMIN_SESSION_TTL_MS) return null;
  const expected = Buffer.from(sign(adminSecret, parts.slice(0, 3).join(".")));
  const actual = Buffer.from(parts[3]);
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
  return expiresAt;
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
